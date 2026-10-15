# 자막 품질 검증 · 1.6.0

한국어 번역을 켠 Codex / 서버의 정확도 우선 새 분석은 원본 전체 음성을 무손실로 전달하고 `large-v3`로 전사합니다. 일부 SRT가 있다는 이유로 음성 인식을 생략하지 않습니다. 이미 정확 모드로 전체 처리를 검증한 자료는 복구에서 재사용합니다. 발화 검출은 긴 무음 뒤의 인식 창 경계와 언어 감지 위치를 계획하는 데 사용하며, 미검출 구간도 모두 전사합니다. 전체 인식 뒤 발화 범위와 대사 시간을 대조하고 누락·낮은 신뢰도 구간을 제한된 범위에서 다시 확인합니다. 한국어 번역은 모든 원문 구간을 번역한 뒤 원문과 다시 대조합니다. 원어 인식의 틀린 단어를 번역 모델이 사실처럼 고쳐 썼다고 간주하지 않습니다.

## 실제 음성 비교

자료: [Google FLEURS](https://huggingface.co/datasets/google/fleurs), Google, CC BY 4.0. 일본어 `ja_jp`, 중국어 `cmn_hans_cn`의 test split 첫 3개씩, 공개 변환 데이터 revision `168de341b3db6859a9bac1c50a2ef5e3b47647e0`. 사용자 영상·대사는 사용하지 않았습니다.

6개 원본에 언어별로 2개의 파생 자료를 더한 10개 사례입니다.

- 원본: 일본어 3개, 중국어 3개.
- 큰 소리 다음 작은 소리: 첫 표본 뒤 3초를 띄우고 두 번째 표본을 진폭 6%로 이어 붙였습니다. 표준편차 0.0002인 고정 난수 잡음을 추가했습니다.
- 창 경계: 84초 무음 뒤 첫 표본, 2초 무음 뒤 두 번째 표본을 배치해 90초 인식 창의 경계를 지나게 했습니다.

비교 대상은 1.5.1의 실제 Python 스크립트(`small`, CPU int8)와 1.6.0 정확도 우선입니다. 문장부호·공백·대소문자·전각 표기 영향을 줄이려고 NFKC 정규화 후 영숫자만 남긴 문자 오류율(CER)을 계산합니다. 언어별 합계는 각 문장의 오류율 평균이 아니라 전체 오류 문자 수 / 전체 정답 문자 수입니다. 음향 기준 정답 시간은 제공되지 않으므로 시간 정확도 수치로 해석할 수 없습니다.

검증 PC: Windows, Intel i7-10700F, RAM 32GB, NVIDIA RTX 3070 8GB. 정확 모드의 실제 CUDA `int8_float16` 모델 로딩과 encoder 실행을 확인했습니다. GPU와 CPU, 모델 시작 비용이 다르므로 처리 속도 비교 수치로 사용하지 않습니다.

## 재현

음성 인식 가상 환경에 선택적 벤치마크 의존성 `pyarrow`가 필요합니다. 아래 준비 명령은 약 1.3GB의 공개 데이터 shard를 내려받습니다. 개인 영상은 읽지 않습니다. 데이터·모델·실행 결과 폴더는 Git에서 제외합니다.

```powershell
$taskPython = Join-Path $env:LOCALAPPDATA 'VideoRandom\catalog\runtime\Scripts\python.exe'
$taskModels = Join-Path $env:LOCALAPPDATA 'VideoRandom\catalog\models'
& $taskPython -m pip install pyarrow
& $taskPython scripts/prepare_subtitle_benchmark.py --output .test-data/subtitle-quality-benchmark
git show bb440aa:scripts/transcribe_local.py | Set-Content .test-data/legacy_transcribe_local.py -Encoding utf8
& $taskPython scripts/benchmark_subtitles.py --manifest .test-data/subtitle-quality-benchmark/manifest.json --legacy-script .test-data/legacy_transcribe_local.py --cache $taskModels --output artifacts/subtitle-quality-benchmark --device auto
```

`results.json`에는 각 사례의 원문·인식문·CER·모델·전체 처리 길이·누락 확인 결과가, `summary.json`에는 언어별 합계가 저장됩니다. 각 실행의 JSONL도 별도로 저장됩니다. `--profiles accurate` 또는 `--device cpu`로 비교 범위를 지정할 수 있습니다. `--reuse-accurate-model`은 같은 CLI의 `main()`을 호출하면서 모델 객체만 재사용합니다. 초기화 시간이 달라지므로 속도 비교에는 사용하지 않습니다. 준비 단계의 `--include-auto-language-case`는 긴 무음 뒤 일본어를 자동 감지하는 11번째 검증 사례를 추가합니다.

## 회귀 검증 범위와 한계

자동 검증은 창 경계의 시간과 중복, 짧은 발화 누락, 긴 무음 뒤 발화, 누락 확인·재확인 예산, 저신뢰 원문 보존, 모델 폴백, 부분 번역 체크포인트, 원문 ID/개수/시간 보존, LAN 무손실 전송과 크기 제한, 구형 서버 안내, 클라이언트 SRT 자동 저장과 기존 파일 보존을 다룹니다. 2시간 길이는 모형 음성과 모형 인식기로 처음·중간·마지막 대사와 전체 타임라인 처리를 검증했습니다. 실제 2시간 영상을 전사한 시험은 아닙니다. 실제 Codex 한국어 번역도 공개 일본어·중국어 인식문으로 실행해 날짜·숫자와 모든 구간 시간을 확인했습니다.

이 표본은 작은 회귀 자료이며 영화·다중 화자·배경 음악·방언·2시간 영상의 전체 품질을 보증하지 않습니다. 고유명사나 작은 소리는 여전히 틀릴 수 있습니다. 전체 처리·발화 범위 검사는 인식한 단어가 모두 정확하다는 증명이 아닙니다. 오류와 미해결 구간을 표시하고 이전 결과를 보존하므로, 원문과 대조한 뒤 필요한 영상만 명시적으로 다시 분석할 수 있습니다.
