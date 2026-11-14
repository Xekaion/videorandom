"""Context-sensitive neutral model tests; no media, network or inference."""
import importlib.util
import math
import pathlib
import random
import unittest

SPEC = importlib.util.spec_from_file_location('context_asr', pathlib.Path(__file__).resolve().parents[1] / 'scripts/transcribe_local.py')
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


class Audio:
    def __init__(self, count, start=0):
        self.count, self.start = count, start

    def __len__(self):
        return self.count

    def __getitem__(self, item):
        if isinstance(item, slice):
            start, end, _ = item.indices(self.count)
            return Audio(end - start, self.start + start)
        return 0.0


def segment(start, end, text='Neutral announcement.'):
    return dict(start=start, end=end, text=text, avg_logprob=-0.1, no_speech_prob=0.05,
                words=[dict(start=start, end=end, word=text, probability=0.95)])


class ContextTests(unittest.TestCase):
    def test_short_target_keeps_external_context(self):
        self.assertEqual(ASR.recovery_plan([(20, 20.5)], 60), [(15.5, 25, 18.5, 22)])

    def test_nearby_targets_share_a_decode(self):
        self.assertEqual(ASR.recovery_plan([(20, 20.5), (25, 25.5)], 60), [(15.5, 30, 18.5, 27)])

    def test_distant_targets_remain_separate(self):
        plan = ASR.recovery_plan([(20, 20.5), (50, 50.5)], 90)
        self.assertEqual(len(plan), 2)
        self.assertLess(plan[0][1], plan[1][0])

    def test_edges_clip_to_audio_without_negative_offsets(self):
        self.assertEqual(ASR.recovery_plan([(0, 0.5), (59.5, 60)], 60),
                         [(0, 5, 0, 2), (55, 60, 58, 60)])

    def test_empty_targets_do_not_decode(self):
        self.assertEqual(ASR.recovery_plan([], 7200), [])

    def test_invalid_window_settings_fail_instead_of_looping(self):
        for maximum, context in [(0, 3), (-1, 0), (30, -1), (30, 16), (float('nan'), 3), (30, float('inf'))]:
            with self.assertRaises(ValueError):
                ASR.recovery_plan([(1, 2)], 60, maximum, context)

    def test_random_plans_keep_all_targets_and_bound_decoded_work(self):
        rng = random.Random(1939)
        for _ in range(500):
            duration = rng.uniform(1, 7200)
            targets = [(start, min(duration, start + rng.uniform(0.01, 40)))
                       for start in (rng.uniform(0, duration) for _ in range(rng.randrange(100)))]
            plan = ASR.recovery_plan(targets, duration)
            self.assertLessEqual(sum(end - start for start, end, _, _ in plan), duration * 1.2 + 1e-8)
            for start, end, left, right in plan:
                self.assertTrue(0 <= start <= left < right <= end <= duration)
                self.assertLessEqual(right - left, 30 + 1e-8)
                self.assertLessEqual(end - start, 36 + 1e-8)
            for start, end in targets:
                self.assertEqual(ASR.uncovered_intervals([(start, end)], [(a, b) for _, _, a, b in plan], duration), [])

    def test_grouping_reduces_short_input_encoder_padding(self):
        targets = [(10 + i * 5, 10.5 + i * 5) for i in range(200)]
        old = ASR.recovery_windows(targets, 1100, 1100)
        new = ASR.recovery_plan(targets, 1100)
        old_padded = sum(math.ceil((end - start) / 30) * 30 for start, end in old)
        new_padded = sum(math.ceil((end - start) / 30) * 30 for start, end, _, _ in new)
        self.assertLess(len(new), len(old) / 4)
        self.assertLess(new_padded, old_padded / 2)

    def test_context_sensitive_recovery_recognizes_short_utterance_at_actual_time(self):
        class Model:
            calls = []

            def transcribe(self, audio, **options):
                self.calls.append((audio.start / 10, len(audio) / 10, options))
                # First pass misses this utterance. Recheck needs >=3 seconds
                # before and after it; the old clipped 3.5-second input fails.
                if 'no_speech_threshold' in options and audio.start <= 170 and audio.start + len(audio) >= 235:
                    return iter([segment(20 - audio.start / 10, 20.5 - audio.start / 10)]), None
                return iter([]), None

        model = Model()
        cues, quality = ASR.transcribe_audio(model, Audio(600), sample_rate=10, language='ja',
            speech_detector=lambda audio, rate: [(20, 20.5)], emitter=lambda event: None)
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(20, 20.5)])
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual(len(model.calls), 3)  # Two initial cores cover the whole input.
        self.assertEqual(quality['audit']['recheckedSeconds'], 9.5)
        self.assertEqual(quality['audit']['recoveryBudgetSeconds'], 9.5)
        options = model.calls[-1][2]
        self.assertEqual((options['beam_size'], options['best_of'], options['temperature']), (5, 5, (0.0, 0.2, 0.4)))
        self.assertFalse(options['vad_filter'])
        self.assertTrue(options['word_timestamps'])

    def test_bridge_context_cannot_create_new_dialogue(self):
        plan = ASR.recovery_plan([(20, 20.5), (25, 25.5)], 60)
        self.assertEqual(len(plan), 1)
        context = ASR.cues_from_segment(segment(22, 23), 0, 60)
        self.assertEqual(ASR.recovery_candidates_for_targets(context, [(20, 20.5), (25, 25.5)], 60), [])


if __name__ == '__main__':
    unittest.main()
