#!/usr/bin/env bash
#
# iOS unit / UI gate.
#
# Usage: ios-tests.sh <unit|ui> [worktree]
#
#   unit -> app scheme `test` minus the UI test target, plus the Today and Nutrition
#           package schemes (their tests only exist there).
#   ui   -> app scheme `test` limited to the UI test target, parallel testing disabled.
#
# The simulator is booted only when it is shut down, and is shut down again only
# if this script started it. A device that was already booted (a human's session)
# is reused and left running.
#
# Knobs (exported by the orchestrator via QualityGate.env):
#   IOS_DEVICE          simulator name (default: iPhone 18 Pro)
#   IOS_XCODE_PROJECT   xcodeproj to test (default: single ios/*.xcodeproj)
#   IOS_XCODE_SCHEME    scheme to build/test (default: project basename)
#   IOS_UI_TEST_TARGET  UI test target for the UI gate (default: ${SCHEME}UITests)
#   QUALITY_MIN_FREE_GB free-space preflight (default: 10)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${1:-}"
if [[ "$MODE" != "unit" && "$MODE" != "ui" ]]; then
    gate_error "usage: ios-tests.sh <unit|ui> [worktree]"
    exit 2
fi

WORKTREE="${2:-$(pwd)}"
DEVICE_NAME="${IOS_DEVICE:-iPhone 18 Pro}"
MIN_FREE_GB="${QUALITY_MIN_FREE_GB:-10}"

cd "$WORKTREE/ios"

require_free_gb "$MIN_FREE_GB" "$WORKTREE"
acquire_device_lock "$(dirname "$WORKTREE")/.gate-lock"

