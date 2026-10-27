"""Frozen 1.9.32 recovery merge comparisons on neutral synthetic metadata.

No media, speech model, inference, provider, network or production data is
opened. --benchmark measures only these CPU metadata operations.
"""
import copy
import importlib.util
import json
import pathlib
import random
import statistics
import sys
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('asr_merge_v1933', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


def reference_novel(result, candidate):
    result, novel, blocked = list(result), [], False
    for word in candidate['words']:
        conflict = False
        for index, old in enumerate(result):
            existing = old.get('words') or [{'start': old['start'], 'end': old['end']}]
            if any(ASR.word_time_overlap(word, previous) for previous in existing):
                conflict = True
                break
            if (not old.get('words') and min(old['end'], word['end'])
                    - max(old['start'], word['start']) > 0.001):
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
            result.extend(ASR.rebuild_word_cues(words, old_cues + [candidate],
                                             max(old['end'] for old in old_cues + [candidate])))
        else:
            outside.append(word)
    buckets = {}
    for word in outside:
        position = sum(old['end'] <= word['start'] for old in result)
        buckets.setdefault(position, []).append(word)
    for words in buckets.values():
        result.extend(ASR.rebuild_word_cues(words, [candidate], max(word['end'] for word in words)))
    return result, len(novel), blocked


def reference_merge(original, candidates):
    result, candidates, accepted = ASR.concordant_rechecks(original, candidates)
    for candidate in candidates:
        if ASR.needs_review(candidate):
            continue
        overlaps = []
        for index, cue in enumerate(result):
            overlap = max(0.0, min(cue['end'], candidate['end']) - max(cue['start'], candidate['start']))
            if overlap > 0.15 and overlap / min(cue['end'] - cue['start'], candidate['end'] - candidate['start']) > 0.35:
                overlaps.append((index, cue, overlap))
        if len(overlaps) == 1:
            index, old, overlap = overlaps[0]
            if (ASR.recheck_improves(old, candidate) and overlap / (old['end'] - old['start']) >= 0.7
                    and ASR.recheck_fits_neighbors([candidate], result, index)):
                result[index] = {**candidate, 'qualityFlags': list(dict.fromkeys(
                    candidate.get('qualityFlags', []) + ['rechecked_confidence']))}
                accepted += 1
                continue
        if candidate.get('words'):
            result, added, blocked = reference_novel(result, candidate)
            if added or blocked:
                accepted += added
                continue
        if overlaps:
            continue
        result.append(candidate)
        accepted += 1
    return sorted(result, key=lambda cue: (cue['start'], cue['end'])), accepted


def cue(start, end, text='neutral', words=True, probability=0.95, log=-0.1, silence=0.01):
    item = {'start': start, 'end': end, 'text': text,
            'avgLogprob': log, 'noSpeechProbability': silence,
            'qualityFlags': ['synthetic_preserved']}
    if words:
        item['words'] = [{'start': start, 'end': end, 'word': text, 'probability': probability}]
    return item


class MergeIndexTests(unittest.TestCase):
    def assert_merge_equal(self, original, candidates):
        before = copy.deepcopy((original, candidates))
        self.assertEqual(ASR.merge_recovery(original, candidates), reference_merge(original, candidates))
        self.assertEqual((original, candidates), before)

    def test_randomized_merges_preserve_every_word_time_flag_and_accepted_count(self):
        rng = random.Random(19332571)
        for case in range(700):
            original, candidates = [], []
            for target in (original, candidates):
                for index in range(rng.randrange(36)):
                    start = rng.randrange(60) / 3
                    item = cue(start, start + rng.choice([0.0005, 0.02, 0.15, 0.5, 1, 3, 8]),
                               text=rng.choice(['a ', 'b', 'c d', '']), words=rng.randrange(4) != 0,
                               probability=rng.choice([0.2, 0.44, 0.7, 0.95]),
                               log=rng.choice([-2.0, -0.8, -0.1]), silence=rng.choice([0.01, 0.9]))
                    if item.get('words') and rng.randrange(3) == 0:
                        # Native metadata can contain word bounds outside its
                        # cue. The envelope must remain conservative.
                        item['words'] = []
                        for word in range(rng.randrange(1, 5)):
                            left = start + rng.choice([-1, 0, 0.02, 0.5, 2])
                            item['words'].append({'start': left, 'end': left + rng.choice([0.0005, 0.2, 1, 2]),
                                                  'word': str(word), 'probability': rng.choice([0.2, 0.95])})
                    target.append(item)
                rng.shuffle(target)
            with self.subTest(case=case):
                self.assert_merge_equal(original, candidates)

    def test_randomized_word_insertions_preserve_source_order_and_bucket_grouping(self):
        rng = random.Random(19337211)
        for case in range(450):
            original = []
            for index in range(rng.randrange(35)):
                start = rng.randrange(50) / 2
                original.append(cue(start, start + rng.choice([0.05, 0.4, 2, 6]), str(index),
                                    words=rng.randrange(4) != 0))
            candidate = cue(0, 40, 'new')
            candidate['words'] = []
            for index in range(rng.randrange(25)):
                start = rng.randrange(60) / 2
                candidate['words'].append({'start': start, 'end': start + rng.choice([0.0005, 0.1, 0.6, 4]),
                                           'word': str(index), 'probability': 0.95})
            before = copy.deepcopy((original, candidate))
            with self.subTest(case=case):
                self.assertEqual(ASR.merge_novel_recovery_words(original, candidate), reference_novel(original, candidate))
                self.assertEqual((original, candidate), before)

    def test_first_conflict_uses_insertion_order_rather_than_time_order(self):
        aligned = cue(5, 8)
        native = cue(1, 7, words=False)
        candidate = cue(6, 9)
        for original in ([aligned, native], [native, aligned]):
            self.assertEqual(ASR.merge_novel_recovery_words(original, candidate), reference_novel(original, candidate))
            self.assert_merge_equal(original, [candidate])

    def test_word_bounds_outside_native_cue_are_not_pruned(self):
        old = cue(20, 22)
        old['words'][0].update(start=2, end=4)
        for candidate in (cue(2.5, 3.5), cue(21, 21.5), cue(3.9995, 4.2)):
            self.assertEqual(ASR.merge_novel_recovery_words([old], candidate), reference_novel([old], candidate))
            self.assert_merge_equal([old], [candidate])

    def test_exact_thresholds_touching_intervals_and_small_positive_durations(self):
        for length in (0.0005, 0.001, 0.0010000001, 0.02, 0.15, 0.150000001, 1):
            for start in (0, 1 - length, 1, 1.001, 1.02, 1.15):
                candidate = cue(start, start + length)
                for aligned in (False, True):
                    self.assert_merge_equal([cue(0, 1, words=aligned)], [candidate])

    def test_replacements_expanding_bounds_are_visible_to_later_candidates(self):
        original = [cue(10, 11, 'old', probability=0.2, log=-2), cue(20, 21)]
        candidates = [cue(9, 12, 'replacement'), cue(11.5, 13, 'tail'), cue(20.9, 22, 'adjacent')]
        self.assert_merge_equal(original, candidates)

    def test_tombstones_preserve_pop_append_and_equal_time_sort_order(self):
        original = [cue(3, 6, 'b'), cue(1, 4, 'a'), cue(9, 10, 'd')]
        original[0]['words'] = [{'start': 5, 'end': 6, 'word': 'b', 'probability': 0.95}]
        original[1]['words'] = [{'start': 1, 'end': 2, 'word': 'a', 'probability': 0.95}]
        candidates = [cue(3, 3.5, 'c'), cue(6.1, 7, 'e'), cue(1, 2, 'same'), cue(12, 13, 'f')]
        self.assert_merge_equal(original, candidates)

    def test_tree_grows_and_counts_unsorted_ends_after_removals(self):
        items = [cue(20, 24), cue(0, 1), cue(7, 8)]
        indexed = ASR.RecoveryCueIndex(items)
        for index in range(45):
            indexed.extend([cue(index + 0.25, index + 0.75)])
            if index % 3 == 0:
                indexed.remove(index)
            for point in (-1, 0, 1, 7, 8, 24, 100):
                self.assertEqual(indexed.ends_at_or_before(point),
                                 sum(cue['end'] <= point for cue in indexed.values()))
            for start, end in ((0, 1), (5, 10), (15, 24), (100, 101)):
                actual = list(indexed.overlapping(start, end))
                self.assertEqual(actual, sorted(actual))
                expected = [position for position, item in enumerate(indexed.cues)
                            if item is not None and item['start'] < end and item['end'] > start]
                self.assertEqual(actual, expected)

    def test_empty_inputs_and_wordless_results_match_reference(self):
        for old, new in (([], []), ([], [cue(1, 2)]), ([cue(1, 2)], []),
                         ([cue(1, 2, words=False)], [cue(5, 6, words=False)])):
            self.assert_merge_equal(old, new)

    def test_nonfinite_zero_reversed_and_boolean_bounds_use_legacy_fallback(self):
        for start, end in ((0, 0), (3, 2), (False, 1), (float('nan'), 2),
                           (0, float('inf')), (-float('inf'), 2)):
            old = [cue(start, end)]
            with patch.object(ASR, '_merge_recovery_linear', return_value=('legacy', 7)) as legacy:
                self.assertEqual(ASR.merge_recovery(old, []), ('legacy', 7))
                legacy.assert_called_once_with(old, [])
            with patch.object(ASR, '_merge_novel_recovery_words_linear', return_value=('legacy', 3, True)) as legacy:
                new = cue(4, 5)
                self.assertEqual(ASR.merge_novel_recovery_words(old, new), ('legacy', 3, True))
                legacy.assert_called_once_with(old, new)

    def test_one_shot_iterators_are_not_exhausted_by_index_validation(self):
        for which in ('original', 'candidates'):
            original, candidates = [cue(1, 2)], [cue(3, 4)]
            if which == 'original':
                original = iter(original)
            else:
                candidates = iter(candidates)
            with patch.object(ASR, '_merge_recovery_linear', return_value=('legacy', 2)) as legacy:
                self.assertEqual(ASR.merge_recovery(original, candidates), ('legacy', 2))
                legacy.assert_called_once_with(original, candidates)
            iterator = original if which == 'original' else candidates
            self.assertEqual(len(list(iterator)), 1)

    def test_invalid_word_metadata_retains_legacy_behavior_without_partial_index(self):
        for words in ([{'start': 1, 'end': 1, 'word': 'a'}], [{'start': 1, 'end': float('inf')}],
                      [{'start': True, 'end': 2}], [{'start': 1}], 'invalid'):
            item = cue(1, 2)
            item['words'] = words
            with patch.object(ASR, '_merge_recovery_linear', return_value=('legacy', 4)) as legacy:
                self.assertEqual(ASR.merge_recovery([item], []), ('legacy', 4))
                legacy.assert_called_once()


def benchmark():
    count = 3000
    original = [cue(index * 4, index * 4 + 1, str(index)) for index in range(count)]
    for kind, candidates in (
        ('known_duplicate_words', [cue(index * 4, index * 4 + 1, str(index)) for index in range(count)]),
        ('novel_words_in_gaps', [cue(index * 4 + 2, index * 4 + 3, str(index)) for index in range(count)]),
    ):
        measurements = {'baseline': [], 'current': []}
        expected = None
        for _ in range(3):
            for name, function in (('baseline', reference_merge), ('current', ASR.merge_recovery)):
                started = time.perf_counter()
                output = function(original, candidates)
                measurements[name].append(time.perf_counter() - started)
                if expected is None:
                    expected = output
                elif output != expected:
                    raise AssertionError('Recovery merge output changed')
        baseline, current = (statistics.median(measurements[name]) for name in ('baseline', 'current'))
        print(json.dumps({'kind': 'synthetic_recovery_merge_cpu_only', 'scenario': kind, 'sourceCues': count,
                          'candidateCues': len(candidates), 'runs': 3, 'baselineMedianSeconds': baseline,
                          'currentMedianSeconds': current, 'ratio': baseline / current, 'sameOutput': True}), flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--benchmark']:
        benchmark()
    else:
        unittest.main()
