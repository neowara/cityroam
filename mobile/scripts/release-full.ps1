# Full local release, driven from this machine instead of GitHub Actions:
#   1. runs the same gate CI does (npm run verify: typecheck, lint, formatting, tests)
#   2. builds a signed release APK (scripts/release-local.sh)
#   3. asks for a patch/minor/major version bump
#   4. commits + pushes the version bump straight to main
#   5. tags v<version> and creates a GitHub Release with the APK attached and
#      a changelog built from every commit since the last version bump
#
# This is the release path — GitHub Actions is not. Nothing here waits on a runner,
# which is the whole point: the same release takes ~3 minutes locally against 30+
# in CI.
#
# Requires: git, node, gh, and Git Bash (release-local.sh needs real Git Bash —
# see the resolution below; `bash` on PATH may be the WSL stub) plus
# mobile/credentials.json + mobile/.env.local (see scripts/release-local.sh).
#
# Usage: pwsh mobile/scripts/release-full.ps1
# (or double-click scripts/release-full.bat, which just launches this)

$ErrorActionPreference = "Stop"

function Fail($msg) {
  Write-Host $msg -ForegroundColor Red
  exit 1
}

$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot

foreach ($cmd in @("git", "node", "gh")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Fail "'$cmd' not found on PATH — required for this script."
  }
}

# `bash` on PATH can resolve to the WSL stub in System32, which fails with
# "execvpe(/bin/bash) failed" when no distro is installed — so locate real
# Git Bash via git.exe's install dir, with the standard install paths as
# fallbacks for shimmed git.
$GitBash = Join-Path (Split-Path (Get-Command git).Source) "..\bin\bash.exe"
if (-not (Test-Path $GitBash)) {
  $GitBash = "C:\Program Files\Git\bin\bash.exe"
}
if (-not (Test-Path $GitBash)) {
  $GitBash = "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
}
if (-not (Test-Path $GitBash)) {
  Fail "Git Bash not found (looked next to git.exe, 'C:\Program Files\Git', and '$env:LOCALAPPDATA\Programs\Git') — required to run scripts/release-local.sh."
}

# --- Preflight -------------------------------------------------------------

$branch = (git branch --show-current).Trim()
if ($branch -ne "main") {
  Fail "Not on main (currently on '$branch'). Switch to main first."
}

Write-Host "== fetching origin/main =="
git fetch origin main | Out-Null
$local = (git rev-parse HEAD).Trim()
$remote = (git rev-parse origin/main).Trim()
if ($local -ne $remote) {
  Fail "main is not in sync with origin/main. Pull (or push) first."
}

$dirty = git status --porcelain
if ($dirty) {
  Fail "Working tree is not clean:`n$dirty`nCommit or stash first."
}

# Last version-bump commit, to scope both the "since when" changelog and the
# preflight check that a real release actually happened since it. A repository whose
# history starts with one squashed commit has no such commit yet, so fall back to the
# root commit: the changelog then covers everything, and the "nothing new to release"
# prompt below still fires when there is genuinely nothing since.
$lastBumpCommit = git log --grep="^Bump app version to" -1 --format="%H"
if (-not $lastBumpCommit) {
  $lastBumpCommit = git rev-list --max-parents=0 HEAD | Select-Object -Last 1
  Write-Host "No previous version-bump commit in this history; scoping the changelog to the first commit." -ForegroundColor Yellow
}

$pendingCommits = git log "$lastBumpCommit..HEAD" --format="%s" | Where-Object { $_ -notmatch "^Bump app version to" }
if (-not $pendingCommits) {
  Write-Host "No commits since the last version bump — nothing new to release." -ForegroundColor Yellow
  $proceed = Read-Host "Release anyway? (y/N)"
  if ($proceed -ne "y" -and $proceed -ne "Y") {
    exit 0
  }
}

# --- Checks ------------------------------------------------------------------
# Type check, lint (at the pinned warning ceiling) and the unit suite, run here rather
# than left to a workflow — this is the only gate a release actually passes through.
# The bundle sanity check CI runs separately (`expo export`) is skipped on purpose:
# assembleRelease below embeds a real Metro bundle, so a broken import fails the build
# anyway, and running it twice adds a minute to a three-minute release.

