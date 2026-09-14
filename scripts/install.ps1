# Installs the Iskra CLI from a GitHub Release archive on Windows. Needs
# only PowerShell 5.1+; no Node, npm, or compiler.
#
#   irm https://iskra.sh/install.ps1 | iex
#
# Environment:
#   ISKRA_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   ISKRA_VERSION           exact version to install (overrides ISKRA_CHANNEL)
#   ISKRA_HOME              Iskra home directory (default: ~\.iskra)
#   ISKRA_INSTALL_BIN_DIR   where iskra.exe is linked (default: ~\.local\bin)
#   ISKRA_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $ISKRA_HOME\runtime\versions\<version>, the
# same layout `iskra service install` uses, so the service reuses this download.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "boroworx/iskra"
$baseUrl = if ($env:ISKRA_RELEASE_BASE_URL) { $env:ISKRA_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
$iskraHome = if ($env:ISKRA_HOME) { $env:ISKRA_HOME } else { Join-Path $HOME ".iskra" }
$binDir = if ($env:ISKRA_INSTALL_BIN_DIR) { $env:ISKRA_INSTALL_BIN_DIR } else { Join-Path $HOME ".local\bin" }

function Fail([string] $message) {
  Write-Error "iskra install: $message"
  exit 1
}

# PROCESSOR_ARCHITEW6432 reports the real machine when a 32-bit PowerShell
# runs under WOW64; RuntimeInformation needs .NET 4.7.1+, which 5.1 hosts
# may lack.
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($rawArch) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "unsupported architecture $rawArch" }
}

$channel = if ($env:ISKRA_CHANNEL) { $env:ISKRA_CHANNEL } else { "stable" }
$version = $env:ISKRA_VERSION
if (-not $version) {
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  $tagPattern = switch ($channel) {
    "stable" { '^v\d+\.\d+\.\d+$' }
    "nightly" { '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$' }
    "preview" { '^v\d+\.\d+\.\d+-preview\.\d+\.\d+$' }
    default { Fail "ISKRA_CHANNEL must be stable, nightly, or preview" }
  }
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ "User-Agent" = "iskra-install" }
  $tag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match $tagPattern } | Select-Object -First 1).tag_name
  if (-not $tag) { Fail "could not find a $channel release; set ISKRA_VERSION" }
  $version = $tag.Substring(1)
}
if ($version -match '-preview\.') {
  Write-Warning "iskra $version is a preview build. Preview builds are cut by maintainers from unreleased branches to exercise the release pipeline. They can be broken, receive no fixes, and are never offered as updates. Set ISKRA_CHANNEL=stable (the default) for a supported build."
  if ($channel -ne "preview" -and -not $env:ISKRA_VERSION) {
    Fail "refusing a preview build that was not explicitly requested"
  }
}

$stem = "iskra-$version-win32-$arch"
$archive = "$stem.zip"
$versionsDir = Join-Path $iskraHome "runtime\versions"
$targetDir = Join-Path $versionsDir $version
$marker = Join-Path $targetDir ".install-complete"

if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $version)) {
  Write-Host "iskra $version is already installed at $targetDir"
} else {
  New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
  $staging = Join-Path $versionsDir (".staging-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $staging | Out-Null
  try {
    Write-Host "Downloading $archive..."
    try {
      Invoke-WebRequest -Uri "$baseUrl/v$version/SHA256SUMS" -OutFile (Join-Path $staging "SHA256SUMS") -UseBasicParsing
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 404) {
        Fail "iskra $version has no release archive for win32-$arch; releases before the self-contained CLI can only be installed with 'npm install -g @iskra/cli@$version'"
      }
      throw
    }
    Invoke-WebRequest -Uri "$baseUrl/v$version/$archive" -OutFile (Join-Path $staging $archive) -UseBasicParsing

    $expected = (Get-Content (Join-Path $staging "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1)
    if (-not $expected) { Fail "$archive is not listed in SHA256SUMS" }
    $expected = ($expected -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $staging $archive)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "checksum mismatch for $archive" }

    Expand-Archive -Path (Join-Path $staging $archive) -DestinationPath $staging -Force
    # The archive wraps everything in one directory named after its stem.
    Get-ChildItem (Join-Path $staging $stem) | Move-Item -Destination $staging
    Remove-Item (Join-Path $staging $stem), (Join-Path $staging $archive), (Join-Path $staging "SHA256SUMS") -Recurse -Force

    & (Join-Path $staging "iskra.exe") --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "the downloaded executable does not run" }
    Set-Content -Path (Join-Path $staging ".install-complete") -Value $version -NoNewline

    if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
    Move-Item $staging $targetDir
  } catch {
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    throw
  }
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir "iskra.cmd"
# UTF-8 without a BOM: cmd.exe reads the shim as-is, and ASCII would corrupt
# non-ASCII characters in the user's home path.
[System.IO.File]::WriteAllText($shim, "@echo off`r`n`"$(Join-Path $targetDir 'iskra.exe')`" %*", (New-Object System.Text.UTF8Encoding $false))
Write-Host "Installed iskra $version"
Write-Host "  $shim -> $(Join-Path $targetDir 'iskra.exe')"
if (($env:PATH -split ";") -notcontains $binDir) {
  Write-Host "Add $binDir to your PATH to run iskra."
}
