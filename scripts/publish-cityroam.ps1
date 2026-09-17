#Requires -Version 7
<#
.SYNOPSIS
Publishes the cleaned tree to a new public GitHub repository as a single commit.

.DESCRIPTION
Runs the release once, by hand. It exports the current commit (not the working tree),
checks that export for anything that must not be published, renames the old repo to an
archive, creates the public repo, pushes the export to it as one commit, applies the
repo settings a public project needs, recreates the current release so the in-app
updater keeps working, and prints what still has to be done by hand.

The old repo keeps its history, pull requests, issues and releases. The public repo
starts from one commit with no history behind it.

Nothing here is automatic, and nothing runs until you answer the prompts. Re-running
after a failure is safe for every step except the rename; each step checks whether it
has already happened.

.PARAMETER ForbiddenPatterns
Strings the exported tree must not contain. Pass them here or list them one per line in
`.publish-forbidden.txt` at the repo root, which is gitignored. There is deliberately no
default list: the names to look for are exactly the ones that must not be published, so
keeping them in this file would defeat the check.

.EXAMPLE
./scripts/publish-cityroam.ps1 -ForbiddenPatterns 'example-host', 'example-tool'
#>
[CmdletBinding()]
param(
  [string]$SourceRepo = 'neowara/turbo',
  [string]$ArchiveRepo = 'neowara/turbo-archive',
  [string]$PublicRepo = 'neowara/cityroam',
  [string]$ReleaseTag = 'v4.3.0',
  [string[]]$ForbiddenPatterns = @(),
  [string]$ReleaseNotesFile,
  [switch]$SkipRelease,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "== $Text" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is not on PATH."
  }
}

# Git is not always on PATH on Windows, so fall back to the usual install locations and
# put it on PATH for this process rather than rewriting every call below.
function Resolve-Git {
  $command = Get-Command git -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $candidates = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw 'git is not on PATH and not in the usual install locations.'
}

function Confirm-Or-Exit([string]$Question) {
  Write-Host $Question -ForegroundColor Yellow
  $answer = Read-Host '(y/N)'
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host 'Stopped. Nothing further was changed.' -ForegroundColor Yellow
    exit 1
  }
}

