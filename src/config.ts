import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load environment variables
dotenv.config();

/**
 * Repository root of the orchestrator itself (`dist/` at runtime, `src/` under
 * tsx). Used to locate the quality-gate scripts that must stay outside the
 * repository under test.
 */
const orchestratorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Configuration schema with validation
 *
 * Identity model:
 *   github.username  = the bot account (quintonflyn). Comments from this login are
 *                      treated as machine output, everything else is a human reply.
 *   The reviewer (yuzutaru) approves the pull requests the orchestrator opens.
 */
const configSchema = z.object({
    // GitHub
    github: z.object({
        token: z.string().min(1, 'GITHUB_TOKEN is required'),
        repo: z.string().regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPO must be in owner/repo format'),
        username: z.string().min(1, 'GITHUB_USERNAME is required (the bot account)'),
    }),

    // Scheduler
    scheduler: z.object({
        pollIntervalMs: z.number().min(10000).default(300000),
        maxConcurrentTasks: z.number().min(1).max(10).default(1),
    }),

    // OpenCode (V2 CLI driven headlessly)
    opencode: z.object({
        bin: z.string().default('opencode'),
        agent: z.string().default('build'),
        model: z.string().optional(),
        projectPath: z.string().min(1, 'PROJECT_PATH is required'),
        worktreeDir: z.string().default('../levela-worktrees'),
        taskTimeoutMinutes: z.number().min(5).max(300).default(90),
    }),

    // Quality gates
    quality: z.object({
        enforceGates: z.boolean().default(true),
        /** Timeout for the cheap unit-test gates. */
        timeoutMinutes: z.number().min(1).max(120).default(30),
        /** Timeout for the device-backed UI/instrumented gates. */
        uiTimeoutMinutes: z.number().min(1).max(180).default(45),
        /** Timeout for the shared-contract parity scripts. */
        contractTimeoutMinutes: z.number().min(1).max(60).default(10),
        /** Run Android instrumented tests when `android/` changed. */
        androidUiTests: z.boolean().default(true),
        /** Run iOS UI tests when `ios/` changed. */
        iosUiTests: z.boolean().default(true),
        /** Refuse to start a device gate with less free space than this. */
        minFreeGb: z.number().min(0).max(500).default(10),
        /** AVD name used by the Android instrumented gate. */
        avd: z.string().default('Pixel_10a'),
        /** Simulator device name used by the iOS gates. */
        iosDevice: z.string().default('iPhone 18 Pro'),
        /** Directory holding the gate lifecycle scripts (outside the tested repo). */
        gateScriptsDir: z.string().default(path.join(orchestratorRoot, 'scripts', 'gates')),
    }),

    // Task state
    taskState: z.object({
        worktreeRetentionDays: z.number().min(1).max(90).default(7),
        autoCleanWorktrees: z.boolean().default(false),
    }),

    // Logging
    logging: z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse boolean from environment variable
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true';
}

/**
 * Parse number from environment variable
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Load and validate configuration from environment
 */
export function loadConfig(): Config {
    const rawConfig = {
        github: {
            token: process.env.GITHUB_TOKEN || '',
            repo: process.env.GITHUB_REPO || '',
            username: process.env.GITHUB_USERNAME || '',
        },
        scheduler: {
            pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 300000),
            maxConcurrentTasks: parseNumber(process.env.MAX_CONCURRENT_TASKS, 1),
        },
        opencode: {
            bin: process.env.OPENCODE_BIN || 'opencode',
            agent: process.env.OPENCODE_AGENT || 'build',
            model: process.env.OPENCODE_MODEL || undefined,
            projectPath: process.env.PROJECT_PATH || '',
            worktreeDir: process.env.WORKTREE_DIR || '../levela-worktrees',
            taskTimeoutMinutes: parseNumber(process.env.TASK_TIMEOUT_MINUTES, 90),
        },
        quality: {
            enforceGates: parseBoolean(process.env.ENFORCE_QUALITY_GATES, true),
            timeoutMinutes: parseNumber(process.env.QUALITY_TIMEOUT_MINUTES, 30),
            uiTimeoutMinutes: parseNumber(process.env.QUALITY_UI_TIMEOUT_MINUTES, 45),
            contractTimeoutMinutes: parseNumber(process.env.QUALITY_CONTRACT_TIMEOUT_MINUTES, 10),
            androidUiTests: parseBoolean(process.env.QUALITY_ANDROID_UI_TESTS, true),
            iosUiTests: parseBoolean(process.env.QUALITY_IOS_UI_TESTS, true),
            minFreeGb: parseNumber(process.env.QUALITY_MIN_FREE_GB, 10),
            avd: process.env.LEVELA_AVD || 'Pixel_10a',
            iosDevice: process.env.LEVELA_IOS_DEVICE || 'iPhone 18 Pro',
            gateScriptsDir: process.env.QUALITY_GATE_SCRIPTS_DIR || path.join(orchestratorRoot, 'scripts', 'gates'),
        },
        taskState: {
            worktreeRetentionDays: parseNumber(process.env.WORKTREE_RETENTION_DAYS, 7),
            autoCleanWorktrees: parseBoolean(process.env.AUTO_CLEAN_WORKTREES, false),
        },
        logging: {
            level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
        },
    };

    const result = configSchema.safeParse(rawConfig);

    if (!result.success) {
        console.error('Configuration validation failed:');
        result.error.errors.forEach((err) => {
            console.error(`  - ${err.path.join('.')}: ${err.message}`);
        });
        process.exit(1);
    }

    return result.data;
}

/**
 * Get parsed repository owner and name
 */
export function getRepoInfo(config: Config): { owner: string; repo: string } {
    const [owner, repo] = config.github.repo.split('/');
    return { owner, repo };
}

/**
 * Directory holding every issue worktree.
 *
 * `WORKTREE_DIR` may be relative to PROJECT_PATH (`../levela-worktrees`) or absolute.
 */
export function getWorktreeBase(config: Config): string {
    return path.isAbsolute(config.opencode.worktreeDir)
        ? config.opencode.worktreeDir
        : path.join(config.opencode.projectPath, config.opencode.worktreeDir);
}

/**
 * Get worktree path for an issue.
 */
export function getWorktreePath(config: Config, issueNumber: number): string {
    return path.join(getWorktreeBase(config), `issue-${issueNumber}`);
}

/**
 * Get branch name for an issue
 */
export function getBranchName(issueNumber: number, slug: string): string {
    return `ai/issue-${issueNumber}-${slug}`;
}
