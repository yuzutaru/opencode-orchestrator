export type TaskPhase =
    | 'starting'
    | 'planning'
    | 'working'
    | 'blocked'
    | 'verifying'
    | 'delivering'
    | 'review-ready'
    | 'completed'
    | 'failed';

export type ToolActionCategory = 'editing' | 'reading' | 'executing' | 'thinking';

/**
 * Map an OpenCode (or any agent) tool name to a normalized activity category.
 * Pure function with no dependency on any specific visual backend, so the
 * orchestrator core stays agent-agnostic.
 */
export function categorizeTool(toolName: string): ToolActionCategory {
    const lower = toolName.toLowerCase();

    if (
        lower.includes('write') ||
        lower.includes('edit') ||
        lower.includes('replace') ||
        lower.includes('create') ||
        lower.includes('append') ||
        lower.includes('patch')
    ) {
        return 'editing';
    }

    if (
        lower.includes('read') ||
        lower.includes('view') ||
        lower.includes('cat') ||
        lower.includes('grep') ||
        lower.includes('glob') ||
        lower.includes('find') ||
        lower.includes('list')
    ) {
        return 'reading';
    }

    if (
        lower.includes('bash') ||
        lower.includes('exec') ||
        lower.includes('command') ||
        lower.includes('terminal') ||
        lower.includes('run') ||
        lower.includes('test')
    ) {
        return 'executing';
    }

    return 'thinking';
}

export interface TaskLifecycleEvent {
    type: 'task:lifecycle';
    issueNumber: number;
    issueTitle: string;
    branchName?: string;
    worktreePath?: string;
    sessionId?: string;
    phase: TaskPhase;
    details?: string;
    timestamp: number;
}

export interface AgentActionEvent {
    type: 'agent:tool_use';
    issueNumber: number;
    sessionId?: string;
    tool: string;
    category: ToolActionCategory;
    summary: string;
    input?: unknown;
    timestamp: number;
}

export interface AgentSpeechEvent {
    type: 'agent:text';
    issueNumber: number;
    sessionId?: string;
    text: string;
    timestamp: number;
}

export type VisualEvent = TaskLifecycleEvent | AgentActionEvent | AgentSpeechEvent;
