"""Owned neutral fake audio/model tests. No downloads or CUDA are required."""
import importlib.util
import json
import pathlib
import random
import tempfile
import types
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('transcribe_local', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)
BENCH_SPEC = importlib.util.spec_from_file_location('coverage_benchmark', SOURCE.with_name('benchmark_subtitle_coverage.py'))
BENCH = importlib.util.module_from_spec(BENCH_SPEC)
BENCH_SPEC.loader.exec_module(BENCH)


def segment(start, end, text='こんにちは。', probability=0.95, logprob=-0.1):
    return {'start': start, 'end': end, 'text': text, 'avg_logprob': logprob, 'no_speech_prob': 0.05,
            'words': [{'start': start, 'end': end, 'word': text, 'probability': probability}]}


class Model:
    def __init__(self, answers, languages=None):
        self.answers = list(answers)
        self.calls = []
        self.languages = list(languages or [('ja', 0.9, [])] * 3)
        self.language_calls = []

    def transcribe(self, audio, **options):
        self.calls.append((len(audio), options))
        answer = self.answers.pop(0) if self.answers else []
        if isinstance(answer, Exception):
            raise answer
        return iter(answer), object()

    def detect_language(self, **options):
        self.language_calls.append(options)
        return self.languages.pop(0)


class PositionedAudio:
    """A source clock for model tests, without allocating hours of samples."""
    def __init__(self, seconds, sample_rate=10, start_sample=0, sample_count=None):
        self.sample_rate = sample_rate
        self.start_sample = start_sample
        self.sample_count = int(seconds * sample_rate) if sample_count is None else sample_count

    def __len__(self):
        return self.sample_count

    def __getitem__(self, index):
        if isinstance(index, slice):
            start, stop, step = index.indices(self.sample_count)
            return PositionedAudio(0, self.sample_rate, self.start_sample + start, stop - start)
        return 0.0


