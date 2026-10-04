<#
.SYNOPSIS
  Installs Office3D's speech gateway outside the repository (Windows).

.DESCRIPTION
  The speech gateway (services/speech): a Python venv with Silero TTS v5 and
  silero-stress (every voice: the system, AM7, the crew) and speech
  recognition (GigaAM v3 + Silero VAD through onnx-asr), plus their model
  weights. Everything runs on the CPU; the GPU stays free for the HQ's 3D.

  Everything lands in -SpeechHome (default %LOCALAPPDATA%\office3d-speech, or
  OFFICE3D_SPEECH_HOME). Nothing is written into the repository. Run it again
  to update; it is idempotent. Start it with `npm run speech`.

  Needs: Python 3.11+ (py launcher or python on PATH) and uv
  (https://docs.astral.sh/uv/).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\speech-setup.ps1
  powershell -ExecutionPolicy Bypass -File scripts\speech-setup.ps1 -SpeechHome D:\speech
#>
param(
  [string]$SpeechHome = "",
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ServiceDir = Join-Path $RepoRoot "services\speech"

function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host "error: $text" -ForegroundColor Red; exit 1 }
function Invoke-Checked([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') exited with $LASTEXITCODE" }
}

if (-not $SpeechHome) { $SpeechHome = $env:OFFICE3D_SPEECH_HOME }
if (-not $SpeechHome) { $SpeechHome = Join-Path $env:LOCALAPPDATA "office3d-speech" }
$SpeechHome = [System.IO.Path]::GetFullPath($SpeechHome)
if ($SpeechHome.StartsWith([System.IO.Path]::GetFullPath($RepoRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
  Fail "SpeechHome must be outside the repository ($SpeechHome)."
}
New-Item -ItemType Directory -Force -Path $SpeechHome | Out-Null
Step "Speech home: $SpeechHome"

# --- tools ------------------------------------------------------------------
if (-not $Python) {
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { $Python = (& py -3.12 -c "import sys; print(sys.executable)" 2>$null) }
  if (-not $Python -and $py) { $Python = (& py -3 -c "import sys; print(sys.executable)" 2>$null) }
  if (-not $Python) { $cmd = Get-Command python -ErrorAction SilentlyContinue; if ($cmd) { $Python = $cmd.Source } }
}
if (-not $Python) { Fail "Python 3.11+ not found. Install it from python.org or pass -Python <path>." }
$version = & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ([version]$version -lt [version]"3.11") { Fail "Python $version is too old; 3.11+ is needed." }
Step "Python $version at $Python"

$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) { Fail "uv not found. Install it: powershell -c `"irm https://astral.sh/uv/install.ps1 | iex`"" }
$uv = $uv.Source
$env:UV_LINK_MODE = "copy"

# --- speech gateway -------------------------------------------------------------
$GatewayVenv = Join-Path $SpeechHome "gateway-venv"
$GatewayPython = Join-Path $GatewayVenv "Scripts\python.exe"
if (-not (Test-Path $GatewayPython)) {
  Step "Creating the gateway venv"
  Invoke-Checked $uv @("venv", $GatewayVenv, "--python", $Python)
}
Step "Installing the gateway's packages (CPU torch)"
Invoke-Checked $uv @("pip", "install", "--python", $GatewayPython, "-r", (Join-Path $ServiceDir "requirements-cpu.txt"))

Step "Downloading Silero, the stress model and GigaAM v3 (speech recognition, ~0.9 GB)"
$env:OFFICE3D_SPEECH_HOME = $SpeechHome
# The same place `npm run speech` gives the gateway.
$env:HF_HOME = Join-Path $SpeechHome "hf"
Push-Location $ServiceDir
try { Invoke-Checked $GatewayPython @("-m", "speech_gateway.tools", "prefetch") } finally { Pop-Location }

Step "Done. Start the speech gateway with: npm run speech"
if ($SpeechHome -ne (Join-Path $env:LOCALAPPDATA "office3d-speech")) {
  Write-Host "Add to .env: OFFICE3D_SPEECH_HOME=$SpeechHome"
}