Write-Host ""
Write-Host "== running checks (typecheck, lint, unit tests) =="
Push-Location mobile
try {
  npm run verify
  if ($LASTEXITCODE -ne 0) {
    throw "npm run verify failed"
  }
} finally {
  Pop-Location
}

# --- Version bump ------------------------------------------------------------

Write-Host ""
Write-Host "Version bump:"
Write-Host "  1) patch"
Write-Host "  2) minor"
Write-Host "  3) major"
$choice = Read-Host "Enter 1/2/3"
$bump = switch ($choice) {
  "1" { "patch" }
  "2" { "minor" }
  "3" { "major" }
  default { Fail "Invalid choice '$choice'." }
}

$newVersion = (node "mobile/scripts/bump-version.js" $bump).Trim()
if (-not $newVersion) {
  Fail "bump-version.js didn't print a version."
}

if (git tag -l "v$newVersion") {
  git checkout -- mobile/app.json mobile/package.json
  Fail "Tag v$newVersion already exists."
}

Write-Host "Version bumped to $newVersion (not committed yet)." -ForegroundColor Cyan

# --- Build -------------------------------------------------------------------

Write-Host ""
Write-Host "== building release APK (this takes a while) =="
Push-Location mobile
try {
  & $GitBash scripts/release-local.sh
  if ($LASTEXITCODE -ne 0) {
    throw "release-local.sh exited with code $LASTEXITCODE"
  }
} catch {
  Pop-Location
  git checkout -- mobile/app.json mobile/package.json
  Fail "Build failed, version bump reverted: $_"
}
Pop-Location

# release-local.sh copies the build to this version-stamped name alongside the fixed
# app-release.apk — using it here means the GitHub Release asset is named TurboVx.x.x.apk
# instead of the generic app-release.apk.
$ApkPath = "mobile/android/app/build/outputs/apk/release/TurboV$newVersion.apk"
if (-not (Test-Path $ApkPath)) {
  git checkout -- mobile/app.json mobile/package.json
  Fail "Build reported success but $ApkPath is missing."
}

# --- Changelog -----------------------------------------------------------

$changelogLines = git log "$lastBumpCommit..HEAD" --format="%s" | Where-Object { $_ -notmatch "^Bump app version to" }
if ($changelogLines) {
  $changelog = ($changelogLines | ForEach-Object { "- $_" }) -join "`n"
} else {
  $changelog = "_No commits since the last release._"
}

# --- Confirm -------------------------------------------------------------

Write-Host ""
Write-Host "About to release v${newVersion}:" -ForegroundColor Cyan
Write-Host $changelog
Write-Host ""
Write-Host "This will push a commit + tag to origin/main and publish a public GitHub release." -ForegroundColor Yellow
$confirm = Read-Host "Continue? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
  git checkout -- mobile/app.json mobile/package.json
  Write-Host "Aborted, version bump reverted."
  exit 0
}

# --- Commit, tag, push -----------------------------------------------------

git add mobile/app.json mobile/package.json
git commit -m "Bump app version to $newVersion" | Out-Null
git tag "v$newVersion"
git push origin main
git push origin "v$newVersion"

# --- GitHub release --------------------------------------------------------

Write-Host "== creating GitHub release v$newVersion =="
# Resolved from the clone's remote rather than named here: the release has to land in
# whichever repository this clone pushes to, and that changed when the project moved.
$releaseRepo = (gh repo view --json nameWithOwner --jq .nameWithOwner).Trim()
if (-not $releaseRepo) {
  Fail "Couldn't resolve the GitHub repository for this clone. Is 'origin' set?"
}

$changelog | gh release create "v$newVersion" $ApkPath `
  --repo $releaseRepo `
  --title "Turbo v$newVersion" `
  --target main `
  --notes-file -

Write-Host ""
Write-Host "Done: https://github.com/$releaseRepo/releases/tag/v$newVersion" -ForegroundColor Green
