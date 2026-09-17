#!/usr/bin/env bash
# Runs the Maestro suite twice — once with the device in light mode, once in dark —
# since neither Android's UI-mode toggle nor a color-scheme switch has a native Maestro
# flow command. Screenshots land in separate light/dark subfolders for visual review.
set -euo pipefail
cd "$(dirname "$0")/.."

# Own PATH rather than an inherited one: this runs as its own shell step, so an
# `export PATH=...` in the calling script never reaches this process, and the first
# run without this failed with "maestro: command not found".
export PATH="$PATH:$HOME/.maestro/bin"

FLOWS="${1:-.maestro/explore.yaml .maestro/trip-fab-toggle.yaml}"

# Every `maestro test` invocation otherwise uninstalls and reinstalls Maestro's own
# instrumentation APK against the device. On a loaded runner that reinstall is what
# flakes, in two ways: "cmd: Failure calling service package: Broken pipe" during the
# reinstall, and the package manager force-stopping dev.mobile.maestro while it is
# still polling on a previous flow's assertion. Passing --no-reinstall-driver after the
# first install removes the cycle, and with it the race.
DRIVER_INSTALLED=false

run_flow_with_retries() {
  local flow="$1"
  local attempt
  local driver_flag=()
  if [ "$DRIVER_INSTALLED" = true ]; then
    driver_flag=(--no-reinstall-driver)
  fi
  for attempt in 1 2 3; do
    if maestro test "${driver_flag[@]}" "$flow"; then
      DRIVER_INSTALLED=true
      return 0
    fi
    echo "=== $flow failed (attempt $attempt/3) ==="
    if [ "$attempt" -lt 3 ]; then
      # A retry right after a dropped ADB connection can reach the emulator before it
      # has recovered, so give it room to come back.
      sleep 15
    fi
  done
  return 1
}

for mode in light dark; do
  echo "=== Running Maestro suite in $mode mode ==="
  adb shell "cmd uimode night $([ "$mode" = dark ] && echo yes || echo no)"
  sleep 2 # let the theme change settle before the next cold launch
  for flow in $FLOWS; do
    run_flow_with_retries "$flow"
  done
done

adb shell "cmd uimode night no" # leave the device in light mode afterward
echo "=== Done: both themes passed ==="
