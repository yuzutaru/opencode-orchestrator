#!/usr/bin/env bash
#
# Shared helpers for orchestrator quality-gate scripts.
#
# These scripts deliberately live in the orchestrator, not in the repository it
# verifies: an agent must not be able to weaken the harness that checks its work.

set -euo pipefail

gate_log() {
    printf '%s\n' "$*"
}

gate_section() {
    printf '\n===== %s =====\n' "$*"
}

gate_error() {
    printf 'gate error: %s\n' "$*" >&2
}

# Refuse to start a device gate without headroom. A full disk during a qcow2 or
# DerivedData write is much worse than failing before the device boots.
require_free_gb() {
    local minimum="${1:-10}"
    local target="${2:-.}"
    local available

    available=$(df -g "$target" 2>/dev/null | awk 'NR==2 {print $4}')

    if [[ -z "${available:-}" ]]; then
        gate_log "WARN: could not read free space for $target"
        return 0
    fi

    gate_log "free space on ${target}: ${available}GB (minimum ${minimum}GB)"

    if (( available < minimum )); then
        gate_error "only ${available}GB free; set QUALITY_MIN_FREE_GB lower only if you are sure"
        return 1
    fi
}

# Serialise device access. Two gate runs must never drive the same emulator or
# simulator, even if MAX_CONCURRENT_TASKS is raised later.
#
# The lock is released through a single EXIT dispatcher so a script can still
# register its own teardown without clobbering the lock cleanup:
#   gate_extra_cleanup() { ... }   # optional hook defined by the caller
GATE_LOCK_HELD=""

gate_cleanup_dispatch() {
    local status=$?
    if declare -F gate_extra_cleanup >/dev/null 2>&1; then
        gate_extra_cleanup || true
    fi
    if [[ -n "$GATE_LOCK_HELD" ]]; then
        rm -rf "$GATE_LOCK_HELD"
    fi
    return "$status"
}

acquire_device_lock() {
    local lock_dir="$1"
    local waited=0

    while ! mkdir "$lock_dir" 2>/dev/null; do
        if [[ -f "$lock_dir/pid" ]]; then
            local holder
            holder="$(cat "$lock_dir/pid" 2>/dev/null || true)"
            if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
                gate_log "removing stale device lock (pid ${holder} is gone)"
                rm -rf "$lock_dir"
                continue
            fi
        fi

        if (( waited >= 7200 )); then
            gate_error "timed out waiting for the device lock at ${lock_dir}"
            return 1
        fi

        sleep 5
        waited=$((waited + 5))
    done

    printf '%s' "$$" > "$lock_dir/pid"
    GATE_LOCK_HELD="$lock_dir"
    trap gate_cleanup_dispatch EXIT
    trap 'exit 130' INT TERM
    gate_log "acquired device lock: ${lock_dir}"
}

# Resolve the Android SDK from the environment, then local.properties, then the
# default macOS install location.
resolve_android_sdk() {
    local worktree="$1"
    local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

    if [[ -z "$sdk" && -f "$worktree/android/local.properties" ]]; then
        sdk="$(sed -n 's/^sdk\.dir=//p' "$worktree/android/local.properties" | head -1)"
    fi

    if [[ -z "$sdk" ]]; then
        sdk="$HOME/Library/Android/sdk"
    fi

    printf '%s' "$sdk"
}
