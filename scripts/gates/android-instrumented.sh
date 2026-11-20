#!/usr/bin/env bash
#
# Android instrumented (Compose UI / Espresso) gate.
#
# Usage: android-instrumented.sh [worktree]
#
# Reuses an already-running emulator when one is attached; otherwise boots the
# configured AVD headlessly, waits for boot completion, runs the tests and tears
# the device down again. A device this script did not start is never killed.
#
# Knobs (exported by the orchestrator via QualityGate.env):
#   ANDROID_AVD           AVD name (default: Pixel_10a)
#   ANDROID_EMULATOR_PORT console port for a device we boot (default: 5556)
#   QUALITY_MIN_FREE_GB   free-space preflight (default: 10)
#   ANDROID_BOOT_TIMEOUT_SECONDS boot timeout for a booted emulator (default: 240)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

WORKTREE="${1:-$(pwd)}"
AVD="${ANDROID_AVD:-Pixel_10a}"
EMULATOR_PORT="${ANDROID_EMULATOR_PORT:-5556}"
MIN_FREE_GB="${QUALITY_MIN_FREE_GB:-10}"
BOOT_TIMEOUT_SECONDS="${ANDROID_BOOT_TIMEOUT_SECONDS:-240}"

cd "$WORKTREE/android"

require_free_gb "$MIN_FREE_GB" "$WORKTREE"
acquire_device_lock "$(dirname "$WORKTREE")/.gate-lock"

SDK="$(resolve_android_sdk "$WORKTREE")"
ADB="$SDK/platform-tools/adb"
EMULATOR_BIN="$SDK/emulator/emulator"

if [[ ! -x "$ADB" ]]; then
    gate_error "adb not found at $ADB (set ANDROID_HOME or android/local.properties sdk.dir)"
    exit 1
fi

SERIAL=""
BOOTED_BY_US=0
EMULATOR_PID=""

gate_extra_cleanup() {
    if [[ "$BOOTED_BY_US" == "1" ]]; then
        gate_log "stopping the emulator this gate started (${SERIAL})"
        "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
        if [[ -n "$EMULATOR_PID" ]]; then
            wait "$EMULATOR_PID" 2>/dev/null || true
        fi
    fi
}

existing_device="$("$ADB" devices | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-/ { print $1; exit }')"

if [[ -n "$existing_device" ]]; then
    existing_avd="$("$ADB" -s "$existing_device" emu avd name 2>/dev/null | head -1 | tr -d '\r' || true)"
    if [[ "$existing_avd" == "$AVD" ]]; then
        SERIAL="$existing_device"
        gate_log "reusing the running emulator ${SERIAL} (${AVD}); it will not be shut down"
    else
        gate_log "attached emulator ${existing_device} runs '${existing_avd:-unknown}', not '${AVD}'; booting ${AVD}"
        existing_device=""
    fi
fi

if [[ -z "$existing_device" ]]; then
    physical_device="$("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
    if [[ -n "$physical_device" ]]; then
        gate_log "ignoring connected physical device ${physical_device}; booting ${AVD} instead"
    fi
    if [[ ! -x "$EMULATOR_BIN" ]]; then
        gate_error "emulator binary not found at $EMULATOR_BIN"
        exit 1
    fi

    # Pick a free console port so a separately started emulator is never disturbed.
    for candidate in 5556 5558 5560 5562 5564; do
        if ! "$ADB" devices | grep -q "emulator-${candidate}"; then
            EMULATOR_PORT="$candidate"
            break
        fi
    done

    SERIAL="emulator-${EMULATOR_PORT}"
    gate_log "booting ${AVD} as ${SERIAL}"

    # -no-snapshot bounds qcow2 growth; swiftshader keeps it headless-safe.
    "$EMULATOR_BIN" -avd "$AVD" -port "$EMULATOR_PORT" \
        -no-window -no-audio -no-boot-anim -no-snapshot \
        -gpu swiftshader_indirect \
        -camera-front none -camera-back none \
        >/dev/null 2>&1 &
    EMULATOR_PID=$!
    BOOTED_BY_US=1

    elapsed=0
    booted=""
    while (( elapsed < BOOT_TIMEOUT_SECONDS )); do
        if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
            gate_error "emulator process exited before boot completed (port ${EMULATOR_PORT} busy?)"
            exit 1
        fi

        booted="$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
        if [[ "$booted" == "1" ]]; then
            break
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done

    if [[ "${booted:-}" != "1" ]]; then
        gate_error "emulator did not finish booting within ${BOOT_TIMEOUT_SECONDS}s"
        exit 1
    fi

    gate_log "emulator booted in ~${elapsed}s"
