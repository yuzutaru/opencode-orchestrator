import {
    TaskLifecycleEvent,
    AgentActionEvent,
    AgentSpeechEvent,
    VisualEvent,
    categorizeTool,
} from '../../events/types.js';
import { PixelAgentHookPayload } from './types.js';

export function mapVisualEventToPixelHook(event: VisualEvent, model?: string): PixelAgentHookPayload | null {
    const sessionId = `issue-${event.issueNumber}`;

    switch (event.type) {
        case 'task:lifecycle':
            return mapLifecycleEvent(event, sessionId, model);

        case 'agent:tool_use':
            return mapToolUseEvent(event, sessionId, model);

        case 'agent:text':
            return {
                hook_event_name: 'Notification',
                session_id: sessionId,
                model,
                message: event.text.slice(0, 150),
                issue_number: event.issueNumber,
                timestamp: event.timestamp,
            };

        default:
            return null;
    }
}

function mapLifecycleEvent(event: TaskLifecycleEvent, sessionId: string, model?: string): PixelAgentHookPayload {
    switch (event.phase) {
        case 'starting':
            return {
                hook_event_name: 'SessionStart',
                session_id: sessionId,
                model,
                issue_number: event.issueNumber,
                title: event.issueTitle,
                cwd: event.worktreePath,
                message: `Starting task #${event.issueNumber}: ${event.issueTitle}`,
                timestamp: event.timestamp,
            };

        case 'planning':
            return {
                hook_event_name: 'PreToolUse',
                session_id: sessionId,
                model,
                tool_name: 'Read',
                tool_input: { summary: `Planning implementation for #${event.issueNumber}` },
                issue_number: event.issueNumber,
                message: `Planning implementation for #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'working':
            return {
                hook_event_name: 'PreToolUse',
                session_id: sessionId,
                model,
                tool_name: 'Edit',
                tool_input: { branch: event.branchName },
                issue_number: event.issueNumber,
                message: `Working on #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'blocked':
            return {
                hook_event_name: 'PermissionRequest',
                session_id: sessionId,
                model,
                issue_number: event.issueNumber,
                message: event.details || `Waiting for user review/approval on #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'verifying':
            return {
                hook_event_name: 'PreToolUse',
                session_id: sessionId,
                model,
                tool_name: 'Bash',
                tool_input: { command: 'Quality Gate Verification' },
                issue_number: event.issueNumber,
                message: `Running verification & test gates on #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'delivering':
            return {
                hook_event_name: 'Notification',
                session_id: sessionId,
                model,
                issue_number: event.issueNumber,
                message: `Delivering pull request for #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'review-ready':
            return {
                hook_event_name: 'Notification',
                session_id: sessionId,
                model,
                issue_number: event.issueNumber,
                message: `Pull request ready for review on #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'completed':
            return {
                hook_event_name: 'Stop',
                session_id: sessionId,
                model,
                issue_number: event.issueNumber,
                message: `Completed task #${event.issueNumber}`,
                timestamp: event.timestamp,
            };

        case 'failed':
            return {
                hook_event_name: 'Stop',
                session_id: sessionId,
                model,
                issue_number: event.issueNumber,
                message: `Failed task #${event.issueNumber}: ${event.details || 'unknown error'}`,
                timestamp: event.timestamp,
            };
    }
}

function mapToolUseEvent(event: AgentActionEvent, sessionId: string, model?: string): PixelAgentHookPayload {
    let toolName: string;

    switch (event.category) {
        case 'editing':
            toolName = 'Edit';
            break;
        case 'reading':
            toolName = 'View';
            break;
        case 'executing':
            toolName = 'Bash';
            break;
        case 'thinking':
        default:
            toolName = event.tool || 'Agent';
            break;
    }

    return {
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        model,
        tool_name: toolName,
        tool_input: event.input || { summary: event.summary },
        issue_number: event.issueNumber,
        message: event.summary,
        timestamp: event.timestamp,
    };
}
