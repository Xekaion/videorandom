"""Exact confidence decisions on synthetic cue metadata; no inference/audio."""
import copy
import importlib.util
import json
from pathlib import Path
import random
import statistics
import sys
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('confidence_asr', Path(__file__).resolve().parents[1] / 'scripts/transcribe_local.py')
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


# Frozen v1.9.41 predicates. The confidence aggregation is unchanged.
def previous_low(cue):
    probability = ASR.cue_confidence(cue)
    return ((probability is not None and probability < 0.45)
            or (ASR.finite(cue.get('avgLogprob')) and cue['avgLogprob'] < -1.0)
            or (ASR.finite(cue.get('noSpeechProbability')) and cue['noSpeechProbability'] > 0.8))


def previous_high(cue):
    probability = ASR.cue_confidence(cue)
    return (not previous_low(cue) and probability is not None and probability >= 0.7
            and (not ASR.finite(cue.get('avgLogprob')) or cue['avgLogprob'] >= -0.5)
            and (not ASR.finite(cue.get('noSpeechProbability')) or cue['noSpeechProbability'] <= 0.4))


def previous_improves(old, candidate):
    old_score, new_score = ASR.cue_confidence(old), ASR.cue_confidence(candidate)
    if not previous_low(old) or previous_low(candidate) or old_score is None or new_score is None:
        return False
    if new_score >= old_score + 0.1:
        return True
    if not previous_high(candidate):
        return False
    old_log, new_log = old.get('avgLogprob'), candidate.get('avgLogprob')
    old_silence, new_silence = old.get('noSpeechProbability'), candidate.get('noSpeechProbability')
    return ((ASR.finite(old_log) and ASR.finite(new_log) and old_log < -1.0 and new_log >= -0.5
             and new_log - old_log >= 0.3)
            or (ASR.finite(old_silence) and ASR.finite(new_silence) and old_silence > 0.8
                and new_silence <= 0.4 and old_silence - new_silence >= 0.3))


def cue(probability=0.8, words=20):
    return {'start': 0.0, 'end': 3.0, 'text': 'Synthetic train announcement.',
            'avgLogprob': -0.1, 'noSpeechProbability': 0.01,
            'words': [{'probability': probability, 'start': offset / 10, 'end': offset / 10 + 0.1, 'word': 'word'}
                      for offset in range(words)]}


class ConfidenceScanTests(unittest.TestCase):
    def test_randomized_metadata_matches_frozen_predicates_without_mutation(self):
        rng = random.Random(1942)
        probabilities = [None, False, float('nan'), float('inf'), -0.1, 0, 0.449999999, 0.45, 0.699999999, 0.7, 1]
        metadata = [None, False, float('nan'), float('inf'), -1.00000001, -1.0, -0.500000001, -0.5, 0.399999999, 0.4, 0.8, 0.800000001]
        for _ in range(1200):
            pair = []
            for _ in range(2):
                item = cue(words=rng.randrange(32))
                item['words'] = [{'probability': rng.choice(probabilities)} for _ in item['words']]
                item['avgLogprob'] = rng.choice(metadata)
                item['noSpeechProbability'] = rng.choice(metadata)
                if rng.randrange(4) == 0:
                    item.pop('words')
                pair.append(item)
            before = copy.deepcopy(pair)
            self.assertEqual(ASR.low_confidence(pair[0]), previous_low(pair[0]))
            self.assertEqual(ASR.high_confidence(pair[0]), previous_high(pair[0]))
            self.assertEqual(ASR.recheck_improves(*pair), previous_improves(*pair))
            self.assertEqual(pair, before)

    def test_high_confidence_scans_the_word_probabilities_once(self):
        with patch.object(ASR, 'cue_confidence', wraps=ASR.cue_confidence) as confidence:
            self.assertTrue(ASR.high_confidence(cue()))
            self.assertEqual(confidence.call_count, 1)

    def test_recheck_reuses_its_two_existing_scores(self):
        old, candidate = cue(0.3), cue(0.8)
        with patch.object(ASR, 'cue_confidence', wraps=ASR.cue_confidence) as confidence:
            self.assertTrue(ASR.recheck_improves(old, candidate))
            self.assertEqual(confidence.call_count, 2)

    def test_recheck_still_considers_log_and_silence_evidence(self):
        for old_field, old_value, new_value in [('avgLogprob', -1.2, -0.4), ('noSpeechProbability', 0.9, 0.2)]:
            old, candidate = cue(0.8), cue(0.8)
            old[old_field], candidate[old_field] = old_value, new_value
            self.assertEqual(ASR.recheck_improves(old, candidate), previous_improves(old, candidate))
            self.assertTrue(ASR.recheck_improves(old, candidate))

    def test_scores_are_not_cached_across_mutations(self):
        item = cue()
        self.assertTrue(ASR.high_confidence(item))
        item['words'][0]['probability'] = -100
        self.assertFalse(ASR.high_confidence(item))
        self.assertTrue(ASR.low_confidence(item))


def benchmark():
    items = [cue(words=24) for _ in range(6000)]
    old_items = [cue(0.3, words=24) for _ in items]
    reports = []
    for name, old, new in [
        ('high_confidence', lambda: [previous_high(item) for item in items],
         lambda: [ASR.high_confidence(item) for item in items]),
        ('recheck_improves', lambda: [previous_improves(before, after) for before, after in zip(old_items, items)],
         lambda: [ASR.recheck_improves(before, after) for before, after in zip(old_items, items)])
    ]:
        expected, actual = old(), new()
        if expected != actual:
            raise AssertionError('Synthetic metadata decisions differ')
        # Alternate order to avoid crediting either path for warm CPU state.
        samples = [[], []]
        for round_index in range(8):
            for index in ((0, 1) if round_index % 2 == 0 else (1, 0)):
                operation = (old, new)[index]
                started = time.perf_counter()
                operation()
                samples[index].append(time.perf_counter() - started)
        timings = [statistics.median(values) for values in samples]
        reports.append({'function': name, 'kind': 'synthetic_metadata_cpu_only', 'cues': len(items), 'wordsPerCue': 24,
                        'beforeSeconds': timings[0], 'afterSeconds': timings[1], 'sameOutput': True})
    print(json.dumps(reports))


if __name__ == '__main__':
    if sys.argv[1:] == ['--benchmark']:
        benchmark()
    else:
        unittest.main()
