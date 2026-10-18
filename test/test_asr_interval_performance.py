"""Metadata-only equivalence checks; no model, real audio, GPU or server access.

The three reference functions are frozen from 1.9.3. ``--benchmark`` compares
their CPU time with the current code using synthetic subtitle metadata only.
"""
import copy
import importlib.util
import json
import pathlib
import random
import sys
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('asr_interval_current', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


def reference_uncovered(speech, covered, duration, minimum=0.0):
    coverage = ASR.merge_intervals(covered, duration)
    result = []
    for start, end in ASR.merge_intervals(speech, duration):
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


def reference_reconcile(cues):
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
            cue.update(words=filtered, start=filtered[0]['start'], end=max(word['end'] for word in filtered),
                       text=''.join(word['word'] for word in filtered).strip())
        elif any(text_key(cue['text']) == text_key(old['text']) and same_observation(cue, old, boundary)
                 for old in previous):
            continue
        kept.append(cue)
    return sorted([{key: value for key, value in cue.items() if not key.startswith('_')}
                   for cue in kept], key=lambda cue: (cue['start'], cue['end']))


def reference_prune(cues, audio, speech, sample_rate):
    kept, removed = [], []
    for cue in cues:
        intersects_speech = any(max(cue['start'] - 0.08, left) < min(cue['end'] + 0.08, right)
                                for left, right in speech)
        if (ASR.low_confidence(cue) and not intersects_speech
                and ASR.very_quiet_stationary_noise(audio, cue['start'], cue['end'], sample_rate)):
            removed.append({'start': cue['start'], 'end': cue['end'], 'reason': 'very_quiet_non_speech'})
        else:
            kept.append(cue)
    return kept, removed


def synthetic_cue(start, end, window=0, probability=0.95, aligned=True, text='synthetic'):
    cue = {'start': start, 'end': end, 'text': text, 'avgLogprob': -0.1,
           'noSpeechProbability': 0.01, '_window': window, '_boundary': window * 90.0}
    if aligned:
        cue['words'] = [{'start': start, 'end': end, 'word': text, 'probability': probability}]
    else:
        cue['avgLogprob'] = -2.0 if probability < 0.45 else -0.1
    return cue


class IntervalEquivalenceTests(unittest.TestCase):
    def test_gap_union_randomized_matches_original_with_unsorted_clipped_ranges(self):
        rng = random.Random(74231)
        for case in range(1200):
            duration = rng.uniform(0.1, 200)

            def spans():
                result = []
                for _ in range(rng.randrange(50)):
                    start = rng.uniform(-10, duration + 10)
                    result.append((start, start + rng.uniform(-2, min(10, duration))))
                result.extend([(float('nan'), duration), (0, float('inf')), (True, duration)])
                rng.shuffle(result)
                return result

            speech, covered = spans(), spans()
            minimum = rng.choice([-1.0, 0.0, 0.001, 0.25, 2.0, duration])
            with self.subTest(case=case):
                self.assertEqual(ASR.uncovered_intervals(speech, covered, duration, minimum),
                                 reference_uncovered(speech, covered, duration, minimum))

    def test_coverage_interval_spanning_several_disjoint_speech_ranges_is_retained(self):
        cases = [([], [], 10), ([(0, 2), (4, 6), (8, 10)], [(1, 9)], 10),
                 ([(0, 1), (2, 3), (4, 5)], [(1, 2), (3, 4)], 5),
                 ([(0, 100)], [(0, 1), (1, 50), (75, 100)], 100)]
        for speech, covered, duration in cases:
            for minimum in (0, 0.25, 1):
                self.assertEqual(ASR.uncovered_intervals(speech, covered, duration, minimum),
                                 reference_uncovered(speech, covered, duration, minimum))

    def test_window_deduplication_matches_original_for_shuffled_and_repeated_windows(self):
        rng = random.Random(310583)
        for case in range(700):
            cues = []
            for _ in range(rng.randrange(1, 80)):
                window = rng.randrange(-2, 6)
                start = rng.choice([window * 90 - 0.3, window * 90, window * 90 + 0.2,
                                    (window - 1) * 90 - 0.3, rng.uniform(0, 500)])
                cue = synthetic_cue(start, start + rng.choice([0.02, 0.2, 0.6, 2.0]), window,
                                    aligned=rng.choice([True, False]), text=rng.choice(['a', ' a ', 'b', '가']))
                if rng.randrange(5) == 0:
                    del cue['_window']
                cue['qualityFlags'] = ['synthetic_preserved']
                cues.append(cue)
            rng.shuffle(cues)
            before = copy.deepcopy(cues)
            with self.subTest(case=case):
                self.assertEqual(ASR.reconcile_window_boundaries(cues), reference_reconcile(cues))
                self.assertEqual(cues, before)

    def test_missing_window_is_not_treated_as_explicit_window_zero(self):
        first = synthetic_cue(89.8, 90.2, 0)
        missing = copy.deepcopy(first)
        del missing['_window']
        following = synthetic_cue(89.8, 90.2, 1)
        self.assertEqual(len(ASR.reconcile_window_boundaries([missing, following])), 2)
        self.assertEqual(len(ASR.reconcile_window_boundaries([first, following])), 1)

    def test_partial_word_deduplication_and_exact_touch_boundaries_match_original(self):
        previous = synthetic_cue(89.5, 90.5, 0, text='a')
        following = synthetic_cue(89.5, 91.5, 1, text='ab')
        following['words'] = [dict(previous['words'][0]),
                              {'start': 90.5, 'end': 91.5, 'word': 'b', 'probability': 0.95}]
        for boundary in (89.5, 89.52, 90.0, 90.5, 90.500001):
            following['_boundary'] = boundary
            for cues in ([previous, following], [following, previous, following],
                         [previous, following, previous, following]):
                self.assertEqual(ASR.reconcile_window_boundaries(cues), reference_reconcile(cues))

    def test_pruning_matches_original_and_checks_same_audio_ranges(self):
        rng = random.Random(981630)
        for case in range(700):
            cues, speech = [], []
            for _ in range(rng.randrange(60)):
                start = rng.uniform(0, 40)
                cue = synthetic_cue(start, start + rng.uniform(0.02, 3),
                                    probability=rng.choice([0.2, 0.44, 0.45, 0.7, 0.99]),
                                    aligned=rng.choice([True, False]))
                cue['avgLogprob'] = rng.choice([-2, -1, -0.1])
                cue['noSpeechProbability'] = rng.choice([0.0, 0.8, 0.81, 0.99])
                cues.append(cue)
            for _ in range(rng.randrange(40)):
                start = rng.uniform(-3, 44)
                speech.append((start, start + rng.uniform(-2, 3)))
            rng.shuffle(cues)
            rng.shuffle(speech)
            calls = []

            def noise(audio, start, end, rate):
                calls.append((start, end, rate))
                return round(start * 100) % 3 == 0

            with self.subTest(case=case), patch.object(ASR, 'very_quiet_stationary_noise', noise):
                expected = reference_prune(cues, [], speech, 100)
                expected_calls, calls = calls, []
                self.assertEqual(ASR.prune_non_speech_artifacts(cues, [], speech, 100), expected)
                self.assertEqual(calls, expected_calls)

    def test_confident_dialogue_never_scans_speech_or_audio(self):
        class Unreadable:
            def __iter__(self):
                raise AssertionError('confident dialogue does not require speech search')

            def __getitem__(self, key):
                raise AssertionError('confident dialogue does not require audio samples')

        cue = synthetic_cue(0, 1)
        self.assertEqual(ASR.prune_non_speech_artifacts([cue], Unreadable(), Unreadable(), 16000), ([cue], []))


def benchmark():
    """Times are CPU metadata cleanup only, never end-to-end ASR performance."""
    cases = []
    for count in (1819, 10000):
        duration = count * 4 + 2
        speech = [(index * 4.0, index * 4.0 + 2.5) for index in range(count)]
        covered = [(index * 4.0 + 0.2, index * 4.0 + 2.3) for index in range(count)]
        cues = [synthetic_cue(index * 4.0, index * 4.0 + 2.5, index // 20) for index in range(count)]
        for name, baseline, current, args in (
            ('uncovered_intervals', reference_uncovered, ASR.uncovered_intervals, (speech, covered, duration)),
            ('reconcile_window_boundaries', reference_reconcile, ASR.reconcile_window_boundaries, (cues,)),
            ('prune_non_speech_artifacts', reference_prune, ASR.prune_non_speech_artifacts, (cues, [], speech, 16000)),
        ):
            started = time.perf_counter()
            expected = baseline(*args)
            baseline_seconds = time.perf_counter() - started
            started = time.perf_counter()
            actual = current(*args)
            current_seconds = time.perf_counter() - started
            if actual != expected:
                raise AssertionError('metadata output changed: ' + name)
            result = {'function': name, 'cueCount': count, 'baselineSeconds': round(baseline_seconds, 6),
                      'currentSeconds': round(current_seconds, 6), 'sameOutput': True}
            cases.append(result)
            print(json.dumps(result), flush=True)
    print(json.dumps({'kind': 'synthetic_metadata_cpu_only', 'cases': len(cases), 'allOutputsEqual': True}), flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--benchmark']:
        benchmark()
    else:
        unittest.main()
