import fs from 'node:fs';
import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { Config, getBranchName } from '../config.js';
import { GitHubClient, Issue } from '../github/client.js';
import { WorktreeManager } from './worktree.js';
import { OpenCodeManager, RunResult } from './opencode.js';
import { QualityGateRunner, QualityResult } from './quality.js';
import { DeliveryManager } from './delivery.js';
import { Labels, isPlanPending } from '../github/labels.js';
import { createLogger } from '../utils/logger.js';
import { createBranchSlug } from '../utils/slug.js';

const logger = createLogger('task-manager');
const execAsync = promisify(execCb);

const STATE_FILE = path.join(process.cwd(), '.state', 'sessions.json');

export type TaskPhase =
    | 'starting'
    | 'planning'
    | 'working'
    | 'blocked'
    | 'verifying'
    | 'delivering'
    | 'review-ready'
    | 'failed';

export interface TaskContext {
    issueNumber: number;
    issue: Issue;
    branchName: string;
    worktreePath: string;
    phase: TaskPhase;
    startedAt: Date;
    sessionId?: string;
}

/**
 * Task lifecycle: worktree -> agent mission -> quality gates -> draft PR.
 */
export class TaskManager {
    private activeTasks = new Map<number, TaskContext>();
    private blockedSince = new Map<number, Date>();
    private sessions = new Map<number, string>();
    private github: GitHubClient;
    private worktrees: WorktreeManager;
    private opencode: OpenCodeManager;
    private quality: QualityGateRunner;
    private delivery: DeliveryManager;

    constructor(private config: Config) {
        this.github = new GitHubClient(config);
        this.worktrees = new WorktreeManager(config);
        this.quality = new QualityGateRunner(config);
        this.delivery = new DeliveryManager(config, this.github);
        this.opencode = new OpenCodeManager(config, (result) => this.handleComplete(result));

        this.loadSessions();
    }

    /**
     * Start a new task.
     */
    async startTask(issue: Issue): Promise<TaskContext> {
        if (this.activeTasks.has(issue.number)) {
            return this.activeTasks.get(issue.number)!;
        }

        const slug = createBranchSlug(issue.title);
        const branchName = getBranchName(issue.number, slug);
        const worktreePath = await this.worktrees.createWorktree(issue.number, branchName);

        const context: TaskContext = {
            issueNumber: issue.number,
            issue,
            branchName,
            worktreePath,
            phase: 'starting',
            startedAt: new Date(),
        };

        this.activeTasks.set(issue.number, context);

        try {
            if (this.config.planning.requirePlanApproval) {
                await this.opencode.startPlan(issue, worktreePath, branchName);
                context.phase = 'planning';
                logger.info({ issueNumber: issue.number }, 'Plan mission started; awaiting human approval');
            } else {
                await this.opencode.startTask(issue, worktreePath, branchName);
                context.phase = 'working';
            }
        } catch (error: any) {
            this.activeTasks.delete(issue.number);
            await this.block(issue, `Could not start the OpenCode mission: ${error.message}`);
        }

        return context;
    }

    /**
     * Resume a blocked task after the human replied.
     *
     * Handles both the existing `ai-blocked` path and the new `ai-plan-pending`
     * path: an `/approve` reply starts implementation; anything else revises the
     * plan and re-posts it for another review.
     */
    async continueBlockedTask(issue: Issue): Promise<TaskContext | null> {
        if (this.activeTasks.has(issue.number)) {
            logger.warn({ issueNumber: issue.number }, 'Task already active, ignoring reply');
            return null;
        }

        const latestComment = this.github.getLatestHumanComment(issue);
        if (!latestComment) {
            logger.warn({ issueNumber: issue.number }, 'No human comment found, not resuming');
            return null;
        }

        const worktreePath = this.worktrees.getPath(issue.number);
        if (!fs.existsSync(worktreePath)) {
            await this.block(issue, 'The worktree for this issue is gone, so the reply cannot be applied. Re-add `ai-task` to start from scratch.');
            return null;
        }

        const branchName = this.worktrees.getCurrentBranch(issue.number);
        if (!branchName) {
            await this.block(issue, 'Could not determine the branch of the existing worktree.');
            return null;
        }

        const planPending = isPlanPending(issue);
        const approved = planPending && this.isApproved(latestComment.body);

        const context: TaskContext = {
            issueNumber: issue.number,
            issue,
            branchName,
            worktreePath,
            phase: planPending ? 'planning' : 'working',
            startedAt: new Date(),
            sessionId: this.getSession(issue.number),
        };

        this.activeTasks.set(issue.number, context);

        try {
            const sessionId = this.getSession(issue.number);

            if (planPending) {
                // Orchestrator-side label swap so the critical transition can't
                // be skipped by a misbehaving agent.
                if (approved) {
                    await this.github.removeLabel(issue.number, Labels.AI_PLAN_PENDING).catch(() => undefined);
                    await this.github.addLabel(issue.number, Labels.AI_IN_PROGRESS).catch(() => undefined);
                    logger.info({ issueNumber: issue.number }, 'Plan approved; implementation starting');
                }

                if (sessionId) {
                    await this.opencode.continueTask(
                        issue,
                        worktreePath,
                        sessionId,
                        latestComment.body,
                        { phase: approved ? 'implement' : 'feedback', branchName },
                    );
                } else {
                    // Session id was lost (fresh state file): start a new mission
                    // with the full comment history so the agent still has context.
                    logger.warn({ issueNumber: issue.number }, 'No stored session id, restarting mission with full history');
                    if (approved) {
                        await this.opencode.startTask(issue, worktreePath, branchName);
                    } else {
                        await this.opencode.startPlan(issue, worktreePath, branchName);
                    }
                }
            } else {
                // Existing ai-blocked continuation path.
                if (sessionId) {
                    await this.opencode.continueTask(issue, worktreePath, sessionId, latestComment.body);
                } else {
                    logger.warn({ issueNumber: issue.number }, 'No stored session id, restarting mission with full history');
                    await this.opencode.startTask(issue, worktreePath, branchName);
                }
            }
        } catch (error: any) {
            this.activeTasks.delete(issue.number);
            await this.block(issue, `Could not resume the OpenCode mission: ${error.message}`);
        }

        return context;
    }

