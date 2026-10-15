"""Stream ASR with full-audio processing and an independent coverage audit."""
import argparse
import gc
import json
import math
import os
from pathlib import Path
import re
import sys

SAMPLE_RATE = 16000
MAX_UNRESOLVED = 200
MAX_BOUNDARY_RANGES = 10000
DLL_DIRECTORY_HANDLES = []
DLL_DIRECTORY_PATHS = set()
DLL_LIBRARY_HANDLES = []
DLL_LIBRARY_PATHS = set()


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
    result = []
    for start, end in merge_intervals(speech, duration):
        cursor = start
        for left, right in coverage:
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


def prune_non_speech_artifacts(cues, audio, speech, sample_rate):
    kept, removed = [], []
    for cue in cues:
        intersects_speech = any(max(cue['start'] - 0.08, left) < min(cue['end'] + 0.08, right)
                                for left, right in speech)
        if (low_confidence(cue) and not intersects_speech
                and very_quiet_stationary_noise(audio, cue['start'], cue['end'], sample_rate)):
            removed.append({'start': cue['start'], 'end': cue['end'], 'reason': 'very_quiet_non_speech'})
        else:
            kept.append(cue)
    return kept, removed


def cues_from_segment(segment, offset, duration, ownership=None):
    """Readable cue breaks always use actual aligned word boundaries."""
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
        if words and left < words[-1]['start']:
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
            cue['qualityFlags'] = ['word_timestamps_unavailable']
        if low_confidence(cue):
            cue.setdefault('qualityFlags', []).append('low_confidence')
        return [cue]
    groups, group = [], []
    for word in words:
        previous_text = ''.join(item['word'] for item in group).strip()
        if group and (word['end'] - group[0]['start'] > 6.0 or len(previous_text + word['word']) > 56
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
        cue = {'start': words[0]['start'], 'end': words[-1]['end'],
               'text': ''.join(word['word'] for word in words).strip(), 'words': words, **metadata}
        if low_confidence(cue):
            cue['qualityFlags'] = ['low_confidence']
        cues.append(cue)
    return cues


def reconcile_window_boundaries(cues):
    """Deduplicate matching observations from adjacent decoding windows only."""
    kept = []
    def text_key(text):
        return ''.join(text.split())
    def same_observation(left, right, boundary):
        if not left['start'] <= boundary <= left['end'] or not right['start'] <= boundary <= right['end']:
            return False
        overlap = min(left['end'], right['end']) - max(left['start'], right['start'])
        return overlap > 0.02 and overlap / min(left['end'] - left['start'], right['end'] - right['start']) >= 0.3
    for original in cues:
        cue = {**original}
        window, boundary = cue.get('_window', 0), cue.get('_boundary', 0)
        previous = [item for item in kept if item.get('_window') == window - 1]
        words = cue.get('words')
        if words:
            filtered = []
            for word in words:
                duplicate = any(text_key(word['word']) == text_key(old['word'])
                    and same_observation(word, old, boundary)
                    and abs(word['start'] - old['start']) <= 0.4 and abs(word['end'] - old['end']) <= 0.4
                    for item in previous for old in item.get('words', []))
                if not duplicate:
                    filtered.append(word)
            if not filtered:
                continue
            cue.update(words=filtered, start=filtered[0]['start'], end=filtered[-1]['end'],
                       text=''.join(word['word'] for word in filtered).strip())
        elif any(text_key(cue['text']) == text_key(old['text']) and same_observation(cue, old, boundary)
                 for old in previous):
            continue
        kept.append(cue)
    return sorted([{key: value for key, value in cue.items() if not key.startswith('_')}
                   for cue in kept], key=lambda cue: (cue['start'], cue['end']))


def recovery_windows(targets, duration, budget, maximum=30.0):
    """Bound recheck cost while including context around short gaps."""
    windows, used = [], 0.0
    for start, end in merge_intervals(targets, duration, padding=1.5):
        cursor = start
        while cursor < end and used < budget:
            right = min(end, cursor + maximum, cursor + budget - used)
            if right - cursor < 0.5:
                break
            windows.append((cursor, right))
            used += right - cursor
            cursor = right
    return windows


def merge_recovery(original, candidates):
    """Keep established dialogue unless a better aligned recheck replaces it."""
    result = list(original)
    accepted = 0
    for candidate in candidates:
        if needs_review(candidate):
            continue
        overlaps = []
        for index, cue in enumerate(result):
            overlap = max(0.0, min(cue['end'], candidate['end']) - max(cue['start'], candidate['start']))
            if overlap > 0.15 and overlap / min(cue['end'] - cue['start'], candidate['end'] - candidate['start']) > 0.35:
                overlaps.append((index, cue, overlap))
        if overlaps:
            if len(overlaps) != 1:
                continue
            index, old, overlap = overlaps[0]
            old_score, new_score = cue_confidence(old), cue_confidence(candidate)
            if (not needs_review(old) or old_score is None or new_score is None
                    or new_score < old_score + 0.1 or overlap / (old['end'] - old['start']) < 0.7):
                continue
            result[index] = candidate
        else:
            result.append(candidate)
        accepted += 1
    return sorted(result, key=lambda cue: (cue['start'], cue['end'])), accepted


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


def transcribe_audio(model, audio, *, profile='accurate', model_name='large-v3', language='auto',
                     device='cpu', compute_type='int8', sample_rate=SAMPLE_RATE,
                     speech_detector=None, emitter=emit):
    duration = len(audio) / sample_rate
    if not finite(duration) or duration <= 0:
        raise ValueError('음성 파일이 비어 있거나 길이가 올바르지 않습니다.')
    warnings, cues, processed = [], [], 0.0
    speech, audit_available = [], False
    if profile == 'accurate':
        emitter({'type': 'progress', 'phase': 'audit', 'completedSeconds': 0.0, 'totalSeconds': duration, 'percent': 0.0})
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
             'duration': duration, 'model': model_name, 'profile': profile, 'device': device, 'computeType': compute_type})
    options = dict(beam_size=5, best_of=5, word_timestamps=True, task='transcribe',
                   condition_on_previous_text=False, language=selected_language,
                   temperature=(0.0, 0.2, 0.4), hallucination_silence_threshold=2.0,
                   vad_filter=profile != 'accurate')
    # Owning windows cover [0,duration]. Extra context is assigned by word
    # midpoint; no evenly spaced, interpolated or fabricated subtitle timings.
    cores = plan_core_windows(duration, speech if audit_available else [])
    for window, (core_start, core_end) in enumerate(cores):
        decode_start, decode_end = max(0.0, core_start - 2.0), min(duration, core_end + 2.0)
        chunk = audio[int(decode_start * sample_rate):int(decode_end * sample_rate)]
        segments, _ = model.transcribe(chunk, **options)
        for segment in segments:
            for cue in cues_from_segment(segment, decode_start, duration, (core_start, core_end)):
                cues.append({**cue, '_window': window, '_boundary': core_start})
                emitter({'type': 'segment', **cue})
        # A consumed empty generator also means the silent tail was examined.
        processed = core_end
        emitter({'type': 'progress', 'phase': 'transcription', 'completedSeconds': processed,
                 'totalSeconds': duration, 'percent': 80.0 * processed / duration})
    cues = reconcile_window_boundaries(cues)
    unresolved, rechecked, budget = [], 0.0, 0.0
    raw_gaps = []
    unresolved_gaps, boundary_ranges = [], []
    boundary_diagnostics = {}
    removed_non_speech = []
    if profile == 'accurate':
        emitter({'type': 'progress', 'phase': 'audit', 'completedSeconds': duration, 'totalSeconds': duration, 'percent': 82.0})
        if audit_available:
            cues, removed = prune_non_speech_artifacts(cues, audio, speech, sample_rate)
            removed_non_speech.extend(removed)
        raw_gaps, gaps = audit_gaps(speech, coverage_for(cues, duration), duration)
        uncertain = [(cue['start'], cue['end']) for cue in cues if needs_review(cue)]
        targets = merge_intervals(gaps + uncertain, duration)
        budget = min(duration, min(600.0, max(60.0, duration * 0.25)))
        windows = recovery_windows(targets, duration, budget)
        for start, end in windows:
            chunk = audio[int(start * sample_rate):int(end * sample_rate)]
            retry_options = {**options, 'vad_filter': False, 'no_speech_threshold': 0.8}
            segments, _ = model.transcribe(chunk, **retry_options)
            candidates = []
            for segment in segments:
                candidates.extend(cue for cue in cues_from_segment(segment, start, duration)
                                  if any(left <= (cue['start'] + cue['end']) / 2 <= right for left, right in targets))
            # No decoded speech is valid: leave intervals empty, never fill text.
            cues, _ = merge_recovery(cues, candidates)
            rechecked += end - start
            emitter({'type': 'progress', 'phase': 'recovery', 'completedSeconds': duration,
                     'totalSeconds': duration, 'percent': 84.0 + 14.0 * rechecked / max(1.0, sum(right - left for left, right in windows))})
        if audit_available:
            cues, removed = prune_non_speech_artifacts(cues, audio, speech, sample_rate)
            removed_non_speech.extend(removed)
        raw_gaps, gaps = audit_gaps(speech, coverage_for(cues, duration), duration)
        unresolved_gaps, boundary_ranges = separate_boundary_uncertainty(raw_gaps, speech, cues, duration, boundary_diagnostics)
        unresolved = [{'start': start, 'end': end, 'reason': 'possible_missing_speech'}
                      for start, end in review_gaps(unresolved_gaps)]
        unresolved.extend({'start': cue['start'], 'end': cue['end'], 'reason': 'low_confidence'}
                          for cue in cues if needs_review(cue))
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
    if alignment_fallbacks:
        warning = f'단어별 시간 정렬이 불완전한 대사 {alignment_fallbacks}개는 원래의 유효한 구간 시간으로 보관했습니다. 단어 시간을 임의로 추정하지 않았으며, 이 제한은 음성 누락과 별도로 표시합니다.'
        warnings.append(warning)
        emitter({'type': 'warning', 'message': warning})
    audit = {'complete': audit_available and not unresolved, 'speechSeconds': sum(end - start for start, end in speech),
             'uncoveredSpeechSeconds': sum(end - start for start, end in raw_gaps),
             'unresolvedSpeechSeconds': sum(end - start for start, end in unresolved_gaps),
             'boundaryUncertaintySeconds': sum(item['end'] - item['start'] for item in boundary_ranges),
             'boundaryRanges': boundary_ranges,
             'recheckedSeconds': rechecked, 'recoveryBudgetSeconds': budget, 'unresolved': unresolved[:MAX_UNRESOLVED]}
    quality = {'profile': profile, 'model': model_name, 'device': device, 'computeType': compute_type,
               'durationSeconds': duration, 'processedSeconds': processed, 'wordTimestamps': all(bool(cue.get('words')) for cue in cues),
               'audit': audit, 'warnings': warnings}
    emitter({'type': 'transcript', 'segments': cues})
    emitter({'type': 'progress', 'phase': 'completed', 'completedSeconds': processed, 'totalSeconds': duration, 'percent': 100.0})
    emitter({'type': 'complete', 'segments': len(cues), 'quality': quality})
    return cues, quality


