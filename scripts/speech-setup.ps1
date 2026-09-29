<#
.SYNOPSIS
  Installs Office3D's speech engines outside the repository (Windows).

.DESCRIPTION
  - the speech gateway (services/speech): a Python venv with Silero TTS v5 and
    silero-stress, and speech recognition (GigaAM v3 + Silero VAD through
    onnx-asr, on the CPU), plus their model weights;
  - VoiceStudio's backend (headless, no desktop app): cloned, its own venv
    via uv, the VoxCPM2 engine in VoiceStudio's sidecar venv, and the
    Whisper weights (only the fallback recogniser now; -SkipAsr leaves them out).

  Everything lands in -SpeechHome (default %LOCALAPPDATA%\office3d-speech, or
  OFFICE3D_SPEECH_HOME). Nothing is written into the repository. Run it again
  to update; it is idempotent. Start both with `npm run speech`.

  Needs: Python 3.11+ (py launcher or python on PATH), git, and uv
  (https://docs.astral.sh/uv/). A GPU is optional: NVIDIA → CUDA 12.8 wheels.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\speech-setup.ps1
  powershell -ExecutionPolicy Bypass -File scripts\speech-setup.ps1 -SpeechHome D:\speech -Torch cpu -SkipVoxcpm2 -AsrModel Systran/faster-whisper-medium
#>
param(
  [string]$SpeechHome = "",
  [ValidateSet("auto", "cpu", "cu128")]
  [string]$Torch = "auto",
  [string]$Python = "",
  [string]$VoiceStudioRepo = "https://github.com/debpalash/VoiceStudio.git",
  [string]$VoiceStudioRef = "v0.5.6",
  [string]$AsrModel = "Systran/faster-whisper-large-v3",
  [switch]$SkipVoiceStudio,
  [switch]$SkipVoxcpm2,
  [switch]$SkipAsr
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
if (-not $SkipVoiceStudio -and -not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found." }
$env:UV_LINK_MODE = "copy"

if ($Torch -eq "auto") {
  $Torch = "cpu"
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    & nvidia-smi -L *> $null
    if ($LASTEXITCODE -eq 0) { $Torch = "cu128" }
  }
}
Step "Torch build: $Torch"

# --- speech gateway -------------------------------------------------------------
$GatewayVenv = Join-Path $SpeechHome "gateway-venv"
$GatewayPython = Join-Path $GatewayVenv "Scripts\python.exe"
if (-not (Test-Path $GatewayPython)) {
  Step "Creating the gateway venv"
  Invoke-Checked $uv @("venv", $GatewayVenv, "--python", $Python)
}
Step "Installing the gateway's packages"
Invoke-Checked $uv @("pip", "install", "--python", $GatewayPython, "-r", (Join-Path $ServiceDir "requirements-$Torch.txt"))

Step "Downloading Silero, the stress model and GigaAM v3 (speech recognition, ~0.9 GB)"
$env:OFFICE3D_SPEECH_HOME = $SpeechHome
# The same place `npm run speech` gives the gateway.
$env:HF_HOME = Join-Path $SpeechHome "hf"
Push-Location $ServiceDir
try { Invoke-Checked $GatewayPython @("-m", "speech_gateway.tools", "prefetch") } finally { Pop-Location }

# --- VoiceStudio ------------------------------------------------------------------
if ($SkipVoiceStudio) { Step "Skipping VoiceStudio (-SkipVoiceStudio)"; exit 0 }

$VsDir = Join-Path $SpeechHome "voicestudio"
if (-not (Test-Path (Join-Path $VsDir ".git"))) {
  Step "Cloning VoiceStudio ($VoiceStudioRef)"
  Invoke-Checked git @("clone", "--depth", "1", "--branch", $VoiceStudioRef, $VoiceStudioRepo, $VsDir)
} else {
  Step "Updating VoiceStudio to $VoiceStudioRef"
  Invoke-Checked git @("-C", $VsDir, "fetch", "--depth", "1", "origin", $VoiceStudioRef)
  Invoke-Checked git @("-C", $VsDir, "checkout", "--detach", "FETCH_HEAD")
}

Step "Installing VoiceStudio's backend (uv sync; several GB on the first run)"
Push-Location $VsDir
try {
  Invoke-Checked $uv @("sync", "--no-dev", "--python", $Python)
  # cuDNN 8 for CTranslate2 (Whisper) on CUDA; checks the VC++ runtime.
  $env:PYTHONIOENCODING = "utf-8"
  Invoke-Checked (Join-Path $VsDir ".venv\Scripts\python.exe") @("scripts\setup.py")
} finally { Pop-Location }

$VsData = Join-Path $SpeechHome "voicestudio-data"
$HfHome = Join-Path $SpeechHome "hf"
New-Item -ItemType Directory -Force -Path $VsData, $HfHome, (Join-Path $SpeechHome "logs") | Out-Null

if ($SkipVoxcpm2 -and $SkipAsr) { Step "Skipping VoxCPM2 and the Whisper weights"; exit 0 }

Step "Starting VoiceStudio once to install its engine and models"
$env:OMNIVOICE_DATA_DIR = $VsData
$env:HF_HOME = $HfHome
$env:OMNIVOICE_BIND_HOST = "127.0.0.1"
$env:OMNIVOICE_PORT = "3900"
$env:PYTHONUTF8 = "1"
$log = Join-Path $SpeechHome "logs\voicestudio-setup.log"
$vs = Start-Process -FilePath (Join-Path $VsDir ".venv\Scripts\python.exe") -ArgumentList "backend\main.py" `
  -WorkingDirectory $VsDir -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 3
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:3900/health" -TimeoutSec 5
      if ($health.status -eq "ok") { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { Fail "VoiceStudio did not start; see $log" }
  Push-Location $ServiceDir
  try {
    if (-not $SkipVoxcpm2) {
      Step "Installing VoxCPM2 (its own sidecar venv)"
      Invoke-Checked $GatewayPython @("-m", "speech_gateway.tools", "voicestudio-install", "voxcpm2")
      Step "Downloading VoxCPM2's weights (about 5 GB)"
      Invoke-Checked $GatewayPython @("-m", "speech_gateway.tools", "voicestudio-warm", "voxcpm2")
    }
    if (-not $SkipAsr) {
      Step "Downloading VoiceStudio's fallback speech-recognition model $AsrModel"
      Invoke-Checked $GatewayPython @("-m", "speech_gateway.tools", "voicestudio-model", $AsrModel)
    }
  } finally { Pop-Location }
} finally {
  & taskkill /PID $vs.Id /T /F *> $null
}

Step "Done. Start the speech services with: npm run speech"
if ($SpeechHome -ne (Join-Path $env:LOCALAPPDATA "office3d-speech")) {
  Write-Host "Add to .env: OFFICE3D_SPEECH_HOME=$SpeechHome"
}
