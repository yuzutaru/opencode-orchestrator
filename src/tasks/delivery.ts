import { execFileSync } from 'node:child_process';
import { Config } from '../config.js';
import { GitHubClient, Issue } from '../github/client.js';
import { createLogger } from '../utils/logger.js';
import { botGitEnv } from '../utils/git.js';
import { QualityResult } from './quality.js';

const logger = createLogger('delivery');

export interface DeliveryResult {
    ok: boolean;
    changedFiles: string[];
    subject?: string;
    prNumber?: number;
    prUrl?: string;
    error?: string;
}

const ANDROID = 'android';
const IOS = 'ios';

/**
 * Turns a verified worktree into a pull request.
 *
 * The agent never commits or pushes. This keeps the repository rules enforceable
 * (platform split, commit scope) and guarantees that a PR only exists for work
 * that already passed the quality gates.
 */
export class DeliveryManager {
    constructor(
        private config: Config,
        private github: GitHubClient
    ) {}

    private git(worktreePath: string, args: string[]): string {
        try {
            return execFileSync('git', args, {
                cwd: worktreePath,
                encoding: 'utf-8',
                env: botGitEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: 32 * 1024 * 1024,
            }) ?? '';
        } catch (error: any) {
            const stderr = error.stderr?.toString?.() ?? error.message;
            throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
        }
    }

    private getDefaultBranch(): string {
        try {
            const ref = this.git(this.config.opencode.projectPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim();
            return ref.replace('refs/remotes/origin/', '');
        } catch {
            return 'main';
        }
    }

    /**
     * Stage everything the agent produced and list the changed paths.
     */
    stageChanges(worktreePath: string): string[] {
        const base = `origin/${this.getDefaultBranch()}`;
        this.git(worktreePath, ['add', '-A']);
        const output = this.git(worktreePath, ['diff', '--cached', '--name-only', base]);
        return output.split('\n').map((line) => line.trim()).filter(Boolean);
    }

    /**
     * Derive a Conventional Commit subject that satisfies scripts/hooks/commit-msg.
     */
    buildSubject(issue: Issue, changedFiles: string[]): string {
        const touchesAndroid = changedFiles.some((file) => file.startsWith('android/'));
        const touchesIos = changedFiles.some((file) => file.startsWith('ios/'));
        const scope = touchesAndroid ? ANDROID : touchesIos ? IOS : undefined;

        const labels = issue.labels;
        const type = labels.includes('documentation')
            ? 'docs'
            : labels.includes('enhancement')
                ? 'feat'
                : labels.includes('bug')
                    ? 'fix'
                    : 'chore';

        const summary = issue.title
            .replace(/^\s*\[[^\]]*\]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[.!]+$/, '');

        const lowered = summary.charAt(0).toLowerCase() + summary.slice(1);
        const capped = lowered.length > 72 ? `${lowered.slice(0, 69)}...` : lowered;

        return scope ? `${type}(${scope}): ${capped}` : `${type}: ${capped}`;
    }

    /**
     * Commit, push and open a draft PR.
     */
    async deliver(
        issue: Issue,
        worktreePath: string,
        branchName: string,
        changedFiles: string[],
        gateResults: QualityResult[],
        agentReport: string
    ): Promise<DeliveryResult> {
        const touchesAndroid = changedFiles.some((file) => file.startsWith('android/'));
        const touchesIos = changedFiles.some((file) => file.startsWith('ios/'));

        if (touchesAndroid && touchesIos) {
            return {
                ok: false,
                changedFiles,
                error: `Changes span both \`android/\` and \`ios/\`, which the repository hooks reject. Split the issue by platform.`,
            };
        }

        const subject = this.buildSubject(issue, changedFiles);

        // The agent is told not to commit, but tolerate it if it did: only commit
        // when something is actually staged.
        let hasStagedChanges = true;
        try {
            this.git(worktreePath, ['diff', '--cached', '--quiet']);
            hasStagedChanges = false;
        } catch {
            hasStagedChanges = true;
        }

        if (hasStagedChanges) {
            try {
                this.git(worktreePath, ['commit', '-m', subject, '-m', `Implements #${issue.number}.`]);
            } catch (error: any) {
                return { ok: false, changedFiles, subject, error: error.message };
            }
        } else {
            logger.info({ issueNumber: issue.number }, 'Worktree already committed by the agent; skipping commit');
        }

        try {
            this.git(worktreePath, ['push', '-u', 'origin', branchName]);
        } catch (error: any) {
            return { ok: false, changedFiles, subject, error: `Push failed: ${error.message}` };
        }

        const report = agentReport.trim();
        const reportSection = report.length > 0 ? `${report.slice(-4000)}\n\n` : '';
        const gatesSection = gateResults.length > 0
            ? gateResults
                .map((r) => `- ${r.passed ? '✅' : '❌'} **${r.gate}** (${(r.durationMs / 1000).toFixed(0)}s)`)
                .join('\n')
            : '_No platform code changed._';

        const body = `## Summary

${reportSection}## Verification

${gatesSection}

## Notes

- Opened automatically by the local automation bot; a human must review and merge.
- Commit, push and verification were performed by the orchestrator, not the agent.

Closes #${issue.number}
`;

        try {
            const pr = await this.github.createPullRequest(subject, body, branchName, this.getDefaultBranch(), true);
            logger.info({ issueNumber: issue.number, pr: pr.url }, 'Draft PR created');
            return { ok: true, changedFiles, subject, prNumber: pr.number, prUrl: pr.url };
        } catch (error: any) {
            return { ok: false, changedFiles, subject, error: `Pull request failed: ${error.message}` };
        }
    }
}
