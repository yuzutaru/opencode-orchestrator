import { EventEmitter } from 'node:events';
import {
    TaskLifecycleEvent,
    AgentActionEvent,
    AgentSpeechEvent,
    VisualEvent,
} from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('event-bus');

class VisualEventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(20);
    }

    emitTaskLifecycle(event: TaskLifecycleEvent): void {
        this.safeEmit('task:lifecycle', event);
        this.safeEmit('visual:event', event);
    }

    emitAgentAction(event: AgentActionEvent): void {
        this.safeEmit('agent:tool_use', event);
        this.safeEmit('visual:event', event);
    }

    emitAgentSpeech(event: AgentSpeechEvent): void {
        this.safeEmit('agent:text', event);
        this.safeEmit('visual:event', event);
    }

    onTaskLifecycle(handler: (event: TaskLifecycleEvent) => void | Promise<void>): void {
        this.on('task:lifecycle', handler);
    }

    onAgentAction(handler: (event: AgentActionEvent) => void | Promise<void>): void {
        this.on('agent:tool_use', handler);
    }

    onAgentSpeech(handler: (event: AgentSpeechEvent) => void | Promise<void>): void {
        this.on('agent:text', handler);
    }

    onVisualEvent(handler: (event: VisualEvent) => void | Promise<void>): void {
        this.on('visual:event', handler);
    }

    private safeEmit(eventName: string, data: unknown): void {
        try {
            this.emit(eventName, data);
        } catch (error) {
            logger.warn({ eventName, error }, 'Error in event bus emission');
        }
    }
}

export const visualEventBus = new VisualEventBus();
