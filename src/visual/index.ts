import { visualEventBus } from '../events/bus.js';
import { VisualEvent } from '../events/types.js';
import { PixelAgentsClient } from './pixel-agents/client.js';
import { mapVisualEventToPixelHook } from './pixel-agents/mapper.js';
import { Config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('visual');

export class VisualManager {
    private pixelAgentsClient?: PixelAgentsClient;
    private initialized = false;

    constructor(private config: Config) {}

    init(): void {
        if (this.initialized) return;
        this.initialized = true;

        if (this.config.visual.pixelAgentsEnabled) {
            this.pixelAgentsClient = new PixelAgentsClient(this.config.visual.pixelAgentsUrl);
            const activeServers = this.pixelAgentsClient.findActiveServers();

            if (activeServers.length > 0) {
                logger.info(
                    { count: activeServers.length, ports: activeServers.map((s) => s.port) },
                    'Pixel Agents integration enabled; connected to active visual office'
                );
            } else {
                logger.info(
                    'Pixel Agents integration enabled (waiting for visual office on `npx pixel-agents`)'
                );
            }

            visualEventBus.onVisualEvent(async (event: VisualEvent) => {
                await this.handleVisualEvent(event);
            });
        }
    }

    private async handleVisualEvent(event: VisualEvent): Promise<void> {
        if (!this.pixelAgentsClient) return;

        try {
            // Resolve the model driving this task: explicit config override,
            // otherwise fall back to the default model for the active agent.
            const model = this.config.opencode.model ?? resolveAgentDefaultModel(this.config.opencode.agent);

            const hookPayload = mapVisualEventToPixelHook(event, model);
            if (hookPayload) {
                await this.pixelAgentsClient.dispatch(hookPayload);
            }
        } catch (error) {
            logger.debug({ error }, 'Failed to dispatch visual hook');
        }
    }
}

/**
 * Fallback model for each agent type when `opencode.model` is not set.
 * Mirrors the per-agent model defaults declared in opencode.json.
 */
function resolveAgentDefaultModel(agent: string): string | undefined {
    const defaults: Record<string, string> = {
        build: 'opencode/nemotron-3.5-super-vl-free',
        plan: 'opencode/mimo-v2.6-flash-free',
        ask: 'opencode/nemotron-3.5-lightning-free',
        title: 'deepseek/deepseek-flash',
        summary: 'deepseek/deepseek-flash',
    };
    return defaults[agent] ?? undefined;
}