def parser_for_cli():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--profile', default='fast', choices=('accurate', 'fast'))
    parser.add_argument('--model', default=None)
    parser.add_argument('--device', default='cpu', choices=('cpu', 'cuda', 'auto'))
    parser.add_argument('--compute-type', default='int8')
    parser.add_argument('--cpu-threads', type=int, default=max(1, min(8, os.cpu_count() or 4)))
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
                       factory=None, cuda_count=None, probe=None, dll_registrar=None, emitter=emit):
    if factory is None:
        from faster_whisper import WhisperModel
        factory = WhisperModel
    common = {'cpu_threads': cpu_threads, 'download_root': os.path.abspath(cache)}
    register = dll_registrar or register_nvidia_dll_directories
    warmup = probe or probe_cuda_encoder
    if device != 'auto':
        if device == 'cuda':
            register()
        model = factory(model_name, device=device, compute_type=compute_type, **common)
        if device == 'cuda':
            warmup(model)
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
        candidate = factory(model_name, device='cuda', compute_type='int8_float16', **common)
        warmup(candidate)
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
        return factory(model_name, device='cpu', compute_type='int8', **common), 'cpu', 'int8'


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    args = parser_for_cli().parse_args()
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    model_name = args.model or ('large-v3' if args.profile == 'accurate' else 'small')
    emit({'type': 'loading', 'model': model_name, 'profile': args.profile, 'device': args.device, 'computeType': args.compute_type})
    model, device, compute_type = load_whisper_model(model_name, args.cache, device=args.device,
        compute_type=args.compute_type, cpu_threads=args.cpu_threads)
    audio = decode_audio(os.path.abspath(args.audio), sampling_rate=SAMPLE_RATE)

    def speech_detector(waveform, rate):
        options = VadOptions(threshold=0.2, min_speech_duration_ms=80,
                             min_silence_duration_ms=500, speech_pad_ms=0)
        return [(item['start'] / rate, item['end'] / rate)
                for item in get_speech_timestamps(waveform, options, sampling_rate=rate)]

    transcribe_audio(model, audio, profile=args.profile, model_name=model_name, language=args.language,
                     device=device, compute_type=compute_type, speech_detector=speech_detector)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'type': 'error', 'message': str(error)[:1000]})
        sys.exit(1)
