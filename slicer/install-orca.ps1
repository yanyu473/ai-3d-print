[CmdletBinding()]
param([string]$Archive)

$ErrorActionPreference = 'Stop'
$release = 'v2.5.0'
$asset = 'OrcaSlicer_Windows_V2.5.0_x64_portable.zip'
$expectedHash = 'e355d9f8ac0be4efa4b4f99ecae448d4e99def8dee97683847ede5aa0ccb9166'
$source = "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/$release/$asset"
$runtime = Join-Path $PSScriptRoot 'runtime'
$installation = Join-Path $runtime "OrcaSlicer-$release"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

if (-not $Archive) {
    $Archive = Join-Path $runtime $asset
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
        $partial = "$Archive.partial"
        & curl.exe --fail --location --silent --show-error --connect-timeout 15 --max-time 420 --output $partial $source
        if ($LASTEXITCODE -ne 0) { throw "Official OrcaSlicer release download failed (curl exit $LASTEXITCODE)." }
        Move-Item -LiteralPath $partial -Destination $Archive
    }
}

$Archive = (Resolve-Path -LiteralPath $Archive).Path
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $expectedHash) {
    throw "The archive does not match the SHA-256 published for OrcaSlicer $release Windows x64."
}
if (Test-Path -LiteralPath $installation) {
    throw "The target already exists: $installation. Use its executable for a prior verified extraction."
}

New-Item -ItemType Directory -Path $installation | Out-Null
& tar.exe -xf $Archive -C $installation
if ($LASTEXITCODE -ne 0) { throw "OrcaSlicer archive extraction failed (tar exit $LASTEXITCODE)." }

$programs = @(Get-ChildItem -LiteralPath $installation -File -Recurse -Filter 'orca-slicer.exe')
if ($programs.Count -ne 1) { throw 'Expected exactly one OrcaSlicer executable in the official portable archive.' }
Write-Output $programs[0].FullName
