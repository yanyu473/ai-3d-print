param([string]$Spec, [string]$Output)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (!$Output) {
    $name = 'offline-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $Output = Join-Path $project ('evidence\replays\' + $name)
}
$Output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if (Test-Path -LiteralPath $Output) {
    throw "Choose a new output directory: $Output"
}
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$slicer = Join-Path $project 'slicer-wasm\probe.mjs'
$cadArgs = @{ Output = (Join-Path $Output 'cad') }
if ($Spec) {
    $cadArgs.Spec = $Spec
}
& (Join-Path $PSScriptRoot 'run-cad.ps1') @cadArgs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $node $slicer $cadArgs.Output (Join-Path $Output 'slicing')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Output "Verified local CAD and slice: $Output"
