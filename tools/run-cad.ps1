param(
    [string]$Spec,
    [string]$Output,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (!$Spec) {
    $Spec = Join-Path $project 'cad-worker\fixtures\mounting-plate.json'
}
if (!$Output) {
    $name = 'cad-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    $Output = Join-Path $project ('evidence\replays\' + $name)
}
$Spec = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Spec)
$Output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
$python = Join-Path $project '.venv\Scripts\python.exe'
if ($Install -or !(Test-Path -LiteralPath $python)) {
    $uv = Join-Path $project '.tools\uv.exe'
    $portablePython = Join-Path $project '.tools\python\python.exe'
    if (!(Test-Path -LiteralPath $uv) -or !(Test-Path -LiteralPath $portablePython)) {
        throw 'Provide .tools\uv.exe and .tools\python\python.exe. See README.md.'
    }
    $previousCache = $env:UV_CACHE_DIR
    $previousIndex = $env:UV_DEFAULT_INDEX
    $previousLinkMode = $env:UV_LINK_MODE
    try {
        $env:UV_CACHE_DIR = Join-Path $project '.tools\uv-cache'
        $env:UV_DEFAULT_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
        $env:UV_LINK_MODE = 'copy'
        & $uv sync --project $project --locked --no-build --system-certs --python $portablePython
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    } finally {
        $env:UV_CACHE_DIR = $previousCache
        $env:UV_DEFAULT_INDEX = $previousIndex
        $env:UV_LINK_MODE = $previousLinkMode
    }
}
$previousBlasThreads = $env:OPENBLAS_NUM_THREADS
try {
    # The probe meshes one part and gains nothing from a BLAS thread pool.
    $env:OPENBLAS_NUM_THREADS = '1'
    & $python (Join-Path $project 'cad-worker\build_plate.py') --spec $Spec --out $Output
    $cadExitCode = $LASTEXITCODE
} finally {
    $env:OPENBLAS_NUM_THREADS = $previousBlasThreads
}
exit $cadExitCode