    /**
     * Test whether a human comment contains the plan-approval keyword as a
     * standalone, case-insensitive token.
     */
    isApproved(commentBody: string): boolean {
        const keyword = this.config.planning.approveKeyword.trim();
        if (!keyword) return false;
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i');
        return re.test(commentBody);
    }

    /**
     * Called by the OpenCode manager when a mission exits.
     */
    private async handleComplete(result: RunResult): Promise<void> {
        const context = this.activeTasks.get(result.issueNumber);
        this.activeTasks.delete(result.issueNumber);

        if (result.sessionId) this.rememberSession(result.issueNumber, result.sessionId);

        if (!context) {
            logger.warn({ issueNumber: result.issueNumber }, 'Mission finished without a tracked context');
            return;
        }

        if (result.killed) {
            logger.warn({ issueNumber: result.issueNumber }, 'Mission was killed; leaving labels untouched');
            return;
        }

        const issue = await this.github.getIssue(result.issueNumber);
        if (!issue) {
            logger.error({ issueNumber: result.issueNumber }, 'Could not reload the issue after the mission');
            return;
        }

        if (issue.labels.includes(Labels.AI_BLOCKED)) {
            logger.info({ issueNumber: issue.number }, 'Agent asked for clarification; waiting for a human');
            this.blockedSince.set(issue.number, new Date());
            return;
        }

        if (issue.labels.includes(Labels.AI_PLAN_PENDING)) {
            logger.info({ issueNumber: issue.number }, 'Plan mission complete; awaiting human approval');
            await this.discardPlanChanges(context.worktreePath);
            this.blockedSince.set(issue.number, new Date());
            return;
        }

        if (result.timedOut) {
            await this.block(issue, `The mission timed out after ${this.config.opencode.taskTimeoutMinutes} minutes.`);
            return;
        }

        if (result.exitCode !== 0) {
            const stderr = result.stderr.trim().slice(-2000);
            await this.block(issue, `OpenCode exited with code ${result.exitCode}.`, stderr ? `\n\n\`\`\`\n${stderr}\n\`\`\`` : '');
            return;
        }

        let changedFiles: string[];
        try {
            changedFiles = this.delivery.stageChanges(context.worktreePath);
        } catch (error: any) {
            await this.block(issue, `Could not stage the worktree changes: ${error.message}`);
            return;
        }

        if (changedFiles.length === 0) {
            await this.block(issue, 'The mission finished without changing any files.');
            return;
        }

        context.phase = 'verifying';
        const gateResults = await this.runGates(context.worktreePath, changedFiles);

        if (this.config.quality.enforceGates && !this.quality.allPassed(gateResults)) {
            await this.block(
                issue,
                'Quality gates failed, so no pull request was opened.',
                this.quality.getFailureDetails(gateResults)
            );
            return;
        }

        // Gates must not rewrite tracked files: otherwise the commit would differ
        // from the tree that was verified (SPM resolution, xcodebuild side effects).
        const gateSideEffects = this.delivery.trackedModifications(context.worktreePath);
        if (gateSideEffects.length > 0) {
            await this.block(
                issue,
                'The verification step modified tracked files, so the tested tree no longer matches what would be committed.',
                `\n\n\`\`\`\n${gateSideEffects.join('\n')}\n\`\`\``
            );
            return;
        }

        context.phase = 'delivering';
        const delivery = await this.delivery.deliver(
            issue,
            context.worktreePath,
            context.branchName,
            changedFiles,
            gateResults,
            result.lastText
        );

        if (!delivery.ok) {
            await this.block(issue, `Delivery failed: ${delivery.error}`);
            return;
        }

        context.phase = 'review-ready';
        this.blockedSince.delete(issue.number);

        await this.github.removeLabel(issue.number, Labels.AI_TASK);
        await this.github.removeLabel(issue.number, Labels.AI_IN_PROGRESS);
        await this.github.removeLabel(issue.number, Labels.AI_BLOCKED);
        await this.github.addLabel(issue.number, Labels.AI_REVIEW_READY);

        await this.github.postComment(issue.number, `## Draft pull request ready

- PR: ${delivery.prUrl}
- Branch: \`${context.branchName}\`
- Commit: \`${delivery.subject}\`

### Verification (run by the orchestrator)

${this.quality.getSummary(gateResults)}

Merging is manual: ask for changes on the PR, or reply here to have the agent continue.`);
    }

