"""Neutral acoustic arrays and fake ASR; no user media or model downloads."""
import importlib.util
import math
import random
import sys
import types
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

SPEC = importlib.util.spec_from_file_location('blindspot_asr', Path(__file__).resolve().parents[1] / 'scripts/transcribe_local.py')
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


def signal(duration=60, intervals=((1, 1.5),), amplitude=0.002, rate=16000):
    audio = np.zeros(round(duration * rate), dtype=np.float32)
    for start, end in intervals:
        left, right = round(start * rate), round(end * rate)
        clock = np.arange(right - left) / rate
        audio[left:right] = amplitude * np.sin(2 * np.pi * 310 * clock)
    return audio


def native(start, end, probability=0.98, words=True):
    return {'start': start, 'end': end, 'text': 'The train leaves soon.', 'avg_logprob': -0.1, 'no_speech_prob': 0.02,
            'words': [{'start': start, 'end': end, 'word': 'The train leaves soon.', 'probability': probability}] if words else []}


class BlindspotTests(unittest.TestCase):
    def test_silence_and_stationary_tone_do_not_create_candidates(self):
        self.assertEqual(ASR.acoustic_activity(np.zeros(16000), 16000), [])
        self.assertEqual(ASR.acoustic_activity(signal(30, [(0, 30)]), 16000), [])

    def test_stationary_noise_is_not_dialogue(self):
        audio = np.random.default_rng(1941).normal(0, 0.002, 30 * 16000).astype(np.float32)
        self.assertEqual(ASR.acoustic_activity(audio, 16000), [])

    def test_quiet_modulated_sound_is_detected_without_vad(self):
        audio = signal(30, [(1, 1.5)], amplitude=0.0008)
        original = audio.copy()
        self.assertEqual(ASR.acoustic_activity(audio, 16000), [(1, 1.5)])
        np.testing.assert_array_equal(audio, original)

    def test_block_boundary_is_merged_without_losing_time(self):
        self.assertEqual(ASR.acoustic_activity(signal(61, [(29.9, 30.2)]), 16000), [(29.9, 30.2)])

    def test_short_sound_survives_the_old_two_hundred_ms_limit(self):
        self.assertEqual(ASR.acoustic_activity(signal(30, [(1, 1.08)]), 16000), [(1, 1.08)])

    def test_nonfinite_audio_fails_instead_of_certifying_audit(self):
        with self.assertRaises(ValueError):
            ASR.acoustic_activity(np.array([float('nan')]), 16000)

    def test_empty_and_partial_last_block(self):
        self.assertEqual(ASR.acoustic_activity(np.array([], dtype=np.float32), 16000), [])
        audio = signal(1.133, [(1.04, 1.133)])
        self.assertEqual(ASR.acoustic_activity(audio, 16000), [(1.04, 1.133)])

    def transcribe(self, answer=None, detector=ASR.acoustic_activity, profile='accurate'):
        calls, events = [], []
        class Model:
            def transcribe(self, chunk, **options):
                calls.append(options)
                if len(calls) == 1 or answer is None:
                    return iter([]), None
                # Acoustic gap [1,1.5] is decoded from zero with full context.
                return iter([answer]), None
        cues, quality = ASR.transcribe_audio(Model(), signal(10, [(1, 1.5)]), language='ja',
            speech_detector=lambda *args: [], acoustic_detector=detector, profile=profile, emitter=events.append)
        return cues, quality, calls, events

    def test_vad_and_initial_asr_both_miss_but_front_dialogue_is_recovered(self):
        cues, quality, calls, _ = self.transcribe(native(1, 1.5))
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(1, 1.5)])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['hallucination_silence_threshold'], 2)
        self.assertIsNone(calls[1]['hallucination_silence_threshold'])
        self.assertIsNone(calls[1]['no_speech_threshold'])
        self.assertEqual(calls[1]['beam_size'], 5)
        self.assertEqual(calls[1]['best_of'], 5)
        self.assertTrue(calls[1]['word_timestamps'])
        self.assertEqual(quality['audit']['unresolvedAcousticSeconds'], 0)
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual(quality['recognitionRevision'], 4)

    def test_sound_without_recognized_words_remains_explicitly_unresolved(self):
        cues, quality, calls, _ = self.transcribe()
        self.assertEqual(cues, [])
        self.assertEqual(len(calls), 2)
        self.assertFalse(quality['audit']['complete'])
        self.assertEqual(quality['audit']['speechSeconds'], 0)
        self.assertEqual(quality['audit']['acousticCandidateSeconds'], 0.5)
        self.assertEqual(quality['audit']['unresolvedAcousticSeconds'], 0.5)
        self.assertEqual(quality['audit']['unresolvedByReason'], {'possible_missing_audio': 1})

    def test_acoustic_only_low_confidence_and_unaligned_text_cannot_fill_a_gap(self):
        for answer in [native(1, 1.5, probability=0.5), native(1, 1.5, words=False)]:
            cues, quality, _, _ = self.transcribe(answer)
            self.assertEqual(cues, [])
            self.assertFalse(quality['audit']['complete'])

    def test_detector_failure_prevents_false_complete(self):
        def broken(*args):
            raise RuntimeError('neutral audit failure')
        cues, quality, _, _ = self.transcribe(detector=broken)
        self.assertEqual(cues, [])
        self.assertFalse(quality['audit']['complete'])
        self.assertIn('acoustic_audit_unavailable', quality['audit']['unresolvedByReason'])

    def test_fast_mode_does_not_add_an_acoustic_audit(self):
        def forbidden(*args):
            raise AssertionError('must not run')
        _, _, calls, _ = self.transcribe(detector=forbidden, profile='fast')
        self.assertEqual(len(calls), 1)

    def test_full_recovery_keeps_the_existing_context_and_budget(self):
        plan = ASR.recovery_plan([(0, 7200)], 7200)
        self.assertEqual(len(plan), 240)
        self.assertTrue(all(end - start <= 36 for start, end, _, _ in plan))
        self.assertLessEqual(sum(end - start for start, end, _, _ in plan), 7200 * 1.2)

    def test_front_probe_runs_even_when_both_activity_detectors_miss(self):
        calls = []
        class Model:
            def transcribe(self, chunk, **options):
                calls.append(options)
                return iter([] if len(calls) == 1 else [native(1, 1.5)]), None
        cues, quality = ASR.transcribe_audio(Model(), signal(10), language='ja',
            speech_detector=lambda *args: [], acoustic_detector=lambda *args: [], emitter=lambda event: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(1, 1.5)])
        self.assertEqual(quality['audit']['openingRecheckedSeconds'], 10)

    def test_sample_quantization_preserves_all_owned_samples(self):
        rng = random.Random(1941)
        for _ in range(1000):
            start = rng.randrange(16000 * 100) / 16000 + 0.5 / 16000
            plan = ASR.recovery_input_windows([(start, start + 80)], start + 100, 16000)
            for left, right, core_start, core_end in plan:
                self.assertLessEqual(round(right * 16000) - round(left * 16000), 576001)
                self.assertLessEqual(left, core_start + 1 / 16000)
                self.assertGreaterEqual(right + 1 / 16000, core_end)

    def test_vectorized_noise_predicate_matches_original_decisions(self):
        rng = np.random.default_rng(1941)
        arrays = [np.zeros(16000), np.full(16000, 1e-8), np.full(16000, float('nan')),
                  np.full(16000, float('inf'))]
        for threshold in [10 ** (-55 / 20), 10 ** (-70 / 20), 10 ** (-90 / 20)]:
            for amplitude in [np.nextafter(threshold, 0), threshold, np.nextafter(threshold, np.inf)]:
                arrays.append(np.full(16000, amplitude))
        for _ in range(300):
            values = rng.normal(0, 10 ** rng.uniform(-9, -2), int(rng.integers(2048, 8192)))
            arrays.append(values.astype(np.float32) if rng.random() < 0.5 else values[::-1])
        for audio in arrays:
            duration = len(audio) / 16000
            self.assertIs(ASR.very_quiet_stationary_noise(audio, 0, duration, 16000),
                          ASR._very_quiet_stationary_noise_linear(audio, 0, duration, 16000))

    def test_real_cli_wires_both_audits_and_short_speech_policy(self):
        calls, events, vad_options = [], [], []
        class Model:
            def transcribe(self, chunk, **options):
                calls.append(options)
                return iter([] if len(calls) == 1 else [native(1, 1.5)]), None
        audio_module = types.ModuleType('faster_whisper.audio')
        audio_module.decode_audio = lambda *args, **kwargs: signal(10)
        vad_module = types.ModuleType('faster_whisper.vad')
        vad_module.VadOptions = lambda **kwargs: vad_options.append(kwargs) or kwargs
        vad_module.get_speech_timestamps = lambda *args, **kwargs: []
        original_transcribe = ASR.transcribe_audio
        def observed_transcribe(*args, **kwargs):
            return original_transcribe(*args, **kwargs, emitter=events.append)
        with patch.dict(sys.modules, {'faster_whisper.audio': audio_module, 'faster_whisper.vad': vad_module}), \
             patch.object(sys, 'argv', ['owned', '--audio', 'owned.flac', '--cache', 'unused', '--profile', 'accurate', '--language', 'ja']), \
             patch.object(ASR, 'load_model_and_audio', return_value=(Model(), 'cpu', 'int8', signal(10))), \
             patch.object(ASR, 'emit', side_effect=events.append), \
             patch.object(ASR, 'transcribe_audio', side_effect=observed_transcribe):
            ASR.main()
        self.assertEqual(vad_options[0]['min_speech_duration_ms'], 64)
        final = next(event for event in events if event['type'] == 'complete')
        self.assertEqual(final['segments'], 1)
        self.assertEqual(final['quality']['recognitionRevision'], 4)
        self.assertEqual(final['quality']['audit']['acousticCandidateSeconds'], 0.5)


if __name__ == '__main__':
    unittest.main()