function Invoke-Gh([string[]]$Arguments) {
  $output = & gh @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gh $($Arguments -join ' ') failed:`n$output"
  }
  return $output
}

function Test-GhRepoExists([string]$Repo) {
  gh repo view $Repo --json name 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Test-GhReleaseExists([string]$Repo, [string]$Tag) {
  gh release view $Tag --repo $Repo --json tagName 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

Assert-Command 'gh'
$gitPath = Resolve-Git
$env:PATH = "$(Split-Path $gitPath);$env:PATH"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
  Write-Step 'Checking the local repository'
  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host 'The working tree has uncommitted changes. Only committed content is published, so they will be ignored:' -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "  $_" }
  } else {
    Write-Host 'Working tree clean.'
  }

  $headSha = (git rev-parse HEAD).Trim()
  $headSubject = (git log -1 --pretty=%s).Trim()
  Write-Host "Publishing $headSha ($headSubject)"

  $identity = Invoke-Gh @('api', 'user', '--jq', '.login')
  $userId = Invoke-Gh @('api', 'user', '--jq', '.id')
  $noreply = "$userId+$identity@users.noreply.github.com"
  Write-Host "Commits in the new repository will be authored as $noreply"

  Write-Step 'Exporting the tree'
  $staging = Join-Path ([IO.Path]::GetTempPath()) "cityroam-publish-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
  $tree = Join-Path $staging 'tree'
  New-Item -ItemType Directory -Path $tree -Force | Out-Null
  $zip = Join-Path $staging 'tree.zip'
  git archive --format=zip -o $zip HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed; nothing was published.' }
  Expand-Archive -Path $zip -DestinationPath $tree
  Remove-Item $zip

  $fileCount = (Get-ChildItem -Recurse -File -Force $tree | Measure-Object).Count
  if ($fileCount -eq 0) { throw "The export at $tree is empty; refusing to continue." }
  Write-Host "Exported $fileCount files to $tree"

  Write-Step 'Checking the export'
  $patterns = $ForbiddenPatterns
  $patternFile = Join-Path $repoRoot '.publish-forbidden.txt'
  if (-not $patterns -and (Test-Path $patternFile)) {
    $patterns = Get-Content $patternFile | Where-Object { $_.Trim() -and -not $_.StartsWith('#') } | ForEach-Object { $_.Trim() }
    Write-Host "Using $($patterns.Count) patterns from .publish-forbidden.txt"
  }
  if (-not $patterns) {
    throw 'No patterns to check for. Pass -ForbiddenPatterns or create .publish-forbidden.txt.'
  }
  # git grep -I searches text files only: a plain byte search reports matches inside
  # PNGs and fonts, where any sequence can look like a word. Word boundaries keep short
  # names out of base64 hashes in the lockfile.
  $hits = @()
  foreach ($pattern in $patterns) {
    $regex = "\b$([regex]::Escape($pattern))\b"
    $found = git -C $tree grep --no-index -I -n -i -e $regex
    if ($LASTEXITCODE -gt 1) { throw "git grep failed on pattern '$pattern'." }
    if ($found) { $hits += $found }
  }
  if ($hits) {
    Write-Host 'Forbidden strings found in the export:' -ForegroundColor Red
    $hits | Sort-Object -Unique | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    throw 'Scrub the tree and commit the fix before publishing.'
  }
  Write-Host "No matches for: $($patterns -join ', ')"

  $secretNames = @('credentials.json', 'keystore.properties', 'google-services.json', 'release-local.log')
  $secretExtensions = @('.jks', '.keystore', '.p12', '.p8', '.key', '.mobileprovision')
  $secretFiles = Get-ChildItem -Recurse -File -Force $tree | Where-Object {
    $_.Extension -in $secretExtensions -or
    $_.Name -in $secretNames -or
    ($_.Name -like '.env*' -and $_.Name -ne '.env.example')
  }
  if ($secretFiles) {
    Write-Host 'Credential files are in the export:' -ForegroundColor Red
    $secretFiles | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
    throw 'Those must stay ignored.'
  }
  Write-Host 'No keystores, credentials files or .env files in the export.'

  Write-Host ''
  Write-Host 'Run the secret scanners against this exact tree before going further:' -ForegroundColor Yellow
  Write-Host "  betterleaks dir `"$tree`" --report-format json --report-path <outside the repo> --redact"
  Write-Host "  trufflehog filesystem `"$tree`" --results=verified,unknown,unverified --json"

  if ($ValidateOnly) {
    Write-Host ''
    Write-Host 'Validate-only run finished. Nothing on GitHub was touched.' -ForegroundColor Green
    Write-Host "The exported tree is at $tree"
    exit 0
  }

  Confirm-Or-Exit 'The scanners came back clean (or their findings are understood)?'

  Write-Step 'Renaming the private repository'
  # rename takes the bare name; the owner comes from -R. Passing owner/name fails with
  # "New repository name cannot contain '/' character".
  $archiveName = $ArchiveRepo.Split('/')[-1]
  if (Test-GhRepoExists $ArchiveRepo) {
    Write-Host "$ArchiveRepo already exists, skipping the rename."
  } else {
    Confirm-Or-Exit "This renames $SourceRepo to $ArchiveRepo. GitHub redirects the old name, so anything pointing at it keeps working."
    Invoke-Gh @('repo', 'rename', $archiveName, '-R', $SourceRepo, '--yes') | Out-Null
    Write-Host "Renamed to $ArchiveRepo."
  }

  Write-Step 'Creating the public repository'
  if (Test-GhRepoExists $PublicRepo) {
    Write-Host "$PublicRepo already exists, leaving it alone."
  } else {
    Invoke-Gh @(
      'repo', 'create', $PublicRepo, '--public',
      '--description', 'Ride recorder for Tynee boards and NAVEE scooters. Source-available, not open source.'
    ) | Out-Null
    Write-Host "Created $PublicRepo."
  }

  Write-Step 'Pushing one commit'
  # The exported tree has no repository of its own, so it becomes one directly. Copying
  # its contents with a wildcard would silently drop dotfiles such as .gitignore,
  # .git-blame-ignore-revs and .github/.
  Push-Location $tree
  try {
    git init --initial-branch=main | Out-Null
    git config user.name $identity
    git config user.email $noreply
    git add -A
    git commit --quiet -m "Cityroam $($ReleaseTag.TrimStart('v'))" -m 'First public commit. The previous repository, with its full history, pull requests and issues, stays private.'
    # SSH, not HTTPS: this commit adds .github/workflows, and an HTTPS push authenticated
    # by the gh OAuth token is refused without the workflow scope. Your key already has
    # access, and the existing clone uses SSH too.
    git remote add origin "git@github.com:$PublicRepo.git"
    $current = git ls-remote --heads origin main
    if ($current) {
      Write-Host 'main already exists on the remote; not pushing over it.' -ForegroundColor Yellow
      Write-Host 'Delete it first if you really mean to replace it.'
    } else {
      git push --quiet origin main
      if ($LASTEXITCODE -ne 0) { throw 'git push failed.' }
      Write-Host 'Pushed.'
    }
  } finally {
    Pop-Location
  }

  Write-Step 'Applying repository settings'
  Invoke-Gh @(
    'api', '-X', 'PATCH', "repos/$PublicRepo",
    '-F', 'allow_squash_merge=true',
    '-F', 'allow_merge_commit=false',
    '-F', 'allow_rebase_merge=false',
    '-F', 'delete_branch_on_merge=true',
    '-F', 'squash_merge_commit_title=PR_TITLE',
    '-F', 'squash_merge_commit_message=PR_BODY',
    '-F', 'has_discussions=false',
    '-f', 'security_and_analysis[secret_scanning][status]=enabled',
    '-f', 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
  ) | Out-Null
  Invoke-Gh @(
    'api', '-X', 'PUT', "repos/$PublicRepo/topics",
    '-H', 'Accept: application/vnd.github+json',
    '-f', 'names[]=android', '-f', 'names[]=expo', '-f', 'names[]=react-native',
    '-f', 'names[]=bluetooth', '-f', 'names[]=electric-skateboard', '-f', 'names[]=ride-tracking'
  ) | Out-Null
  Invoke-Gh @('api', '-X', 'PUT', "repos/$PublicRepo/private-vulnerability-reporting") | Out-Null
  Write-Host 'Squash-merge only, discussions off, secret scanning and push protection on, private vulnerability reporting on.'

  Write-Step 'Creating labels'
  $labels = @(
    @('needs-triage', 'D4C5F9', 'New issue, not looked at yet'),
    @('needs-info', 'FBCA04', 'Waiting on more detail from the reporter'),
    @('ready-for-agent', '0E8A16', 'Detailed enough to implement without more questions'),
    @('ready-for-human', '1D76DB', 'Needs a decision or a real device'),
    @('wontfix', 'FFFFFF', 'Not going to be done'),
    @('dependencies', '0366D6', 'Dependency update')
  )
  foreach ($label in $labels) {
    gh label create $label[0] --repo $PublicRepo --color $label[1] --description $label[2] --force | Out-Null
  }
  Write-Host "Created $($labels.Count) labels."

  if (-not $SkipRelease) {
    Write-Step "Recreating the $ReleaseTag release"
    $assets = gh release view $ReleaseTag --repo $ArchiveRepo --json assets --jq '.assets[].name'
    if (-not $assets) {
      Write-Host "No release $ReleaseTag in $ArchiveRepo; skipping." -ForegroundColor Yellow
    } elseif (Test-GhReleaseExists $PublicRepo $ReleaseTag) {
      Write-Host "$PublicRepo already has $ReleaseTag, leaving it alone."
    } else {
      $releaseDir = Join-Path $staging 'release'
      New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
      foreach ($asset in $assets) {
        gh release download $ReleaseTag --repo $ArchiveRepo --pattern $asset --dir $releaseDir
      }
      if (-not $ReleaseNotesFile) {
        $ReleaseNotesFile = Join-Path $staging 'notes.md'
        @'
Android app for Tynee boards and NAVEE scooters.

The APK is signed with the same key as earlier builds, so it installs over an existing
install. Accounts on the default server are invite-only.
'@ | Set-Content $ReleaseNotesFile
        Write-Host "Using default release notes. Pass -ReleaseNotesFile to use your own." -ForegroundColor Yellow
      }
      $files = Get-ChildItem $releaseDir -File | Select-Object -ExpandProperty FullName
      gh release create $ReleaseTag @files --repo $PublicRepo --title "Turbo $ReleaseTag" --notes-file $ReleaseNotesFile
      Write-Host "Recreated $ReleaseTag with $($files.Count) asset(s). The asset name matters: the app parses the version out of it."
    }
  }

  Write-Step 'Left to do by hand'
  Write-Host @"
1. Ruleset on main (squash-only, 'check' required, you on the bypass list). The UI is
   the quickest route: https://github.com/$PublicRepo/settings/rules
2. Let the updater see the new repo:
   - GitHub, Settings, Developer settings, Fine-grained tokens: add $PublicRepo to the
     token's repository access. The token value does not change.
   - On the server: GITHUB_RELEASES_REPO=$PublicRepo in the stack environment, then
     redeploy.
   - In turbo-backend, as a local commit: the default in app/core/config.py, the example
     in .env.example, and the docstring in app/services/app_release.py that calls the
     repo private.
3. Confirm the updater resolves a release:
   curl https://<your-server>/api/v1/app/latest-release
4. Install the Renovate app on $PublicRepo. renovate.json does nothing without it, and
   nothing is running Renovate on the old repo today.
5. Delete the secret that release.yml used, which nothing references any more:
   gh secret delete EXPO_ACCESS_TOKEN -R $ArchiveRepo
6. Point a clone at the new repo, because that is where releases have to be created for
   the updater to see them. Either repoint this clone:
     git remote rename origin archive
     git remote add origin git@github.com:$PublicRepo.git
     git fetch origin
     git checkout -B main origin/main
   or clone $PublicRepo fresh and release from there. That last checkout matters:
   scripts/release-full.ps1 refuses to run unless main matches origin/main, and this
   clone's main has history the new repo does not. The old history stays reachable as
   archive/main and in the private archive repo.
7. Check docs/screenshots for EXIF and for map tiles showing where you live.
8. Delete the staging directory when you are done with it:
     $staging
"@
} finally {
  Pop-Location
}
