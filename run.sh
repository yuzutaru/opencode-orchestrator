#!/usr/bin/env bash
#
# Launch the orchestrator as the bot account.
#
# The identity is pinned through GH_TOKEN, so `gh` and `git push` inside agent
# sessions always act as the bot, regardless of which account is active in the
# gh keyring (handy: you can `gh auth switch` to review PRs safely).
#
set -euo pipefail
cd "$(dirname "$0")"

BOT_USER="${BOT_USER:-quintonflyn}"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    GITHUB_TOKEN="$(gh auth token --user "$BOT_USER")"
fi
export GITHUB_TOKEN
export GH_TOKEN="$GITHUB_TOKEN"

# Fail fast if the token does not belong to the bot account: a human identity
# here would make the orchestrator treat its own comments as reviewer replies.
login="$(GH_TOKEN="$GITHUB_TOKEN" gh api user --jq .login 2>/dev/null || true)"
if [[ "$login" != "$BOT_USER" ]]; then
    echo "error: token belongs to '${login:-unknown}', expected '$BOT_USER'" >&2
    exit 1
fi

if [[ ! -f dist/index.js ]]; then
    echo "error: dist/index.js missing — run 'npm run build' first" >&2
    exit 1
fi

echo "▶ bot identity: $login"
exec node dist/index.js "$@"
