export type FailureKind =
    | 'rate-limit'
    | 'quota'
    | 'context-length'
    | 'model-unavailable'
    | 'other';

interface OpenCodeError {
    type?: string | unknown;
    message?: string | unknown;
}

const keywords = [
    [ 'rate-limit', 'rate limit', 'rate_limit', 'ratelimit', '429', 'too many requests', 'retry after' ],
    [ 'quota', 'quota exceeded', 'insufficient credit', 'usage limit', 'balance', 'billing', 'exceeded limit' ],
    [ 'context length', 'context window', 'too many tokens', 'maximum context', 'input is too long', 'prompt is too long' ],
    [ 'provider.no-route', 'model unavailable', 'no such model', 'model not found' ],
];

const failureKinds: FailureKind[] = [ 'rate-limit', 'quota', 'context-length', 'model-unavailable' ];

function blob(errors: OpenCodeError[]): string {
    return errors.map((e) => `${e.type ?? ''} ${e.message ?? ''}`).join(' ').toLowerCase();
}

/**
 * Classify a run's captured OpenCode error events.
 *
 * Returns the most specific matching kind (rate-limit / quota / context-length /
 * model-unavailable) or 'other' when nothing matched.
 */
export function classifyRunErrors(errors: OpenCodeError[]): FailureKind {
    const text = blob(errors);
    for (let i = 0; i < keywords.length; i++) {
        for (const keyword of keywords[i]) {
            if (text.includes(keyword.toLowerCase())) {
                return failureKinds[i];
            }
        }
    }
    return 'other';
}

export function failureKindLabel(kind: FailureKind): string {
    switch (kind) {
        case 'rate-limit': return 'Model rate limit reached';
        case 'quota': return 'Model quota exhausted';
        case 'context-length': return 'Context window exceeded';
        case 'model-unavailable': return 'Model unavailable';
        default: return 'OpenCode error';
    }
}
