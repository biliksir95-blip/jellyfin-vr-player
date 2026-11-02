param(
    [ValidateSet('all', 'jf10', 'jf12')][string]$Target = 'all',
    [string]$DotnetExe = 'dotnet',
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'plugin.json') -Raw | ConvertFrom-Json
if ($metadata.version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'plugin.json version must contain four numeric components.' }
if ($metadata.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid GitHub repository in plugin.json.' }
$distPath = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $distPath | Out-Null
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
if (-not $env:DOTNET_CLI_HOME) { $env:DOTNET_CLI_HOME = Join-Path $projectRoot '.tools/cli-home' }
if (-not $env:NUGET_PACKAGES) { $env:NUGET_PACKAGES = Join-Path $projectRoot '.nuget/packages' }
$projectPath = Join-Path $projectRoot 'src/Jellyfin.Plugin.VrPlayer/Jellyfin.Plugin.VrPlayer.csproj'
$testPath = Join-Path $projectRoot 'tests/Jellyfin.Plugin.VrPlayer.SmokeTests/Jellyfin.Plugin.VrPlayer.SmokeTests.csproj'
$timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$tag = "v$($metadata.version)"
$versions = @()

foreach ($build in $metadata.targets) {
    if ($Target -ne 'all' -and $Target -ne $build.buildTarget) { continue }
    if (-not $SkipTests) {
        & $DotnetExe run --project $testPath -c Release "-p:JellyfinTarget=$($build.buildTarget)" --no-launch-profile
        if ($LASTEXITCODE -ne 0) { throw "Smoke tests failed: $($build.name)" }
    }
    $publishPath = Join-Path $distPath "staging/$($build.name)/publish"
    & $DotnetExe publish $projectPath -c Release "-p:JellyfinTarget=$($build.buildTarget)" "-p:Version=$($metadata.version)" -o $publishPath --nologo -v minimal
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $($build.name)" }

    $bundlePath = Join-Path $distPath "staging/$($build.name)/bundle"
    New-Item -ItemType Directory -Force -Path $bundlePath | Out-Null
    Copy-Item -LiteralPath (Join-Path $publishPath 'Jellyfin.Plugin.VrPlayer.dll') -Destination $bundlePath
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $bundlePath
    Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination $bundlePath
    Copy-Item -LiteralPath (Join-Path $projectRoot 'third_party/three/LICENSE') -Destination (Join-Path $bundlePath 'THREE-LICENSE.txt')
    $pluginManifest = [ordered]@{
        id = $metadata.guid; name = $metadata.name; version = $metadata.version
        targetAbi = $build.targetAbi; overview = $metadata.overview
        description = $metadata.description; owner = $metadata.owner
        category = $metadata.category; timestamp = $timestamp; status = 'Active'
    }
    [IO.File]::WriteAllText((Join-Path $bundlePath 'meta.json'), ($pluginManifest | ConvertTo-Json -Depth 8) + "`n")
    $archiveName = "Jellyfin.Plugin.VrPlayer_$($metadata.version)_$($build.name).zip"
    $archivePath = Join-Path $distPath $archiveName
    $files = @('Jellyfin.Plugin.VrPlayer.dll', 'meta.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THREE-LICENSE.txt') | ForEach-Object { Join-Path $bundlePath $_ }
    Compress-Archive -LiteralPath $files -DestinationPath $archivePath -Force

    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($archive.Entries.Count -ne 5 -or 'Jellyfin.Plugin.VrPlayer.dll' -notin $archive.Entries.FullName) {
            throw "Invalid plugin ZIP: $archiveName"
        }
    } finally { $archive.Dispose() }
    $versions += [ordered]@{
        version = $metadata.version; changelog = $metadata.changelog
        targetAbi = $build.targetAbi
        sourceUrl = "https://github.com/$($metadata.repository)/releases/download/$tag/$archiveName"
        checksum = (Get-FileHash -LiteralPath $archivePath -Algorithm MD5).Hash.ToLowerInvariant()
        timestamp = $timestamp
    }
    Write-Host "Packaged $archiveName"
}

$existingManifestPath = Join-Path $projectRoot 'manifest.json'
if (Test-Path -LiteralPath $existingManifestPath) {
    $previous = @(Get-Content -LiteralPath $existingManifestPath -Raw | ConvertFrom-Json) | Where-Object { $_.guid -eq $metadata.guid }
    foreach ($old in $previous.versions) {
        $replaced = $versions | Where-Object { $_.version -eq $old.version -and $_.targetAbi -eq $old.targetAbi }
        if (-not $replaced) { $versions += $old }
    }
}
$catalog = @([ordered]@{
    guid = $metadata.guid; name = $metadata.name; owner = $metadata.owner
    overview = $metadata.overview; description = $metadata.description
    category = $metadata.category; versions = @($versions)
})
[IO.File]::WriteAllText((Join-Path $distPath 'manifest.json'), (ConvertTo-Json -InputObject $catalog -Depth 12) + "`n")
$source = [IO.File]::ReadAllText((Join-Path $projectRoot 'Jellyfin_VR_Player.js'))
$import = @{ CustomJavaScripts = @(@{ Name = 'Jellyfin VR Player'; Script = $source; Enabled = $true; RequiresAuthentication = $false; Src = ''; Module = $false }) }
[IO.File]::WriteAllText((Join-Path $distPath 'Jellyfin_VR_Player.import.json'), (ConvertTo-Json -InputObject $import -Depth 6) + "`n")
Write-Host "Repository manifest: $(Join-Path $distPath 'manifest.json')"
