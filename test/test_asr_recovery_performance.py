"""Recovery CPU equivalence using synthetic cue metadata only.

The reference functions are frozen from 1.9.7. No audio, model, provider,
network, GPU or production data is opened. --benchmark times metadata only.
"""
import copy
import importlib.util
import json
import pathlib
import random
import sys
import time
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('asr_recovery_current', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


def reference_select(cues, targets, duration):
    selected = []
    for cue in cues:
        if any(start <= (cue['start'] + cue['end']) / 2 <= end for start, end in targets):
            selected.append(cue)
        elif cue.get('words'):
            words = [word for word in cue['words'] if any(
                min(word['end'], end) - max(word['start'], start) > 0.001 for start, end in targets)]
            selected.extend(ASR.rebuild_word_cues(words, [cue], duration))
    return selected


def reference_concordant(original, candidates):
    used, replacements = set(), {}
    for old_index, old in enumerate(original):
        if not (ASR.needs_review(old) or ASR.needs_alignment_review(old)):
            continue
        matches = [(index, cue) for index, cue in enumerate(candidates) if index not in used
                   and cue.get('words') and not ASR.needs_review(cue)
                   and ASR.cue_confidence(cue) is not None and ASR.cue_confidence(cue) >= 0.7
                   and old['start'] <= (cue['start'] + cue['end']) / 2 <= old['end']]
        matches.sort(key=lambda pair: (pair[1]['start'], pair[1]['end']))
        if not matches or not ASR.transcript_key(old['text']):
            continue
        if ASR.transcript_key(''.join(cue['text'] for _, cue in matches)) != ASR.transcript_key(old['text']):
            continue
        covered = ASR.merge_intervals([(cue['start'], cue['end']) for _, cue in matches], old['end'])
        overlap = sum(max(0.0, min(end, old['end']) - max(start, old['start'])) for start, end in covered)
        if overlap / (old['end'] - old['start']) < 0.7:
            continue
        if not ASR.recheck_fits_neighbors([cue for _, cue in matches], original, old_index, replacements):
            continue
        flag = 'rechecked_confidence' if ASR.needs_review(old) else 'rechecked_alignment'
        replacements[old_index] = [{**cue, 'qualityFlags': list(dict.fromkeys(cue.get('qualityFlags', []) + [flag]))}
                                   for _, cue in matches]
        used.update(index for index, _ in matches)
    result = [cue for index, old in enumerate(original) for cue in replacements.get(index, [old])]
    return result, [cue for index, cue in enumerate(candidates) if index not in used], len(used)


def cue(start, end, text='synthetic', aligned=True, probability=0.95):
    item = {'start': start, 'end': end, 'text': text, 'avgLogprob': -0.1,
            'noSpeechProbability': 0.01}
    if aligned:
        item['words'] = [{'start': start, 'end': end, 'word': text, 'probability': probability}]
    else:
        item['qualityFlags'] = ['word_timestamps_unavailable']
    return item


class RecoveryEquivalenceTests(unittest.TestCase):
    def test_target_index_matches_exact_predicates_at_submillisecond_boundaries(self):
        targets = [(2, 3), (6, 6), (10, 10.0005), (20, 19), (0, 100),
                   (float('nan'), 1), (2, float('nan'))]
        index = ASR.RecoveryTargetIndex(targets)
        for point in (-1, 0, 2, 3, 6, 10, 10.0005, 100, 100.000001):
            self.assertEqual(index.contains(point), any(start <= point <= end for start, end in targets))
        for start in (-1, 0, 1.999, 2, 3, 5.999, 6, 9.999, 10, 10.0005, 99.999, 100):
            for length in (0, 0.0005, 0.001, 0.0010000001, 0.5, 5):
                end = start + length
                self.assertEqual(index.overlaps(start, end), any(
                    min(end, right) - max(start, left) > 0.001 for left, right in targets))

    def test_recovery_selection_randomized_unsorted_nested_touching_targets(self):
        rng = random.Random(195982)
        for case in range(700):
            targets = []
            for _ in range(rng.randrange(80)):
                start = rng.uniform(-5, 100)
                targets.append((start, start + rng.choice([0, 0.0005, 0.001, 0.2, 1, 30])))
            rng.shuffle(targets)
            cues = []
            for _ in range(rng.randrange(40)):
                start = rng.uniform(0, 98)
                item = cue(start, start + rng.choice([0.001, 0.002, 0.5, 1, 2]),
                           text=rng.choice(['a', ' B ', '가。']), aligned=rng.randrange(4) > 0)
                item['qualityFlags'] = ['synthetic_preserved']
                cues.append(item)
            before = copy.deepcopy((cues, targets))
            expected = reference_select(cues, targets, 100)
            with self.subTest(case=case):
                self.assertEqual(ASR.recovery_candidates_for_targets(cues, targets, 100), expected)
                self.assertEqual(ASR.recovery_candidates_for_targets(cues, ASR.RecoveryTargetIndex(targets), 100), expected)
                self.assertEqual((cues, targets), before)

    def test_context_tail_keeps_same_words_and_native_midpoint_keeps_full_cue(self):
        source = cue(0, 10)
        source['words'] = [{'start': n, 'end': n + 0.5, 'word': str(n), 'probability': 0.99}
                           for n in range(10)]
        source['text'] = ''.join(word['word'] for word in source['words'])
        for targets in ([(8, 10)], [(5, 5)], [(4.999, 5)], [(10, 10)], [(3, 4), (8, 9)]):
            self.assertEqual(ASR.recovery_candidates_for_targets([source], targets, 10),
                             reference_select([source], targets, 10))

    def test_concordant_rechecks_randomized_preserve_used_indices_and_neighbor_rejections(self):
        rng = random.Random(817490)
        for case in range(350):
            original, candidates = [], []
            for index in range(rng.randrange(1, 35)):
                start = index * 3.0
                text = rng.choice(['ab', 'a b', 'AB', '가나', ''])
                old = cue(start, start + 2, text, aligned=rng.choice([False, True]),
                          probability=rng.choice([0.3, 0.95]))
                if rng.randrange(4) == 0:
                    old['avgLogprob'] = -2
                original.append(old)
                for part in range(rng.choice([1, 1, 2])):
                    offset = rng.choice([-0.4, 0, 0, 0.4])
                    new = cue(start + offset, start + 2 + offset, text, probability=rng.choice([0.5, 0.7, 0.99]))
                    new['qualityFlags'] = ['synthetic_preserved']
                    if part:
                        new['text'] = 'conflict'
                    candidates.append(new)
            rng.shuffle(original)
            rng.shuffle(candidates)
            before = copy.deepcopy((original, candidates))
            with self.subTest(case=case):
                self.assertEqual(ASR.concordant_rechecks(original, candidates), reference_concordant(original, candidates))
                self.assertEqual((original, candidates), before)

    def test_equal_time_candidate_order_is_stable_and_endpoint_midpoints_are_inclusive(self):
        original = [cue(1, 3, 'ab', aligned=False)]
        left, right = cue(0, 2, 'a'), cue(2, 4, 'b')
        same_a, same_b = cue(1, 3, 'a'), cue(1, 3, 'b')
        for candidates in ([left, right], [right, left], [same_a, same_b], [same_b, same_a]):
            self.assertEqual(ASR.concordant_rechecks(original, candidates), reference_concordant(original, candidates))

    def test_neighbor_index_tracks_expanded_split_and_empty_replacements(self):
        original = [cue(0, 2), cue(10, 12), cue(20, 22)]
        index = ASR.RecoveryNeighborIndex(original)
        replacements = {}
        for replacement in ([cue(5, 12)], [cue(5, 6), cue(10, 12)], [], [cue(-5, 25)]):
            replacements[1] = replacement
            index.replace(1, replacement)
            for old_index in range(3):
                for start, end in ((0, 2), (5.5, 6.5), (7, 8), (10, 12), (22, 24), (1.98, 3)):
                    candidates = [cue(start, end)]
                    self.assertEqual(index.fits(candidates, old_index),
                                     ASR.recheck_fits_neighbors(candidates, original, old_index, replacements))
        self.assertTrue(ASR.RecoveryNeighborIndex([]).fits([cue(0, 1)], -1))

    def test_neighbor_index_random_updates_match_authoritative_overlap_predicate(self):
        rng = random.Random(265392)
        for case in range(180):
            original = []
            for _ in range(rng.randrange(1, 45)):
                start = rng.uniform(-5, 100)
                original.append(cue(start, start + rng.uniform(0.001, 10)))
            rng.shuffle(original)
            indexed = ASR.RecoveryNeighborIndex(original)
            replacements = {}
            for _ in range(30):
                position = rng.randrange(len(original))
                replacements[position] = []
                for _ in range(rng.randrange(4)):
                    start = rng.uniform(-10, 110)
                    replacements[position].append(cue(start, start + rng.uniform(0.001, 10)))
                indexed.replace(position, replacements[position])
                start = rng.uniform(-10, 110)
                candidates = [cue(start, start + rng.choice([0.019, 0.02, 0.020001, 1, 20]))]
                with self.subTest(case=case, position=position):
                    self.assertEqual(indexed.fits(candidates, position),
                                     ASR.recheck_fits_neighbors(candidates, original, position, replacements))


def benchmark():
    cases = 0
    for count in (1819, 6000):
        duration = count * 4 + 2
        targets = [(index * 4.0 + 1.75, index * 4.0 + 2.0) for index in range(count)]
        candidates = [cue(index * 4.0, index * 4.0 + 2, text=str(index)) for index in range(count)]
        original = [cue(index * 4.0, index * 4.0 + 2, text=str(index), aligned=False) for index in range(count)]
        # The recovery caller processes each decoded segment separately. Reuse
        # one target index for the entire phase, exactly as production does.
        def baseline_select():
            return [selected for item in candidates for selected in reference_select([item], targets, duration)]

        def indexed_select():
            index = ASR.RecoveryTargetIndex(targets)
            return [selected for item in candidates for selected in ASR.recovery_candidates_for_targets([item], index, duration)]

        for name, baseline, current in (
            ('recovery_candidates_for_targets', baseline_select, indexed_select),
            ('concordant_rechecks', lambda: reference_concordant(original, candidates),
             lambda: ASR.concordant_rechecks(original, candidates)),
        ):
            started = time.perf_counter()
            expected = baseline()
            baseline_seconds = time.perf_counter() - started
            started = time.perf_counter()
            actual = current()
            current_seconds = time.perf_counter() - started
            if actual != expected:
                raise AssertionError('Recovery metadata output changed: ' + name)
            print(json.dumps({'kind': 'synthetic_recovery_metadata_cpu_only', 'function': name,
                              'cueCount': count, 'baselineSeconds': round(baseline_seconds, 6),
                              'currentSeconds': round(current_seconds, 6), 'sameOutput': True}), flush=True)
            cases += 1
    print(json.dumps({'cases': cases, 'allOutputsEqual': True}), flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--benchmark']:
        benchmark()
    else:
        unittest.main()
