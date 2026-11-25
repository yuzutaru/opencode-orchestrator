import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { visualEventBus } from '../src/events/bus.js';
import {
    categorizeTool,
    TaskLifecycleEvent,
    VisualEvent,
} from '../src/events/types.js';
import { mapVisualEventToPixelHook } from '../src/visual/pixel-agents/mapper.js';
import { PixelAgentsClient } from '../src/visual/pixel-agents/client.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.error(`  ✗ ${name}: ${(error as Error).message}`);
    }
}

/* ------------------------------------------------------------------ */
/* 1. categorizeTool                                                  */
/* ------------------------------------------------------------------ */

console.log('categorizeTool:');
check('write_file -> editing', () => {
    assert.strictEqual(categorizeTool('write_file'), 'editing');
});
check('edit_file -> editing', () => {
    assert.strictEqual(categorizeTool('edit_file'), 'editing');
});
check('str_replace -> editing', () => {
    assert.strictEqual(categorizeTool('str_replace'), 'editing');
});
check('read_file -> reading', () => {
    assert.strictEqual(categorizeTool('read_file'), 'reading');
});
check('grep -> reading', () => {
    assert.strictEqual(categorizeTool('grep'), 'reading');
});
check('glob -> reading', () => {
    assert.strictEqual(categorizeTool('glob'), 'reading');
});
check('bash -> executing', () => {
    assert.strictEqual(categorizeTool('bash'), 'executing');
});
check('npm test -> executing', () => {
    assert.strictEqual(categorizeTool('npm test'), 'executing');
});
check('unknown -> thinking', () => {
    assert.strictEqual(categorizeTool('xyzzy'), 'thinking');
});

/* ------------------------------------------------------------------ */
/* 2. mapVisualEventToPixelHook                                       */
/* ------------------------------------------------------------------ */

const base: VisualEvent = {
    type: 'task:lifecycle',
    issueNumber: 42,
    issueTitle: 'Fix the thing',
    sessionId: 'sess-1',
    timestamp: 1_000_000,
};

console.log('\nmapVisualEventToPixelHook:');

check('starting -> SessionStart', () => {
    const payload = mapVisualEventToPixelHook({
        ...base,
        phase: 'starting',
        worktreePath: '/tmp/wt',
    } as TaskLifecycleEvent);
    assert.strictEqual(payload?.hook_event_name, 'SessionStart');
    assert.strictEqual(payload?.session_id, 'issue-42');
    assert.strictEqual(payload?.issue_number, 42);
    assert.strictEqual(payload?.title, 'Fix the thing');
});

check('session id stable across starting->planning->working', () => {
    const starting = mapVisualEventToPixelHook({
        ...base,
        phase: 'starting',
        worktreePath: '/tmp/wt',
    } as TaskLifecycleEvent);
    const planning = mapVisualEventToPixelHook({
        ...base,
        phase: 'planning',
    } as TaskLifecycleEvent);
    const working = mapVisualEventToPixelHook({
        ...base,
        phase: 'working',
        branchName: 'fix/42',
    } as TaskLifecycleEvent);
    assert.strictEqual(starting?.session_id, 'issue-42');
    assert.strictEqual(planning?.session_id, 'issue-42');
    assert.strictEqual(working?.session_id, 'issue-42');
    assert.notStrictEqual(starting?.session_id, 'sess-1');
});

check('blocked -> PermissionRequest', () => {
    const payload = mapVisualEventToPixelHook({
        ...base,
        phase: 'blocked',
        details: 'waiting for /approve',
    } as TaskLifecycleEvent);
    assert.strictEqual(payload?.hook_event_name, 'PermissionRequest');
    assert.strictEqual(payload?.message, 'waiting for /approve');
});

check('verifying -> PreToolUse (Bash)', () => {
    const payload = mapVisualEventToPixelHook({
        ...base,
        phase: 'verifying',
    } as TaskLifecycleEvent);
    assert.strictEqual(payload?.hook_event_name, 'PreToolUse');
    assert.strictEqual(payload?.tool_name, 'Bash');
});

check('completed -> Stop', () => {
    const payload = mapVisualEventToPixelHook({
        ...base,
        phase: 'completed',
    } as TaskLifecycleEvent);
    assert.strictEqual(payload?.hook_event_name, 'Stop');
});

check('tool_use editing -> PreToolUse (Edit)', () => {
    const payload = mapVisualEventToPixelHook({
        type: 'agent:tool_use',
        issueNumber: 42,
        sessionId: 'sess-1',
        tool: 'write_file',
        category: 'editing',
        summary: 'edited index.ts',
        timestamp: 1_000_000,
    });
    assert.strictEqual(payload?.hook_event_name, 'PreToolUse');
    assert.strictEqual(payload?.tool_name, 'Edit');
});

check('agent:text -> Notification', () => {
    const payload = mapVisualEventToPixelHook({
        type: 'agent:text',
        issueNumber: 42,
        sessionId: 'sess-1',
        text: 'hello world',
        timestamp: 1_000_000,
    });
    assert.strictEqual(payload?.hook_event_name, 'Notification');
    assert.strictEqual(payload?.message, 'hello world');
});

/* ------------------------------------------------------------------ */
/* 3. Visual event bus round-trip                                     */
/* ------------------------------------------------------------------ */

console.log('\nvisualEventBus:');

let received: VisualEvent | null = null;
visualEventBus.onVisualEvent((event) => {
    received = event;
});

visualEventBus.emitAgentAction({
    type: 'agent:tool_use',
    issueNumber: 7,
    sessionId: 'sess-7',
    tool: 'bash',
    category: 'executing',
    summary: 'npm test',
    timestamp: 2_000_000,
});

check('bus emits agent:tool_use to visual listeners', () => {
    assert.notStrictEqual(received, null);
    assert.strictEqual(received!.type, 'agent:tool_use');
    assert.strictEqual((received as any).issueNumber, 7);
});

/* ------------------------------------------------------------------ */
/* 4. PixelAgentsClient server discovery                              */
/* ------------------------------------------------------------------ */

console.log('\nPixelAgentsClient server discovery:');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-home-'));
const serversDir = path.join(tmpHome, '.pixel-agents', 'servers');
fs.mkdirSync(serversDir, { recursive: true });

// Write a mock server descriptor (PID = current process, so it's "alive").
fs.writeFileSync(
    path.join(serversDir, '1234.json'),
    JSON.stringify({ port: 3999, pid: process.pid, token: 'abc' }),
);

// A stale descriptor with a dead PID should be ignored.
fs.writeFileSync(
    path.join(serversDir, 'stale.json'),
    JSON.stringify({ port: 3998, pid: 999999999 }),
);

// Point HOME at the temp dir *before* constructing the client so
// os.homedir() resolves to it.
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

try {
    check('discovers active mock server', () => {
        const client = new PixelAgentsClient();
        const servers = client.findActiveServers();
        assert.strictEqual(servers.length, 1);
        assert.strictEqual(servers[0].port, 3999);
        assert.strictEqual(servers[0].token, 'abc');
    });

    check('dispatches silently when no servers', async () => {
        // New client with a home that has no servers dir.
        const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-empty-'));
        process.env.HOME = emptyHome;
        const client = new PixelAgentsClient();
        await client.dispatch({
            hook_event_name: 'SessionStart',
            session_id: 'sess',
            issue_number: 1,
            message: 'hi',
        }); // must not throw
        fs.rmSync(emptyHome, { recursive: true, force: true });
    });
} finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Summary                                                            */
/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
