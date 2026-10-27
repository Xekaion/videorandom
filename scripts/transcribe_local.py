"""Stream ASR with full-audio processing and an independent coverage audit."""
import argparse
from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout, wait as wait_futures, FIRST_COMPLETED
import gc
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unicodedata

SAMPLE_RATE = 16000
MAX_UNRESOLVED = 200
MAX_BOUNDARY_RANGES = 10000
RECOGNITION_REVISION = 3
DLL_DIRECTORY_HANDLES = []
DLL_DIRECTORY_PATHS = set()
DLL_LIBRARY_HANDLES = []
DLL_LIBRARY_PATHS = set()
GPU_PARALLEL_MIN_FREE_MIB = 4096
GPU_PARALLEL_RESERVE_MIB = 2048


def nvidia_smi_executable(environment=None, platform=None):
    """Locate an installed utility without relying only on the app's PATH."""
    executable = shutil.which('nvidia-smi')
    if executable and Path(executable).is_absolute():
        return executable
    if (platform or sys.platform) != 'win32':
        return None
    settings = environment if environment is not None else os.environ

    def setting(name):
        return next((value for key, value in settings.items() if key.upper() == name), '')

    candidates = []
    for name in ('SYSTEMROOT', 'WINDIR'):
        root = Path(setting(name))
        if root.is_absolute():
            candidates.append(root / 'System32' / 'nvidia-smi.exe')
    for name in ('PROGRAMW6432', 'PROGRAMFILES'):
        root = Path(setting(name))
        if root.is_absolute():
            candidates.append(root / 'NVIDIA Corporation' / 'NVSMI' / 'nvidia-smi.exe')
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def gpu_memory_available():
    """Optional capacity hint only; unknown/mapped devices stay serial in auto."""
    if os.environ.get('CUDA_VISIBLE_DEVICES', '0') != '0':
        return None
    try:
        executable = nvidia_smi_executable()
        if not executable:
            return None
        result = subprocess.run([executable, '--id=0', '--query-gpu=memory.free,memory.total',
                                 '--format=csv,noheader,nounits'], capture_output=True, text=True,
                                timeout=5, check=True,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        lines = result.stdout.strip().splitlines()
        if len(lines) != 1:
            return None
        free, total = (int(value.strip()) for value in lines[0].split(','))
        return (free, total) if 0 <= free <= total else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def requested_workers(value, device, memory=None):
    if str(value) not in ('auto', '1', '2'):
        raise ValueError('음성 인식 병렬 수는 auto, 1, 2 중에서 선택해야 합니다.')
    if device != 'cuda' or str(value) == '1':
        return 1
    if str(value) == '2':
        return 2
    return 2 if memory and memory[1] >= 8192 and memory[0] >= GPU_PARALLEL_MIN_FREE_MIB else 1


def gpu_out_of_memory(error):
    message = str(error).lower()
    return isinstance(error, (RuntimeError, OSError)) and any(marker in message for marker in
        ('cuda_error_out_of_memory', 'cuda out of memory', 'cuda failed with error out of memory',
         'cuda error: out of memory', 'cuda error out of memory', 'cublas_status_alloc_failed'))


def decode_windows(model, audio, windows, options, sample_rate, state, emitter, waiting=None):
    """Keep two ordinary decoders busy, emitting only in source order.

    At most four finished successor windows can wait for a slow predecessor.
    Decoding settings, ownership, and alignment remain unchanged. Completed
    work is retained on OOM, and only failed windows are retried serially once.
    """
    def decode(window):
        start, end, _, _ = window
        chunk = audio[round(start * sample_rate):round(end * sample_rate)]
        segments, _ = model.transcribe(chunk, **options)
        return list(segments)

    if state['workers'] < 2 or len(windows) < 2:
        for index, window in enumerate(windows):
            start, end, _, _ = window
            segments, _ = model.transcribe(audio[round(start * sample_rate):round(end * sample_rate)], **options)
            yield index, window, segments
        return

    def settle(future, index):
        while True:
            try:
                return future.result(timeout=10)
            except FutureTimeout:
                if future.done():
                    return future.result()
                if waiting:
                    waiting(index)

    cursor, next_output = 0, 0
    active, ready = {}, {}
    failure_seen = False
    # Four successor results plus the currently owned window. This also bounds
    # submitted work when the consumer pauses at a checkpoint or output yield.
    max_outstanding = 5
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix='videorandom-asr') as executor:
        def fill():
            nonlocal cursor
            while not failure_seen and cursor < len(windows) and len(active) < 2 \
                    and len(active) + len(ready) < max_outstanding:
                active[cursor] = executor.submit(decode, windows[cursor])
                cursor += 1

        def collect(index):
            nonlocal failure_seen
            future = active.pop(index)
            try:
                ready[index] = (settle(future, index), None)
            except Exception as error:
                failure_seen = True
                if gpu_out_of_memory(error):
                    error.__traceback__ = None
                ready[index] = (None, error)

        fill()
        while next_output < len(windows):
            if next_output not in ready:
                # Prefer an already finished owner. Refill before yielding it,
                # just as before; otherwise observe whichever worker finishes.
                owner = active.get(next_output)
                if owner is not None and owner.done():
                    collect(next_output)
                else:
                    completed, _ = wait_futures(active.values(), timeout=10, return_when=FIRST_COMPLETED)
                    if not completed:
                        if waiting:
                            waiting(next_output)
                        continue
                    for index in sorted(index for index, future in active.items() if future in completed):
                        collect(index)
                fill()
                if next_output not in ready:
                    continue
            segments, error = ready.pop(next_output)
            if error is not None:
                if not gpu_out_of_memory(error):
                    for future in active.values():
                        future.cancel()
                    raise error
                # Drain every started decoder before a serial retry. No work
                # is submitted after observing a failure, even out of order.
                for index in sorted(list(active)):
                    collect(index)
                error.__traceback__ = None
                for _, other_error in ready.values():
                    if other_error is not None and not gpu_out_of_memory(other_error):
                        raise other_error
                    if other_error is not None:
                        other_error.__traceback__ = None
                state.update(workers=1, oomFallback=True)
                emitter({'type': 'warning', 'message': 'GPU 병렬 처리의 메모리가 부족해 남은 구간을 한 번에 하나씩 처리합니다. '
                         '완료된 구간은 유지하며 같은 모델과 인식 설정을 사용합니다.'})
                gc.collect()
                yield next_output, windows[next_output], decode(windows[next_output])
                for index in range(next_output + 1, cursor):
                    saved, failed = ready.pop(index)
                    yield index, windows[index], decode(windows[index]) if failed is not None else saved
                for index in range(cursor, len(windows)):
                    yield index, windows[index], decode(windows[index])
                return
            fill()
            yield next_output, windows[next_output], segments
            next_output += 1


def batched_pipeline_class():
    """Resolve the optional batch API without silently running the old decoder."""
    try:
        from faster_whisper import BatchedInferencePipeline
    except ImportError as error:
        raise RuntimeError('초고속 음성 인식에는 BatchedInferencePipeline을 지원하는 faster-whisper 1.2.1이 필요합니다. '
                           '분석 서버의 음성 인식 환경을 다시 준비해 주세요.') from error
    return BatchedInferencePipeline


def turbo_clip_timestamps(sample_count, sample_rate):
    """Describe every input sample with adjacent clips of at most 30 seconds.

    faster-whisper 1.2.1 takes explicit clips in seconds and converts their
    edges with int(seconds * sample_rate). A clip longer than 30 seconds is
    truncated by its encoder. These are decoding bounds, not subtitle times.
    """
    maximum = max(1, int(30 * sample_rate))

    def seconds(sample):
        # A floating point round trip must not move an edge back one sample.
        return math.nextafter(sample / sample_rate, math.inf) if sample else 0.0

    return [{'start': seconds(start), 'end': seconds(min(sample_count, start + maximum))}
            for start in range(0, sample_count, maximum)]


def decode_turbo_windows(pipeline, audio, windows, options, sample_rate, state, emitter):
    """Use one serial pipeline; batching is internal and bounded to four clips.

    Commit a complete window atomically. If CUDA runs out of memory, retain
    all earlier windows and retry only this window once with batch size one.
    Other failures and a failed low-memory retry are surfaced immediately.
    """
    for index, window in enumerate(windows):
        start, end, _, _ = window
        chunk = audio[round(start * sample_rate):round(end * sample_rate)]
        clips = turbo_clip_timestamps(len(chunk), sample_rate)

        def decode():
            segments, _ = pipeline.transcribe(chunk, **options, clip_timestamps=clips,
                                              batch_size=state['batchSize'])
            return list(segments)

        try:
            segments = decode()
        except Exception as error:
            if state['batchSize'] <= 1 or not gpu_out_of_memory(error):
                raise
            error.__traceback__ = None
            state.update(batchSize=1, oomFallback=True)
            # The batch generator resets this at normal completion. A failed
            # generator must not leave cross-window alignment state behind.
            pipeline.last_speech_timestamp = 0.0
            gc.collect()
            emitter({'type': 'warning', 'message': '초고속 GPU 일괄 처리의 메모리가 부족해 현재 구간만 한 번 다시 처리하고 '
                     '남은 구간은 배치 1로 처리합니다. 완료된 구간과 모델은 유지합니다.'})
            segments = decode()
        yield index, window, segments


