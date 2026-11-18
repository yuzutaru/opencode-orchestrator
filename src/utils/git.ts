/**
 * Environment helpers that make git/gh calls run as the bot account.
 *
 * The repository's `origin` is an SSH remote. Pushes made by this process (and by
 * agent child processes) are rewritten to HTTPS and authenticated with the token
 * so the bot account, not the human's SSH key, is used.
 */
export function botToken(): string | undefined {
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
}

export function botGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const token = botToken();
    if (!token) return { ...base };

    return {
        ...base,
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
        GIT_CONFIG_VALUE_0: 'git@github.com:',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    };
}