UDID="$(xcrun simctl list devices available \
    | grep -F "${DEVICE_NAME} (" \
    | head -1 \
    | sed -E 's/.*\(([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\).*/\1/')"

if [[ -z "$UDID" || "$UDID" == "$DEVICE_NAME" ]]; then
    gate_error "no available simulator named '${DEVICE_NAME}' (set IOS_DEVICE)"
    exit 1
fi

BOOTED_BY_US=0
gate_extra_cleanup() {
    if [[ "$BOOTED_BY_US" == "1" ]]; then
        gate_log "shutting down the simulator this gate started (${DEVICE_NAME})"
        xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
    fi
}

if xcrun simctl list devices | grep -F "$UDID" | grep -q "(Booted)"; then
    gate_log "reusing the booted simulator ${DEVICE_NAME} (${UDID}); it will not be shut down"
else
    gate_log "booting simulator ${DEVICE_NAME} (${UDID})"
    if xcrun simctl boot "$UDID"; then
        BOOTED_BY_US=1
    else
        gate_log "simctl boot reported an error; waiting for the device anyway"
    fi
fi

xcrun simctl bootstatus "$UDID" -b

DERIVED_DATA="$WORKTREE/ios/.build/dd"
RESULTS_DIR="$WORKTREE/ios/.build/results"
mkdir -p "$DERIVED_DATA" "$RESULTS_DIR"

# --- Resolve the xcode project / scheme / UI test target ---------------------
PROJECT="${IOS_XCODE_PROJECT:-}"
if [[ -z "$PROJECT" ]]; then
    shopt -s nullglob
    projs=(*.xcodeproj)
    shopt -u nullglob
    if [[ ${#projs[@]} -eq 0 ]]; then
        gate_error "no *.xcodeproj found in ios/ (set IOS_XCODE_PROJECT)"
        exit 2
    elif [[ ${#projs[@]} -gt 1 ]]; then
        gate_error "multiple *.xcodeproj found in ios/ (set IOS_XCODE_PROJECT explicitly)"
        exit 2
    fi
    PROJECT="${projs[0]##*/}"
fi

SCHEME="${IOS_XCODE_SCHEME:-}"
if [[ -z "$SCHEME" ]]; then
    SCHEME="${PROJECT%.xcodeproj}"
fi

# UI test target: explicit override, else ${SCHEME}UITests if present in the project.
UI_TARGET="${IOS_UI_TEST_TARGET:-}"
if [[ -z "$UI_TARGET" ]]; then
    UI_TARGET="${SCHEME}UITests"
    if ! grep -qE "name = ${UI_TARGET};" "$WORKTREE/ios/$PROJECT/project.pbxproj"; then
        gate_error "no native target '${UI_TARGET}' in '$PROJECT' (set IOS_UI_TEST_TARGET)"
        exit 2
    fi
fi

# -onlyUsePackageVersionsFromResolvedFile prevents SPM from rewriting
# Package.resolved mid-gate (tracked file drift would invalidate the commit).
COMMON_ARGS=(
    -project "$PROJECT"
    -scheme "$SCHEME"
    -destination "id=$UDID"
    -derivedDataPath "$DERIVED_DATA"
    -onlyUsePackageVersionsFromResolvedFile
)

started_at=$SECONDS
status=0
xcode_log=$(mktemp "${TMPDIR:-/tmp}/ios-gate-XXXXXX")

# The UI runner occasionally dies with "crashed with signal term while preparing
# to run tests" on the first launch after a boot. That is a simulator hiccup, not
# a test failure, so retry exactly that once. Real assertion failures are never
# retried.
run_app_scheme_tests() {
    local bundle="$1"
    shift

    set +e
    xcodebuild test "${COMMON_ARGS[@]}" "$@" 2>&1 | tee -a "$xcode_log"
    local run_status=${PIPESTATUS[0]}

    if (( run_status != 0 )) && grep -q "crash with signal term while preparing to run tests" "$xcode_log"; then
        gate_log "test runner crashed while preparing; retrying once"
        rm -rf "$bundle"
        sleep 5
        xcodebuild test "${COMMON_ARGS[@]}" "$@" 2>&1 | tee -a "$xcode_log"
        run_status=${PIPESTATUS[0]}
    fi
    set -e

    return "$run_status"
}

if [[ "$MODE" == "unit" ]]; then
    result_bundle="$RESULTS_DIR/unit.xcresult"
    rm -rf "$result_bundle"

    gate_section "app scheme unit tests (unit tests + hosted mirrors)"
    run_app_scheme_tests "$result_bundle" \
        -skip-testing:"$UI_TARGET" \
        -resultBundlePath "$result_bundle" \
        || status=$?

    if (( status == 0 )); then
        for package in Today Nutrition; do
            gate_section "package unit tests (${package})"
            package_bundle="$RESULTS_DIR/${package}.xcresult"
            rm -rf "$package_bundle"
            (
                cd "Packages/$package"
                xcodebuild test -scheme "$package" \
                    -destination "id=$UDID" \
                    -derivedDataPath "$WORKTREE/ios/.build/dd-$package" \
                    -onlyUsePackageVersionsFromResolvedFile \
                    -resultBundlePath "$package_bundle"
            ) || status=$?
            if (( status != 0 )); then
                break
            fi
        done
    fi
else
    result_bundle="$RESULTS_DIR/ui.xcresult"
    rm -rf "$result_bundle"

    gate_section "${UI_TARGET} (parallel testing disabled)"
    run_app_scheme_tests "$result_bundle" \
        -only-testing:"$UI_TARGET" \
        -parallel-testing-enabled NO \
        -resultBundlePath "$result_bundle" \
        || status=$?
fi

duration=$((SECONDS - started_at))

gate_section "summary"
gate_log "mode: ${MODE}"
gate_log "simulator: ${DEVICE_NAME} (${UDID})"
gate_log "duration: ${duration}s"
gate_log "result bundles: ${RESULTS_DIR}"
gate_log "full log: ${xcode_log}"

if (( status != 0 )); then
    gate_error "iOS ${MODE} tests failed with exit code ${status}"
    exit "$status"
fi

gate_log "iOS ${MODE} tests passed"
