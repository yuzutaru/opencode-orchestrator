import { spawn, ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { Config } from '../config.js';
import { Issue } from '../github/client.js';
import { createLogger } from '../utils/logger.js';
import { botGitEnv } from '../utils/git.js';
import {
    generateOrchestratorPrompt,
    generatePlanPrompt,
    generateApprovalPrompt,
    generatePlanFeedbackPrompt,
} from '../prompts/orchestrator.js';

const logger = createLogger('opencode');

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/**
 * Outcome of one `opencode run` invocation.
 */
export interface RunResult {
    issueNumber: number;
    exitCode: number | null;
    sessionId?: string;
    lastText: string;
    costUsd: number;
    durationMs: number;
    timedOut: boolean;
    killed: boolean;
    stderr: string;
}

export type TaskCompleteHandler = (result: RunResult) => void | Promise<void>;

interface RunningTask {
    issueNumber: number;
    child: ChildProcessByStdio<null, Readable, Readable>;
    startedAt: number;
    timer?: NodeJS.Timeout;
    result: RunResult;
}

/**
 * Runs OpenCode V2 missions headlessly.
 *
 * Uses the V2 CLI (`opencode run --format json`) against the shared background
 * service instead of the removed V1 server API (`/session`, `/event`, ...).
 * Every JSON line carries the session ID, so a blocked mission can be resumed
 * with `-s <id>`.
 */
export class OpenCodeManager {
    private tasks = new Map<number, RunningTask>();

    constructor(
        private config: Config,
        private onComplete: TaskCompleteHandler
    ) {}

    isRunning(issueNumber: number): boolean {
        return this.tasks.has(issueNumber);
    }

    getSessionId(issueNumber: number): string | undefined {
        return this.tasks.get(issueNumber)?.result.sessionId;
    }

    /**
     * Start a mission for a new issue.
     */
    async startTask(issue: Issue, worktreePath: string, branchName: string): Promise<RunResult['sessionId']> {
        const prompt = generateOrchestratorPrompt(this.config, issue, worktreePath, branchName);
        const title = `Issue #${issue.number}: ${issue.title}`.substring(0, 80);
        return this.spawnRun(issue.number, worktreePath, prompt, undefined, title);
    }

    /**
     * Start a plan-only mission for a new issue.
     *
     * The agent explores and writes a plan, posts it via `gh issue comment`,
     * swaps `ai-task` -> `ai-plan-pending`, and ends its turn. No file changes.
     */
    async startPlan(issue: Issue, worktreePath: string, branchName: string): Promise<RunResult['sessionId']> {
        const prompt = generatePlanPrompt(this.config, issue, worktreePath, branchName);
        const title = `Plan issue #${issue.number}: ${issue.title}`.substring(0, 80);
        return this.spawnRun(issue.number, worktreePath, prompt, undefined, title);
    }

    /**
     * Resume a blocked mission with the human's reply.
     *
     * @param options.phase - 'implement' (plan was approved), 'feedback' (plan
     *   needs revision), or 'plan' (restart planning). Defaults to 'implement'.
     */
    async continueTask(
        issue: Issue,
        worktreePath: string,
        previousSessionId: string,
        newComment: string,
        options: { phase?: 'implement' | 'feedback' | 'plan'; branchName?: string } = {},
    ): Promise<RunResult['sessionId']> {
        if (!previousSessionId) {
            throw new Error(`No previous session for issue #${issue.number}; cannot continue`);
        }

        const branchName = options.branchName;
        let prompt: string;
        switch (options.phase) {
            case 'feedback':
                if (!branchName) {
                    throw new Error(`branchName is required to continue a plan-feedback mission for issue #${issue.number}`);
                }
                prompt = generatePlanFeedbackPrompt(
                    this.config,
                    issue,
                    worktreePath,
                    branchName,
                    newComment,
                );
                break;
            case 'plan':
                if (!branchName) {
                    throw new Error(`branchName is required to continue a plan mission for issue #${issue.number}`);
                }
                prompt = generatePlanPrompt(this.config, issue, worktreePath, branchName);
                break;
            case 'implement':
                prompt = generateApprovalPrompt(this.config, issue, worktreePath, branchName ?? '');
                break;
            default:
                // No phase specified: the existing ai-blocked clarification
                // resume path. Use the standard implementation prompt.
                prompt = generateOrchestratorPrompt(this.config, issue, worktreePath, branchName ?? '');
                break;
        }

        return this.spawnRun(issue.number, worktreePath, prompt, previousSessionId);
    }

    /**
     * Stop a running mission.
     */
    killTask(issueNumber: number): void {
        const task = this.tasks.get(issueNumber);
        if (!task) return;

        logger.warn({ issueNumber }, 'Stopping OpenCode mission');
        task.result.killed = true;
        task.child.kill('SIGTERM');
    }

    /**
     * Stop every running mission (used on shutdown).
     */
    killAll(): void {
        for (const issueNumber of this.tasks.keys()) {
            this.killTask(issueNumber);
        }
    }

    private spawnRun(
        issueNumber: number,
        cwd: string,
        prompt: string,
        sessionId?: string,
        title?: string
    ): string | undefined {
        if (this.tasks.has(issueNumber)) {
            throw new Error(`Issue #${issueNumber} already has a running mission`);
        }

        const args = ['run', '--auto', '--archived', '--format', 'json', '--agent', this.config.opencode.agent];

        if (this.config.opencode.model) {
            args.push('--model', this.config.opencode.model);
        }

        if (sessionId) {
            args.push('-s', sessionId);
        } else if (title) {
            args.push('--title', title);
        }

        args.push(prompt);

        logger.info({ issueNumber, cwd, agent: this.config.opencode.agent, model: this.config.opencode.model ?? '(default)', sessionId }, 'Starting OpenCode mission');

        const child = spawn(this.config.opencode.bin, args, {
            cwd,
            env: botGitEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const task: RunningTask = {
            issueNumber,
            child,
            startedAt: Date.now(),
            result: {
                issueNumber,
                exitCode: null,
                sessionId,
                lastText: '',
                costUsd: 0,
                durationMs: 0,
                timedOut: false,
                killed: false,
                stderr: '',
            },
        };

        this.tasks.set(issueNumber, task);

        const timeoutMs = this.config.opencode.taskTimeoutMinutes * 60 * 1000;
        task.timer = setTimeout(() => {
            logger.error({ issueNumber, timeoutMinutes: this.config.opencode.taskTimeoutMinutes }, 'Mission timed out, terminating');
            task.result.timedOut = true;
            task.child.kill('SIGTERM');
            setTimeout(() => task.child.kill('SIGKILL'), 10_000).unref();
        }, timeoutMs);
        task.timer.unref();

        const stdout = createInterface({ input: child.stdout });
        stdout.on('line', (line) => this.handleLine(task, line));
        stdout.on('close', () => undefined);

        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            task.result.stderr = (task.result.stderr + text).slice(-16_000);
            logger.debug({ issueNumber, stderr: text.trim().slice(0, 400) }, 'opencode stderr');
        });

        child.on('error', (error) => {
            task.result.stderr += `\nspawn error: ${error.message}`;
            logger.error({ issueNumber, error }, 'Failed to spawn opencode');
        });

        child.on('close', (code) => this.finish(task, code));

        return sessionId;
    }

    /**
     * Parse one JSONL event from `--format json`.
     */
    private handleLine(task: RunningTask, line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: any;
        try {
            event = JSON.parse(trimmed);
        } catch {
            logger.debug({ issueNumber: task.issueNumber, line: trimmed.slice(0, 400) }, 'Non-JSON output from opencode');
            return;
        }

        if (event.sessionID) task.result.sessionId = event.sessionID;

        switch (event.type) {
            case 'text': {
                const text = event.part?.text;
                if (typeof text === 'string' && text.length > 0) {
                    task.result.lastText = text;
                    logger.debug({ issueNumber: task.issueNumber, text }, 'Assistant text');
                }
                break;
            }
            case 'tool_use': {
                const part = event.part ?? {};
                const tool = part.tool ?? 'unknown';
                const detail = part.state?.title ?? part.state?.input?.path ?? part.state?.input?.command ?? '';
                const summary = typeof detail === 'string' ? detail.replace(/\s+/g, ' ').slice(0, 120) : '';
                console.log(`${DIM}#${task.issueNumber}${RESET} ${CYAN}${tool}${RESET} ${DIM}${summary}${RESET}`);
                break;
            }
            case 'step_finish': {
                const cost = event.part?.cost;
                if (typeof cost === 'number') {
                    task.result.costUsd += cost;
                    logger.debug({ issueNumber: task.issueNumber, stepCost: cost }, 'Step finished');
                }
                break;
            }
            case 'error': {
                logger.error({ issueNumber: task.issueNumber, event }, 'OpenCode error event');
                break;
            }
            default:
                logger.debug({ issueNumber: task.issueNumber, type: event.type }, 'Event');
        }
    }

    private finish(task: RunningTask, code: number | null): void {
        if (task.timer) clearTimeout(task.timer);

        task.result.exitCode = code;
        task.result.durationMs = Date.now() - task.startedAt;

        this.tasks.delete(task.issueNumber);

        const { result } = task;
        const minutes = (result.durationMs / 60_000).toFixed(1);
        const line = `#${result.issueNumber} exit=${code ?? 'null'} duration=${minutes}m cost=$${result.costUsd.toFixed(4)}`;

        if (result.killed) {
            logger.warn({ ...result }, `Mission killed ${line}`);
        } else if (result.timedOut) {
            logger.error({ ...result }, `Mission timed out ${line}`);
        } else if (code === 0) {
            console.log(`${GREEN}✓ mission finished${RESET} ${line}`);
        } else {
            console.log(`${RED}✗ mission failed${RESET} ${line}`);
        }

        Promise.resolve()
            .then(() => this.onComplete(result))
            .catch((error) => {
                logger.error({ issueNumber: result.issueNumber, error }, 'Task completion handler failed');
            });
    }
}
