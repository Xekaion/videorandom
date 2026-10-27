"""Neutral differential CPU checks; no audio files, model, GPU or provider.

The reference predicates are frozen from v1.9.29. --benchmark reports repeated
function-only timings, never a speech recognition or whole-video speed claim.
"""
import copy
import importlib.util
import json
import math
import pathlib
import random
import statistics
import sys
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('asr_postprocessing_v1930', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


def reference_reconcile(cues):
    kept, by_window = [], {}
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
        previous = by_window.get(window - 1, ())
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
        by_window.setdefault(cue.get('_window'), []).append(cue)
    return sorted([{key: value for key, value in cue.items() if not key.startswith('_')}
                   for cue in kept], key=lambda cue: (cue['start'], cue['end']))


def reference_prune(cues, audio, speech, sample_rate):
    kept, removed = [], []
    for cue in cues:
        if not ASR.low_confidence(cue):
            kept.append(cue)
            continue
        intersects = any(max(cue['start'] - 0.08, left) < min(cue['end'] + 0.08, right)
                         for left, right in speech)
        if not intersects and ASR.very_quiet_stationary_noise(audio, cue['start'], cue['end'], sample_rate):
            removed.append({'start': cue['start'], 'end': cue['end'], 'reason': 'very_quiet_non_speech'})
        else:
            kept.append(cue)
    return kept, removed


def cue(start, end, text='neutral', *, window=0, boundary=0, words=True, confidence=0.95):
    value = {'start': start, 'end': end, 'text': text, '_window': window, '_boundary': boundary,
             'avgLogprob': -0.1 if confidence >= 0.7 else -2.0, 'noSpeechProbability': 0.1}
    if words:
        value['words'] = [{'start': start, 'end': end, 'word': text, 'probability': confidence}]
    return value


class PostprocessingTests(unittest.TestCase):
    def assert_reconcile_equal(self, values):
        before = copy.deepcopy(values)
        self.assertEqual(ASR.reconcile_window_boundaries(values), reference_reconcile(values))
        self.assertEqual(values, before, 'source cues and words must never be mutated')

    def test_random_word_and_native_cues_keep_exact_decisions(self):
        randomizer = random.Random(193001)
        texts = ['one', 'two', 'one two', 'one\ttwo', ' one\ntwo ', '한 글', '日本語', '']
        for trial in range(350):
            values = []
            for _ in range(randomizer.randrange(5, 90)):
                window = randomizer.randrange(6)
                start = window * 3 + randomizer.randrange(-10, 11) * 0.1
                value = cue(start, start + randomizer.choice([0.02, 0.1, 0.3, 1.0]),
                            randomizer.choice(texts), window=window, boundary=window * 3,
                            words=randomizer.choice([True, False]))
                if randomizer.random() < 0.05:
                    del value['_window']
                values.append(value)
            with self.subTest(trial=trial):
                self.assert_reconcile_equal(values)

    def test_word_and_segment_timing_thresholds_remain_exact(self):
        for words in (True, False):
            for length in (0.02, math.nextafter(0.02, math.inf), 0.3, 1.0):
                for shift in (0, 0.4, math.nextafter(0.4, math.inf), -0.4):
                    values = [cue(-length / 2, length / 2, window=0, words=words),
                              cue(-length / 2 + shift, length / 2 + shift, ' neu\ttral ',
                                  window=1, words=words)]
                    self.assert_reconcile_equal(values)

    def test_missing_window_is_distinct_from_explicit_zero_and_order_is_stable(self):
        missing = cue(-0.1, 0.1)
        del missing['_window']
        following = cue(-0.1, 0.1, window=1)
        self.assertEqual(len(ASR.reconcile_window_boundaries([missing, following])), 2)
        self.assertEqual(len(ASR.reconcile_window_boundaries([cue(-0.1, 0.1), following])), 1)
        tied = [cue(5, 6, str(index), window=2) for index in range(8)]
        self.assert_reconcile_equal(tied)
        self.assertEqual([item['text'] for item in ASR.reconcile_window_boundaries(tied)], list(map(str, range(8))))

    def test_out_of_order_insert_invalidates_only_the_affected_prior_window(self):
        values = [cue(-0.1, 0.1, 'one', window=0), cue(-0.1, 0.1, 'two', window=1),
                  cue(-0.1, 0.1, 'three', window=0), cue(-0.1, 0.1, 'three', window=1),
                  cue(-0.1, 0.1, 'four', window=0, words=False),
                  cue(-0.1, 0.1, 'four', window=1, words=False)]
        self.assert_reconcile_equal(values)
        self.assertEqual([item['text'] for item in ASR.reconcile_window_boundaries(values)], ['one', 'two', 'three', 'four'])

    def test_partial_duplicate_word_group_uses_retained_native_word_times(self):
        first, second = cue(-0.1, 0.1), cue(-0.1, 0.1, window=1)
        second['words'].append({'start': 0.2, 'end': 0.4, 'word': ' retained', 'probability': 0.93})
        self.assert_reconcile_equal([first, second])
        result = ASR.reconcile_window_boundaries([first, second])
        self.assertEqual(result[1]['start'], 0.2)
        self.assertEqual(result[1]['end'], 0.4)
        self.assertEqual(result[1]['text'], 'retained')

    def test_legacy_malformed_word_list_preserves_lazy_fallback_errors(self):
        native = cue(-0.1, 0.1, words=False)
        native['words'] = None
        self.assertEqual(ASR.reconcile_window_boundaries([native]), reference_reconcile([native]))
        for values in ([native, cue(-0.1, 0.1, window=1)],
                       [cue(-0.1, 0.1), native, cue(-0.1, 0.1, window=1)]):
            outcomes = []
            for operation in (reference_reconcile, ASR.reconcile_window_boundaries):
                try:
                    outcomes.append(('value', operation(values)))
                except Exception as error:
                    outcomes.append(('error', type(error)))
            self.assertEqual(outcomes[0], outcomes[1])

    def test_random_prune_intervals_match_original_and_noise_call_order(self):
        randomizer = random.Random(193002)
        for trial in range(250):
            speech = [(randomizer.uniform(-3, 30), randomizer.uniform(-3, 30))
                      for _ in range(randomizer.randrange(60))]
            values = [cue(randomizer.uniform(-2, 30), randomizer.uniform(-2, 30),
                          confidence=randomizer.choice([0.1, 0.95])) for _ in range(35)]
            observations = []
            for operation in (reference_prune, ASR.prune_non_speech_artifacts):
                calls = []
                def noise(audio, start, end, rate):
                    calls.append((start, end, rate))
                    return len(calls) % 3 != 0
                with patch.object(ASR, 'very_quiet_stationary_noise', noise):
                    result = operation(values, [], speech, 16000)
                observations.append((result, calls))
            with self.subTest(trial=trial):
                self.assertEqual(observations[0], observations[1])

    def test_strict_interval_endpoints_and_reversed_zero_bounds(self):
        values = [-1, 0, math.nextafter(0, 1), 1, math.nextafter(1, 0), math.nextafter(1, 2), 2]
        speech = [(2, 3), (0, 1), (0.4, 0.9), (1, 1), (5, 4), (-2, -1)]
        index = ASR.SpeechOverlapIndex(speech)
        for start in values:
            for end in values:
                expected = any(max(start, left) < min(end, right) for left, right in speech)
                self.assertIs(index.overlaps(start, end), expected)

    def test_nonfinite_interval_fallback_uses_original_min_max_decisions(self):
        unusual = [math.nan, math.inf, -math.inf, True]
        for strange in unusual:
            for speech in ([(strange, 1)], [(0, strange)], [(3, 4), (strange, 1)], [(0, 1)]):
                index = ASR.SpeechOverlapIndex(speech)
                for start, end in ((0, 2), (strange, 2), (0, strange), (2, 1)):
                    expected = any(max(start, left) < min(end, right) for left, right in speech)
                    self.assertIs(index.overlaps(start, end), expected)

    def test_malformed_late_intervals_and_one_shot_iterators_keep_original_laziness(self):
        for speech in ([(0, 1), None], [(0, 1), (3,)], [(0, 1), (3, 4, 5)], [(0, 1), ('bad', 4)]):
            index = ASR.SpeechOverlapIndex(speech)
            self.assertTrue(index.overlaps(0.1, 0.9))
            outcomes = []
            for operation in (lambda: any(max(5, left) < min(6, right) for left, right in speech),
                              lambda: index.overlaps(5, 6)):
                try:
                    outcomes.append(('value', operation()))
                except Exception as error:
                    outcomes.append(('error', type(error)))
            self.assertEqual(outcomes[0], outcomes[1])
        old_speech, new_speech = (iter([(0, 1), (2, 3), (4, 5)]) for _ in range(2))
        index = ASR.SpeechOverlapIndex(new_speech)
        for start, end in ((0.1, 0.9), (0.1, 0.9), (4.1, 4.9)):
            self.assertIs(index.overlaps(start, end),
                          any(max(start, left) < min(end, right) for left, right in old_speech))

    def test_no_high_confidence_cue_reads_speech_or_numeric_samples(self):
        class ForbiddenSpeech:
            def __iter__(self):
                raise AssertionError('high-confidence cues need no speech lookup')
        with patch.object(ASR, 'very_quiet_stationary_noise', side_effect=AssertionError('no numeric reads')):
            values = [cue(0, 1), cue(3, 4)]
            self.assertEqual(ASR.prune_non_speech_artifacts(values, None, ForbiddenSpeech(), 16000), (values, []))

    def test_finite_speech_union_is_indexed_once_instead_of_per_cue(self):
        class CountedSpeech(list):
            def __iter__(self):
                self.reads += 1
                return super().__iter__()
        speech = CountedSpeech((index * 3.0, index * 3.0 + 1) for index in range(500))
        speech.reads = 0
        values = [cue(index * 3 + 0.1, index * 3 + 0.9, confidence=0.1) for index in range(500)]
        with patch.object(ASR, 'very_quiet_stationary_noise', side_effect=AssertionError('all intersect speech')):
            self.assertEqual(ASR.prune_non_speech_artifacts(values, [], speech, 10), (values, []))
        self.assertEqual(speech.reads, 3)

    def test_real_numeric_noise_decisions_are_unchanged_including_tiny_bursts(self):
        rate = 1000
        values = [cue(0.1, 0.8, confidence=0.1), cue(1.1, 1.8, confidence=0.1), cue(2.1, 2.8)]
        for numbers in ([0.0] * 3000, [1e-9] * 3000, [0.01] + [0.0] * 2999,
                        [0.0] * 1500 + [0.0001] * 20 + [0.0] * 1480):
            for speech in ([], [(0.9, 1.1)], [(2.2, 2.7), (0.9, 1.1)]):
                self.assertEqual(ASR.prune_non_speech_artifacts(values, numbers, speech, rate),
                                 reference_prune(values, numbers, speech, rate))


def benchmark():
    cues = []
    for window in range(40):
        for part in range(40):
            start = window * 90 + part * 2
            value = cue(start, start + 1.8, window=window, boundary=window * 90)
            value['words'] = [{'start': start + n * 0.18, 'end': start + n * 0.18 + 0.15,
                               'word': 'neutral' + str(n % 5), 'probability': 0.95} for n in range(10)]
            cues.append(value)
    speech = [(index * 3.0, index * 3.0 + 1) for index in range(4000)]
    doubtful = [cue(index * 3 + 0.1, index * 3 + 0.9, confidence=0.1) for index in range(4000)]
    cases = [('boundary-text-index', reference_reconcile, ASR.reconcile_window_boundaries, (cues,)),
             ('speech-overlap-index', reference_prune, ASR.prune_non_speech_artifacts, (doubtful, [], speech, 16000))]
    measurements = []
    for name, previous, current, arguments in cases:
        samples = {'reference': [], 'current': []}
        for repetition in range(3):
            outputs = []
            for key, operation in [('reference', previous), ('current', current)]:
                started = time.perf_counter()
                outputs.append(operation(*arguments))
                samples[key].append(time.perf_counter() - started)
            assert outputs[0] == outputs[1]
        old, new = (statistics.median(samples[key]) for key in ('reference', 'current'))
        measurements.append({'function': name, 'referenceSeconds': samples['reference'],
                             'currentSeconds': samples['current'], 'medianRatio': old / new,
                             'equal': True, 'scope': 'synthetic CPU postprocessing only; no ASR or video speed claim'})
    print(json.dumps({'measurements': measurements}, ensure_ascii=True))


if __name__ == '__main__':
    if '--benchmark' in sys.argv:
        benchmark()
    else:
        unittest.main()
