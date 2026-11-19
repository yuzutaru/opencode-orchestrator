import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Config, getWorktreeBase } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('quality');

/** What a gate proves: fast compile/unit signal, device-backed UI, or a shared contract. */
export type GateKind = 'unit' | 'ui' | 'contract';

export interface QualityGate {
    name: string;
    kind: GateKind;
    command: string;
    args: string[];
    /** Working directory, relative to the worktree root. */
    cwd: string;
    timeoutMinutes: number;
    /** Extra environment for the child process (gate scripts read these). */
    env?: Record<string, string>;
    /** Report directory/bundle, relative to the worktree root, useful on failure. */
    reportPath?: string;
}

export interface QualityResult {
    gate: string;
    kind: GateKind;
    passed: boolean;
    exitCode: number | null;
    timedOut: boolean;
    /** Absolute path to the full output log (kept outside the worktree). */
    logPath: string;
    reportPath?: string;
    /** Extracted failing lines, so the issue comment does not need the whole log. */
    signal?: string;
    durationMs: number;
}

/**
 * Levela quality gates.
 *
 * Selection is change-based: an issue that only touches `android/` never pays for
 * iOS verification. Each touched platform runs its unit gate first (cheap, fails
 * fast) and then its UI gate (device-backed). The upstream implementation only
 * understood Node projects (`npm run lint`, `tsc --noEmit`, ...), which silently
 * passed for this repository.
 *
 * Device lifecycle lives in `scripts/gates/*.sh` in this orchestrator, not in the
 * repository under test, so an agent cannot weaken the harness that verifies it.
 */
export class QualityGateRunner {
    constructor(private config: Config) {}

    detectGates(changedFiles: string[]): QualityGate[] {
        const touches = (prefix: string) => changedFiles.some((file) => file.startsWith(prefix));
        const quality = this.config.quality;
        const gates: QualityGate[] = [];

        if (touches('android/')) {
            gates.push({
                name: 'Android · unit tests',
                kind: 'unit',
                command: './gradlew',
                args: ['assembleDebug', 'testDebugUnitTest', '--console=plain'],
                cwd: 'android',
                timeoutMinutes: quality.timeoutMinutes,
            });

            if (quality.androidUiTests) {
                gates.push({
                    name: 'Android · instrumented UI tests',
                    kind: 'ui',
                    command: path.join(quality.gateScriptsDir, 'android-instrumented.sh'),
                    args: [],
                    cwd: '.',
                    timeoutMinutes: quality.uiTimeoutMinutes,
                    env: {
                        LEVELA_AVD: quality.avd,
                        LEVELA_MIN_FREE_GB: String(quality.minFreeGb),
                    },
                    reportPath: 'android/app/build/reports/androidTests',
                });
            }
        }

        if (touches('ios/')) {
            gates.push({
                name: 'iOS · unit tests',
                kind: 'unit',
                command: path.join(quality.gateScriptsDir, 'ios-tests.sh'),
                args: ['unit'],
                cwd: '.',
                timeoutMinutes: quality.timeoutMinutes,
                env: {
                    LEVELA_IOS_DEVICE: quality.iosDevice,
                    LEVELA_MIN_FREE_GB: String(quality.minFreeGb),
                },
            });

            if (quality.iosUiTests) {
                gates.push({
                    name: 'iOS · UI tests',
                    kind: 'ui',
                    command: path.join(quality.gateScriptsDir, 'ios-tests.sh'),
                    args: ['ui'],
                    cwd: '.',
                    timeoutMinutes: quality.uiTimeoutMinutes,
                    env: {
                        LEVELA_IOS_DEVICE: quality.iosDevice,
                        LEVELA_MIN_FREE_GB: String(quality.minFreeGb),
                    },
                    reportPath: 'ios/.build/results/ui.xcresult',
                });
            }
        }

        if (touches('assets/')) {
            gates.push(
                {
                    name: 'Contract · theme parity',
                    kind: 'contract',
                    command: './scripts/verify_theme_parity.sh',
                    args: [],
                    cwd: '.',
                    timeoutMinutes: quality.contractTimeoutMinutes,
                },
                {
                    name: 'Contract · splash parity',
                    kind: 'contract',
                    command: './scripts/verify_splash_parity.sh',
                    args: ['--strict'],
                    cwd: '.',
                    timeoutMinutes: quality.contractTimeoutMinutes,
                },
                {
                    name: 'Contract · onboarding parity',
                    kind: 'contract',
                    command: './scripts/verify_onboarding_parity.sh',
                    args: ['--strict'],
                    cwd: '.',
                    timeoutMinutes: quality.contractTimeoutMinutes,
                },
                {
                    name: 'Contract · iOS test mirror parity',
                    kind: 'contract',
                    command: './scripts/verify_ios_test_mirror_parity.sh',
                    args: [],
                    cwd: '.',
                    timeoutMinutes: quality.contractTimeoutMinutes,
                }
            );
        }

        if (gates.length === 0) {
            logger.info({ changedFiles: changedFiles.length }, 'No platform code changed; no quality gates to run');
        }

        return gates;
    }

