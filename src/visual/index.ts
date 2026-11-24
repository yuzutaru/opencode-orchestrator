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
            const hookPayload = mapVisualEventToPixelHook(event);
            if (hookPayload) {
                await this.pixelAgentsClient.dispatch(hookPayload);
            }
        } catch (error) {
            logger.debug({ error }, 'Failed to dispatch visual hook');
        }
    }
}
