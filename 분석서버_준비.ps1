$ErrorActionPreference = 'Stop'
$taskDataDir = Join-Path $env:LOCALAPPDATA 'VideoRandom\catalog'
$taskRuntime = Join-Path $taskDataDir 'runtime'
$taskPython = Join-Path $taskRuntime 'Scripts\python.exe'

Write-Host '영상 분석 서버의 로컬 음성 인식을 준비합니다. API 키는 필요 없습니다.'
if (-not (Test-Path -LiteralPath $taskPython)) {
    $taskPythonCommand = Get-Command python -ErrorAction Stop
    & $taskPythonCommand.Source -m venv $taskRuntime
    if ($LASTEXITCODE -ne 0) { throw 'Python 가상 환경 생성에 실패했습니다.' }
}
& $taskPython -m pip install -r (Join-Path $PSScriptRoot 'scripts\requirements-speech.txt')
if ($LASTEXITCODE -ne 0) { throw '음성 인식 설치에 실패했습니다.' }
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
& $taskPython -c "import os; from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root=os.path.join(os.environ['LOCALAPPDATA'], 'VideoRandom', 'catalog', 'models')); print('로컬 음성 인식 준비 완료')"
if ($LASTEXITCODE -ne 0) { throw '음성 인식 모델 준비에 실패했습니다.' }
Write-Host '준비가 끝났습니다. Codex에서 ChatGPT 계정으로 로그인한 뒤 프로그램의 서버 시작을 누르세요.'
