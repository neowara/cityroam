#!/usr/bin/env bash
# Local signed Android release build — the build half of `npm run release:full`, and
# the documented alternative to EAS's cloud build queue (see mobile/AGENTS.md: never
# run a bare `eas build`, the free-tier quota gets used up fast and blocks the whole
# queue). Produces a release-signed APK that installs straight over an already-
# installed production app (matching signature).
#
# Requires mobile/credentials.json (gitignored) — get it once via:
#   npx eas-cli@latest credentials -p android
#   -> "Keystore: Manage everything needed to build your project"
#   -> "Download credentials from EAS servers"
#
# Usage: npm run release:local          # build only
#        npm run release:local:install  # build, then adb install -r to a connected device
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f credentials.json ]; then
  echo "credentials.json not found — see this script's header comment for how to get it." >&2
  exit 1
fi


STORE_PW=$(node -e "console.log(require('./credentials.json').android.keystore.keystorePassword)")
KEY_PW=$(node -e "console.log(require('./credentials.json').android.keystore.keyPassword)")

# --- clearing android/ so prebuild --clean can delete it ---------------------
# `expo prebuild --clean` deletes the whole android/ dir, and on Windows that fails
# with EBUSY if any process still holds a handle under it. Two layers, cheapest first:
# stop the build daemons that are nearly always the culprit, then -- only if prebuild
# actually fails -- pay for a full handle scan to find whatever else it is.

# `tasklist` is ~0.3s; the CIM query below costs several seconds of PowerShell startup,
# so don't pay it at all on a machine with no JVM running.
any_java_running() {
  tasklist //FI "IMAGENAME eq java.exe" //NH 2>/dev/null | grep -qi '^java\.exe'
}

# Both build daemons outlive the build that started them and both hold android/ open.
# Match on the command line, not the java.exe path: the JDK generally lives nowhere
# near ~/.gradle. All of it runs in one PowerShell invocation on purpose -- each start
# costs several seconds on Windows, so polling from the shell pays that over and over.
read -r -d '' PS_STOP_DAEMONS <<'PS' || true
function Get-Daemons($pattern) {
  @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'java.exe' -and $_.CommandLine -match $pattern })
}
# The Kotlin compile daemon has no graceful stop and never exits on its own, so
# waiting on it is waiting forever. prebuild regenerates android/ from scratch
# anyway, which throws away everything its warm state was good for.
Get-Daemons 'KotlinCompileDaemon' |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# `gradlew --stop` only sends the request; the daemon takes a moment to actually exit
# and release its handles, and prebuild racing that is the EBUSY above.
$deadline = (Get-Date).AddSeconds(15)
while ($true) {
  $gradle = Get-Daemons 'GradleDaemon'
  if (-not $gradle) { break }
  if ((Get-Date) -ge $deadline) {
    $gradle | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    break
  }
  Start-Sleep -Milliseconds 500
}
PS

stop_build_daemons() {
  if ! any_java_running; then
    echo "  (no JVM running, nothing to stop)"
    return 0
  fi
  if [ -f android/gradlew.bat ]; then
    (cd android && ./gradlew.bat --stop) || true
  elif [ -f android/gradlew ]; then
    (cd android && ./gradlew --stop) || true
  fi
  powershell -NoProfile -Command "$PS_STOP_DAEMONS" >/dev/null 2>&1 || true
}

# --- android/ lock hunting (failure path only) -------------------------------
# Anything holding a handle under android/ (a stray `adb`, Metro, jest --watch, an
# Explorer window, a terminal cd'd into android/, ...) causes the same EBUSY as a
# leftover daemon, and it isn't always a node process. Sysinternals `handle` finds
# whatever actually has the directory open so it can be stopped precisely, instead
# of guessing by process name.
#
# It sweeps every handle of every process on the machine, which takes minutes -- so it
# runs only after a prebuild attempt has actually failed, never speculatively, and is
# capped so a hung scan can't eat the whole release.
HANDLE_EXE="${LOCALAPPDATA:-/tmp}/turbo-release-tools/handle64.exe"
HANDLE_SCAN_TIMEOUT=240

# A failed download can leave a truncated/HTML file behind, and executing it then
# would fail silently — so verify it's a real PE and refetch if not.
ensure_handle_exe() {
  if [ -f "$HANDLE_EXE" ] && head -c 2 "$HANDLE_EXE" | grep -q "MZ"; then
    return 0
  fi
  rm -f "$HANDLE_EXE"
  mkdir -p "$(dirname "$HANDLE_EXE")"
  curl -sL -o "$HANDLE_EXE" "https://live.sysinternals.com/handle64.exe" || true
  [ -f "$HANDLE_EXE" ] && head -c 2 "$HANDLE_EXE" | grep -q "MZ"
}

