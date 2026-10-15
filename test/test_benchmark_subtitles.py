"""Synthetic benchmark CLI/metrics tests; never load models, audio or CUDA."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch


SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'benchmark_subtitles.py'
SPEC = importlib.util.spec_from_file_location('benchmark_subtitles', SOURCE)
BENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCH)


class ThroughputBenchmarkTests(unittest.TestCase):
    def arguments(self, *extra):
        return ['--manifest', 'owned-manifest.json', '--legacy-script', 'legacy.py',
                '--cache', 'owned-cache', '--output', 'owned-output', *extra]

    def test_cli_defaults_and_reused_model_are_explicit_about_worker_count(self):
        self.assertEqual(BENCH.parse_cli_args(self.arguments())[1].workers, 'auto')
        reused = BENCH.parse_cli_args(self.arguments('--reuse-accurate-model'))[1]
        self.assertEqual(reused.workers, '1')
        self.assertEqual(BENCH.parse_cli_args(self.arguments('--workers', '2'))[1].workers, '2')
        for workers in ('2', 'auto'):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                BENCH.parse_cli_args(self.arguments('--reuse-accurate-model', '--workers', workers))

    def test_accurate_throughput_runs_do_not_require_an_unrelated_legacy_script(self):
        arguments = ['--manifest', 'owned-manifest.json', '--cache', 'owned-cache', '--output', 'owned-output']
        _, args = BENCH.parse_cli_args([*arguments, '--profiles', 'accurate', '--workers', '2'])
        self.assertIsNone(args.legacy_script)
        self.assertEqual(args.workers, '2')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            BENCH.parse_cli_args([*arguments, '--profiles', 'legacy'])

    def run_synthetic_case(self, profile='accurate', quality_workers=1):
        events = [{'type': 'info', 'language': 'ja', 'duration': 20, 'workers': 2},
                  {'type': 'segment', 'start': 0, 'end': 1, 'text': 'こんにちは'},
                  {'type': 'complete', 'quality': {'durationSeconds': 20, 'workers': quality_workers}}]
        calls = []

        def runner(arguments):
            calls.append(arguments)
            return types.SimpleNamespace(returncode=0, stderr='',
                                         stdout='\n'.join(json.dumps(event) for event in events))

        with tempfile.TemporaryDirectory(prefix='videorandom-benchmark-unit-') as directory:
            with patch.object(BENCH.time, 'monotonic', side_effect=[10, 14]):
                result = BENCH.run_case('owned-python', pathlib.Path('owned-worker.py'),
                                        {'file': 'synthetic-not-read.wav', 'reference': 'こんにちは', 'language': 'ja'},
                                        pathlib.Path(directory), profile, 'cuda', pathlib.Path(directory) / 'events.jsonl',
                                        runner=runner, workers='2')
        return result, calls[0]

    def test_current_cli_receives_workers_and_reports_actual_memory_fallback(self):
        result, arguments = self.run_synthetic_case()
        self.assertEqual(arguments[arguments.index('--workers') + 1], '2')
        self.assertEqual(result['requestedWorkers'], '2')
        self.assertEqual(result['actualWorkers'], 1, 'completed quality takes precedence over the initial info event')
        self.assertEqual(result['elapsedSeconds'], 4)
        self.assertEqual(result['realTimeFactor'], 0.2)
        self.assertEqual(result['characterErrorRate'], 0)

    def test_legacy_cli_is_not_sent_unsupported_worker_arguments(self):
        result, arguments = self.run_synthetic_case(profile='legacy')
        self.assertNotIn('--workers', arguments)
        self.assertIsNone(result['requestedWorkers'])

    def test_invalid_actual_worker_metadata_is_not_reported_as_a_successful_parallel_run(self):
        result, _ = self.run_synthetic_case(quality_workers='2')
        self.assertIsNone(result['actualWorkers'])

    def test_summary_retains_requested_actual_counts_and_duration_weighted_speed(self):
        with tempfile.TemporaryDirectory(prefix='videorandom-benchmark-summary-') as directory:
            root = pathlib.Path(directory)
            manifest = root / 'owned-manifest.json'
            manifest.write_text(json.dumps([{'file': 'not-read-a.wav', 'reference': 'abc', 'language': 'ja'},
                                            {'file': 'not-read-b.wav', 'reference': 'def', 'language': 'ja'}]), encoding='utf-8')
            invocations = []

            def fake_case(*args, **kwargs):
                invocations.append(kwargs['workers'])
                index = len(invocations)
                return {'profile': 'accurate', 'language': 'ja', 'case': str(index), 'characterErrorRate': 0,
                        'referenceCharacters': 3, 'characterErrors': 0, 'elapsedSeconds': index * 2,
                        'durationSeconds': index * 10, 'realTimeFactor': 0.2, 'requestedWorkers': '2',
                        'actualWorkers': index, 'cueCount': 1}

            arguments = ['benchmark_subtitles.py', '--manifest', str(manifest), '--legacy-script', 'not-read.py',
                         '--cache', str(root / 'cache'), '--output', str(root / 'workers-2'),
                         '--profiles', 'accurate', '--workers', '2']
            with patch.object(BENCH.sys, 'argv', arguments), patch.object(BENCH, 'run_case', side_effect=fake_case), \
                    contextlib.redirect_stdout(io.StringIO()):
                BENCH.main()
            summary = json.loads((root / 'workers-2' / 'summary.json').read_text(encoding='utf-8'))[0]
            self.assertEqual(invocations, ['2', '2'])
            self.assertEqual(summary['requestedWorkers'], '2')
            self.assertEqual(summary['actualWorkers'], [1, 2])
            self.assertEqual(summary['elapsedSeconds'], 6)
            self.assertEqual(summary['durationSeconds'], 30)
            self.assertEqual(summary['realTimeFactor'], 0.2)
            self.assertFalse(summary['modelReuse'])


if __name__ == '__main__':
    unittest.main()
