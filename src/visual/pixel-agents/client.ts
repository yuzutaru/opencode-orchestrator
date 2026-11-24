import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PixelAgentHookPayload, PixelAgentServerInfo } from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('pixel-agents-client');

export class PixelAgentsClient {
    private explicitUrl?: string;

    constructor(explicitUrl?: string) {
        this.explicitUrl = explicitUrl;
    }

    /**
     * Find all active Pixel Agents servers.
     * Looks in:
     * 1. explicitUrl from config / env
     * 2. ~/.pixel-agents/servers/*.json
     * 3. ~/.pixel-agents/server.json
     */
    findActiveServers(): PixelAgentServerInfo[] {
        if (this.explicitUrl) {
            try {
                const parsed = new URL(this.explicitUrl);
                return [
                    {
                        port: Number(parsed.port) || 3000,
                        source: `explicit (${this.explicitUrl})`,
                    },
                ];
            } catch {
                logger.warn({ url: this.explicitUrl }, 'Invalid explicit Pixel Agents URL');
            }
        }

        const servers: PixelAgentServerInfo[] = [];
        const homeDir = os.homedir();
        const configDir = path.join(homeDir, '.pixel-agents');

        if (!fs.existsSync(configDir)) {
            return servers;
        }

        // Check single server.json
        const singleServerFile = path.join(configDir, 'server.json');
        if (fs.existsSync(singleServerFile)) {
            const info = this.parseServerFile(singleServerFile);
            if (info) servers.push(info);
        }

        // Check servers/ directory
        const serversDir = path.join(configDir, 'servers');
        if (fs.existsSync(serversDir)) {
            try {
                const entries = fs.readdirSync(serversDir);
                for (const entry of entries) {
                    if (entry.endsWith('.json')) {
                        const filePath = path.join(serversDir, entry);
                        const info = this.parseServerFile(filePath);
                        if (info) servers.push(info);
                    }
                }
            } catch (err) {
                logger.debug({ err }, 'Could not read servers directory');
            }
        }

        return servers;
    }

    private parseServerFile(filePath: string): PixelAgentServerInfo | null {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (!data.port || typeof data.port !== 'number') return null;

            // If PID is provided, check if the process is still running
            if (data.pid && typeof data.pid === 'number') {
                try {
                    process.kill(data.pid, 0);
                } catch {
                    // Process is not running; ignore stale descriptor
                    return null;
                }
            }

            return {
                port: data.port,
                pid: data.pid,
                authToken: data.authToken,
                source: filePath,
            };
        } catch {
            return null;
        }
    }

    /**
     * Dispatch payload to all active Pixel Agents servers.
     * Silently swallows connection errors so orchestrator is never blocked.
     */
    async dispatch(payload: PixelAgentHookPayload): Promise<void> {
        const servers = this.findActiveServers();
        if (servers.length === 0) {
            return;
        }

        const body = JSON.stringify(payload);

        await Promise.allSettled(
            servers.map(async (server) => {
                const endpoints = [
                    `http://localhost:${server.port}/api/hooks/claude`,
                    `http://localhost:${server.port}/api/hooks/opencode`,
                ];

                for (const url of endpoints) {
                    try {
                        const headers: Record<string, string> = {
                            'Content-Type': 'application/json',
                        };
                        if (server.authToken) {
                            headers['Authorization'] = `Bearer ${server.authToken}`;
                        }

                        const controller = new AbortController();
                        const timer = setTimeout(() => controller.abort(), 2000);

                        const res = await fetch(url, {
                            method: 'POST',
                            headers,
                            body,
                            signal: controller.signal,
                        }).finally(() => clearTimeout(timer));

                        if (res.ok) {
                            logger.debug({ port: server.port, hook: payload.hook_event_name }, 'Hook dispatched');
                            return;
                        }
                    } catch {
                        // Silent fallback - server might not have the specific provider route or is shutting down
                    }
                }
            })
        );
    }
}
