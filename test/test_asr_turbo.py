"""Turbo decoder contracts with owned clock/audio/model fakes only.

No model package, model download, media file, GPU or provider is required.
"""
import importlib.util
import math
import pathlib
import random
import sys
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('asr_turbo_owned', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


class ClockAudio:
    def __init__(self, seconds=0, rate=10, start=0, count=None):
        self.rate = rate
        self.start = start
        self.count = round(seconds * rate) if count is None else count

    def __len__(self):
        return self.count

    def __getitem__(self, key):
        if isinstance(key, slice):
            start, end, step = key.indices(self.count)
            if step != 1:
                raise AssertionError('Audio must be contiguous')
            return ClockAudio(rate=self.rate, start=self.start + start, count=end - start)
        return 0.0


def segment(start=3.125, end=4.375, text='합성 원어 발화'):
    return {'start': start, 'end': end, 'text': text,
            'avg_logprob': -0.1, 'no_speech_prob': 0.02, 'words': None}


class NativeModel:
    def __init__(self):
        self.calls = []
        self.language_calls = []

    def detect_language(self, **options):
        self.language_calls.append(options)
        return 'ja', 0.99, []

    def transcribe(self, audio, **options):
        self.calls.append((audio, options))
        return iter([segment()]), None


class TurboTests(unittest.TestCase):
    def run_audio(self, seconds=190, rate=10, handler=None, **options):
        calls, factories, events = [], [], []
        model = NativeModel()

        class Pipeline:
            last_speech_timestamp = 0.0

            def __init__(self, selected):
                factories.append(selected)

            def transcribe(self, audio, **kwargs):
                call = {'audio': audio, 'options': kwargs, 'pipeline': self}
                calls.append(call)
                result = handler(call, calls) if handler else [segment()]
                if isinstance(result, Exception):
                    raise result
                return iter(result), None

        cues, quality = ASR.transcribe_audio(model, ClockAudio(seconds, rate), profile='turbo',
            sample_rate=rate, language='ja', emitter=events.append, turbo_pipeline_factory=Pipeline, **options)
        return cues, quality, events, calls, factories, model

    def test_parser_accepts_turbo_without_changing_existing_default(self):
        base = ['--audio', 'owned-not-opened.flac', '--cache', 'owned-cache']
        self.assertEqual(ASR.parser_for_cli().parse_args(base).profile, 'fast')
        args = ASR.parser_for_cli().parse_args(base + ['--profile', 'turbo', '--workers', '2'])
        self.assertEqual(args.profile, 'turbo')
        self.assertIsNone(args.model)
        self.assertEqual(args.workers, '2')

    def test_gpu_uses_one_pipeline_and_bounded_batch_four_with_greedy_native_timestamps(self):
        cues, quality, events, calls, factories, model = self.run_audio(device='cuda', workers=2,
            speech_detector=lambda *_: self.fail('Turbo cannot run the accurate independent audit'))
        self.assertEqual(factories, [model])
        self.assertEqual(model.calls, [])
        self.assertEqual(len(calls), 3)
        self.assertEqual(len({id(call['pipeline']) for call in calls}), 1)
        for call in calls:
            options = call['options']
            self.assertEqual(options['batch_size'], 4)
            self.assertEqual(options['beam_size'], 1)
            self.assertEqual(options['best_of'], 1)
            self.assertEqual(options['temperature'], 0.0)
            self.assertIs(options['without_timestamps'], False)
            self.assertIs(options['word_timestamps'], False)
            self.assertIs(options['vad_filter'], False)
            self.assertIs(options['condition_on_previous_text'], False)
            self.assertEqual(options['task'], 'transcribe')
            self.assertEqual(options['language'], 'ja')
        self.assertEqual(quality['workers'], 1)
        self.assertEqual(quality['batchSize'], 4)
        self.assertEqual(quality['model'], 'turbo')
        self.assertTrue(all(event['workers'] == 1 for event in events if 'workers' in event))

    def test_cpu_uses_batch_one_even_when_two_workers_are_requested(self):
        _, quality, _, calls, _, _ = self.run_audio(device='cpu', workers=2)
        self.assertTrue(all(call['options']['batch_size'] == 1 for call in calls))
        self.assertEqual((quality['workers'], quality['batchSize']), (1, 1))

    def test_native_segment_times_are_preserved_with_only_real_source_offset(self):
        cues, _, _, _, _, _ = self.run_audio()
        self.assertEqual([(cue['start'], cue['end']) for cue in cues],
                         [(3.125, 4.375), (91.125, 92.375), (181.125, 182.375)])
        self.assertTrue(all(cue['qualityFlags'] == ['segment_timestamps'] for cue in cues))
        self.assertTrue(all('words' not in cue for cue in cues))

    def test_entire_two_hour_source_and_tail_are_explicitly_covered_without_vad(self):
        def answer(call, _):
            clips = call['options']['clip_timestamps']
            return [segment(clip['start'] + 0.125, min(clip['end'], clip['start'] + 0.375))
                    for clip in clips if clip['end'] - clip['start'] > 0.375]
        cues, quality, events, calls, _, _ = self.run_audio(seconds=7200.7, handler=answer)
        self.assertEqual(calls[0]['audio'].start, 0)
        self.assertEqual(calls[-1]['audio'].start + len(calls[-1]['audio']), 72007)
        self.assertEqual(quality['processedSeconds'], 7200.7)
        self.assertTrue(quality['processingComplete'])
        self.assertEqual(quality['durationSeconds'], quality['processedSeconds'])
        self.assertFalse(quality['audit']['complete'])
        self.assertFalse(quality['wordTimestamps'])
        self.assertEqual(quality['audit']['recheckedSeconds'], 0)
        self.assertGreater(cues[-1]['start'], 7190)
        for previous, following in zip(calls, calls[1:]):
            self.assertLessEqual(following['audio'].start, previous['audio'].start + len(previous['audio']))
        for call in calls:
            audio, clips = call['audio'], call['options']['clip_timestamps']
            decoded = [(int(clip['start'] * audio.rate), int(clip['end'] * audio.rate)) for clip in clips]
            self.assertEqual(decoded[0][0], 0)
            self.assertEqual(decoded[-1][1], len(audio))
            self.assertTrue(all(right - left <= 30 * audio.rate for left, right in decoded))
            self.assertTrue(all(left == previous[1] for previous, (left, _) in zip(decoded, decoded[1:])))
            self.assertLessEqual(len(clips), 4)
        self.assertTrue(all(event['phase'] not in ('audit', 'recovery') for event in events if event['type'] == 'progress'))

    def test_fractional_clip_bounds_round_trip_to_every_sample_for_official_integer_conversion(self):
        rng = random.Random(1911)
        for rate in (10, 16000, 44100):
            for count in [1, rate - 1, rate * 30, rate * 30 + 1, rate * 94] + [rng.randrange(1, rate * 94) for _ in range(100)]:
                clips = ASR.turbo_clip_timestamps(count, rate)
                decoded = [(int(clip['start'] * rate), int(clip['end'] * rate)) for clip in clips]
                self.assertEqual(decoded[0][0], 0)
                self.assertEqual(decoded[-1][1], count)
                self.assertTrue(all(end - start <= 30 * rate for start, end in decoded))
                self.assertTrue(all(start == previous[1] for previous, (start, _) in zip(decoded, decoded[1:])))
                self.assertTrue(all(math.isfinite(clip['end']) for clip in clips))

    def test_silence_is_consumed_without_fabricated_cues_and_audit_stays_unverified(self):
        cues, quality, events, _, _, _ = self.run_audio(seconds=181, handler=lambda *_: [])
        self.assertEqual(cues, [])
        self.assertTrue(quality['processingComplete'])
        self.assertFalse(quality['audit']['complete'])
        self.assertEqual(events[-1]['segments'], 0)
        self.assertFalse(any(event['type'] == 'segment' for event in events))
        self.assertIn('누락', quality['warnings'][0])

    def test_empty_audio_fails_before_constructing_pipeline(self):
        with self.assertRaisesRegex(ValueError, '비어'):
            self.run_audio(seconds=0)

    def test_explicit_model_override_is_retained_in_quality_and_runtime(self):
        _, quality, events, _, _, _ = self.run_audio(model_name='owned-local-model')
        self.assertEqual(quality['model'], 'owned-local-model')
        self.assertEqual(next(event for event in events if event['type'] == 'info')['model'], 'owned-local-model')

    def test_auto_language_still_uses_distributed_probes_without_accurate_audit(self):
        model, events = NativeModel(), []
        class Pipeline:
            def __init__(self, selected):
                self.model = selected
            def transcribe(self, audio, **options):
                return iter([]), None
        ASR.transcribe_audio(model, ClockAudio(190), profile='turbo', sample_rate=10,
            emitter=events.append, turbo_pipeline_factory=Pipeline)
        self.assertEqual(len(model.language_calls), 3)
        self.assertEqual([entry['audio'].start for entry in model.language_calls], [0, 800, 1600])

    def test_cuda_oom_retries_only_current_atomic_window_once_and_keeps_earlier_work(self):
        def handler(call, calls):
            if len(calls) == 2:
                def partial_failure():
                    yield segment(text='미완료 시도에서 나온 가짜 결과')
                    call['pipeline'].last_speech_timestamp = 999
                    raise RuntimeError('CUDA out of memory')
                return partial_failure()
            return [segment()]
        cues, quality, events, calls, factories, _ = self.run_audio(device='cuda', handler=handler)
        self.assertEqual([call['audio'].start for call in calls], [0, 880, 880, 1780])
        self.assertEqual([call['options']['batch_size'] for call in calls], [4, 4, 1, 1])
        self.assertEqual(len(factories), 1)
        self.assertEqual(len(cues), 3)
        self.assertFalse(any('가짜' in cue['text'] for cue in cues))
        self.assertFalse(any('가짜' in event.get('text', '') for event in events))
        self.assertTrue(quality['parallelMemoryFallback'])
        self.assertEqual(quality['batchSize'], 1)
        self.assertEqual(calls[-1]['pipeline'].last_speech_timestamp, 0.0)
        progress = [event for event in events if event['type'] == 'progress' and event['phase'] == 'transcription']
        self.assertEqual([event['completedSeconds'] for event in progress], [90, 180, 190])
        self.assertEqual([event['batchSize'] for event in progress], [4, 1, 1])

    def test_cuda_oom_retry_failure_is_not_retried_again(self):
        calls, events = [], []
        class Pipeline:
            last_speech_timestamp = 0.0
            def __init__(self, model):
                pass
            def transcribe(self, audio, **options):
                calls.append(options['batch_size'])
                raise RuntimeError('CUDA out of memory')
        with self.assertRaisesRegex(RuntimeError, 'out of memory'):
            ASR.transcribe_audio(NativeModel(), ClockAudio(190), profile='turbo', device='cuda',
                sample_rate=10, language='ja', emitter=events.append, turbo_pipeline_factory=Pipeline)
        self.assertEqual(calls, [4, 1])
        self.assertFalse(any(event['type'] in ('segment', 'transcript', 'complete') for event in events))

    def test_cpu_oom_is_not_retried_and_nonmemory_cuda_errors_hard_stop(self):
        for device, message in [('cpu', 'CUDA out of memory'), ('cuda', 'invalid model format'),
                                ('cuda', 'synthetic unrelated decode failure')]:
            calls, events = [], []
            class Pipeline:
                def __init__(self, model):
                    pass
                def transcribe(self, audio, **options):
                    calls.append(options['batch_size'])
                    raise RuntimeError(message)
            with self.subTest(device=device, message=message), self.assertRaisesRegex(RuntimeError, message):
                ASR.transcribe_audio(NativeModel(), ClockAudio(190), profile='turbo', device=device,
                    sample_rate=10, language='ja', emitter=events.append, turbo_pipeline_factory=Pipeline)
            self.assertEqual(len(calls), 1)
            self.assertFalse(any(event['type'] == 'complete' for event in events))

    def test_failure_after_completed_window_retains_its_events_without_advancing_failed_coverage(self):
        calls, events = [], []
        class Pipeline:
            def __init__(self, model):
                pass
            def transcribe(self, audio, **options):
                calls.append(audio.start)
                if len(calls) == 2:
                    raise RuntimeError('owned second window failed')
                return iter([segment()]), None
        with self.assertRaisesRegex(RuntimeError, 'second window'):
            ASR.transcribe_audio(NativeModel(), ClockAudio(190), profile='turbo',
                sample_rate=10, language='ja', emitter=events.append, turbo_pipeline_factory=Pipeline)
        self.assertEqual(calls, [0, 880])
        self.assertEqual(len([event for event in events if event['type'] == 'segment']), 1)
        self.assertEqual([event['completedSeconds'] for event in events if event['type'] == 'progress'], [90])
        self.assertFalse(any(event['type'] == 'complete' for event in events))

    def test_missing_batch_api_fails_actionably_without_falling_back_to_regular_model(self):
        with patch.dict(sys.modules, {'faster_whisper': types.ModuleType('faster_whisper')}):
            with self.assertRaisesRegex(RuntimeError, 'BatchedInferencePipeline.*1.2.1'):
                ASR.batched_pipeline_class()

    def test_existing_fast_and_accurate_keep_their_ordinary_decoder_settings(self):
        for profile in ('fast', 'accurate'):
            model, events = NativeModel(), []
            ASR.transcribe_audio(model, ClockAudio(10), profile=profile, sample_rate=10, language='ja',
                emitter=events.append, speech_detector=lambda *_: [(3.125, 4.375)],
                turbo_pipeline_factory=lambda _: self.fail('Existing profiles cannot instantiate batch pipeline'))
            self.assertTrue(model.calls)
            for _, options in model.calls:
                self.assertEqual(options['beam_size'], 5)
                self.assertEqual(options['best_of'], 5)
                self.assertEqual(options['temperature'], (0.0, 0.2, 0.4))
                self.assertEqual(options['word_timestamps'], profile == 'accurate')
                self.assertNotIn('batch_size', options)
                self.assertNotIn('clip_timestamps', options)

    def test_cli_turbo_default_and_override_force_one_model_worker(self):
        for override, expected in [([], 'turbo'), (['--model', 'owned-local-model'], 'owned-local-model')]:
            model = types.SimpleNamespace(_videorandom_workers=1, _videorandom_parallel_memory_fallback=False)
            audio_module, vad_module = types.ModuleType('faster_whisper.audio'), types.ModuleType('faster_whisper.vad')
            audio_module.decode_audio = lambda *_args, **_kwargs: ClockAudio(10, 16000)
            vad_module.VadOptions = lambda **_kwargs: object()
            vad_module.get_speech_timestamps = lambda *_args, **_kwargs: self.fail('CLI turbo does not need VAD')
            with patch.dict(sys.modules, {'faster_whisper.audio': audio_module, 'faster_whisper.vad': vad_module}), \
                 patch.object(sys, 'argv', ['owned-script', '--audio', 'owned-not-opened.flac', '--cache', 'owned-cache',
                                           '--profile', 'turbo', '--workers', '2'] + override), \
                 patch.object(ASR, 'batched_pipeline_class', return_value=object) as resolve, \
                 patch.object(ASR, 'load_whisper_model', return_value=(model, 'cuda', 'int8_float16')) as load, \
                 patch.object(ASR, 'transcribe_audio') as transcribe, patch.object(ASR, 'emit'):
                ASR.main()
                self.assertEqual(load.call_args.args[0], expected)
                self.assertEqual(load.call_args.kwargs['workers'], '1')
                self.assertEqual(transcribe.call_args.kwargs['model_name'], expected)
                self.assertEqual(transcribe.call_args.kwargs['workers'], 1)
                self.assertIs(transcribe.call_args.kwargs['turbo_pipeline_factory'], object)
                resolve.assert_called_once()


if __name__ == '__main__':
    unittest.main()