    /**
     * Run every detected gate, stopping at the first failure (unit before UI).
     */
    async runAllGates(worktreePath: string, changedFiles: string[]): Promise<QualityResult[]> {
        const results: QualityResult[] = [];

        for (const gate of this.detectGates(changedFiles)) {
            const result = await this.runGate(worktreePath, gate);
            results.push(result);

            if (!result.passed) break;
        }

        return results;
    }

    async runGate(worktreePath: string, gate: QualityGate): Promise<QualityResult> {
        const startedAt = Date.now();
        const cwd = path.join(worktreePath, gate.cwd);
        const logPath = this.logPathFor(worktreePath, gate);

        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(
            logPath,
            [
                `# gate: ${gate.name}`,
                `# kind: ${gate.kind}`,
                `# cwd: ${cwd}`,
                `# command: ${gate.command} ${gate.args.join(' ')}`,
                `# started: ${new Date().toISOString()}`,
                `# timeout: ${gate.timeoutMinutes}m`,
                '',
                '',
            ].join('\n')
        );

        logger.info({ gate: gate.name, cwd, logPath }, 'Running quality gate');

        const outcome = await this.spawnGate(gate, cwd, logPath);
        const durationMs = Date.now() - startedAt;
        const passed = !outcome.spawnError && !outcome.timedOut && outcome.exitCode === 0;

        if (passed) {
            logger.info({ gate: gate.name, durationMs }, 'Quality gate passed');
        } else {
            logger.warn(
                { gate: gate.name, exitCode: outcome.exitCode, timedOut: outcome.timedOut, spawnError: outcome.spawnError },
                'Quality gate failed'
            );
        }

        return {
            gate: gate.name,
            kind: gate.kind,
            passed,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            logPath,
            reportPath: gate.reportPath ? path.join(worktreePath, gate.reportPath) : undefined,
            signal: passed
                ? undefined
                : outcome.spawnError ?? this.extractSignal(logPath, outcome.timedOut, gate.timeoutMinutes),
            durationMs,
        };
    }