    private async runGates(worktreePath: string, changedFiles: string[]): Promise<QualityResult[]> {
        if (!this.config.quality.enforceGates) {
            logger.warn('Quality gates are disabled (ENFORCE_QUALITY_GATES=false)');
            return [];
        }

        return this.quality.runAllGates(worktreePath, changedFiles);
    }

    /**
     * Mark the issue blocked and explain why.
     */
    private async block(issue: Issue, reason: string, details: string = ''): Promise<void> {
        logger.warn({ issueNumber: issue.number, reason }, 'Blocking issue');

        await this.github.removeLabel(issue.number, Labels.AI_IN_PROGRESS).catch(() => undefined);
        await this.github.addLabel(issue.number, Labels.AI_BLOCKED).catch(() => undefined);

        await this.github.postComment(
            issue.number,
            `## Automation blocked

${reason}${details}

Reply to this issue to let the agent continue, or fix the problem and re-add \`ai-task\`.`
        );

        this.blockedSince.set(issue.number, new Date());
    }

    /**
     * Discard any stray changes left in the worktree after a read-only plan
     * phase. The plan must not touch files, so anything modified here is a
     * rule violation and is thrown away before implementation begins.
     */
    private async discardPlanChanges(worktreePath: string): Promise<void> {
        try {
            await execAsync(`git -C "${worktreePath}" checkout -- .`);
            const status = await execAsync(`git -C "${worktreePath}" status --porcelain`);
            if (status.stdout.trim()) {
                logger.warn({ worktreePath, status: status.stdout.trim() }, 'Untracked plan-phase files remain; leaving them in place');
            } else {
                logger.info({ worktreePath }, 'Discarded stray plan-phase changes');
            }
        } catch (error: any) {
            logger.warn({ error, worktreePath }, 'Could not discard plan-phase changes');
        }
    }

    /**
     * Timestamp of the moment the issue was blocked, used to detect a human reply.
     */
    getBlockedSince(issue: Issue): Date {
        const tracked = this.blockedSince.get(issue.number);
        if (tracked) return tracked;

        const botComments = issue.comments.filter((comment) => comment.author === this.config.github.username);
        if (botComments.length > 0) {
            return new Date(botComments[botComments.length - 1].createdAt);
        }

        return new Date(issue.updatedAt);
    }

    getTask(issueNumber: number): TaskContext | undefined {
        return this.activeTasks.get(issueNumber);
    }

    getActiveTasks(): TaskContext[] {
        return Array.from(this.activeTasks.values());
    }

    getActiveCount(): number {
        return this.activeTasks.size;
    }

    isRunning(issueNumber: number): boolean {
        return this.activeTasks.has(issueNumber) || this.opencode.isRunning(issueNumber);
    }

    canStartNewTask(): boolean {
        return this.activeTasks.size < this.config.scheduler.maxConcurrentTasks;
    }

    shutdown(): void {
        logger.info('Shutting down task manager');
        this.opencode.killAll();
    }

    // --- session persistence -------------------------------------------------

    private loadSessions(): void {
        try {
            if (!fs.existsSync(STATE_FILE)) return;
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Record<string, string>;
            for (const [issueNumber, sessionId] of Object.entries(raw)) {
                this.sessions.set(Number(issueNumber), sessionId);
            }
        } catch (error) {
            logger.warn({ error }, 'Could not read stored sessions');
        }
    }

    private rememberSession(issueNumber: number, sessionId: string): void {
        this.sessions.set(issueNumber, sessionId);

        try {
            fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
            const raw = Object.fromEntries(Array.from(this.sessions.entries()).map(([k, v]) => [String(k), v]));
            fs.writeFileSync(STATE_FILE, JSON.stringify(raw, null, 2));
        } catch (error) {
            logger.warn({ error }, 'Could not persist session id');
        }
    }

    getSession(issueNumber: number): string | undefined {
        return this.sessions.get(issueNumber);
    }
}
