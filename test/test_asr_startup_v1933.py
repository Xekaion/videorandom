"""Model/audio startup checks with inert loaders; never load ASR or audio."""
import importlib.util
import os
from pathlib import Path
import threading
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('asr_startup_v1933', Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py')
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


class StartupTests(unittest.TestCase):
    def test_accurate_cli_uses_overlap_and_forwards_the_same_audio_and_quality_inputs(self):
        waveform, events, calls = [0.0, .125, -.125], [], []
        model = types.SimpleNamespace(_videorandom_workers=2, _videorandom_parallel_memory_fallback=False)
        decoder = types.SimpleNamespace(decode_audio=lambda *args, **kwargs: waveform)
        vad = types.SimpleNamespace(VadOptions=lambda **kwargs: kwargs, get_speech_timestamps=lambda *args, **kwargs: [])

        def load(*args, **kwargs):
            calls.append(('model', args, kwargs, threading.get_ident()))
            return model, 'cuda', 'int8_float16'

        def transcribe(actual_model, actual_audio, **kwargs):
            self.assertIs(actual_model, model)
            self.assertIs(actual_audio, waveform)
            self.assertEqual(kwargs['profile'], 'accurate')
            self.assertEqual(kwargs['model_name'], 'large-v3')
            self.assertEqual(kwargs['workers'], 2)
            self.assertEqual(kwargs['device'], 'cuda')
            self.assertEqual(kwargs['compute_type'], 'int8_float16')
            self.assertFalse(kwargs['parallel_memory_fallback'])
            self.assertEqual(kwargs['speech_detector'](waveform, ASR.SAMPLE_RATE), [])
            calls.append(('transcribe',))

        caller = threading.get_ident()
        with patch.dict('sys.modules', {'faster_whisper.audio': decoder, 'faster_whisper.vad': vad}), \
                patch.object(ASR.sys, 'argv', ['owned-asr', '--audio', 'owned.flac', '--cache', 'owned-cache', '--profile', 'accurate', '--device', 'auto']), \
                patch.object(ASR, 'load_whisper_model', load), patch.object(ASR, 'transcribe_audio', transcribe), \
                patch.object(ASR, 'emit', events.append):
            ASR.main()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1], ('large-v3', 'owned-cache'))
        self.assertEqual(calls[0][2]['workers'], 'auto')
        self.assertEqual(calls[0][3], caller)
        self.assertEqual(events[0]['type'], 'loading')

    def test_independent_loaders_overlap_with_unchanged_identity_arguments_and_threads(self):
        audio_started, model_started = threading.Event(), threading.Event()
        caller, seen = threading.get_ident(), {}
        model, audio = object(), object()
        options = dict(device='auto', compute_type='auto', cpu_threads=8, workers='auto')

        def decode(filename, **kwargs):
            seen['audio'] = (filename, kwargs, threading.get_ident())
            audio_started.set()
            self.assertTrue(model_started.wait(2))
            return audio

        def load(name, cache, **kwargs):
            seen['model'] = (name, cache, kwargs, threading.get_ident())
            model_started.set()
            self.assertTrue(audio_started.wait(2))
            return model, 'cuda', 'int8_float16'

        result = ASR.load_model_and_audio('large-v3', 'owned-cache', 'owned.flac',
                                         audio_loader=decode, model_loader=load, **options)
        self.assertEqual(result, (model, 'cuda', 'int8_float16', audio))
        self.assertEqual(seen['audio'][:2], (os.path.abspath('owned.flac'), {'sampling_rate': ASR.SAMPLE_RATE}))
        self.assertNotEqual(seen['audio'][2], caller)
        self.assertEqual(seen['model'], ('large-v3', 'owned-cache', options, caller))

    def test_model_failure_drains_started_decode_before_propagating_same_error(self):
        started, model_failed, release, done = (threading.Event() for _ in range(4))
        expected, observed = RuntimeError('owned model failure'), []

        def decode(*args, **kwargs):
            started.set()
            self.assertTrue(release.wait(2))
            return object()

        def load(*args, **kwargs):
            self.assertTrue(started.wait(2))
            model_failed.set()
            raise expected

        def run():
            try:
                ASR.load_model_and_audio('large-v3', 'owned-cache', 'owned.flac', audio_loader=decode, model_loader=load)
            except BaseException as error:
                observed.append(error)
            finally:
                done.set()

        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(model_failed.wait(2))
            self.assertFalse(done.wait(.025), 'the started decoder must settle before the failure escapes')
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(observed, [expected])

    def test_decode_failure_waits_for_model_and_is_not_retried(self):
        failed, model_started, release, done = (threading.Event() for _ in range(4))
        expected, observed, calls = ValueError('owned decode failure'), [], []

        def decode(*args, **kwargs):
            calls.append('audio')
            failed.set()
            raise expected

        def load(*args, **kwargs):
            calls.append('model')
            model_started.set()
            self.assertTrue(release.wait(2))
            return object(), 'cpu', 'int8'

        def run():
            try:
                ASR.load_model_and_audio('large-v3', 'owned-cache', 'owned.flac', audio_loader=decode, model_loader=load)
            except BaseException as error:
                observed.append(error)
            finally:
                done.set()

        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(failed.wait(2))
            self.assertTrue(model_started.wait(2))
            self.assertFalse(done.wait(.025))
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(observed, [expected])
        self.assertEqual(sorted(calls), ['audio', 'model'])

    def test_model_failure_keeps_serial_priority_when_both_loaders_fail(self):
        audio_failed = threading.Event()
        expected = RuntimeError('owned first-priority model failure')

        def decode(*args, **kwargs):
            audio_failed.set()
            raise ValueError('owned second-priority decode failure')

        def load(*args, **kwargs):
            self.assertTrue(audio_failed.wait(2))
            raise expected

        with self.assertRaises(RuntimeError) as caught:
            ASR.load_model_and_audio('large-v3', 'owned-cache', 'owned.flac', audio_loader=decode, model_loader=load)
        self.assertIs(caught.exception, expected)

    def test_turbo_and_cpu_worker_arguments_are_not_promoted_by_startup(self):
        for options in [dict(device='cpu', compute_type='int8', cpu_threads=4, workers='1'),
                        dict(device='cuda', compute_type='float16', cpu_threads=8, workers='2')]:
            seen, waveform = [], object()

            def load(*args, **kwargs):
                seen.append(kwargs)
                return object(), options['device'], options['compute_type']

            result = ASR.load_model_and_audio('owned-model', 'owned-cache', 'owned.flac',
                audio_loader=lambda *args, **kwargs: waveform, model_loader=load, **options)
            self.assertEqual(seen, [options])
            self.assertIs(result[3], waveform)


if __name__ == '__main__':
    unittest.main()
