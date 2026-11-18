import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('quality');

export interface QualityGate {
    name: string;
    command: string;
    args: string[];
    /** Working directory, relative to the worktree root. */
    cwd: string;
}

export interface QualityResult {
    gate: string;
    passed: boolean;
    output: string;
    error?: string;
    durationMs: number;
}

/**
 * Levela quality gates.
 *
 * The upstream implementation only understood Node projects (`npm run lint`,
 * `tsc --noEmit`, ...), which silently passed for this repository. These gates
 * mirror `.github/workflows/ci.yml`: Android gets a debug build plus unit tests,
 * iOS gets a simulator build, and any change under `assets/` must keep the
 * cross-platform parity contracts green.
 */
export class QualityGateRunner {
    constructor(private config: Config) {}

    detectGates(worktreePath: string, changedFiles: string[]): QualityGate[] {
        const touches = (prefix: string) => changedFiles.some((file) => file.startsWith(prefix));
        const gates: QualityGate[] = [];

        if (touches('android/')) {
            gates.push({
                name: 'Android build & unit tests',
                command: './gradlew',
                args: ['assembleDebug', 'testDebugUnitTest', '--console=plain'],
                cwd: 'android',
            });
        }

        if (touches('ios/')) {
            gates.push({
                name: 'iOS simulator build',
                command: 'xcodebuild',
                args: ['-scheme', 'Levela', '-destination', 'generic/platform=iOS Simulator', 'build'],
                cwd: 'ios',
            });
        }

        if (touches('assets/')) {
            gates.push(
                {
                    name: 'Evidence: theme parity',
                    command: './scripts/verify_theme_parity.sh',
                    args: [],
                    cwd: '.',
                },
                {
                    name: 'Evidence: splash parity',
                    command: './scripts/verify_splash_parity.sh',
                    args: ['--strict'],
                    cwd: '.',
                },
                {
                    name: 'Evidence: onboarding parity',
                    command: './scripts/verify_onboarding_parity.sh',
                    args: ['--strict'],
                    cwd: '.',
                },
                {
                    name: 'Evidence: iOS test mirror parity',
                    command: './scripts/verify_ios_test_mirror_parity.sh',
                    args: [],
                    cwd: '.',
                }
            );
        }

        if (gates.length === 0) {
            logger.info({ worktreePath }, 'No platform code changed; no quality gates to run');
        }

        return gates;
    }

    runGate(worktreePath: string, gate: QualityGate): QualityResult {
        const startedAt = Date.now();
        const cwd = path.join(worktreePath, gate.cwd);

        logger.info({ gate: gate.name, cwd }, 'Running quality gate');

        try {
            const output = execFileSync(gate.command, gate.args, {
                cwd,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: this.config.quality.timeoutMinutes * 60 * 1000,
                maxBuffer: 32 * 1024 * 1024,
            });

            logger.info({ gate: gate.name, durationMs: Date.now() - startedAt }, 'Quality gate passed');
            return { gate: gate.name, passed: true, output: output ?? '', durationMs: Date.now() - startedAt };
        } catch (error: any) {
            const stdout = typeof error.stdout === 'string' ? error.stdout : error.stdout?.toString?.() ?? '';
            const stderr = typeof error.stderr === 'string' ? error.stderr : error.stderr?.toString?.() ?? '';

            logger.warn({ gate: gate.name, error: error.message }, 'Quality gate failed');
            return {
                gate: gate.name,
                passed: false,
                output: stdout,
                error: stderr || error.message,
                durationMs: Date.now() - startedAt,
            };
        }
    }

    /**
     * Run every detected gate, stopping at the first failure.
     */
    runAllGates(worktreePath: string, changedFiles: string[]): QualityResult[] {
        const results: QualityResult[] = [];

        for (const gate of this.detectGates(worktreePath, changedFiles)) {
            const result = this.runGate(worktreePath, gate);
            results.push(result);

            if (!result.passed) break;
        }

        return results;
    }

    allPassed(results: QualityResult[]): boolean {
        return results.every((result) => result.passed);
    }

    getSummary(results: QualityResult[]): string {
        if (results.length === 0) return '_No quality gates needed for this change._';

        return results
            .map((result) => {
                const icon = result.passed ? '✅' : '❌';
                const seconds = (result.durationMs / 1000).toFixed(0);
                return `- ${icon} **${result.gate}** (${seconds}s)`;
            })
            .join('\n');
    }

    /**
     * Failure details for the issue comment, trimmed to keep the comment readable.
     */
    getFailureDetails(results: QualityResult[]): string {
        const failed = results.find((result) => !result.passed);
        if (!failed) return '';

        const body = (failed.error || failed.output || '').trim();
        const trimmed = body.length > 4000 ? body.slice(-4000) : body;

        return `\n\n### Failing gate: ${failed.gate}\n\n\`\`\`\n${trimmed}\n\`\`\``;
    }
}
