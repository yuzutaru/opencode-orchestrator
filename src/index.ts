import cron from 'node-cron';
import process from 'node:process';
import { loadConfig, Config } from './config.js';
import { GitHubClient } from './github/client.js';
import { Labels, isReadyForPickup } from './github/labels.js';
import { TaskManager } from './tasks/manager.js';
import { WorktreeManager } from './tasks/worktree.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('orchestrator');

/**
 * Polls GitHub for `ai-task` issues and runs them through the local pipeline:
 * worktree -> OpenCode mission -> quality gates -> draft PR.
 */
class GitHubTaskOrchestrator {
    private config: Config;
    private github: GitHubClient;
    private taskManager: TaskManager;
    private worktrees: WorktreeManager;
    private isShuttingDown = false;

    constructor() {
        this.config = loadConfig();
        this.github = new GitHubClient(this.config);
        this.taskManager = new TaskManager(this.config);
        this.worktrees = new WorktreeManager(this.config);
    }

    async start(): Promise<void> {
        const configDir = process.env.CONFIG_DIR || '.';
        const projectName = configDir.split('/').pop() || this.config.github.repo.split('/').pop() || 'default';

        logger.info('Starting OpenCode GitHub Task Orchestrator (V2 CLI transport)');
        logger.info({
            project: projectName,
            configDir: process.env.CONFIG_DIR || '(root .env)',
            repo: this.config.github.repo,
            projectPath: this.config.opencode.projectPath,
            worktrees: this.config.opencode.worktreeDir,
            agent: this.config.opencode.agent,
            model: this.config.opencode.model ?? '(agent default)',
            pollInterval: this.config.scheduler.pollIntervalMs,
            maxConcurrent: this.config.scheduler.maxConcurrentTasks,
            gates: {
                androidUi: this.config.quality.androidUiTests,
                iosUi: this.config.quality.iosUiTests,
                unitTimeout: this.config.quality.timeoutMinutes,
                uiTimeout: this.config.quality.uiTimeoutMinutes,
                minFreeGb: this.config.quality.minFreeGb,
                avd: this.config.quality.avd,
                iosDevice: this.config.quality.iosDevice,
            },
        }, 'Configuration loaded');

        this.setupShutdownHandlers();

        logger.info('Running initial poll...');
        await this.poll();
        logger.info('Initial poll completed');

        const intervalMs = this.config.scheduler.pollIntervalMs;
        const intervalMinutes = Math.max(1, Math.ceil(intervalMs / 60000));
        const cronExpression = intervalMinutes <= 1
            ? '* * * * *'
            : `*/${intervalMinutes} * * * *`;

        cron.schedule(cronExpression, async () => {
            if (!this.isShuttingDown) {
                await this.poll();
            }
        });

        logger.info({ cronExpression }, 'Scheduler started');

        console.log('\n╔════════════════════════════════════════════════════════════════╗');
        console.log('║  ✅ Orchestrator running                                       ║');
        console.log('╠════════════════════════════════════════════════════════════════╣');
        console.log(`║  📦 Repo:    ${this.config.github.repo.padEnd(48)} ║`);
        console.log(`║  📂 Path:    ${this.config.opencode.projectPath.substring(0, 48).padEnd(48)} ║`);
        console.log(`║  🌳 Trees:   ${this.config.opencode.worktreeDir.substring(0, 48).padEnd(48)} ║`);
        console.log(`║  ⏱️  Poll:    Every ${intervalMinutes} min${intervalMinutes !== 1 ? 's' : ' '}${''.padEnd(37)} ║`);
        console.log(`║  🔢 Tasks:   Max ${this.config.scheduler.maxConcurrentTasks} concurrent${''.padEnd(38)} ║`);
        console.log('╠════════════════════════════════════════════════════════════════╣');
        console.log('║  Press Ctrl+C to stop                                          ║');
        console.log('╚════════════════════════════════════════════════════════════════╝\n');

        logger.info('Orchestrator is running and waiting for tasks');
    }

    private async poll(): Promise<void> {
        logger.debug('Polling GitHub for tasks...');

        try {
            await this.checkNewTasks();
            await this.checkBlockedTasks();
            await this.worktrees.cleanOldWorktrees();
        } catch (error) {
            logger.error({ error }, 'Error during poll');
        }
    }

    private async checkNewTasks(): Promise<void> {
        if (!this.taskManager.canStartNewTask()) {
            logger.debug({
                active: this.taskManager.getActiveCount(),
                max: this.config.scheduler.maxConcurrentTasks,
            }, 'At max concurrent tasks');
            return;
        }

        const issues = await this.github.getIssuesWithLabel(Labels.AI_TASK, [Labels.AI_IN_PROGRESS]);

        if (issues.length === 0) {
            logger.debug('No new tasks found');
            return;
        }

        for (const issue of this.github.sortByPriority(issues)) {
            if (!this.taskManager.canStartNewTask()) break;
            if (!isReadyForPickup(issue)) continue;
            if (this.taskManager.isRunning(issue.number)) continue;

            try {
                await this.taskManager.startTask(issue);
                logger.info({ issueNumber: issue.number, title: issue.title }, 'Started task');
            } catch (error: any) {
                logger.error({ issueNumber: issue.number, error: error.message }, 'Failed to start task');
            }
        }
    }

    private async checkBlockedTasks(): Promise<void> {
        const blockedIssues = await this.github.getIssuesWithLabel(Labels.AI_BLOCKED);

        for (const issue of blockedIssues) {
            if (this.taskManager.isRunning(issue.number)) continue;

            // Only resume when a human replied after the agent asked its question.
            const since = this.taskManager.getBlockedSince(issue);
            if (!this.github.hasNewComments(issue, since)) continue;

            try {
                await this.taskManager.continueBlockedTask(issue);
                logger.info({ issueNumber: issue.number }, 'Resumed blocked task');
            } catch (error: any) {
                logger.error({ issueNumber: issue.number, error: error.message }, 'Failed to resume task');
            }
        }
    }

    private setupShutdownHandlers(): void {
        const shutdown = (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            logger.info({ signal }, 'Received shutdown signal');
            this.taskManager.shutdown();
            logger.info('Shutdown complete');
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
}

async function main(): Promise<void> {
    try {
        const configDir = process.env.CONFIG_DIR;
        const projectInfo = configDir ? ` [${configDir.split('/').pop()}]` : '';

        console.log(`🚀 Starting OpenCode GitHub Orchestrator${projectInfo}...`);
        const orchestrator = new GitHubTaskOrchestrator();
        await orchestrator.start();
    } catch (error) {
        console.error('❌ Failed to start orchestrator:', error);
        logger.error({ error }, 'Failed to start orchestrator');
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
});