    private spawnGate(
        gate: QualityGate,
        cwd: string,
        logPath: string
    ): Promise<{ exitCode: number | null; timedOut: boolean; spawnError?: string }> {
        return new Promise((resolve) => {
            let fd: number;
            try {
                fd = fs.openSync(logPath, 'a');
            } catch (error: any) {
                resolve({ exitCode: null, timedOut: false, spawnError: `Could not open log file: ${error.message}` });
                return;
            }

            let settled = false;
            let timedOut = false;
            let timer: NodeJS.Timeout | undefined;

            const finish = (value: { exitCode: number | null; timedOut: boolean; spawnError?: string }) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                try {
                    fs.closeSync(fd);
                } catch {
                    // already closed
                }
                resolve(value);
            };

            let child: ChildProcess;
            try {
                child = spawn(gate.command, gate.args, {
                    cwd,
                    env: { ...process.env, ...gate.env },
                    // Own process group, so a timeout kills the whole tree (gradle,
                    // xcodebuild, emulator helpers) instead of leaving orphans.
                    detached: true,
                    stdio: ['ignore', fd, fd],
                });
            } catch (error: any) {
                finish({ exitCode: null, timedOut: false, spawnError: error.message });
                return;
            }

            timer = setTimeout(() => {
                timedOut = true;
                logger.warn({ gate: gate.name, timeoutMinutes: gate.timeoutMinutes }, 'Quality gate timed out; killing process group');
                this.killTree(child);
            }, gate.timeoutMinutes * 60 * 1000);

            child.on('error', (error) => {
                finish({ exitCode: null, timedOut, spawnError: error.message });
            });

            child.on('close', (code) => {
                finish({ exitCode: code, timedOut });
            });
        });
    }

    private killTree(child: ChildProcess): void {
        if (!child.pid) return;

        try {
            // Negative pid targets the whole process group created by `detached`.
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            try {
                child.kill('SIGKILL');
            } catch {
                // already gone
            }
        }
    }

    private logPathFor(worktreePath: string, gate: QualityGate): string {
        const issueDir = path.basename(worktreePath);
        const slug = gate.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return path.join(getWorktreeBase(this.config), '.gate-logs', issueDir, `${slug}.log`);
    }

    /**
     * Pull the useful failure lines out of a (potentially 100MB+) gate log.
     */
    private extractSignal(logPath: string, timedOut: boolean, timeoutMinutes: number): string {
        const text = this.readTail(logPath, 512 * 1024);
        const patterns = [
            /FAILED/i,
            /\berror:/i,
            /BUILD FAILED/i,
            /TEST FAILED/i,
            /XCTAssert/i,
            /AssertionFailure|Assertion failed/i,
            /tests? completed/i,
            /No connected devices/i,
            /Unable to find a destination/i,
            /not enough space|No space left/i,
        ];

        const hits = text
            .split('\n')
            .map((line) => line.trimEnd())
            // Skip the gate metadata header, which can itself contain the command.
            .filter((line) => line.length > 0 && !line.startsWith('#'))
            .filter((line) => patterns.some((pattern) => pattern.test(line)))
            .slice(-40);

        const body = (hits.length > 0
            ? hits
            : text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#')).slice(-25)
        )
            .join('\n')
            .trim();
        const prefix = timedOut ? `Gate timed out after ${timeoutMinutes} minutes.\n\n` : '';

        return `${prefix}${body.length > 6000 ? body.slice(-6000) : body}`;
    }

    private readTail(filePath: string, maxBytes: number): string {
        try {
            const stat = fs.statSync(filePath);
            const start = Math.max(0, stat.size - maxBytes);
            const fd = fs.openSync(filePath, 'r');
            try {
                const buffer = Buffer.alloc(stat.size - start);
                fs.readSync(fd, buffer, 0, buffer.length, start);
                return buffer.toString('utf-8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return '';
        }
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
                return `- ${icon} **${result.gate}** (${result.kind}, ${seconds}s)`;
            })
            .join('\n');
    }

    /**
     * Failure details for the issue comment: failing gate, signal lines, log and
     * report locations, without pasting an entire build log.
     */
    getFailureDetails(results: QualityResult[]): string {
        const failed = results.find((result) => !result.passed);
        if (!failed) return '';

        const sections: string[] = [`\n\n### Failing gate: ${failed.gate}`];

        sections.push(`\n- Log: \`${failed.logPath}\``);
        if (failed.reportPath) sections.push(`- Report: \`${failed.reportPath}\``);

        const signal = (failed.signal ?? '').trim();
        if (signal.length > 0) {
            sections.push(`\n\`\`\`\n${signal}\n\`\`\``);
        }

        return sections.join('');
    }
}