# Prints "<pid> <image name>" for every process holding a File handle under
# android/. Never fails the script: handle64 exits nonzero when nothing matches,
# an empty result is a valid answer, and everything here runs under `set -e`.
android_lock_holders() {
  ensure_handle_exe || return 0
  local win_path out
  # handle64 matches handle names containing backslash paths — a forward-slash
  # or POSIX-style path matches nothing.
  win_path=$(cygpath -w "$PWD/android" 2>/dev/null || echo "$(pwd -W 2>/dev/null || pwd)/android")
  out=$(timeout "$HANDLE_SCAN_TIMEOUT" "$HANDLE_EXE" -accepteula -nobanner "$win_path" 2>/dev/null || true)
  printf '%s\n' "$out" | awk '/pid: [0-9]+/ && /type: File/ { pid = $0; sub(/^.*pid: /, "", pid); sub(/ .*$/, "", pid); print pid, $1 }' | sort -u
  return 0
}

free_android_locks() {
  if ! ensure_handle_exe; then
    echo "  (couldn't fetch handle64.exe — can't detect what's holding android/ open)"
    return 0
  fi
  local holders pid name
  echo "  (scanning every process's handles, this takes a few minutes)"
  holders=$(android_lock_holders)
  if [ -z "$holders" ]; then
    echo "  (no process currently holds a handle under android/)"
    return 0
  fi
  while read -r pid name; do
    [ -n "$pid" ] || continue
    case "$(basename "$name" | tr '[:upper:]' '[:lower:]')" in
      # Killing these takes down the user's shell, editor or taskbar instead of
      # just the lock — closing the window/terminal by hand is the right fix.
      explorer.exe|pwsh.exe|powershell.exe|cmd.exe|bash.exe|sh.exe|code.exe|handle64.exe)
        echo "  NOT stopping $name (pid $pid) — it holds android/ open; close it manually if prebuild keeps failing"
        ;;
      *)
        echo "  stopping $name (pid $pid) — holds a handle under android/"
        taskkill //F //PID "$pid" >/dev/null 2>&1 || true
        ;;
    esac
  done <<< "$holders"
}

# Nothing to unlock when there's no android/ to delete in the first place.
if [ -d android ]; then
  echo "== stopping Gradle/Kotlin build daemons (they hold android/ open on Windows) =="
  stop_build_daemons
fi

echo "== expo prebuild (regenerates android/ so withReleaseSigning picks up credentials.json) =="
# An indexer/AV scan can grab a handle at any moment and some holders can only be
# closed by hand — so retry, and escalate to the full handle scan between attempts.
PREBUILD_OK=0
for attempt in 1 2 3 4 5; do
  if npx expo prebuild --platform android --clean; then
    PREBUILD_OK=1
    break
  fi
  echo "expo prebuild failed (attempt $attempt/5)." >&2
  if [ "$attempt" -lt 5 ]; then
    echo "== hunting processes holding android/ open =="
    stop_build_daemons
    free_android_locks
    sleep 5
  fi
done
if [ "$PREBUILD_OK" -ne 1 ]; then
  leftover=$(android_lock_holders || true)
  {
    echo "expo prebuild --clean kept failing after 5 attempts."
    if [ -n "$leftover" ]; then
      echo "These processes still hold a handle under android/ — close them and rerun:"
      printf '%s\n' "$leftover"
    else
      echo "handle64 found no named holder — the lock is likely held by a system or elevated process (Android Studio, antivirus, Windows Search). Close those or reboot, then rerun."
    fi
  } >&2
  exit 1
fi

echo "== gradlew assembleRelease =="
cd android
# A physical phone only needs arm64; building all four ABIs (the default) roughly
# triples the APK and the native CMake work. CI's release.yml pins the same
# reactNativeArchitectures so the local build matches the shipped artifact.
TURBO_STORE_PASSWORD="$STORE_PW" TURBO_KEY_PASSWORD="$KEY_PW" \
  ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a \
  ./gradlew assembleRelease
cd ..

APK=android/app/build/outputs/apk/release/app-release.apk
if [ ! -f "$APK" ]; then
  echo "Build reported success but $APK is missing — something's wrong." >&2
  exit 1
fi

# A version-stamped copy alongside the fixed-name one, so a folder of past builds
# (or a GitHub Release asset — see release-full.ps1) sorts and identifies by version
# at a glance instead of every build shipping the same app-release.apk name.
APK_VERSION=$(node -e "console.log(require('./app.json').expo.version)")
VERSIONED_APK="android/app/build/outputs/apk/release/TurboV${APK_VERSION}.apk"
cp "$APK" "$VERSIONED_APK"
echo "Built: $APK"
echo "       $VERSIONED_APK"

if [ "${1:-}" = "--install" ]; then
  if ! command -v adb >/dev/null 2>&1; then
    echo "adb not found on PATH — can't install." >&2
    exit 1
  fi
  DEVICE_COUNT=$(adb devices | grep -c "	device$" || true)
  if [ "$DEVICE_COUNT" -lt 1 ]; then
    echo "No device connected (adb devices shows none) — build succeeded but nothing to install to." >&2
    exit 1
  fi
  echo "== adb install -r =="
  adb install -r "$APK"
fi
