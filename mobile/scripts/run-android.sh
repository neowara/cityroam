#!/usr/bin/env bash
# `expo run:android` starts Metro fine on its own, but never manages the emulator's
# lifecycle — it only installs onto whatever's already visible to `adb devices`. On a
# fresh machine (or a machine where the emulator just isn't running yet) that means
# the whole command fails with no clear "you forgot to boot an emulator" message. This
# boots a fresh emulator each run with a wiped data partition, then hands off to the
# real command. It also kills any stale emulator rows so a dirty AVD can't poison the
# install with `INSTALL_FAILED_INSUFFICIENT_STORAGE`.
#
# If ANY device is already connected — a physical phone over USB included — none of
# that emulator dance runs. Booting a second (fresh, wiped) emulator alongside an
# already-connected phone left `adb devices` with two targets and no way for `expo
# run:android` (no explicit --device) to know which one you meant; it either errored
# or silently installed onto the wrong one. A real device always wins.
set -euo pipefail
cd "$(dirname "$0")/.."

AVD_NAME="${TURBO_AVD_NAME:-tynee_test}"
BOOT_TIMEOUT_SECS=120
PACKAGER_PORT="${EXPO_PACKAGER_PORT:-8082}"

has_device() {
  adb devices | grep -q "	device$"
}

if has_device; then
  echo "== device already connected, skipping emulator boot =="
  npx expo run:android --port "$PACKAGER_PORT" "$@"
  exit 0
fi

clear_offline_emulators() {
  local serial
  serials=$(adb devices | awk '$2 == "offline" { print $1 }')
  if [ -n "$serials" ]; then
    echo "== clearing stale offline emulator rows: ${serials} =="
    for serial in $serials; do
      adb -s "$serial" emu kill >/dev/null 2>&1 || true
    done
    adb kill-server >/dev/null 2>&1 || true
    adb start-server >/dev/null 2>&1 || true
  fi
}

kill_running_emulators() {
  local serial
  serials=$(adb devices | awk '$2 == "device" && $1 ~ /^emulator-/ { print $1 }')
  if [ -n "$serials" ]; then
    echo "== killing existing emulator rows for a clean AVD boot: ${serials} =="
    for serial in $serials; do
      adb -s "$serial" emu kill >/dev/null 2>&1 || true
    done
    adb kill-server >/dev/null 2>&1 || true
    adb start-server >/dev/null 2>&1 || true
  fi
}

EMULATOR_BIN="$ANDROID_HOME/emulator/emulator"
[ -f "$EMULATOR_BIN.exe" ] && EMULATOR_BIN="$EMULATOR_BIN.exe"
if [ ! -f "$EMULATOR_BIN" ]; then
  echo "Android emulator binary not found at $EMULATOR_BIN — is ANDROID_HOME set and the emulator package installed?" >&2
  exit 1
fi

if ! "$EMULATOR_BIN" -list-avds | grep -qx "$AVD_NAME"; then
  echo "No AVD named '$AVD_NAME' found. Available AVDs:" >&2
  "$EMULATOR_BIN" -list-avds >&2
  echo "Create one in Android Studio (Device Manager), or point TURBO_AVD_NAME at an existing one." >&2
  exit 1
fi

clear_offline_emulators
kill_running_emulators

# Harden the retry path so any lingering emulator.exe host process can't keep
# the ADB daemon or the AVD serial registry from seeing a clean board state.
if command -v taskkill >/dev/null 2>&1; then
  taskkill /F /IM emulator.exe >/dev/null 2>&1 || true
fi

adb kill-server >/dev/null 2>&1 || true
adb start-server >/dev/null 2>&1 || true

echo "== booting emulator '$AVD_NAME' (set TURBO_AVD_NAME to use a different one) =="
"$EMULATOR_BIN" -avd "$AVD_NAME" -netdelay none -netspeed full -wipe-data >/dev/null 2>&1 &

echo "== waiting for it to come online (up to ${BOOT_TIMEOUT_SECS}s) =="
SECONDS=0
until has_device; do
  if [ "$SECONDS" -ge "$BOOT_TIMEOUT_SECS" ]; then
    echo "Emulator didn't register with adb within ${BOOT_TIMEOUT_SECS}s — giving up." >&2
    exit 1
  fi
  sleep 2
done

# adb sees the device well before the OS has actually finished booting; installing
# too early fails with an opaque "device offline"/"package manager not ready" error.
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  if [ "$SECONDS" -ge "$BOOT_TIMEOUT_SECS" ]; then
    echo "Emulator registered but never finished booting within ${BOOT_TIMEOUT_SECS}s — giving up." >&2
    exit 1
  fi
  sleep 2
done
echo "== emulator ready =="

npx expo run:android --port "$PACKAGER_PORT" "$@"
