"""Compare ASR output against a local reference manifest; never download user media.

Requires the application's faster-whisper environment. The manifest is a JSON
array containing file, reference, language, and optional dataset attribution.
This is a small regression benchmark, not a universal accuracy guarantee.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import math
import os
import pathlib
import subprocess
import sys
import time
import traceback
import types
import unicodedata


def normalize_text(text):
    return ''.join(character.lower() for character in unicodedata.normalize('NFKC', text)
                   if character.isalnum())


def character_errors(reference, hypothesis):
    reference, hypothesis = normalize_text(reference), normalize_text(hypothesis)
    previous = list(range(len(hypothesis) + 1))
    for index, expected in enumerate(reference, 1):
        current = [index]
        for column, actual in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[column] + 1,
                               previous[column - 1] + (expected != actual)))
        previous = current
    errors = previous[-1]
    return {'referenceCharacters': len(reference), 'characterErrors': errors,
            'characterErrorRate': errors / max(1, len(reference))}


def accurate_runner(script):
    """Run the exact CLI main, retaining only its model object between cases."""
    spec = importlib.util.spec_from_file_location('benchmark_asr', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    load_model = module.load_whisper_model
    models = {}

    def cached_model(*args, **kwargs):
        key = (args, tuple(sorted(kwargs.items())))
        if key not in models:
            models[key] = load_model(*args, **kwargs)
        return models[key]

    module.load_whisper_model = cached_model

    def invoke(arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        previous_arguments = sys.argv
        try:
            sys.argv = arguments[1:]
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                module.main()
            return types.SimpleNamespace(returncode=0, stdout=stdout.getvalue(), stderr=stderr.getvalue())
        except Exception:
            return types.SimpleNamespace(returncode=1, stdout=stdout.getvalue(), stderr=traceback.format_exc())
        finally:
            sys.argv = previous_arguments
    return invoke


def run_case(python, script, sample, cache, profile, device, output, runner=None, workers='auto'):
    arguments = [python, str(script), '--audio', sample['file'], '--cache', str(cache),
                 '--language', sample['language']]
    if profile == 'legacy':
        arguments += ['--model', 'small', '--device', 'cpu', '--compute-type', 'int8']
    else:
        arguments += ['--profile', 'accurate', '--device', device, '--compute-type', 'auto', '--workers', workers]
    started = time.monotonic()
    result = runner(arguments) if runner else subprocess.run(arguments, capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=7200, env={**os.environ, 'PYTHONUTF8': '1'})
    elapsed = time.monotonic() - started
    output.write_text(result.stdout, encoding='utf-8')
    if result.returncode:
        raise RuntimeError('Benchmark inference failed: ' + result.stderr[-2000:] + result.stdout[-1000:])
    events = []
    for line in result.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    final = [event for event in events if event.get('type') == 'complete']
    if not final:
        raise RuntimeError('ASR did not emit a completion marker.')
    resets = [event['segments'] for event in events if event.get('type') == 'transcript']
    cues = resets[-1] if resets else [event for event in events if event.get('type') == 'segment']
    hypothesis = ''.join(cue['text'] for cue in cues)
    metrics = character_errors(sample['reference'], hypothesis)
    info = next((event for event in events if event.get('type') == 'info'), {})
    quality = final[-1].get('quality', {})
    actual_workers = quality.get('workers', info.get('workers'))
    if type(actual_workers) is not int or actual_workers not in (1, 2):
        actual_workers = None
    duration = quality.get('durationSeconds', info.get('duration'))
    valid_duration = isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration) and duration > 0
    return {**metrics, 'profile': profile, 'language': sample['language'],
            'detectedLanguage': info.get('language'), 'languageProbability': info.get('languageProbability'),
            'case': sample.get('case', pathlib.Path(sample['file']).stem), 'elapsedSeconds': elapsed,
            'durationSeconds': duration, 'realTimeFactor': elapsed / duration if valid_duration else None,
            'requestedWorkers': workers if profile == 'accurate' else None, 'actualWorkers': actual_workers,
            'modelReuse': runner is not None,
            'cueCount': len(cues), 'recognizedText': hypothesis, 'reference': sample['reference'],
            'quality': quality, 'dataset': sample.get('dataset'), 'source': sample.get('source'),
            'license': sample.get('license')}


def parse_cli_args(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--legacy-script', help='Required only when the legacy profile is selected.')
    parser.add_argument('--cache', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'])
    parser.add_argument('--workers', choices=['auto', '1', '2'],
                        help='Current accurate CLI worker count (default: auto; reused-model runs: 1). Use separate output directories to compare 1 and 2.')
    parser.add_argument('--profiles', nargs='+', default=['legacy', 'accurate'], choices=['legacy', 'accurate'])
    parser.add_argument('--case', action='append', dest='cases', help='Only run the named manifest case (repeatable).')
    parser.add_argument('--reuse-accurate-model', action='store_true', help='Reuse one model while invoking the same accurate CLI main for every case; timings are not startup comparisons.')
    args = parser.parse_args(arguments)
    if 'legacy' in args.profiles and not args.legacy_script:
        parser.error('--legacy-script is required when --profiles includes legacy.')
    if args.reuse_accurate_model and args.workers not in (None, '1'):
        parser.error('--reuse-accurate-model supports only --workers 1; use fresh subprocess runs to compare worker throughput.')
    args.workers = args.workers or ('1' if args.reuse_accurate_model else 'auto')
    return parser, args


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser, args = parse_cli_args()
    samples = json.loads(pathlib.Path(args.manifest).read_text(encoding='utf-8'))
    if args.cases:
        missing = set(args.cases) - {sample.get('case') for sample in samples}
        if missing:
            parser.error('Unknown manifest case: ' + ', '.join(sorted(missing)))
        samples = [sample for sample in samples if sample.get('case') in args.cases]
    if not samples:
        parser.error('The manifest contains no selected samples.')
    destination = pathlib.Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    current = pathlib.Path(__file__).resolve().parent / 'transcribe_local.py'
    runner = accurate_runner(current) if args.reuse_accurate_model else None
    results = []
    for profile, script in [('legacy', pathlib.Path(args.legacy_script) if args.legacy_script else None), ('accurate', current)]:
        if profile not in args.profiles:
            continue
        for index, sample in enumerate(samples):
            print(json.dumps({'event': 'case-start', 'profile': profile, 'case': sample.get('case', index),
                              'requestedWorkers': args.workers if profile == 'accurate' else None}), flush=True)
            result = run_case(sys.executable, script, sample, pathlib.Path(args.cache), profile, args.device,
                              destination / (profile + '-' + str(index) + '.jsonl'), runner if profile == 'accurate' else None,
                              workers=args.workers)
            results.append(result)
            (destination / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({key: result[key] for key in ['profile', 'language', 'case', 'characterErrorRate', 'elapsedSeconds', 'realTimeFactor',
                                                         'requestedWorkers', 'actualWorkers', 'cueCount']}, ensure_ascii=False), flush=True)
    summary = []
    for profile in ['legacy', 'accurate']:
        if profile not in args.profiles:
            continue
        for language in sorted({sample['language'] for sample in samples}):
            selected = [result for result in results if result['profile'] == profile and result['language'] == language]
            characters = sum(result['referenceCharacters'] for result in selected)
            errors = sum(result['characterErrors'] for result in selected)
            elapsed = sum(result['elapsedSeconds'] for result in selected)
            duration = sum(result['durationSeconds'] for result in selected if result['realTimeFactor'] is not None)
            all_durations_known = all(result['realTimeFactor'] is not None for result in selected)
            summary.append({'profile': profile, 'language': language, 'samples': len(selected),
                            'referenceCharacters': characters, 'characterErrors': errors,
                            'characterErrorRate': errors / max(1, characters), 'elapsedSeconds': elapsed,
                            'durationSeconds': duration if all_durations_known else None,
                            'realTimeFactor': elapsed / duration if all_durations_known and duration > 0 else None,
                            'requestedWorkers': args.workers if profile == 'accurate' else None,
                            'actualWorkers': sorted({result['actualWorkers'] for result in selected if result['actualWorkers'] is not None}),
                            'modelReuse': args.reuse_accurate_model and profile == 'accurate'})
    (destination / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'event': 'complete', 'summary': summary}), flush=True)


if __name__ == '__main__':
    main()
