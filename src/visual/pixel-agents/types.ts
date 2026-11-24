export type PixelAgentHookName =
    | 'SessionStart'
    | 'PreToolUse'
    | 'PostToolUse'
    | 'PermissionRequest'
    | 'Notification'
    | 'Stop';

export interface PixelAgentHookPayload {
    hook_event_name: PixelAgentHookName;
    session_id: string;
    tool_name?: string;
    tool_input?: unknown;
    cwd?: string;
    message?: string;
    issue_number?: number;
    title?: string;
    timestamp?: number;
}

export interface PixelAgentServerInfo {
    port: number;
    pid?: number;
    authToken?: string;
    source: string;
}