class TranscriptionTests(unittest.TestCase):
    def run_audio(self, model, seconds=10, speech=(), **options):
        events = []
        cues, quality = ASR.transcribe_audio(model, [0] * (seconds * 10), sample_rate=10,
            language='ja', speech_detector=lambda audio, rate: speech, emitter=events.append, **options)
        return cues, quality, events

    def test_union_subtraction_handles_overlap_and_clipped_edges(self):
        self.assertEqual(ASR.merge_intervals([(-2, 2), (1, 4), (7, 12), (float('nan'), 5)], 10), [(0, 4), (7, 10)])
        self.assertEqual(ASR.uncovered_intervals([(0, 10), (5, 14)], [(2, 4), (3, 6), (9, 11)], 12), [(0, 2), (6, 9), (11, 12)])
        self.assertEqual(ASR.uncovered_intervals([(0, 10)], [(0, 9.6)], 10, minimum=0.75), [])

    def test_recovery_work_never_exceeds_budget_or_maximum_window(self):
        windows = ASR.recovery_windows([(0, 1000)], 1000, 71)
        self.assertEqual(windows, [(0, 30), (30, 60), (60, 71)])
        self.assertLessEqual(sum(end - start for start, end in windows), 71)

    def test_quality_processes_all_samples_without_vad_including_a_silent_tail(self):
        model = Model([[segment(1.125, 2.375)], []])
        cues, quality, events = self.run_audio(model, seconds=120, speech=[(1.125, 2.375)])
        self.assertEqual(cues[0]['start'], 1.125)
        self.assertEqual(cues[0]['end'], 2.375)
        self.assertEqual(quality['processedSeconds'], 120)
        self.assertEqual(quality['durationSeconds'], 120)
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual([length for length, _ in model.calls], [920, 320])
        self.assertTrue(all(not options['vad_filter'] for _, options in model.calls))
        self.assertTrue(all(options['task'] == 'transcribe' and options['word_timestamps'] for _, options in model.calls))
        self.assertEqual(events[-1]['type'], 'complete')
        self.assertEqual(events[-2]['percent'], 100)

    def test_trailing_silence_finishes_even_when_no_segments_are_emitted(self):
        cues, quality, events = self.run_audio(Model([[]]), seconds=15)
        self.assertEqual(cues, [])
        self.assertEqual(quality['processedSeconds'], 15)
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual(events[-1]['segments'], 0)
        self.assertEqual(events[-2]['completedSeconds'], 15)

    def test_two_hour_timeline_keeps_beginning_middle_and_final_dialogue_without_truncation(self):
        dialogue = [(1, 2, '始まりです。'), (3601, 3602, '中間です。'), (7197, 7198, '終わりです。')]
        class TimelineModel:
            calls = []
            def transcribe(self, audio, **options):
                start, end = audio.start_sample / 10, (audio.start_sample + len(audio)) / 10
                self.calls.append((start, end))
                return iter([segment(left - start, right - start, text) for left, right, text in dialogue
                             if left >= start and right <= end]), object()
        model, events = TimelineModel(), []
        cues, quality = ASR.transcribe_audio(model, PositionedAudio(7200), sample_rate=10, language='ja',
            speech_detector=lambda audio, rate: [(left, right) for left, right, _ in dialogue], emitter=events.append)
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(1, 2), (3601, 3602), (7197, 7198)])
        self.assertEqual(model.calls[0][0], 0)
        self.assertEqual(model.calls[-1][1], 7200)
        self.assertTrue(all(following[0] <= previous[1] for previous, following in zip(model.calls, model.calls[1:])))
        self.assertEqual(quality['processedSeconds'], 7200)
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual(quality['audit']['uncoveredSpeechSeconds'], 0)
        self.assertEqual(events[-1]['segments'], 3)

    def test_missing_speech_is_rechecked_and_recovered_with_actual_offsets(self):
        model = Model([[segment(1, 2)], [segment(1.5, 2.5, '駅です。')]])
        cues, quality, events = self.run_audio(model, speech=[(1, 2), (5, 6)])
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(1, 2), (5, 6)])
        self.assertEqual(cues[1]['words'][0]['start'], 5)
        self.assertEqual(quality['audit']['uncoveredSpeechSeconds'], 0)
        self.assertTrue(quality['audit']['complete'])
        self.assertFalse(model.calls[1][1]['vad_filter'])
        self.assertEqual(events[-3]['type'], 'transcript')
        self.assertEqual(events[-3]['segments'], cues)

    def test_empty_recheck_never_fabricates_words_for_possible_speech(self):
        cues, quality, events = self.run_audio(Model([[segment(1, 2)], []]), speech=[(1, 2), (5, 6)])
        self.assertEqual(len(cues), 1)
        self.assertFalse(quality['audit']['complete'])
        self.assertEqual(quality['audit']['unresolved'], [{'start': 5, 'end': 6, 'reason': 'possible_missing_speech'}])
        self.assertTrue(any(event['type'] == 'warning' for event in events))

    def test_recheck_context_cannot_add_text_outside_the_suspected_speech(self):
        model = Model([[segment(1, 2)], [segment(0.1, 0.4, 'context only')]])
        cues, quality, _ = self.run_audio(model, speech=[(1, 2), (5, 6)])
        self.assertEqual([cue['text'] for cue in cues], ['こんにちは。'])
        self.assertFalse(quality['audit']['complete'])

    def test_low_confidence_speech_can_be_replaced_only_by_a_better_real_decode(self):
        model = Model([[segment(1, 2, '不確かな語', probability=0.2, logprob=-2)], [segment(1, 2, 'こんにちは。')]])
        cues, quality, _ = self.run_audio(model, speech=[(1, 2)])
        self.assertEqual(cues[0]['text'], 'こんにちは。')
        self.assertEqual(cues[0]['words'][0]['probability'], 0.95)
        self.assertTrue(quality['audit']['complete'])

    def test_second_pass_cannot_overwrite_confident_first_pass_with_different_text(self):
        old = ASR.cues_from_segment(segment(1, 2, '元の言葉'), 0, 10)
        new = ASR.cues_from_segment(segment(1, 2, '違う言葉'), 0, 10)
        result, accepted = ASR.merge_recovery(old, new)
        self.assertEqual(result, old)
        self.assertEqual(accepted, 0)

    def test_subtitle_segmentation_uses_real_word_boundaries_without_interpolation(self):
        raw = segment(1, 9, '原文')
        raw['words'] = [{'start': 1.125, 'end': 2.375, 'word': 'こんにちは。', 'probability': 0.9},
                        {'start': 8.25, 'end': 9.125, 'word': '駅です。', 'probability': 0.85}]
        cues = ASR.cues_from_segment(raw, 20, 60)
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(21.125, 22.375), (28.25, 29.125)])
        self.assertEqual([cue['text'] for cue in cues], ['こんにちは。', '駅です。'])

    def test_invalid_word_alignment_retains_original_segment_and_warns(self):
        raw = segment(1, 3)
        raw['words'][0]['end'] = float('nan')
        cues = ASR.cues_from_segment(raw, 10, 60)
        self.assertEqual(cues[0]['text'], 'こんにちは。')
        self.assertEqual((cues[0]['start'], cues[0]['end']), (11, 13))
        self.assertIn('invalid_word_timestamps', cues[0]['qualityFlags'])
        self.assertFalse(ASR.needs_review(cues[0]))

    def test_missing_word_alignment_preserves_valid_full_transcript_and_segment_timings(self):
        raw = segment(1.92, 4.58)
        raw['words'][0]['end'] = raw['words'][0]['start']
        model = Model([[raw]])
        cues, quality, _ = self.run_audio(model, speech=[(1.92, 4.58)])
        self.assertEqual((cues[0]['start'], cues[0]['end']), (1.92, 4.58))
        self.assertEqual(cues[0]['text'], 'こんにちは。')
        self.assertFalse(quality['wordTimestamps'])
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual(quality['audit']['unresolved'], [])
        self.assertEqual(len(model.calls), 1)
        self.assertTrue(quality['warnings'])

    def test_language_uses_separated_windows_instead_of_only_opening_music(self):
        model = Model([], [('en', 0.5, []), ('ja', 0.9, []), ('ja', 0.95, [])])
        language, probability = ASR.choose_language(model, list(range(1200)), 120, 'auto', 10)
        self.assertEqual(language, 'ja')
        self.assertAlmostEqual(probability, 0.925)
        self.assertEqual([call['audio'][0] for call in model.language_calls], [0, 450, 900])

    def test_audit_failure_is_visible_and_never_claims_verified_coverage(self):
        events = []
        def detector(audio, rate):
            raise RuntimeError('owned fixture detector unavailable')
        cues, quality = ASR.transcribe_audio(Model([[segment(1, 2)]]), [0] * 100, sample_rate=10,
            language='ja', speech_detector=detector, emitter=events.append)
        self.assertEqual(quality['processedSeconds'], 10)
        self.assertFalse(quality['audit']['complete'])
        self.assertEqual(quality['audit']['unresolved'][0]['reason'], 'audit_unavailable')
        self.assertTrue(quality['warnings'])

    def test_events_are_finite_jsonl_and_final_reset_precedes_completion(self):
        cues, quality, events = self.run_audio(Model([[segment(1.125, 2.375)]]), speech=[(1.125, 2.375)])
        lines = [json.dumps(event, ensure_ascii=False, allow_nan=False) for event in events]
        decoded = [json.loads(line) for line in lines]
        self.assertEqual(decoded[-1]['quality'], quality)
        self.assertEqual(decoded[-1]['quality']['recognitionRevision'], 2)
        self.assertEqual(decoded[-3]['segments'], cues)
        self.assertEqual(decoded[-2]['phase'], 'completed')
        percentages = [event['percent'] for event in events if event['type'] == 'progress']
        self.assertEqual(percentages, sorted(percentages))

    def test_cli_default_retains_legacy_fast_and_accurate_is_explicit(self):
        default = ASR.parser_for_cli().parse_args(['--audio', 'owned.wav', '--cache', 'cache'])
        self.assertEqual(default.profile, 'fast')
        self.assertIsNone(default.model)
        selected = ASR.parser_for_cli().parse_args(['--audio', 'owned.wav', '--cache', 'cache', '--profile', 'accurate'])
        self.assertEqual(selected.profile, 'accurate')

    def test_auto_gpu_uses_same_requested_model_and_probes_native_encoder(self):
        calls, probes = [], []
        candidate = object()
        def factory(name, **options):
            calls.append((name, options))
            return candidate
        model, device, compute = ASR.load_whisper_model('large-v3', 'owned-cache', device='auto',
            factory=factory, cuda_count=lambda: 1, probe=probes.append, dll_registrar=lambda: 0)
        self.assertIs(model, candidate)
        self.assertEqual((device, compute), ('cuda', 'int8_float16'))
        self.assertEqual(calls[0][0], 'large-v3')
        self.assertEqual(calls[0][1]['compute_type'], 'int8_float16')
        self.assertEqual(probes, [candidate])

    def test_auto_without_gpu_uses_cpu_same_model_and_reports_warning(self):
        calls, warnings = [], []
        def factory(name, **options):
            calls.append((name, options))
            return object()
        _, device, compute = ASR.load_whisper_model('large-v3', 'owned-cache', device='auto',
            factory=factory, cuda_count=lambda: 0, probe=lambda model: None,
            dll_registrar=lambda: 0, emitter=warnings.append)
        self.assertEqual((device, compute), ('cpu', 'int8'))
        self.assertEqual([(name, options['device']) for name, options in calls], [('large-v3', 'cpu')])
        self.assertEqual(warnings[0]['type'], 'warning')
        self.assertIn('같은 음성 인식 모델', warnings[0]['message'])

    def test_lazy_cuda_dll_failure_unloads_gpu_and_preserves_model_on_cpu(self):
        calls, unloaded, warnings = [], [], []
        candidate = types.SimpleNamespace(model=types.SimpleNamespace(unload_model=lambda: unloaded.append(True)))
        def factory(name, **options):
            calls.append((name, options))
            return candidate if options['device'] == 'cuda' else 'owned-cpu-model'
        def probe(model):
            raise RuntimeError('Could not locate cudnn_ops64_9.dll')
        model, device, compute = ASR.load_whisper_model('large-v3', 'owned-cache', device='auto',
            factory=factory, cuda_count=lambda: 1, probe=probe, dll_registrar=lambda: 1, emitter=warnings.append)
        self.assertEqual(model, 'owned-cpu-model')
        self.assertEqual((device, compute), ('cpu', 'int8'))
        self.assertEqual([name for name, _ in calls], ['large-v3', 'large-v3'])
        self.assertEqual(unloaded, [True])
        self.assertEqual(len(warnings), 1)

    def test_gpu_oom_can_fall_back_to_cpu_but_never_a_smaller_model(self):
        calls = []
        def factory(name, **options):
            calls.append((name, options['device']))
            if options['device'] == 'cuda':
                raise RuntimeError('CUDA failed with error out of memory')
            return object()
        _, device, _ = ASR.load_whisper_model('large-v3', 'owned-cache', device='auto', factory=factory,
            cuda_count=lambda: 1, dll_registrar=lambda: 0, emitter=lambda event: None)
        self.assertEqual(device, 'cpu')
        self.assertEqual(calls, [('large-v3', 'cuda'), ('large-v3', 'cpu')])

    def test_wrong_model_or_corrupted_model_does_not_trigger_hardware_fallback(self):
        for failure in [ValueError('Unknown model size owned-invalid-model'), RuntimeError('Invalid model binary format'),
                        OSError('Unable to open model.bin'), RuntimeError('Hugging Face download timed out'),
                        RuntimeError('Unable to open C:/cuda-model/model.bin: file not found')]:
            calls = []
            def factory(name, **options):
                calls.append(options['device'])
                raise failure
            with self.assertRaises(type(failure)):
                ASR.load_whisper_model('owned-invalid-model', 'owned-cache', device='auto', factory=factory,
                    cuda_count=lambda: 1, dll_registrar=lambda: 0, emitter=lambda event: None)
            self.assertEqual(calls, ['cuda'])

    def test_explicit_cuda_failure_remains_visible_without_cpu_fallback(self):
        calls = []
        def factory(name, **options):
            calls.append(options['device'])
            return object()
        def probe(model):
            raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded')
        with self.assertRaisesRegex(RuntimeError, 'cublas'):
            ASR.load_whisper_model('large-v3', 'owned-cache', device='cuda', factory=factory,
                probe=probe, dll_registrar=lambda: 0)
        self.assertEqual(calls, ['cuda'])

    def test_explicit_cpu_does_not_probe_or_register_cuda_libraries(self):
        calls = []
        def factory(name, **options):
            calls.append(options)
            return object()
        def must_not_run(*args):
            self.fail('Explicit CPU must not run a CUDA probe.')
        _, device, compute = ASR.load_whisper_model('large-v3', 'owned-cache', device='cpu',
            factory=factory, probe=must_not_run, dll_registrar=must_not_run)
        self.assertEqual((device, compute), ('cpu', 'int8'))
        self.assertEqual(calls[0]['device'], 'cpu')

    def test_dll_registration_is_limited_to_installed_trusted_wheel_folders(self):
        with tempfile.TemporaryDirectory(prefix='videorandom-owned-dll-test-') as prefix:
            root = pathlib.Path(prefix)
            for package in ('cublas', 'cudnn', 'cuda_nvrtc', 'unrelated'):
                (root / 'Lib' / 'site-packages' / 'nvidia' / package / 'bin').mkdir(parents=True)
            calls, handles = [], []
            def register(directory):
                calls.append(directory)
                handle = object()
                handles.append(handle)
                return handle
            self.assertEqual(ASR.register_nvidia_dll_directories(prefix, register), 3)
            self.assertEqual({pathlib.Path(value).parent.name for value in calls}, {'cublas', 'cudnn', 'cuda_nvrtc'})
            self.assertTrue(all(pathlib.Path(value).is_relative_to(root) for value in calls))
            self.assertTrue(all(handle in ASR.DLL_DIRECTORY_HANDLES for handle in handles))
            self.assertEqual(ASR.register_nvidia_dll_directories(prefix, register), 0)

    def test_later_transcription_failure_is_not_retried_by_model_loader(self):
        calls = []
        candidate = Model([RuntimeError('CUDA out of memory during ASR')])
        def factory(name, **options):
            calls.append(options['device'])
            return candidate
        model, _, _ = ASR.load_whisper_model('large-v3', 'owned-cache', device='auto', factory=factory,
            cuda_count=lambda: 1, probe=lambda model: None, dll_registrar=lambda: 0)
        with self.assertRaisesRegex(RuntimeError, 'during ASR'):
            self.run_audio(model)
        self.assertEqual(calls, ['cuda'])

    def test_absolute_dll_preload_uses_trusted_names_and_keeps_native_handles(self):
        with tempfile.TemporaryDirectory(prefix='videorandom-owned-preload-test-') as prefix:
            root = pathlib.Path(prefix)
            base = root / 'Lib' / 'site-packages' / 'nvidia'
            files = [('cublas', 'cublas64_12.dll'), ('cublas', 'cublasLt64_12.dll'),
                     ('cuda_nvrtc', 'nvrtc-builtins64_129.dll'), ('cuda_nvrtc', 'nvrtc64_120_0.dll'),
                     ('cuda_nvrtc', 'nvrtc64_120_0.alt.dll'), ('cudnn', 'cudnn64_9.dll'),
                     ('cudnn', 'cudnn_ops64_9.dll'), ('cublas', 'untrusted.dll')]
            for package, filename in files:
                folder = base / package / 'bin'
                folder.mkdir(parents=True, exist_ok=True)
                (folder / filename).write_bytes(b'owned fake DLL')
            calls, handles = [], []
            def load(filename):
                calls.append(filename)
                handle = object()
                handles.append(handle)
                return handle
            loaded = ASR.preload_nvidia_libraries(prefix, load)
            self.assertEqual(loaded, 6)
            self.assertEqual(pathlib.Path(calls[0]).name, 'cublasLt64_12.dll')
            self.assertTrue(all(pathlib.Path(filename).is_absolute() for filename in calls))
            self.assertFalse(any('untrusted' in filename or '.alt.' in filename for filename in calls))
            self.assertTrue(all(handle in ASR.DLL_LIBRARY_HANDLES for handle in handles))
            self.assertEqual(ASR.preload_nvidia_libraries(prefix, load), 0)

    def test_absolute_dll_failure_is_classified_as_hardware_failure(self):
        with tempfile.TemporaryDirectory(prefix='videorandom-owned-preload-error-') as prefix:
            folder = pathlib.Path(prefix) / 'Lib' / 'site-packages' / 'nvidia' / 'cublas' / 'bin'
            folder.mkdir(parents=True)
            (folder / 'cublas64_12.dll').write_bytes(b'owned fake DLL')
            def load(filename):
                raise OSError('owned fixture missing native dependency')
            with self.assertRaises(RuntimeError) as failure:
                ASR.preload_nvidia_libraries(prefix, load)
            self.assertTrue(ASR.hardware_runtime_unavailable(failure.exception))

    def test_near_silent_stationary_noise_with_low_confidence_and_no_vad_is_excluded(self):
        rng = random.Random(49)
        audio = [rng.gauss(0, 0.0002) for _ in range(32000)]
        for text in ['ordinary unrelated sentence', '別の内容の文です。']:
            cue = ASR.cues_from_segment(segment(0.5, 1.3, text, probability=0.2, logprob=-2), 0, 2)[0]
            kept, removed = ASR.prune_non_speech_artifacts([cue], audio, [], 16000)
            self.assertEqual(kept, [])
            self.assertEqual(removed, [{'start': 0.5, 'end': 1.3, 'reason': 'very_quiet_non_speech'}])

    def test_quiet_voiced_sound_is_preserved_despite_low_confidence_and_vad_miss(self):
        import math
        audio = [0.0002 * math.sin(2 * math.pi * 220 * index / 16000) for index in range(32000)]
        cue = ASR.cues_from_segment(segment(0.5, 1.3, probability=0.2, logprob=-2), 0, 2)[0]
        kept, removed = ASR.prune_non_speech_artifacts([cue], audio, [], 16000)
        self.assertEqual(kept, [cue])
        self.assertEqual(removed, [])

    def test_modulated_very_quiet_breathy_sound_is_preserved_on_vad_miss(self):
        rng = random.Random(101)
        audio = [rng.gauss(0, 0.00001 if (index // 320) % 2 == 0 else 0.0003) for index in range(32000)]
        cue = ASR.cues_from_segment(segment(0.5, 1.3, probability=0.2, logprob=-2), 0, 2)[0]
        kept, removed = ASR.prune_non_speech_artifacts([cue], audio, [], 16000)
        self.assertEqual(kept, [cue])
        self.assertEqual(removed, [])

    def test_loud_noise_or_any_vad_speech_or_confident_text_is_preserved(self):
        rng = random.Random(6)
        quiet = [rng.gauss(0, 0.0002) for _ in range(32000)]
        weak = ASR.cues_from_segment(segment(0.5, 1.3, probability=0.2, logprob=-2), 0, 2)[0]
        good = ASR.cues_from_segment(segment(0.5, 1.3), 0, 2)[0]
        for audio, cues, speech in [([value * 100 for value in quiet], [weak], []),
                                    (quiet, [weak], [(0.6, 0.7)]), (quiet, [good], []),
                                    ([float('nan')] * 32000, [weak], [])]:
            kept, removed = ASR.prune_non_speech_artifacts(cues, audio, speech, 16000)
            self.assertEqual(kept, cues)
            self.assertEqual(removed, [])

    def test_non_speech_removal_warns_and_final_transcript_reset_excludes_only_candidate(self):
        events = []
        model = Model([[segment(1, 1.8, 'unrelated text', probability=0.2, logprob=-2)]])
        cues, quality = ASR.transcribe_audio(model, [0.0] * 32000, sample_rate=16000,
            language='ja', speech_detector=lambda audio, rate: [], emitter=events.append)
        self.assertEqual(cues, [])
        self.assertTrue(quality['audit']['complete'])
        self.assertEqual(quality['audit']['unresolved'], [])
        self.assertTrue(quality['warnings'])
        self.assertEqual(events[-3], {'type': 'transcript', 'segments': []})
        self.assertEqual(len(model.calls), 1)

    def test_adjacent_window_jitter_of_same_boundary_word_is_deduplicated(self):
        first = ASR.cues_from_segment(segment(89.8, 90.05, '同じ語'), 0, 100, (0, 90))[0]
        second = ASR.cues_from_segment(segment(1.95, 2.2, '同じ語'), 88, 100, (90, 100))[0]
        cues = ASR.reconcile_window_boundaries([dict(first, _window=0, _boundary=0), dict(second, _window=1, _boundary=90)])
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0]['text'], '同じ語')
        self.assertEqual((cues[0]['start'], cues[0]['end']), (89.8, 90.05))
        self.assertFalse(any(key.startswith('_') for key in cues[0]))

    def test_wordless_fallback_crossing_boundary_is_never_discarded_by_both_windows(self):
        first, second = segment(89, 91.5, '境界の会話'), segment(0, 2, '境界の会話')
        first['words'], second['words'] = [], []
        first_cues = ASR.cues_from_segment(first, 0, 100, (0, 90))
        second_cues = ASR.cues_from_segment(second, 88, 100, (90, 100))
        self.assertTrue(first_cues)
        cues = ASR.reconcile_window_boundaries([dict(cue, _window=0, _boundary=0) for cue in first_cues]
            + [dict(cue, _window=1, _boundary=90) for cue in second_cues])
        self.assertEqual(len(cues), 1)
        self.assertEqual((cues[0]['start'], cues[0]['end']), (89, 91.5))
        self.assertEqual(cues[0]['text'], '境界の会話')

    def test_real_same_window_repetition_and_adjacent_nonoverlapping_repetition_are_preserved(self):
        same = ASR.cues_from_segment(segment(89.8, 90.05, 'はい'), 0, 100)[0]
        repeated = [dict(same, _window=0, _boundary=0), dict(same, _window=0, _boundary=0)]
        self.assertEqual(len(ASR.reconcile_window_boundaries(repeated)), 2)
        first = ASR.cues_from_segment(segment(89.5, 89.75, 'はい'), 0, 100)[0]
        second = ASR.cues_from_segment(segment(90.05, 90.3, 'はい'), 0, 100)[0]
        different = ASR.cues_from_segment(segment(89.95, 90.2, '別の言葉'), 0, 100)[0]
        preserved = ASR.reconcile_window_boundaries([dict(first, _window=0, _boundary=0),
            dict(second, _window=1, _boundary=90), dict(different, _window=1, _boundary=90)])
        self.assertEqual(len(preserved), 3)

    def test_two_short_missing_utterances_are_rechecked_and_reported_without_false_full_coverage(self):
        model = Model([[segment(1, 2)], [], []])
        cues, quality, _ = self.run_audio(model, seconds=20, speech=[(1, 2), (5, 5.5), (10, 10.5)])
        self.assertEqual(len(cues), 1)
        self.assertEqual(quality['audit']['uncoveredSpeechSeconds'], 1.0)
        self.assertEqual(len(quality['audit']['unresolved']), 2)
        self.assertFalse(quality['audit']['complete'])
        self.assertEqual(len(model.calls), 3)

    def test_short_gap_total_is_preserved_and_accumulated_in_audit_review(self):
        raw, review = ASR.audit_gaps([(1, 2), (5, 5.2), (10, 10.2)], [(1, 2)], 20)
        self.assertAlmostEqual(sum(end - start for start, end in raw), 0.4)
        self.assertEqual(review, raw)
        raw, review = ASR.audit_gaps([(1, 2), (5, 5.1)], [(1, 2)], 20)
        self.assertAlmostEqual(sum(end - start for start, end in raw), 0.1)
        self.assertEqual(review, [])

    def test_long_silence_advisory_windows_cover_every_sample_and_limit_context(self):
        windows = ASR.plan_core_windows(110, [(85.5, 95), (100, 105)])
        self.assertEqual(windows, [(0, 84.5), (84.5, 110)])
        self.assertEqual(sum(end - start for start, end in windows), 110)
        self.assertTrue(all(end - start <= 90 for start, end in windows))
        long = ASR.plan_core_windows(7200, [(3601, 3602), (7197, 7198)])
        self.assertEqual(long[0][0], 0)
        self.assertEqual(long[-1][1], 7200)
        self.assertTrue(all(previous[1] == following[0] for previous, following in zip(long, long[1:])))

    def test_advisory_split_retains_vad_missed_dialogue_and_avoids_long_silent_prefix(self):
        sequence, events = [], []
        class AdvisoryModel:
            def transcribe(self, audio, **options):
                sequence.append('asr')
                start, end = audio.start_sample / 10, (audio.start_sample + len(audio)) / 10
                if start == 0:
                    result = [segment(42, 43, 'VADが見逃した静かな会話'), segment(85.5, 86.2, '別の誤認識')]
                else:
                    result = [segment(85.5 - start, 86.2 - start, '音声の本来の会話')]
                return iter(result), object()
        def detector(audio, rate):
            sequence.append('vad')
            return [(85.5, 86.2)]
        cues, quality = ASR.transcribe_audio(AdvisoryModel(), PositionedAudio(100), sample_rate=10,
            language='ja', speech_detector=detector, emitter=events.append)
        self.assertEqual(sequence, ['vad', 'asr', 'asr'])
        self.assertEqual([cue['text'] for cue in cues], ['VADが見逃した静かな会話', '音声の本来の会話'])
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(42, 43), (85.5, 86.2)])
        self.assertEqual(quality['processedSeconds'], 100)
        self.assertTrue(quality['audit']['complete'])

    def test_auto_language_probes_voiced_windows_after_long_silence(self):
        order, events, probes = [], [], []
        class VoicedLanguageModel:
            def detect_language(self, audio, **options):
                order.append('language')
                start, end = audio.start_sample / 10, (audio.start_sample + len(audio)) / 10
                probes.append((start, end))
                return ('ja', 0.95, []) if start < 86.5 and end > 85.5 else ('en', 0.8, [])
            def transcribe(self, audio, **options):
                start, end = audio.start_sample / 10, (audio.start_sample + len(audio)) / 10
                self.asserted_language = options['language']
                result = [segment(85.5 - start, 86.5 - start, '静かな会話')] if start <= 85.5 and end >= 86.5 else []
                return iter(result), object()
        def detector(audio, rate):
            order.append('vad')
            return [(85.5, 86.5)]
        model = VoicedLanguageModel()
        cues, quality = ASR.transcribe_audio(model, PositionedAudio(113), sample_rate=10,
            language='auto', speech_detector=detector, emitter=events.append)
        self.assertEqual(order[0], 'vad')
        self.assertEqual(order.count('vad'), 1)
        self.assertTrue(all(start < 86.5 and end > 85.5 for start, end in probes))
        self.assertEqual(next(event['language'] for event in events if event['type'] == 'info'), 'ja')
        self.assertEqual(model.asserted_language, 'ja')
        self.assertEqual(cues[0]['text'], '静かな会話')
        self.assertEqual(quality['processedSeconds'], 113)

    def test_language_probe_fallback_and_manual_hint_remain_unchanged(self):
        model = Model([], [('en', 0.5, []), ('ja', 0.9, []), ('ja', 0.95, [])])
        language, _ = ASR.choose_language(model, list(range(1200)), 120, 'auto', 10, speech=[])
        self.assertEqual(language, 'ja')
        self.assertEqual([call['audio'][0] for call in model.language_calls], [0, 450, 900])
        manual = Model([])
        self.assertEqual(ASR.choose_language(manual, [0] * 1200, 120, 'zh', 10, speech=[(85, 90)]), ('zh', 1.0))
        self.assertEqual(manual.language_calls, [])

    def test_high_confidence_vad_boundary_difference_preserves_transcript_without_false_missing_speech(self):
        first, last = segment(3.2, 7.88, '原文の前半'), segment(7.88, 11.0, '原文の後半')
        model = Model([[first, last], [], []])
        cues, quality, _ = self.run_audio(model, seconds=15, speech=[(2.762, 11.766)])
        audit = quality['audit']
        self.assertEqual([(cue['start'], cue['end']) for cue in cues], [(3.2, 7.88), (7.88, 11.0)])
        self.assertEqual([cue['text'] for cue in cues], ['原文の前半', '原文の後半'])
        self.assertAlmostEqual(audit['uncoveredSpeechSeconds'], 0.704)
        self.assertAlmostEqual(audit['boundaryUncertaintySeconds'], 0.704)
        self.assertEqual(audit['unresolvedSpeechSeconds'], 0)
        self.assertEqual(len(audit['boundaryRanges']), 2)
        self.assertEqual(audit['unresolved'], [])
        self.assertTrue(audit['complete'])
        self.assertTrue(quality['warnings'])

    def test_independent_short_speech_and_internal_gaps_remain_unresolved(self):
        cues = [ASR.cues_from_segment(segment(1, 2), 0, 10)[0], ASR.cues_from_segment(segment(3, 4), 0, 10)[0]]
        speech = [(0.75, 4.25), (6, 6.5)]
        raw = ASR.uncovered_intervals(speech, ASR.coverage_for(cues, 10), 10)
        remaining, boundary = ASR.separate_boundary_uncertainty(raw, speech, cues, 10)
        self.assertEqual(boundary, [])
        self.assertEqual(remaining, [(2.25, 2.75), (6, 6.5)])

    def test_low_confidence_or_largely_unrecognized_span_cannot_use_boundary_exception(self):
        for cue in [ASR.cues_from_segment(segment(3.2, 11, probability=0.3, logprob=-2), 0, 20)[0],
                    ASR.cues_from_segment(dict(segment(3.2, 11), no_speech_prob=0.7), 0, 20)[0]]:
            speech = [(2.762, 11.766)]
            raw = ASR.uncovered_intervals(speech, ASR.coverage_for([cue], 20), 20)
            remaining, boundary = ASR.separate_boundary_uncertainty(raw, speech, [cue], 20)
            self.assertEqual(remaining, raw)
            self.assertEqual(boundary, [])
        cue = ASR.cues_from_segment(segment(3.2, 11), 0, 20)[0]
        speech = [(2.762, 20)]
        raw = ASR.uncovered_intervals(speech, ASR.coverage_for([cue], 20), 20)
        remaining, boundary = ASR.separate_boundary_uncertainty(raw, speech, [cue], 20)
        self.assertEqual(remaining, raw)
        self.assertEqual(boundary, [])

    def test_long_tail_gap_is_not_excused_as_boundary_alignment(self):
        cue = ASR.cues_from_segment(segment(3.2, 11), 0, 20)[0]
        speech = [(2.95, 12)]
        raw = ASR.uncovered_intervals(speech, ASR.coverage_for([cue], 20), 20)
        remaining, boundary = ASR.separate_boundary_uncertainty(raw, speech, [cue], 20)
        self.assertEqual(remaining, [(11.25, 12)])
        self.assertEqual(boundary, [])

    def test_near_digital_silence_with_tiny_slow_residual_can_be_excluded(self):
        import math
        audio = [0.00012 * math.sin(2 * math.pi * 3 * index / 16000) if index < 3200 else 0.0
                 for index in range(32000)]
        cue = ASR.cues_from_segment(segment(0, 2, 'unrelated neutral text', probability=0.2, logprob=-2), 0, 2)[0]
        self.assertTrue(ASR.very_quiet_stationary_noise(audio, 0, 2, 16000))
        kept, removed = ASR.prune_non_speech_artifacts([cue], audio, [], 16000)
        self.assertEqual(kept, [])
        self.assertEqual(len(removed), 1)

    def test_digital_silence_with_extremely_quiet_short_voiced_fragment_is_preserved(self):
        import math
        cue = ASR.cues_from_segment(segment(0, 2, '短い会話', probability=0.2, logprob=-2), 0, 2)[0]
        for frequency in (80, 220):
            audio = [0.0001 * math.sin(2 * math.pi * frequency * index / 16000) if index < 3200 else 0.0
                     for index in range(32000)]
            self.assertFalse(ASR.very_quiet_stationary_noise(audio, 0, 2, 16000))
            kept, removed = ASR.prune_non_speech_artifacts([cue], audio, [], 16000)
            self.assertEqual(kept, [cue])
            self.assertEqual(removed, [])

    def test_boundary_range_limit_preserves_overflow_in_unresolved_time(self):
        previous = ASR.MAX_BOUNDARY_RANGES
        try:
            ASR.MAX_BOUNDARY_RANGES = 2
            cues = [ASR.cues_from_segment(segment(start + 0.3, start + 1.7), 0, 10)[0] for start in (0, 4, 8)]
            speech = [(0, 2), (4, 6), (8, 10)]
            raw = ASR.uncovered_intervals(speech, ASR.coverage_for(cues, 10), 10)
            diagnostics = {}
            remaining, boundary = ASR.separate_boundary_uncertainty(raw, speech, cues, 10, diagnostics)
            self.assertEqual(len(boundary), 2)
            self.assertTrue(diagnostics['boundaryLimitExceeded'])
            self.assertAlmostEqual(sum(end - start for start, end in raw),
                sum(end - start for start, end in remaining) + sum(item['end'] - item['start'] for item in boundary))
        finally:
            ASR.MAX_BOUNDARY_RANGES = previous

    def test_recovery_target_selects_new_tail_word_even_if_context_cue_midpoint_is_outside(self):
        raw = segment(4, 5.4, 'old new')
        raw['words'] = [{'start': 4, 'end': 4.4, 'word': 'old ', 'probability': 0.95},
                        {'start': 5.1, 'end': 5.4, 'word': 'new', 'probability': 0.95}]
        cues = ASR.cues_from_segment(raw, 0, 20)
        selected = ASR.recovery_candidates_for_targets(cues, [(5, 6)], 20)
        self.assertEqual([(cue['start'], cue['end'], cue['text']) for cue in selected], [(5.1, 5.4, 'new')])

    def test_recovery_preserves_full_native_cue_when_vad_target_starts_after_its_first_word(self):
        raw = segment(2.54, 6.56, 'first next')
        raw['words'] = [{'start': 2.54, 'end': 2.86, 'word': 'first ', 'probability': 0.95},
                        {'start': 2.86, 'end': 6.56, 'word': 'next', 'probability': 0.95}]
        native = ASR.cues_from_segment(raw, 0, 20)
        selected = ASR.recovery_candidates_for_targets(native, [(2.968, 9)], 20)
        self.assertEqual(selected[0]['text'], 'first next')
        self.assertEqual([(word['start'], word['end']) for word in selected[0]['words']], [(2.54, 2.86), (2.86, 6.56)])

    def test_recovery_new_word_survives_confident_context_overlap_without_duplicate_prefix(self):
        old = ASR.cues_from_segment(segment(4, 5.2, 'old'), 0, 20)
        raw = segment(4.5, 6, 'old new')
        raw['words'] = [{'start': 4.5, 'end': 5, 'word': 'old ', 'probability': 0.95},
                        {'start': 5.5, 'end': 6, 'word': 'new', 'probability': 0.95}]
        recovered = ASR.cues_from_segment(raw, 0, 20)
        merged, accepted = ASR.merge_recovery(old, recovered)
        self.assertEqual([cue['text'] for cue in merged], ['old', 'new'])
        self.assertEqual([(cue['start'], cue['end']) for cue in merged], [(4, 5.2), (5.5, 6)])
        self.assertEqual(accepted, 1)

    def test_recovered_words_inside_an_existing_caption_are_inserted_without_overlapping_captions(self):
        raw = segment(2, 4, 'old next')
        raw['words'] = [{'start': 2, 'end': 2.6, 'word': 'old ', 'probability': 0.95},
                        {'start': 3.4, 'end': 4, 'word': 'next', 'probability': 0.95}]
        original = ASR.cues_from_segment(raw, 0, 20)
        candidate = ASR.cues_from_segment(segment(2.8, 3.2, 'new '), 0, 20)
        merged, accepted = ASR.merge_recovery(original, candidate)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['text'], 'old new next')
        self.assertEqual([(word['start'], word['end']) for word in merged[0]['words']], [(2, 2.6), (2.8, 3.2), (3.4, 4)])
        self.assertEqual(accepted, 1)

    def test_recovery_keeps_a_real_adjacent_repeat_but_does_not_repeat_its_known_context(self):
        original = ASR.cues_from_segment(segment(1, 1.3, 'はい'), 0, 10)
        raw = segment(1, 1.7, 'はいはい')
        raw['words'] = [{'start': 1, 'end': 1.3, 'word': 'はい', 'probability': 0.95},
                        {'start': 1.4, 'end': 1.7, 'word': 'はい', 'probability': 0.95}]
        recovered = ASR.cues_from_segment(raw, 0, 10)
        merged, accepted = ASR.merge_recovery(original, recovered)
        self.assertEqual(''.join(cue['text'] for cue in merged), 'はいはい')
        self.assertEqual([(word['start'], word['end']) for cue in merged for word in cue['words']], [(1, 1.3), (1.4, 1.7)])
        self.assertEqual(accepted, 1)

    def test_nested_word_end_order_falls_back_to_native_segment_without_truncating_dialogue(self):
        raw = segment(1, 10, 'first second')
        raw['words'] = [{'start': 1, 'end': 8, 'word': 'first ', 'probability': 0.95},
                        {'start': 3, 'end': 4, 'word': 'second', 'probability': 0.95}]
        cue = ASR.cues_from_segment(raw, 0, 20)[0]
        self.assertEqual((cue['start'], cue['end']), (1, 10))
        self.assertEqual(cue['text'], 'first second')
        self.assertIn('invalid_word_timestamps', cue['qualityFlags'])
        self.assertFalse(cue.get('words'))

    def test_wordless_recovery_keeps_native_times_and_never_guesses_text_slices(self):
        raw = segment(4, 5.4, 'full native text')
        raw['words'] = []
        cues = ASR.cues_from_segment(raw, 0, 20)
        self.assertEqual(ASR.recovery_candidates_for_targets(cues, [(5, 6)], 20), [])
        selected = ASR.recovery_candidates_for_targets(cues, [(4, 6)], 20)
        self.assertEqual((selected[0]['start'], selected[0]['end'], selected[0]['text']), (4, 5.4, 'full native text'))

    def test_partially_overlapping_new_word_expands_native_caption_without_overlapping_srt_cues(self):
        raw = segment(4, 5.2, 'old tail')
        raw['words'] = [{'start': 4, 'end': 4.8, 'word': 'old ', 'probability': 0.95},
                        {'start': 5, 'end': 5.2, 'word': 'tail ', 'probability': 0.95}]
        old = ASR.cues_from_segment(raw, 0, 20)
        recovered = ASR.cues_from_segment(segment(5.15, 5.6, 'new'), 0, 20)
        merged, accepted = ASR.merge_recovery(old, recovered)
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0]['start'], merged[0]['end']), (4, 5.6))
        self.assertEqual(merged[0]['text'], 'old tail new')
        self.assertEqual(accepted, 1)

    def test_overlap_at_a_reading_break_keeps_adjacent_actual_word_times_in_one_caption(self):
        raw = segment(1, 8, 'old new')
        raw['words'] = [{'start': 1, 'end': 7, 'word': 'old ', 'probability': 0.95},
                        {'start': 6.95, 'end': 8, 'word': 'new', 'probability': 0.95}]
        cues = ASR.cues_from_segment(raw, 0, 20)
        self.assertEqual(len(cues), 1)
        self.assertEqual((cues[0]['start'], cues[0]['end']), (1, 8))

    def test_partial_recovery_overlap_with_wordless_native_cue_is_not_split_or_duplicated(self):
        native = segment(4, 5.2, 'native segment')
        native['words'] = []
        original = ASR.cues_from_segment(native, 0, 20)
        recovered = ASR.cues_from_segment(segment(5.15, 5.6, 'new'), 0, 20)
        merged, accepted = ASR.merge_recovery(original, recovered)
        self.assertEqual(accepted, 0)
        self.assertEqual([(cue['start'], cue['end'], cue['text']) for cue in merged], [(4, 5.2, 'native segment')])
        self.assertIn('recovery_alignment_conflict', merged[0]['qualityFlags'])
        self.assertNotIn('recovery_alignment_conflict', original[0]['qualityFlags'])

    def test_wordless_overlap_keeps_unresolved_alignment_diagnostic_in_full_audit(self):
        native = segment(4, 5.2, 'native segment')
        native['words'] = []
        # The recheck window starts at 3.95; its native [1.2,1.65]
        # word therefore overlaps the unsplittable original by 0.05 seconds.
        recovery = segment(1.2, 1.65, 'new')
        cues, quality, _ = self.run_audio(Model([[native], [recovery]]), speech=[(4, 6)])
        self.assertEqual(len(cues), 1)
        self.assertFalse(quality['audit']['complete'])
        self.assertTrue(any(item['reason'] == 'recovery_alignment_conflict' for item in quality['audit']['unresolved']))

    def test_better_recovery_replaces_low_confidence_word_before_adding_its_new_tail(self):
        old = ASR.cues_from_segment(segment(1, 2, 'wrong', probability=0.2, logprob=-2), 0, 10)
        raw = segment(1, 3, 'correct tail')
        raw['words'] = [{'start': 1, 'end': 2, 'word': 'correct ', 'probability': 0.95},
                        {'start': 2.3, 'end': 3, 'word': 'tail', 'probability': 0.95}]
        recovered = ASR.cues_from_segment(raw, 0, 10)
        merged, accepted = ASR.merge_recovery(old, recovered)
        self.assertEqual([cue['text'] for cue in merged], ['correct tail'])
        self.assertEqual([(word['start'], word['end']) for word in merged[0]['words']], [(1, 2), (2.3, 3)])
        self.assertEqual(accepted, 1)

    def test_tolerated_native_word_end_jitter_cannot_shorten_the_caption_envelope(self):
        raw = segment(0, 1, 'first last')
        raw['words'] = [{'start': 0, 'end': 1, 'word': 'first ', 'probability': 0.95},
                        {'start': 0.9, 'end': 0.99, 'word': 'last', 'probability': 0.95}]
        cue = ASR.cues_from_segment(raw, 0, 10)[0]
        self.assertEqual(cue['end'], 1)
        reconciled = ASR.reconcile_window_boundaries([{**cue, '_window': 0, '_boundary': 0}])
        self.assertEqual(reconciled[0]['end'], 1)

    def test_benchmark_reports_omission_and_insertion_separately(self):
        self.assertEqual(BENCH.character_errors('また', 'ま')['deletions'], 1)
        self.assertEqual(BENCH.character_errors('また', 'またまた')['insertions'], 2)

    def test_benchmark_does_not_claim_precise_block_timing_for_crossing_wordless_cue(self):
        row = BENCH.block_result({'start': 2, 'end': 3, 'reference': 'native'},
                                [{'start': 1, 'end': 4, 'text': 'native'}], [(2.2, 2.6)])
        self.assertTrue(row['ambiguousFallbackTiming'])
        self.assertAlmostEqual(row['vadOverlapSeconds'], 0.4)


if __name__ == '__main__':
    unittest.main()