fi

# Compose/Espresso are timing sensitive; this mirrors CI's disable-animations.
disable_animations() {
    for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
        "$ADB" -s "$SERIAL" shell settings put global "$setting" 0 >/dev/null 2>&1 || true
    done
}

# Pin every adb call AGP makes to the device this gate chose. Without this a
# second attached emulator can receive installs/uninstalls mid-run.
export ANDROID_SERIAL="$SERIAL"

run_tests() {
    ./gradlew connectedDebugAndroidTest --console=plain --no-parallel --max-workers=1
}

is_infrastructure_failure() {
    grep -qE "device offline|No connected devices|device unauthorized|adb: device .* not found|Connection reset|error: closed" "$1"
}

wait_for_boot() {
    local deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS))
    while (( SECONDS < deadline )); do
        if [[ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == "1" ]]; then
            return 0
        fi
        sleep 3
    done
    return 1
}

# Sum the instrumentation results produced by this run. A successful Gradle
# build with zero executed tests is a silent pass, so the caller treats it as a
# failure instead.
collect_results() {
    local since_epoch="$1"
    local total=0 failures=0 files=0

    while IFS= read -r result; do
        [[ -z "$result" ]] && continue
        local mtime
        mtime=$(stat -f %m "$result" 2>/dev/null || echo 0)
        (( mtime < since_epoch )) && continue
        files=$((files + 1))
        local t f
        t=$(sed -n '2s/.*tests="\([0-9]*\)".*/\1/p' "$result")
        f=$(sed -n '2s/.*failures="\([0-9]*\)".*/\1/p' "$result")
        total=$((total + ${t:-0}))
        failures=$((failures + ${f:-0}))
    done < <(find . -path '*/build/outputs/androidTest-results/connected/*' -name '*.xml' 2>/dev/null)

    printf '%s %s %s' "$total" "$failures" "$files"
}

disable_animations

gate_section "connectedDebugAndroidTest (all modules)"
start_epoch=$(date +%s)
started_at=$SECONDS
run_log=$(mktemp "${TMPDIR:-/tmp}/android-gate-XXXXXX")
status=0

set +e
run_tests 2>&1 | tee -a "$run_log"
status=${PIPESTATUS[0]}

if (( status != 0 )) && is_infrastructure_failure "$run_log"; then
    gate_log "device dropped out mid-run; rebooting ${SERIAL} and retrying once"
    "$ADB" -s "$SERIAL" reboot >/dev/null 2>&1 || true
    if wait_for_boot; then
        disable_animations
        run_tests 2>&1 | tee -a "$run_log"
        status=${PIPESTATUS[0]}
    else
        gate_error "emulator did not come back after reboot"
    fi
fi
set -e

duration=$((SECONDS - started_at))
read -r total_tests total_failures result_files <<< "$(collect_results "$start_epoch")"

gate_section "summary"
gate_log "device: ${SERIAL}"
gate_log "duration: ${duration}s"
gate_log "tests: ${total_tests} (failures: ${total_failures}) across ${result_files} result file(s)"
gate_log "reports: $(pwd)/*/build/reports/androidTests/connected"
gate_log "full log: ${run_log}"

if (( status != 0 )); then
    gate_error "connectedDebugAndroidTest failed with exit code ${status}"
    exit "$status"
fi

if (( total_tests == 0 )); then
    gate_error "connectedDebugAndroidTest reported success but executed no tests (stale device state?)"
    exit 1
fi

gate_log "connectedDebugAndroidTest passed"