def transcribe_turbo_audio(model, audio, *, model_name='turbo', language='auto', device='cpu',
                           compute_type='int8', sample_rate=SAMPLE_RATE, emitter=None,
                           pipeline_factory=None):
    """Explicit speed/quality tradeoff; never advertise an independent audit."""
    emitter = emitter or emit
    duration = len(audio) / sample_rate
    if not finite(duration) or duration <= 0:
        raise ValueError('음성 파일이 비어 있거나 길이가 올바르지 않습니다.')
    pipeline = (pipeline_factory or batched_pipeline_class())(model)
    state = {'workers': 1, 'batchSize': 4 if device == 'cuda' else 1, 'oomFallback': False}
    warning = ('초고속 모드는 빠른 모델과 단일 탐색을 사용하며 독립적인 음성 누락 재검수와 단어별 시간 정렬을 생략합니다. '
               '모든 입력 음성을 처리하지만 정확 모드보다 인식 오류나 누락이 늘 수 있습니다.')
    warnings, cues, processed = [warning], [], 0.0
    emitter({'type': 'warning', 'message': warning})
    selected_language, probability = choose_language(model, audio, duration, language, sample_rate)
    emitter({'type': 'info', 'language': selected_language, 'languageProbability': probability,
             'duration': duration, 'model': model_name, 'profile': 'turbo', 'device': device,
             'computeType': compute_type, 'workers': 1, 'batchSize': state['batchSize']})
    options = dict(beam_size=1, best_of=1, temperature=0.0, word_timestamps=False,
                   without_timestamps=False, task='transcribe', condition_on_previous_text=False,
                   language=selected_language, vad_filter=False)
    cores = plan_core_windows(duration, [])
    windows = [(max(0.0, start - 2.0), min(duration, end + 2.0), start, end) for start, end in cores]
    for window, (start, _, core_start, core_end), segments in decode_turbo_windows(
            pipeline, audio, windows, options, sample_rate, state, emitter):
        for segment in segments:
            for cue in cues_from_segment(segment, start, duration, (core_start, core_end),
                                         word_timestamps_expected=False):
                cues.append({**cue, '_window': window, '_boundary': core_start})
                emitter({'type': 'segment', **cue})
        # Only a fully consumed generator, including an empty silent tail,
        # advances coverage. Neither clip edges nor percentages create cues.
        processed = core_end
        emitter({'type': 'progress', 'phase': 'transcription', 'completedSeconds': processed,
                 'totalSeconds': duration, 'percent': 100.0 * processed / duration,
                 'workers': 1, 'batchSize': state['batchSize']})
    cues = reconcile_window_boundaries(cues)
    quality = {'profile': 'turbo', 'model': model_name, 'device': device, 'computeType': compute_type,
               'workers': 1, 'batchSize': state['batchSize'], 'parallelMemoryFallback': state['oomFallback'],
               'recognitionRevision': RECOGNITION_REVISION, 'processingComplete': processed == duration,
               'durationSeconds': duration, 'processedSeconds': processed, 'wordTimestamps': False,
               'audit': {'complete': False, 'speechSeconds': 0.0, 'uncoveredSpeechSeconds': 0.0,
                         'unresolvedSpeechSeconds': 0.0, 'boundaryUncertaintySeconds': 0.0, 'boundaryRanges': [],
                         'recheckedSeconds': 0.0, 'recoveryBudgetSeconds': 0.0, 'unresolved': [],
                         'unresolvedCount': 0, 'unresolvedByReason': {}, 'unresolvedTruncated': False},
               'warnings': warnings}
    emitter({'type': 'transcript', 'segments': cues})
    emitter({'type': 'progress', 'phase': 'completed', 'completedSeconds': processed,
             'totalSeconds': duration, 'percent': 100.0, 'workers': 1, 'batchSize': state['batchSize']})
    emitter({'type': 'complete', 'segments': len(cues), 'quality': quality})
    return cues, quality


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, allow_nan=False), flush=True)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def field(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def merge_intervals(intervals, duration, padding=0.0):
    """Padding is for audit math only, never exported subtitle timestamps."""
    valid = sorted((max(0.0, float(start) - padding), min(duration, float(end) + padding))
                   for start, end in intervals if finite(start) and finite(end) and end > start
                   and end > 0 and start < duration)
    merged = []
    for start, end in valid:
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def uncovered_intervals(speech, covered, duration, minimum=0.0):
    coverage = merge_intervals(covered, duration)
    result, coverage_index = [], 0
    for start, end in merge_intervals(speech, duration):
        # Both unions are ordered and nonoverlapping. Reuse the left edge of
        # the search without dropping an interval that spans several speech
        # ranges; every gap still uses the original, exact comparisons.
        while coverage_index < len(coverage) and coverage[coverage_index][1] <= start:
            coverage_index += 1
        cursor = start
        for index in range(coverage_index, len(coverage)):
            left, right = coverage[index]
            if right <= cursor:
                continue
            if left >= end:
                break
            if left > cursor and min(left, end) - cursor >= minimum:
                result.append((cursor, min(left, end)))
            cursor = max(cursor, right)
            if cursor >= end:
                break
        if end - cursor >= minimum and end > cursor:
            result.append((cursor, end))
    return result


def coverage_for(cues, duration):
    intervals = []
    for cue in cues:
        words = cue.get('words') or []
        intervals.extend((word['start'], word['end']) for word in words)
        if not words:
            intervals.append((cue['start'], cue['end']))
    return merge_intervals(intervals, duration, padding=0.25)


def audit_gaps(speech, covered, duration):
    raw = uncovered_intervals(speech, covered, duration)
    # Keep the real total, including short gaps. Several short utterances must
    # never disappear because each was below an individual review threshold.
    return raw, review_gaps(raw)


def review_gaps(raw):
    return raw if sum(end - start for start, end in raw) > 0.25 else [
        (start, end) for start, end in raw if end - start >= 0.25]


def high_confidence(cue):
    probability = cue_confidence(cue)
    return (not low_confidence(cue) and probability is not None and probability >= 0.7
            and (not finite(cue.get('avgLogprob')) or cue['avgLogprob'] >= -0.5)
            and (not finite(cue.get('noSpeechProbability')) or cue['noSpeechProbability'] <= 0.4))


def separate_boundary_uncertainty(raw_gaps, speech, cues, duration, diagnostics=None):
    """Separate VAD/ASR edge disagreement without extending subtitle times."""
    confident = coverage_for([cue for cue in cues if high_confidence(cue)], duration)
    eligible, coverage_index = [], 0
    for start, end in speech:
        while coverage_index < len(confident) and confident[coverage_index][1] <= start:
            coverage_index += 1
        covered, local, index = 0.0, [], coverage_index
        while index < len(confident):
            left, right = confident[index]
            if left >= end:
                break
            overlap = max(0.0, min(end, right) - max(start, left))
            if overlap:
                covered += overlap
                local.append((left, right))
            index += 1
        if end > start and covered / (end - start) >= 0.7:
            eligible.append((start, end, local))
    remaining, boundary, span_index = [], [], 0
    for start, end in raw_gaps:
        while span_index < len(eligible) and eligible[span_index][1] <= start:
            span_index += 1
        matched = False
        if end - start <= 0.6 + 1e-9 and span_index < len(eligible):
            left, right, local = eligible[span_index]
            if start >= left - 1e-9 and end <= right + 1e-9:
                leading = abs(start - left) <= 1e-6 and any(abs(end - begin) <= 1e-6 for begin, _ in local)
                trailing = abs(end - right) <= 1e-6 and any(abs(start - finish) <= 1e-6 for _, finish in local)
                matched = leading or trailing
        if matched and len(boundary) < MAX_BOUNDARY_RANGES:
            boundary.append({'start': start, 'end': end, 'reason': 'speech_boundary_uncertainty'})
        else:
            remaining.append((start, end))
            if matched and diagnostics is not None:
                diagnostics.setdefault('boundaryLimitExceeded', {'start': start, 'end': end})
    return remaining, boundary


def plan_core_windows(duration, speech, maximum=90.0):
    """Add advisory cuts before speech after long silence; never skip audio."""
    transitions, previous_end = [], 0.0
    for start, end in merge_intervals(speech, duration):
        if start - previous_end >= 10.0:
            transitions.append(max(0.0, start - 1.0))
        previous_end = end
    windows, cursor = [], 0.0
    for cut in transitions:
        while cursor + maximum < cut:
            windows.append((cursor, cursor + maximum))
            cursor += maximum
        if cut > cursor + 0.5 and cut < duration - 0.5:
            windows.append((cursor, cut))
            cursor = cut
    while cursor < duration:
        end = min(duration, cursor + maximum)
        windows.append((cursor, end))
        cursor = end
    return windows


def cue_confidence(cue):
    probabilities = [word['probability'] for word in cue.get('words', [])
                     if finite(word.get('probability'))]
    if probabilities:
        return sum(probabilities) / len(probabilities)
    value = cue.get('avgLogprob')
    return math.exp(min(0.0, value)) if finite(value) else None


def low_confidence(cue):
    probability = cue_confidence(cue)
    return ((probability is not None and probability < 0.45)
            or (finite(cue.get('avgLogprob')) and cue['avgLogprob'] < -1.0)
            or (finite(cue.get('noSpeechProbability')) and cue['noSpeechProbability'] > 0.8))


def needs_review(cue):
    # Missing word alignment is a timing-granularity limitation, not evidence
    # that correctly decoded dialogue or its valid segment times are missing.
    return low_confidence(cue)


def needs_alignment_review(cue):
    return not cue.get('words')


def very_quiet_stationary_noise(audio, start, end, sample_rate):
    """Recognize only near-silent stationary noise, not merely VAD-missed audio."""
    left = max(0, int((start - 0.08) * sample_rate))
    right = min(len(audio), int((end + 0.08) * sample_rate))
    if right - left < max(1, int(sample_rate * 0.12)):
        return False
    frame_size = max(1, int(sample_rate * 0.02))
    squares, peak, crossed, product, previous, frame_sum = 0.0, 0.0, 0, 0.0, None, 0.0
    nonzero_count = 0
    energies = []
    for index in range(left, right):
        value = float(audio[index])
        if not math.isfinite(value):
            return False
        square = value * value
        squares += square
        frame_sum += square
        peak = max(peak, abs(value))
        # Peak can only increase. One sample above the same final absolute
        # limit already proves this is not near-silent stationary noise.
        if peak > 10 ** (-55 / 20):
            return False
        nonzero_count += value != 0
        if previous is not None:
            crossed += value * previous < 0
            product += value * previous
        previous = value
        if (index - left + 1) % frame_size == 0:
            energies.append(math.sqrt(frame_sum / frame_size))
            frame_sum = 0.0
    count = right - left
    rms = math.sqrt(squares / count)
    # Absolute levels are deliberately conservative. Loud/normal/quiet speech
    # stays available even if VAD did not detect it or Whisper was uncertain.
    if rms > 10 ** (-70 / 20) or peak > 10 ** (-55 / 20):
        return False
    if peak <= 1e-7:
        return True
    if len(energies) < 4 or squares <= 0:
        return False
    # Quantized recording tails can be mostly exact zero with a tiny slow DC
    # remnant. Their varying RMS is not stationary noise, but is still distinct
    # from even very quiet short voiced sounds. Keep any oscillating/voice-like
    # active fragment instead of relying on the proportion of silence alone.
    if (rms <= 10 ** (-90 / 20) and peak <= 10 ** (-65 / 20)
            and sum(value == 0 for value in energies) / len(energies) >= 0.8
            and crossed / max(1, nonzero_count - 1) <= 0.005):
        return True
    ordered = sorted(energies)
    low, high = ordered[int((len(ordered) - 1) * 0.1)], ordered[int((len(ordered) - 1) * 0.9)]
    stationary = high / max(low, 1e-12) <= 1.8
    noise_like = crossed / max(1, count - 1) >= 0.3 and abs(product / squares) <= 0.15
    return stationary and noise_like


class SpeechOverlapIndex:
    """Index only finite interval bounds; preserve the exact strict predicate.

    The VAD union is normally ordered and disjoint. Prefix maxima also support
    overlapping or unordered finite input without changing endpoint decisions.
    Non-finite/malformed bounds use the original predicate instead of assuming
    that Python's min/max comparisons follow ordinary interval algebra.
    """
    def __init__(self, speech):
        self.speech = speech
        self.starts, self.ends = [], []
        self.indexed = False
        try:
            # A legacy one-shot iterator has observable consumption across
            # queries. Leave it on the original path rather than exhaust it.
            if iter(speech) is speech:
                return
            self.indexed = all(finite(start) and finite(end) for start, end in speech)
        except (TypeError, ValueError):
            return
        if not self.indexed:
            return
        maximum = -math.inf
        for start, end in sorted((start, end) for start, end in speech if end > start):
            self.starts.append(start)
            maximum = max(maximum, end)
            self.ends.append(maximum)

    def overlaps(self, start, end):
        if not self.indexed or not finite(start) or not finite(end):
            return any(max(start, left) < min(end, right) for left, right in self.speech)
        if start >= end:
            return False
        index = bisect_left(self.starts, end) - 1
        return index >= 0 and self.ends[index] > start


def prune_non_speech_artifacts(cues, audio, speech, sample_rate):
    kept, removed = [], []
    speech_index = None
    for cue in cues:
        # Only low-confidence cues can be removed. Do not repeatedly search
        # the full speech union for dialogue that will be kept in any case.
        if not low_confidence(cue):
            kept.append(cue)
            continue
        if speech_index is None:
            speech_index = SpeechOverlapIndex(speech)
        intersects_speech = speech_index.overlaps(cue['start'] - 0.08, cue['end'] + 0.08)
        if (not intersects_speech
                and very_quiet_stationary_noise(audio, cue['start'], cue['end'], sample_rate)):
            removed.append({'start': cue['start'], 'end': cue['end'], 'reason': 'very_quiet_non_speech'})
        else:
            kept.append(cue)
    return kept, removed


def cues_from_segment(segment, offset, duration, ownership=None, word_timestamps_expected=True):
    """Use aligned word boundaries or preserve native segment times intact."""
    text = str(field(segment, 'text', '')).strip()
    raw_start, raw_end = field(segment, 'start'), field(segment, 'end')
    if not text or not finite(raw_start) or not finite(raw_end) or raw_end <= raw_start:
        return []
    start, end = max(0.0, raw_start + offset), min(duration, raw_end + offset)
    if end <= start:
        return []
    metadata = {}
    for source_name, target_name in [('avg_logprob', 'avgLogprob'), ('no_speech_prob', 'noSpeechProbability')]:
        value = field(segment, source_name)
        if finite(value):
            metadata[target_name] = value
    words = []
    invalid_words = False
    for raw in field(segment, 'words', []) or []:
        left, right, probability = field(raw, 'start'), field(raw, 'end'), field(raw, 'probability')
        word = field(raw, 'word')
        if (not finite(left) or not finite(right) or right <= left or not isinstance(word, str)
                or not word.strip() or not finite(probability) or not 0 <= probability <= 1):
            invalid_words = True
            continue
        left, right = max(0.0, left + offset), min(duration, right + offset)
        if right <= left:
            invalid_words = True
            continue
        if ownership and not ownership[0] <= (left + right) / 2 < ownership[1]:
            continue
        if words and (left < words[-1]['start'] or right < words[-1]['end'] - 0.02):
            invalid_words = True
            continue
        words.append({'start': left, 'end': right, 'word': word, 'probability': probability})
    if not words or invalid_words:
        if ownership and not (start < ownership[1] and end > ownership[0]):
            return []
        cue = {'start': start, 'end': end, 'text': text, **metadata}
        if invalid_words:
            cue['qualityFlags'] = ['invalid_word_timestamps']
        else:
            cue['qualityFlags'] = ['word_timestamps_unavailable' if word_timestamps_expected else 'segment_timestamps']
        if low_confidence(cue):
            cue.setdefault('qualityFlags', []).append('low_confidence')
        return [cue]
    groups, group = [], []
    for word in words:
        previous_text = ''.join(item['word'] for item in group).strip()
        if group and word['start'] >= group[-1]['end'] - 1e-6 and (word['end'] - group[0]['start'] > 6.0 or len(previous_text + word['word']) > 56
                      or word['start'] - group[-1]['end'] > 0.8
                      or (previous_text.endswith(('.', '?', '!', '。', '？', '！'))
                          and group[-1]['end'] - group[0]['start'] >= 1.2)):
            groups.append(group)
            group = []
        group.append(word)
    if group:
        groups.append(group)
    cues = []
    for words in groups:
        cue = {'start': words[0]['start'], 'end': max(word['end'] for word in words),
               'text': ''.join(word['word'] for word in words).strip(), 'words': words, **metadata}
        if low_confidence(cue):
            cue['qualityFlags'] = ['low_confidence']
        cues.append(cue)
    return cues


def reconcile_window_boundaries(cues):
    """Deduplicate matching observations from adjacent decoding windows only."""
    kept, by_window, text_indexes = [], {}, {}
    def text_key(text):
        return ''.join(text.split())
    def matching_previous(window, kind, text):
        # Keep only equal-text observations in the expensive timing check.
        # Build lazily so unused malformed legacy metadata retains its old
        # behavior; out-of-order insertion invalidates only that window.
        indexes = text_indexes.setdefault(window, {})
        if kind not in indexes:
            index = {}
            try:
                for item in by_window.get(window, ()):
                    observations = item.get('words', []) if kind == 'word' else (item,)
                    for observation in observations:
                        index.setdefault(text_key(observation[kind]), []).append(observation)
            except (KeyError, TypeError, AttributeError):
                index = None
            indexes[kind] = index
        index = indexes[kind]
        return None if index is None else index.get(text_key(text), ())
    def same_observation(left, right, boundary):
        if not left['start'] <= boundary <= left['end'] or not right['start'] <= boundary <= right['end']:
            return False
        overlap = min(left['end'], right['end']) - max(left['start'], right['start'])
        return overlap > 0.02 and overlap / min(left['end'] - left['start'], right['end'] - right['start']) >= 0.3
    for original in cues:
        cue = {**original}
        window, boundary = cue.get('_window', 0), cue.get('_boundary', 0)
        # Preserve insertion order even for out-of-order window input, while
        # searching only the observations from the preceding window.
        previous = by_window.get(window - 1, ())
        words = cue.get('words')
        if words:
            filtered = []
            for word in words:
                candidates = matching_previous(window - 1, 'word', word['word'])
                if candidates is None:
                    duplicate = any(text_key(word['word']) == text_key(old['word'])
                        and same_observation(word, old, boundary)
                        and abs(word['start'] - old['start']) <= 0.4 and abs(word['end'] - old['end']) <= 0.4
                        for item in previous for old in item.get('words', []))
                else:
                    duplicate = any(same_observation(word, old, boundary)
                        and abs(word['start'] - old['start']) <= 0.4 and abs(word['end'] - old['end']) <= 0.4
                        for old in candidates)
                if not duplicate:
                    filtered.append(word)
            if not filtered:
                continue
            cue.update(words=filtered, start=filtered[0]['start'], end=max(word['end'] for word in filtered),
                       text=''.join(word['word'] for word in filtered).strip())
        else:
            candidates = matching_previous(window - 1, 'text', cue['text'])
            if candidates is None:
                duplicate = any(text_key(cue['text']) == text_key(old['text']) and same_observation(cue, old, boundary)
                                for old in previous)
            else:
                duplicate = any(same_observation(cue, old, boundary) for old in candidates)
            if duplicate:
                continue
        kept.append(cue)
        # A missing window was historically distinct from explicit window 0
        # when matching previous observations; retain that distinction.
        by_window.setdefault(cue.get('_window'), []).append(cue)
        text_indexes.pop(cue.get('_window'), None)
    return sorted([{key: value for key, value in cue.items() if not key.startswith('_')}
                   for cue in kept], key=lambda cue: (cue['start'], cue['end']))


def recovery_windows(targets, duration, budget, maximum=30.0):
    """Plan nonoverlapping review cores; budget counts their owned samples."""
    windows, used = [], 0.0
    for start, end in merge_intervals(targets, duration, padding=1.5):
        cursor = start
        while cursor < end and used < budget:
            right = min(end, cursor + maximum, cursor + budget - used)
            if right <= cursor:
                break
            windows.append((cursor, right))
            used += right - cursor
            cursor = right
    return windows


def recovery_plan(targets, duration, maximum=30.0, context=3.0):
    """Own each target sample once; decode context across internal core cuts."""
    spans = merge_intervals(targets, duration, padding=1.5)
    cores = recovery_windows(targets, duration, duration, maximum)
    plan, span_index = [], 0
    for core_start, core_end in cores:
        while span_index + 1 < len(spans) and core_start >= spans[span_index][1]:
            span_index += 1
        start, end = spans[span_index]
        plan.append((max(start, core_start - context), min(end, core_end + context), core_start, core_end))
    return plan


def rebuild_word_cues(words, templates, duration):
    if not words:
        return []
    words = sorted(words, key=lambda word: (word['start'], word['end']))
    raw = {'start': min(word['start'] for word in words), 'end': max(word['end'] for word in words),
           'text': ''.join(word['word'] for word in words).strip(), 'words': words}
    logprobs = [cue['avgLogprob'] for cue in templates if finite(cue.get('avgLogprob'))]
    silence = [cue['noSpeechProbability'] for cue in templates if finite(cue.get('noSpeechProbability'))]
    if logprobs:
        raw['avg_logprob'] = min(logprobs)
    if silence:
        raw['no_speech_prob'] = max(silence)
    return cues_from_segment(raw, 0, duration)


class RecoveryTargetIndex:
    """Reuse the unchanged target predicates without a full scan per word.

    Prefix end bounds only exclude impossible intervals. Word intersections
    still use the original subtraction and tolerance, including at boundaries.
    """
    def __init__(self, targets):
        self.intervals, self.unordered = [], []
        for start, end in targets:
            if start <= end:
                self.intervals.append((start, end))
            elif not start > end:
                # Normal recognition targets are finite. Preserve Python's
                # original min/max behavior even for an unordered NaN input.
                self.unordered.append((start, end))
        self.intervals.sort()
        self.starts = [start for start, _ in self.intervals]
        self.ends = []
        maximum = -math.inf
        for _, end in self.intervals:
            maximum = max(maximum, end)
            self.ends.append(maximum)

    def contains(self, point):
        if point != point:
            return False
        index = bisect_right(self.starts, point) - 1
        return index >= 0 and self.ends[index] >= point

    def overlaps(self, start, end):
        if any(min(end, right) - max(start, left) > 0.001 for left, right in self.unordered):
            return True
        index = bisect_left(self.starts, end) - 1
        while index >= 0 and self.ends[index] > start:
            left, right = self.intervals[index]
            if min(end, right) - max(start, left) > 0.001:
                return True
            index -= 1
        return False


def recovery_candidates_for_targets(cues, targets, duration):
    """Select actual aligned words; a context cue's midpoint can miss its tail."""
    targets = targets if isinstance(targets, RecoveryTargetIndex) else RecoveryTargetIndex(targets)
    selected = []
    for cue in cues:
        if targets.contains((cue['start'] + cue['end']) / 2):
            # Preserve the established full-cue recovery path. A detector can
            # start after the actual opening word; trimming to its span would
            # discard native decoded dialogue even though this cue is in scope.
            selected.append(cue)
        elif cue.get('words'):
            words = [word for word in cue['words'] if targets.overlaps(word['start'], word['end'])]
            selected.extend(rebuild_word_cues(words, [cue], duration))
    return selected


def word_time_overlap(left, right):
    overlap = min(left['end'], right['end']) - max(left['start'], right['start'])
    return overlap > 0.001 and overlap / min(left['end'] - left['start'], right['end'] - right['start']) > 0.35


def _merge_novel_recovery_words_linear(result, candidate):
    """Keep valid new words even when their decoding cue contains old context."""
    result, novel, blocked = list(result), [], False
    for word in candidate['words']:
        conflict = False
        for index, old in enumerate(result):
            existing = old.get('words') or [{'start': old['start'], 'end': old['end']}]
            if any(word_time_overlap(word, previous) for previous in existing):
                conflict = True
                break
            if (not old.get('words') and min(old['end'], word['end'])
                    - max(old['start'], word['start']) > 0.001):
                # Native segment text cannot be sliced to make room for an
                # overlapping word. Preserve it, and make this ambiguity visible.
                flags = list(dict.fromkeys(old.get('qualityFlags', []) + ['recovery_alignment_conflict']))
                result[index] = {**old, 'qualityFlags': flags}
                conflict, blocked = True, True
                break
        if not conflict:
            novel.append(word)
    if not novel:
        return result, 0, blocked
    outside = []
    for word in novel:
        touching = [index for index, old in enumerate(result) if old.get('words')
                    and min(old['end'], word['end']) - max(old['start'], word['start']) > 0.001]
        if touching:
            old_cues = [result.pop(index) for index in reversed(touching)]
            words = [previous for old in old_cues for previous in old['words']] + [word]
            result.extend(rebuild_word_cues(words, old_cues + [candidate],
                                           max(old['end'] for old in old_cues + [candidate])))
        else:
            outside.append(word)
    # Do not group added words across an existing subtitle interval. This keeps
    # old dialogue in place and avoids introducing overlapping SRT captions.
    buckets = {}
    for word in outside:
        position = sum(old['end'] <= word['start'] for old in result)
        buckets.setdefault(position, []).append(word)
    for words in buckets.values():
        result.extend(rebuild_word_cues(words, [candidate], max(word['end'] for word in words)))
    return result, len(novel), blocked


def recovery_index_eligible(cues):
    """Index ordinary decoded lists only; retain legacy handling otherwise."""
    if not isinstance(cues, (list, tuple)):
        return False
    for cue in cues:
        if not isinstance(cue, dict) or not finite(cue.get('start')) or not finite(cue.get('end')) \
                or cue['end'] <= cue['start']:
            return False
        words = cue.get('words') or []
        if not isinstance(words, (list, tuple)):
            return False
        if any(not isinstance(word, dict) or not finite(word.get('start')) or not finite(word.get('end'))
               or word['end'] <= word['start'] for word in words):
            return False
    return True


class RecoveryCueIndex:
    """Mutable time envelopes with stable source-order leaves.

    Leaves keep the original insertion order even when a merged cue removes
    several predecessors and appends replacements. Bounds conservatively
    include both native cue and word times; exact predicates still decide at
    each leaf. Tombstones avoid shifting every later subtitle on each merge.
    """
    def __init__(self, cues):
        self.cues = list(cues)
        self.size = 1
        while self.size < len(self.cues):
            self.size *= 2
        self._rebuild()

    def _rebuild(self):
        self.starts = [math.inf] * (self.size * 2)
        self.ends = [-math.inf] * (self.size * 2)
        self.minimum_ends = [math.inf] * (self.size * 2)
        self.maximum_ends = [-math.inf] * (self.size * 2)
        self.counts = [0] * (self.size * 2)
        for index, cue in enumerate(self.cues):
            self._leaf(index, cue)
        for node in range(self.size - 1, 0, -1):
            self._combine(node)

    def _leaf(self, index, cue):
        node = self.size + index
        self.starts[node], self.ends[node] = math.inf, -math.inf
        self.minimum_ends[node], self.maximum_ends[node] = math.inf, -math.inf
        self.counts[node] = 0
        if cue is not None:
            words = cue.get('words') or []
            self.starts[node] = min([cue['start']] + [word['start'] for word in words])
            self.ends[node] = max([cue['end']] + [word['end'] for word in words])
            self.minimum_ends[node] = self.maximum_ends[node] = cue['end']
            self.counts[node] = 1

    def _combine(self, node):
        left, right = node * 2, node * 2 + 1
        self.starts[node] = min(self.starts[left], self.starts[right])
        self.ends[node] = max(self.ends[left], self.ends[right])
        self.minimum_ends[node] = min(self.minimum_ends[left], self.minimum_ends[right])
        self.maximum_ends[node] = max(self.maximum_ends[left], self.maximum_ends[right])
        self.counts[node] = self.counts[left] + self.counts[right]

    def replace(self, index, cue):
        self.cues[index] = cue
        self._leaf(index, cue)
        node = (self.size + index) // 2
        while node:
            self._combine(node)
            node //= 2

    def remove(self, index):
        cue = self.cues[index]
        self.replace(index, None)
        return cue

    def extend(self, cues):
        for cue in cues:
            index = len(self.cues)
            if index == self.size:
                self.size *= 2
                self._rebuild()
            self.cues.append(cue)
            self.replace(index, cue)

    def overlapping(self, start, end):
        pending = [1]
        while pending:
            node = pending.pop()
            if not self.counts[node] or self.ends[node] <= start or self.starts[node] >= end:
                continue
            if node < self.size:
                pending.extend((node * 2 + 1, node * 2))
            else:
                yield node - self.size

    def ends_at_or_before(self, point):
        count, pending = 0, [1]
        while pending:
            node = pending.pop()
            if not self.counts[node] or self.minimum_ends[node] > point:
                continue
            if self.maximum_ends[node] <= point:
                count += self.counts[node]
            else:
                pending.extend((node * 2, node * 2 + 1))
        return count

    def fits(self, candidate, excluded):
        return not any(index != excluded and min(candidate['end'], self.cues[index]['end'])
                       - max(candidate['start'], self.cues[index]['start']) > 0.02
                       for index in self.overlapping(candidate['start'], candidate['end']))

    def values(self):
        return [cue for cue in self.cues if cue is not None]


def _merge_novel_recovery_words_indexed(result, candidate):
    novel, blocked = [], False
    for word in candidate['words']:
        conflict = False
        for index in result.overlapping(word['start'], word['end']):
            old = result.cues[index]
            existing = old.get('words') or [{'start': old['start'], 'end': old['end']}]
            if any(word_time_overlap(word, previous) for previous in existing):
                conflict = True
                break
            if (not old.get('words') and min(old['end'], word['end'])
                    - max(old['start'], word['start']) > 0.001):
                flags = list(dict.fromkeys(old.get('qualityFlags', []) + ['recovery_alignment_conflict']))
                result.replace(index, {**old, 'qualityFlags': flags})
                conflict, blocked = True, True
                break
        if not conflict:
            novel.append(word)
    if not novel:
        return 0, blocked
    outside = []
    for word in novel:
        touching = [index for index in result.overlapping(word['start'], word['end'])
                    if result.cues[index].get('words') and min(result.cues[index]['end'], word['end'])
                    - max(result.cues[index]['start'], word['start']) > 0.001]
        if touching:
            old_cues = [result.remove(index) for index in reversed(touching)]
            words = [previous for old in old_cues for previous in old['words']] + [word]
            result.extend(rebuild_word_cues(words, old_cues + [candidate],
                                           max(old['end'] for old in old_cues + [candidate])))
        else:
            outside.append(word)
    buckets = {}
    for word in outside:
        position = result.ends_at_or_before(word['start'])
        buckets.setdefault(position, []).append(word)
    for words in buckets.values():
        result.extend(rebuild_word_cues(words, [candidate], max(word['end'] for word in words)))
    return len(novel), blocked


def merge_novel_recovery_words(result, candidate):
    if not recovery_index_eligible(result) or not recovery_index_eligible([candidate]):
        return _merge_novel_recovery_words_linear(result, candidate)
    indexed = RecoveryCueIndex(result)
    added, blocked = _merge_novel_recovery_words_indexed(indexed, candidate)
    return indexed.values(), added, blocked


def transcript_key(text):
    return ''.join(character.lower() for character in unicodedata.normalize('NFKC', text)
                   if character.isalnum())


def recheck_improves(old, candidate):
    """A resolved log/silence signal matters even when word scores are equal."""
    old_score, new_score = cue_confidence(old), cue_confidence(candidate)
    if not needs_review(old) or needs_review(candidate) or old_score is None or new_score is None:
        return False
    if new_score >= old_score + 0.1:
        return True
    if not high_confidence(candidate):
        return False
    old_log, new_log = old.get('avgLogprob'), candidate.get('avgLogprob')
    old_silence, new_silence = old.get('noSpeechProbability'), candidate.get('noSpeechProbability')
    return ((finite(old_log) and finite(new_log) and old_log < -1.0 and new_log >= -0.5
             and new_log - old_log >= 0.3)
            or (finite(old_silence) and finite(new_silence) and old_silence > 0.8
                and new_silence <= 0.4 and old_silence - new_silence >= 0.3))


def recheck_fits_neighbors(candidates, original, old_index, replacements=None):
    replacements = replacements or {}
    return not any(min(cue['end'], neighbor['end']) - max(cue['start'], neighbor['start']) > 0.02
                   for cue in candidates for index, old in enumerate(original) if index != old_index
                   for neighbor in replacements.get(index, [old]))


class RecoveryNeighborIndex:
    """Skip distant neighbors, updating bounds when a recheck replaces a cue.

    Internal nodes contain conservative time envelopes only. At a leaf, the
    authoritative cue times and original 0.02-second comparison decide. A
    replacement may extend outside the original cue, so its leaf and ancestors
    are updated before the next recheck; no original bounds are assumed valid.
    """
    def __init__(self, original):
        self.original, self.replacements = original, {}
        self.size = 1
        while self.size < len(original):
            self.size *= 2
        self.starts, self.ends = [math.inf] * (self.size * 2), [-math.inf] * (self.size * 2)
        for index, cue in enumerate(original):
            self.starts[self.size + index] = cue['start']
            self.ends[self.size + index] = cue['end']
        for index in range(self.size - 1, 0, -1):
            self.starts[index] = min(self.starts[index * 2], self.starts[index * 2 + 1])
            self.ends[index] = max(self.ends[index * 2], self.ends[index * 2 + 1])

    def replace(self, index, cues):
        self.replacements[index] = cues
        node = self.size + index
        self.starts[node] = min((cue['start'] for cue in cues), default=math.inf)
        self.ends[node] = max((cue['end'] for cue in cues), default=-math.inf)
        node //= 2
        while node:
            self.starts[node] = min(self.starts[node * 2], self.starts[node * 2 + 1])
            self.ends[node] = max(self.ends[node * 2], self.ends[node * 2 + 1])
            node //= 2

    def fits(self, candidates, old_index):
        for cue in candidates:
            pending = [1]
            while pending:
                node = pending.pop()
                if self.ends[node] <= cue['start'] or self.starts[node] >= cue['end']:
                    continue
                if node < self.size:
                    pending.extend((node * 2, node * 2 + 1))
                    continue
                index = node - self.size
                if index == old_index or index >= len(self.original):
                    continue
                for neighbor in self.replacements.get(index, [self.original[index]]):
                    if min(cue['end'], neighbor['end']) - max(cue['start'], neighbor['start']) > 0.02:
                        return False
        return True


def concordant_rechecks(original, candidates):
    """Confirm a native cue across several independently decoded reading cues."""
    used, replacements = set(), {}
    # A recovery normally contains thousands of cues far away from the current
    # native subtitle. Cache eligibility once, then search its inclusive time
    # range. Keep the original candidate index for stable tie ordering and use.
    eligible = []
    for index, cue in enumerate(candidates):
        score = cue_confidence(cue)
        if cue.get('words') and not needs_review(cue) and score is not None and score >= 0.7:
            eligible.append(((cue['start'] + cue['end']) / 2, index, cue))
    eligible.sort(key=lambda entry: (entry[0], entry[1]))
    midpoints = [midpoint for midpoint, _, _ in eligible]
    neighbors = RecoveryNeighborIndex(original)
    for old_index, old in enumerate(original):
        if not (needs_review(old) or needs_alignment_review(old)):
            continue
        left = bisect_left(midpoints, old['start'])
        right = bisect_right(midpoints, old['end'])
        matches = [(index, cue) for _, index, cue in eligible[left:right] if index not in used]
        matches.sort(key=lambda pair: (pair[1]['start'], pair[1]['end'], pair[0]))
        if not matches or not transcript_key(old['text']):
            continue
        if transcript_key(''.join(cue['text'] for _, cue in matches)) != transcript_key(old['text']):
            continue
        covered = merge_intervals([(cue['start'], cue['end']) for _, cue in matches], old['end'])
        overlap = sum(max(0.0, min(end, old['end']) - max(start, old['start'])) for start, end in covered)
        if overlap / (old['end'] - old['start']) < 0.7:
            continue
        # Do not displace a neighboring native subtitle to fit the new reading
        # breaks. Its actual words and times remain authoritative observations.
        if not neighbors.fits([cue for _, cue in matches], old_index):
            continue
        flag = 'rechecked_confidence' if needs_review(old) else 'rechecked_alignment'
        replacements[old_index] = [{**cue, 'qualityFlags': list(dict.fromkeys(cue.get('qualityFlags', []) + [flag]))}
                                   for _, cue in matches]
        neighbors.replace(old_index, replacements[old_index])
        used.update(index for index, _ in matches)
    result = [cue for index, old in enumerate(original) for cue in replacements.get(index, [old])]
    return result, [cue for index, cue in enumerate(candidates) if index not in used], len(used)


def _merge_recovery_linear(original, candidates):
    """Keep established dialogue unless a better aligned recheck replaces it."""
    result, candidates, accepted = concordant_rechecks(original, candidates)
    for candidate in candidates:
        if needs_review(candidate):
            continue
        overlaps = []
        for index, cue in enumerate(result):
            overlap = max(0.0, min(cue['end'], candidate['end']) - max(cue['start'], candidate['start']))
            if overlap > 0.15 and overlap / min(cue['end'] - cue['start'], candidate['end'] - candidate['start']) > 0.35:
                overlaps.append((index, cue, overlap))
        if len(overlaps) == 1:
            index, old, overlap = overlaps[0]
            if (recheck_improves(old, candidate) and overlap / (old['end'] - old['start']) >= 0.7
                    and recheck_fits_neighbors([candidate], result, index)):
                result[index] = {**candidate, 'qualityFlags': list(dict.fromkeys(
                    candidate.get('qualityFlags', []) + ['rechecked_confidence']))}
                accepted += 1
                continue
        if candidate.get('words'):
            result, added, blocked = _merge_novel_recovery_words_linear(result, candidate)
            if added or blocked:
                accepted += added
                continue
        if overlaps:
            continue
        result.append(candidate)
        accepted += 1
    return sorted(result, key=lambda cue: (cue['start'], cue['end'])), accepted


def merge_recovery(original, candidates):
    """Preserve recovery decisions while avoiding scans of distant subtitles."""
    if not recovery_index_eligible(original) or not recovery_index_eligible(candidates):
        return _merge_recovery_linear(original, candidates)
    result, candidates, accepted = concordant_rechecks(original, candidates)
    indexed = RecoveryCueIndex(result)
    for candidate in candidates:
        if needs_review(candidate):
            continue
        overlaps = []
        for index in indexed.overlapping(candidate['start'], candidate['end']):
            cue = indexed.cues[index]
            overlap = max(0.0, min(cue['end'], candidate['end']) - max(cue['start'], candidate['start']))
            if overlap > 0.15 and overlap / min(cue['end'] - cue['start'], candidate['end'] - candidate['start']) > 0.35:
                overlaps.append((index, cue, overlap))
        if len(overlaps) == 1:
            index, old, overlap = overlaps[0]
            if (recheck_improves(old, candidate) and overlap / (old['end'] - old['start']) >= 0.7
                    and indexed.fits(candidate, index)):
                indexed.replace(index, {**candidate, 'qualityFlags': list(dict.fromkeys(
                    candidate.get('qualityFlags', []) + ['rechecked_confidence']))})
                accepted += 1
                continue
        if candidate.get('words'):
            added, blocked = _merge_novel_recovery_words_indexed(indexed, candidate)
            if added or blocked:
                accepted += added
                continue
        if overlaps:
            continue
        indexed.extend([candidate])
        accepted += 1
    return sorted(indexed.values(), key=lambda cue: (cue['start'], cue['end'])), accepted


def choose_language(model, audio, duration, language, sample_rate, speech=None):
    if language != 'auto':
        return language, 1.0
    # Avoid deciding the entire language from only an opening logo or music.
    offsets = sorted(set([0.0, max(0.0, (duration - 30.0) / 2), max(0.0, duration - 30.0)]))
    voiced = merge_intervals(speech or [], duration)
    if voiced:
        total = sum(end - start for start, end in voiced)
        anchors = []
        for fraction in (0.1, 0.5, 0.9):
            remaining = total * fraction
            for start, end in voiced:
                if remaining <= end - start:
                    anchors.append(start + remaining)
                    break
                remaining -= end - start
        # These are language probes only. Full ASR still examines every sample,
        # including quiet dialogue the advisory detector did not identify.
        offsets = sorted(set(max(0.0, min(duration - 30.0, anchor - 1.0)) for anchor in anchors))
    votes = {}
    for offset in offsets:
        chunk = audio[int(offset * sample_rate):int(min(duration, offset + 30.0) * sample_rate)]
        detected, probability, _ = model.detect_language(audio=chunk, vad_filter=False,
                                                        language_detection_segments=1,
                                                        language_detection_threshold=0.8)
        if isinstance(detected, str) and finite(probability):
            votes.setdefault(detected, []).append(probability)
    if not votes:
        raise ValueError('음성의 언어를 감지하지 못했습니다. 원문 언어를 직접 지정해 주세요.')
    winner = max(votes, key=lambda item: sum(votes[item]))
    return winner, sum(votes[winner]) / len(votes[winner])


def transcribe_audio(model, audio, *, profile='accurate', model_name=None, language='auto',
                     device='cpu', compute_type='int8', sample_rate=SAMPLE_RATE,
                     speech_detector=None, emitter=emit, workers=1, parallel_memory_fallback=False,
                     turbo_pipeline_factory=None):
    if profile == 'turbo':
        return transcribe_turbo_audio(model, audio, model_name=model_name or 'turbo', language=language,
            device=device, compute_type=compute_type, sample_rate=sample_rate, emitter=emitter,
            pipeline_factory=turbo_pipeline_factory)
    model_name = model_name or 'large-v3'
    duration = len(audio) / sample_rate
    if not finite(duration) or duration <= 0:
        raise ValueError('음성 파일이 비어 있거나 길이가 올바르지 않습니다.')
    warnings, cues, processed = [], [], 0.0
    state = {'workers': requested_workers(workers, device), 'oomFallback': bool(parallel_memory_fallback)}
    speech, audit_available = [], False
    if profile == 'accurate':
        emitter({'type': 'progress', 'phase': 'audit', 'completedSeconds': 0.0, 'totalSeconds': duration, 'percent': 0.0,
                 'workers': state['workers']})
        try:
            if speech_detector is None:
                raise RuntimeError('음성 누락 검사 도구가 준비되지 않았습니다.')
            # VAD supplies advisory boundaries and the later independent audit.
            # It never removes any source samples from the decoding windows.
            speech = merge_intervals(speech_detector(audio, sample_rate), duration)
            audit_available = True
        except Exception as error:
            warning = '음성 누락 검사를 완료하지 못했습니다. 전체 음성은 처리하지만 완전성 확인이 필요합니다. ' + str(error)[:200]
            warnings.append(warning)
            emitter({'type': 'warning', 'message': warning})
    selected_language, probability = choose_language(model, audio, duration, language, sample_rate,
                                                    speech=speech if audit_available else None)
    emitter({'type': 'info', 'language': selected_language, 'languageProbability': probability,
             'duration': duration, 'model': model_name, 'profile': profile, 'device': device,
             'computeType': compute_type, 'workers': state['workers']})
    options = dict(beam_size=5, best_of=5, word_timestamps=profile == 'accurate', task='transcribe',
                   condition_on_previous_text=False, language=selected_language,
                   temperature=(0.0, 0.2, 0.4), hallucination_silence_threshold=2.0,
                   vad_filter=profile != 'accurate')
    # Owning windows cover [0,duration]. Extra context is assigned by word
    # midpoint; no evenly spaced, interpolated or fabricated subtitle timings.
    cores = plan_core_windows(duration, speech if audit_available else [])

    def transcription_waiting(window):
        emitter({'type': 'progress', 'phase': 'transcription', 'completedSeconds': processed,
                 'totalSeconds': duration, 'percent': 80.0 * processed / duration,
                 'windowIndex': window, 'windowCount': len(cores), 'workers': state['workers'], 'heartbeat': True})

    initial_windows = [(max(0.0, start - 2.0), min(duration, end + 2.0), start, end) for start, end in cores]
    for window, (decode_start, decode_end, core_start, core_end), segments in decode_windows(
            model, audio, initial_windows, options, sample_rate, state, emitter, transcription_waiting):
        for segment in segments:
            for cue in cues_from_segment(segment, decode_start, duration, (core_start, core_end),
                                         word_timestamps_expected=profile == 'accurate'):
                cues.append({**cue, '_window': window, '_boundary': core_start})
                emitter({'type': 'segment', **cue})
        # A consumed empty generator also means the silent tail was examined.
        processed = core_end
        emitter({'type': 'progress', 'phase': 'transcription', 'completedSeconds': processed,
                 'totalSeconds': duration, 'percent': 80.0 * processed / duration, 'workers': state['workers']})
    cues = reconcile_window_boundaries(cues)
    unresolved, rechecked, budget = [], 0.0, 0.0
    raw_gaps = []
    unresolved_gaps, boundary_ranges = [], []
    boundary_diagnostics = {}
    removed_non_speech = []
    if profile == 'accurate':
        emitter({'type': 'progress', 'phase': 'audit', 'completedSeconds': duration, 'totalSeconds': duration, 'percent': 82.0,
                 'workers': state['workers']})
        if audit_available:
            cues, removed = prune_non_speech_artifacts(cues, audio, speech, sample_rate)
            removed_non_speech.extend(removed)
        raw_gaps, gaps = audit_gaps(speech, coverage_for(cues, duration), duration)
        uncertain = [(cue['start'], cue['end']) for cue in cues if needs_review(cue) or needs_alignment_review(cue)]
        targets = merge_intervals(gaps + uncertain, duration)
        # All cores are examined, with context across internal cuts rather than
        # truncated phonemes. Thirty-second cores plus three seconds per side
        # cost at most 1.2 audio-durations. Count the actual decoded samples.
        windows = [(round(start * sample_rate) / sample_rate, round(end * sample_rate) / sample_rate, core_start, core_end)
                   for start, end, core_start, core_end in recovery_plan(targets, duration)]
        budget = sum(end - start for start, end, _, _ in windows)
        recovery_cues = []
        target_index = RecoveryTargetIndex(targets)

        def recovery_waiting(window):
            emitter({'type': 'progress', 'phase': 'recovery', 'completedSeconds': duration,
                     'totalSeconds': duration, 'percent': 84.0 + 14.0 * rechecked / max(1.0, budget),
                     'phaseCompletedSeconds': rechecked, 'phaseTotalSeconds': budget,
                     'windowIndex': window, 'windowCount': len(windows), 'workers': state['workers'], 'heartbeat': True})

        retry_options = {**options, 'vad_filter': False, 'no_speech_threshold': 0.8}
        for window, (start, end, core_start, core_end), segments in decode_windows(
                model, audio, windows, retry_options, sample_rate, state, emitter, recovery_waiting):
            candidates = []
            for segment in segments:
                candidates.extend(recovery_candidates_for_targets(cues_from_segment(
                    segment, start, duration, (core_start, core_end)), target_index, duration))
            recovery_cues.extend({**cue, '_window': window, '_boundary': core_start} for cue in candidates)
            rechecked += end - start
            emitter({'type': 'progress', 'phase': 'recovery', 'completedSeconds': duration,
                     'totalSeconds': duration, 'percent': 84.0 + 14.0 * rechecked / max(1.0, budget),
                     'phaseCompletedSeconds': rechecked, 'phaseTotalSeconds': budget, 'workers': state['workers']})
        # Reconcile context observations before confirming split native cues.
        # Empty rechecks stay empty; no words or times are synthesized.
        cues, _ = merge_recovery(cues, reconcile_window_boundaries(recovery_cues))
        if audit_available:
            cues, removed = prune_non_speech_artifacts(cues, audio, speech, sample_rate)
            removed_non_speech.extend(removed)
        raw_gaps, gaps = audit_gaps(speech, coverage_for(cues, duration), duration)
        unresolved_gaps, boundary_ranges = separate_boundary_uncertainty(raw_gaps, speech, cues, duration, boundary_diagnostics)
        unresolved = [{'start': start, 'end': end, 'reason': 'possible_missing_speech'}
                      for start, end in review_gaps(unresolved_gaps)]
        unresolved.extend({'start': cue['start'], 'end': cue['end'], 'reason': 'low_confidence'}
                          for cue in cues if needs_review(cue))
        unresolved.extend({'start': cue['start'], 'end': cue['end'], 'reason': 'recovery_alignment_conflict'}
                          for cue in cues if 'recovery_alignment_conflict' in cue.get('qualityFlags', []))
        if boundary_diagnostics.get('boundaryLimitExceeded'):
            unresolved.append({**boundary_diagnostics['boundaryLimitExceeded'], 'reason': 'boundary_range_limit'})
            warning = f'발화 경계 진단이 {MAX_BOUNDARY_RANGES}개를 초과했습니다. 초과 구간의 시간 합계는 미해결 시간에 포함해 보관했습니다.'
            warnings.append(warning)
            emitter({'type': 'warning', 'message': warning})
        if not audit_available:
            unresolved.append({'start': 0.0, 'end': duration, 'reason': 'audit_unavailable'})
        if unresolved:
            warning = f'다시 확인한 뒤에도 음성 누락 또는 낮은 신뢰도가 의심되는 구간 {len(unresolved)}개가 남았습니다. 해당 구간은 임의의 대사로 채우지 않았습니다.'
            warnings.append(warning)
            emitter({'type': 'warning', 'message': warning})
    if boundary_ranges:
        intervals = ', '.join(f"{item['start']:.2f}–{item['end']:.2f}초" for item in boundary_ranges[:10])
        warning = f'대부분이 높은 신뢰도로 인식된 발화의 양끝 {len(boundary_ranges)}개 구간은 발화 검출과 대사 정렬 사이의 짧은 시간 차이로 따로 표시했습니다: {intervals}. 원문과 원래 자막 시간은 유지했습니다.'
        warnings.append(warning)
        emitter({'type': 'warning', 'message': warning})
    if removed_non_speech:
        intervals = ', '.join(f"{item['start']:.2f}–{item['end']:.2f}초" for item in removed_non_speech[:10])
        warning = f'매우 낮은 음량의 무음·일정한 잡음이고 발화 검출이 없으며 인식 신뢰도도 낮은 구간 {len(removed_non_speech)}개를 비발화 인식 후보로 제외했습니다: {intervals}.'
        warnings.append(warning)
        emitter({'type': 'warning', 'message': warning})
    alignment_fallbacks = sum(not cue.get('words') for cue in cues)
    if profile == 'accurate' and alignment_fallbacks:
        warning = f'단어별 시간 정렬이 불완전한 대사 {alignment_fallbacks}개는 원래의 유효한 구간 시간으로 보관했습니다. 단어 시간을 임의로 추정하지 않았으며, 이 제한은 음성 누락과 별도로 표시합니다.'
        warnings.append(warning)
        emitter({'type': 'warning', 'message': warning})
    unresolved_by_reason = {}
    for item in unresolved:
        unresolved_by_reason[item['reason']] = unresolved_by_reason.get(item['reason'], 0) + 1
    audit = {'complete': audit_available and not unresolved, 'speechSeconds': sum(end - start for start, end in speech),
             'uncoveredSpeechSeconds': sum(end - start for start, end in raw_gaps),
             'unresolvedSpeechSeconds': sum(end - start for start, end in unresolved_gaps),
             'boundaryUncertaintySeconds': sum(item['end'] - item['start'] for item in boundary_ranges),
             'boundaryRanges': boundary_ranges,
             'recheckedSeconds': rechecked, 'recoveryBudgetSeconds': budget, 'unresolved': unresolved[:MAX_UNRESOLVED],
             'unresolvedCount': len(unresolved), 'unresolvedByReason': unresolved_by_reason,
             'unresolvedTruncated': len(unresolved) > MAX_UNRESOLVED}
    quality = {'profile': profile, 'model': model_name, 'device': device, 'computeType': compute_type,
               'workers': state['workers'], 'parallelMemoryFallback': state['oomFallback'],
               'recognitionRevision': RECOGNITION_REVISION,
               'processingComplete': profile == 'accurate' and processed == duration,
               'durationSeconds': duration, 'processedSeconds': processed,
               'wordTimestamps': profile == 'accurate' and all(bool(cue.get('words')) for cue in cues),
               'audit': audit, 'warnings': warnings}
    emitter({'type': 'transcript', 'segments': cues})
    emitter({'type': 'progress', 'phase': 'completed', 'completedSeconds': processed, 'totalSeconds': duration, 'percent': 100.0,
             'workers': state['workers']})
    emitter({'type': 'complete', 'segments': len(cues), 'quality': quality})
    return cues, quality


def parser_for_cli():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--profile', default='fast', choices=('accurate', 'fast', 'turbo'))
    parser.add_argument('--model', default=None)
    parser.add_argument('--device', default='cpu', choices=('cpu', 'cuda', 'auto'))
    parser.add_argument('--compute-type', default='int8')
    parser.add_argument('--cpu-threads', type=int, default=max(1, min(8, os.cpu_count() or 4)))
    parser.add_argument('--workers', default='auto', choices=('auto', '1', '2'))
    parser.add_argument('--language', default='auto', choices=('auto', 'ja', 'zh'))
    return parser


def register_nvidia_dll_directories(prefix=None, add_directory=None):
    """Use only installed NVIDIA wheels in this Python environment, never PATH."""
    if add_directory is None:
        if os.name != 'nt' or not hasattr(os, 'add_dll_directory'):
            return 0
        add_directory = os.add_dll_directory
    root = Path(prefix or sys.prefix).resolve()
    registered = 0
    for package in ('cublas', 'cudnn', 'cuda_nvrtc'):
        candidate = root / 'Lib' / 'site-packages' / 'nvidia' / package / 'bin'
        if not candidate.is_dir():
            continue
        resolved = candidate.resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        key = os.path.normcase(str(resolved))
        if key in DLL_DIRECTORY_PATHS:
            continue
        # Keep the handles for the life of the process. Closing them early can
        # make a lazily loaded cuDNN/cuBLAS component disappear during decoding.
        DLL_DIRECTORY_HANDLES.append(add_directory(str(resolved)))
        DLL_DIRECTORY_PATHS.add(key)
        registered += 1
    # Some CTranslate2/cuDNN versions call legacy LoadLibrary by basename, which
    # ignores AddDllDirectory. Preload only the installed wheel DLLs by absolute
    # path, so those basename lookups find retained, already loaded modules.
    if os.name == 'nt':
        preload_nvidia_libraries(root)
    return registered


def preload_nvidia_libraries(prefix=None, load_library=None):
    if load_library is None:
        if os.name != 'nt':
            return 0
        import ctypes
        load_library = lambda filename: ctypes.WinDLL(filename, winmode=0x1100)
    root = Path(prefix or sys.prefix).resolve()
    packages = [
        ('cublas', [r'cublasLt64_12\.dll', r'cublas64_12\.dll']),
        ('cuda_nvrtc', [r'nvrtc-builtins64_[0-9]+\.dll', r'nvrtc64_[0-9]+_0\.dll']),
        ('cudnn', [r'cudnn64_9\.dll', r'cudnn_[a-z_]+64_9\.dll'])
    ]
    loaded = 0
    for package, patterns in packages:
        folder = root / 'Lib' / 'site-packages' / 'nvidia' / package / 'bin'
        if not folder.is_dir():
            continue
        for pattern in patterns:
            for candidate in sorted(folder.glob('*.dll')):
                if not re.fullmatch(pattern, candidate.name, re.IGNORECASE):
                    continue
                resolved = candidate.resolve()
                try:
                    resolved.relative_to(root)
                except ValueError:
                    continue
                if not resolved.is_file():
                    continue
                key = os.path.normcase(str(resolved))
                if key in DLL_LIBRARY_PATHS:
                    continue
                try:
                    handle = load_library(str(resolved))
                except OSError as error:
                    raise RuntimeError(f'CUDA library {candidate.name} failed to load: {error}') from error
                DLL_LIBRARY_HANDLES.append(handle)
                DLL_LIBRARY_PATHS.add(key)
                loaded += 1
    return loaded


def hardware_runtime_unavailable(error):
    if not isinstance(error, (RuntimeError, OSError)):
        return False
    message = str(error).lower()
    if any(marker in message for marker in ('model.bin', 'model format', 'model binary', 'model size',
                                            'hugging face', 'huggingface', 'download', 'tokenizer')):
        return False
    components = ('cuda', 'cublas', 'cudnn', 'cufft', 'nvrtc', 'nvcuda')
    symptoms = ('not found', 'cannot be found', 'could not locate', 'cannot be loaded', 'cannot load', 'could not load', 'failed to load',
                'not available', 'unavailable', 'not enabled', 'not compiled', 'no cuda', 'no device',
                'insufficient driver', 'driver version is insufficient', 'out of memory',
                'driver initialization', 'initialization error', 'unsupported driver', 'no kernel image',
                'cuda_error_out_of_memory', 'cuda_error_no_device', 'cuda_error_insufficient_driver')
    return (any(component in message for component in components) and any(symptom in message for symptom in symptoms)) \
        or ('float16' in message and 'do not support efficient' in message)


def probe_cuda_encoder(model):
    """Load lazy GPU libraries with a zero-audio encoder, never generate words."""
    import numpy as np
    from faster_whisper.audio import pad_or_trim
    features = model.feature_extractor(np.zeros(SAMPLE_RATE, dtype=np.float32))
    model.encode(pad_or_trim(features))


def load_whisper_model(model_name, cache, *, device='cpu', compute_type='int8', cpu_threads=8,
                       factory=None, cuda_count=None, probe=None, dll_registrar=None, emitter=emit,
                       workers='auto', memory_probe=None):
    native_factory = factory is None
    if factory is None:
        from faster_whisper import WhisperModel
        factory = WhisperModel
    common = {'cpu_threads': cpu_threads, 'download_root': os.path.abspath(cache)}
    register = dll_registrar or register_nvidia_dll_directories
    warmup = probe or probe_cuda_encoder
    capacity = memory_probe or (gpu_memory_available if native_factory else lambda: None)

    def construct(selected_device, selected_compute):
        count = requested_workers(workers, selected_device, capacity() if selected_device == 'cuda' else None)
        memory_fallback = False
        options = {**common, 'device': selected_device, 'compute_type': selected_compute}
        try:
            try:
                model = factory(model_name, **options, num_workers=count)
            except TypeError as error:
                # Custom/older model factories without this optional argument
                # retain their serial decoder, never pretend to run parallel.
                if 'num_workers' not in str(error) or 'unexpected keyword' not in str(error):
                    raise
                count = 1
                model = factory(model_name, **options)
        except Exception as error:
            if count != 2 or not gpu_out_of_memory(error):
                raise
            gc.collect()
            count = 1
            memory_fallback = True
            emitter({'type': 'warning', 'message': 'GPU 병렬 모델 준비 중 메모리가 부족해 같은 모델을 직렬로 준비합니다.'})
            model = factory(model_name, **options, num_workers=1)
        if selected_device == 'cuda':
            try:
                warmup(model)
            except Exception as error:
                unload = getattr(getattr(model, 'model', None), 'unload_model', None)
                if callable(unload):
                    try:
                        unload()
                    except Exception:
                        pass
                if count != 2 or not gpu_out_of_memory(error):
                    raise
                model = None
                gc.collect()
                count = 1
                memory_fallback = True
                emitter({'type': 'warning', 'message': 'GPU 병렬 준비 중 메모리가 부족해 같은 모델을 직렬로 다시 준비합니다.'})
                model = factory(model_name, **options, num_workers=1)
                try:
                    warmup(model)
                except Exception:
                    unload = getattr(getattr(model, 'model', None), 'unload_model', None)
                    if callable(unload):
                        try:
                            unload()
                        except Exception:
                            pass
                    raise
            if count == 2:
                available = capacity()
                # Unknown capacity is allowed only after an explicit --workers
                # 2 choice. Automatic mode needs a verified post-load reserve.
                if (available is None and str(workers) == 'auto') or (
                        available is not None and available[0] < GPU_PARALLEL_RESERVE_MIB):
                    count = 1
        try:
            model._videorandom_workers = count
            model._videorandom_parallel_memory_fallback = memory_fallback
        except (AttributeError, TypeError):
            pass
        return model

    if device != 'auto':
        if device == 'cuda':
            register()
        model = construct(device, compute_type)
        return model, device, compute_type
    candidate = None
    try:
        register()
        if cuda_count is None:
            import ctranslate2
            available = ctranslate2.get_cuda_device_count()
        else:
            available = cuda_count()
        if not available:
            raise RuntimeError('CUDA device is not available')
        candidate = construct('cuda', 'int8_float16')
        return candidate, 'cuda', 'int8_float16'
    except Exception as error:
        if not hardware_runtime_unavailable(error):
            raise
        if candidate is not None:
            unload = getattr(getattr(candidate, 'model', None), 'unload_model', None)
            if callable(unload):
                try:
                    unload()
                except Exception:
                    pass
            candidate = None
            gc.collect()
        emitter({'type': 'warning', 'message': 'GPU 실행 환경을 사용할 수 없어 같은 음성 인식 모델을 CPU int8로 실행합니다. '
                 + str(error).replace('\n', ' ')[:200]})
        # Never change the requested model or profile when hardware is missing.
        return construct('cpu', 'int8'), 'cpu', 'int8'


def load_model_and_audio(model_name, cache, audio_path, *, audio_loader, model_loader=None, **model_options):
    """Overlap independent CPU audio decode with the unchanged model setup.

    Model construction, CUDA setup and warmup stay on the calling thread.
    A failed model remains the first failure, as in the original serial path;
    every started decode is drained before returning or raising.
    """
    load_model = model_loader or load_whisper_model
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix='videorandom-audio') as executor:
        decoded = executor.submit(audio_loader, os.path.abspath(audio_path), sampling_rate=SAMPLE_RATE)
        try:
            model, device, compute_type = load_model(model_name, cache, **model_options)
        except BaseException:
            decoded.cancel()
            raise
        return model, device, compute_type, decoded.result()


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    args = parser_for_cli().parse_args()
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    model_name = args.model or ('turbo' if args.profile == 'turbo' else 'large-v3' if args.profile == 'accurate' else 'small')
    # Resolve before loading a model so a missing batch API fails actionably.
    turbo_factory = batched_pipeline_class() if args.profile == 'turbo' else None
    emit({'type': 'loading', 'model': model_name, 'profile': args.profile, 'device': args.device, 'computeType': args.compute_type})
    model, device, compute_type, audio = load_model_and_audio(model_name, args.cache, args.audio,
        audio_loader=decode_audio, device=args.device, compute_type=args.compute_type,
        cpu_threads=args.cpu_threads, workers='1' if args.profile == 'turbo' else args.workers)

    def speech_detector(waveform, rate):
        options = VadOptions(threshold=0.2, min_speech_duration_ms=200,
                             min_silence_duration_ms=500, speech_pad_ms=0)
        return [(item['start'] / rate, item['end'] / rate)
                for item in get_speech_timestamps(waveform, options, sampling_rate=rate)]

    transcribe_audio(model, audio, profile=args.profile, model_name=model_name, language=args.language,
                     device=device, compute_type=compute_type, speech_detector=speech_detector,
                     workers=getattr(model, '_videorandom_workers', 1),
                     parallel_memory_fallback=getattr(model, '_videorandom_parallel_memory_fallback', False),
                     turbo_pipeline_factory=turbo_factory)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'type': 'error', 'message': str(error)[:1000]})
        sys.exit(1)
