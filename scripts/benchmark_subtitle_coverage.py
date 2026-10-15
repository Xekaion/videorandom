"""Compare two local ASR scripts on an explicitly supplied, owned/public manifest.

The runner reads local fixtures and installs no dependencies. Use an existing
model cache; the selected ASR script's model loader is unchanged.
The manifest is a JSON array of {case,file,reference,language}; relative file
paths resolve against --audio-root or the manifest directory. Optional blocks
[{start,end,reference,label}] measure localized omissions using native words.
Only the model object is reused; each case invokes the selected script's CLI
main, including its original decoding, VAD, audit, and JSONL event code.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import unicodedata


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalize_text(text):
    return ''.join(char.lower() for char in unicodedata.normalize('NFKC', text) if char.isalnum())


def character_errors(reference, hypothesis):
    """Keep insertion/deletion counts separately from aggregate CER."""
    left, right = normalize_text(reference), normalize_text(hypothesis)
    previous = [(index, index, 0, 0) for index in range(len(right) + 1)]
    for row, letter in enumerate(left, 1):
        current = [(row, 0, row, 0)]
        for column, other in enumerate(right, 1):
            cost, ins, delete, substitute = previous[column - 1]
            diagonal = (cost + (letter != other), ins, delete, substitute + (letter != other))
            cost, ins, delete, substitute = previous[column]
            deletion = (cost + 1, ins, delete + 1, substitute)
            cost, ins, delete, substitute = current[-1]
            insertion = (cost + 1, ins + 1, delete, substitute)
            current.append(min((diagonal, deletion, insertion), key=lambda value: value[0]))
        previous = current
    cost, insertions, deletions, substitutions = previous[-1]
    return {'characters': len(left), 'insertions': insertions, 'deletions': deletions,
            'substitutions': substitutions, 'cer': cost / max(1, len(left)),
            'deletionRate': deletions / max(1, len(left))}


def block_result(block, cues, speech):
    words, ambiguous = [], False
    for cue in cues:
        if cue.get('words'):
            words.extend(word['word'] for word in cue['words']
                         if block['start'] <= (word['start'] + word['end']) / 2 < block['end'])
        elif block['start'] <= (cue['start'] + cue['end']) / 2 < block['end']:
            words.append(cue['text'])
            ambiguous |= cue['start'] < block['start'] or cue['end'] > block['end']
    text = ''.join(words)
    return {**block, 'recognized': text, 'errors': character_errors(block['reference'], text),
            'ambiguousFallbackTiming': bool(ambiguous),
            'vadOverlapSeconds': sum(max(0, min(end, block['end']) - max(start, block['start']))
                                     for start, end in speech)}


def load_script(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EventLog:
    """Persist exact JSONL and report long cases without changing ASR emitters."""
    def __init__(self, path, console, case, variant):
        self.file = path.open('w', encoding='utf-8')
        self.console, self.case, self.variant = console, case, variant
        self.pending, self.events, self.last_progress = '', [], -float('inf')

    def write(self, value):
        self.file.write(value)
        self.pending += value
        while '\n' in self.pending:
            line, self.pending = self.pending.split('\n', 1)
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.events.append(event)
            if event.get('type') == 'progress' and time.monotonic() - self.last_progress >= 20:
                self.last_progress = time.monotonic()
                self.console.write(json.dumps({'event': 'progress', 'case': self.case,
                    'variant': self.variant, **{key: event[key] for key in
                    ('phase', 'completedSeconds', 'totalSeconds', 'percent') if key in event}}) + '\n')
                self.console.flush()
        return len(value)

    def flush(self):
        self.file.flush()

    def close(self):
        self.file.close()


def invoke(module, arguments, log):
    previous_arguments, original = sys.argv, module.transcribe_audio
    speech = []

    def observe(*args, **kwargs):
        detector = kwargs.get('speech_detector')
        if detector:
            def audit_detector(*values):
                spans = list(detector(*values))
                speech.extend(spans)
                return spans
            kwargs['speech_detector'] = audit_detector
        return original(*args, **kwargs)

    try:
        sys.argv = arguments
        module.transcribe_audio = observe
        with contextlib.redirect_stdout(log):
            module.main()
    finally:
        module.transcribe_audio, sys.argv = original, previous_arguments
        log.flush()
        log.close()
    complete = next((event for event in reversed(log.events) if event.get('type') == 'complete'), None)
    reset = next((event for event in reversed(log.events) if event.get('type') == 'transcript'), None)
    if complete is None or reset is None:
        raise RuntimeError('ASR did not emit its final transcript and completion markers.')
    return reset['segments'], complete['quality'], speech


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--source', default=str(Path(__file__).with_name('transcribe_local.py')))
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--audio-root')
    parser.add_argument('--cache', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--case', action='append', dest='cases')
    parser.add_argument('--device', choices=['auto', 'cpu', 'cuda'], default='auto')
    parser.add_argument('--compute-type', default='auto')
    parser.add_argument('--model', default='large-v3')
    parser.add_argument('--require-cuda', action='store_true')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = Path(args.manifest).resolve()
    samples = json.loads(manifest.read_text(encoding='utf-8'))
    if args.cases:
        missing = set(args.cases) - {sample.get('case') for sample in samples}
        if missing:
            parser.error('Unknown manifest cases: ' + ', '.join(sorted(missing)))
        samples = [sample for sample in samples if sample.get('case') in args.cases]
    if not samples:
        parser.error('No selected benchmark cases.')
    metadata, modules = {'manifest': str(manifest), 'manifestSha256': sha256(manifest),
                         'python': sys.version, 'runnerSha256': sha256(__file__),
                         'modelReused': True, 'sources': {}}, {}
    for variant, filename in [('before', args.baseline), ('after', args.source)]:
        source = Path(filename).resolve()
        snapshot = output / ('source-' + variant + '.py')
        snapshot.write_bytes(source.read_bytes())
        metadata['sources'][variant] = {'path': str(source), 'sha256': sha256(snapshot)}
        modules[variant] = load_script(snapshot, 'coverage_' + variant)
    (output / 'metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    # Share only the model; all actual CLI behavior remains in each snapshot.
    factory, models = modules['after'].load_whisper_model, {}

    def cached_model(*values, **options):
        key = (values, tuple(sorted(options.items())))
        if key not in models:
            models[key] = factory(*values, **options)
        if args.require_cuda and models[key][1] != 'cuda':
            raise RuntimeError('Benchmark requires CUDA; same-model CPU fallback was reported.')
        return models[key]

    for module in modules.values():
        module.load_whisper_model = cached_model
    results, console = [], sys.stdout
    for index, sample in enumerate(samples):
        audio = Path(sample['file'])
        if not audio.is_absolute():
            audio = Path(args.audio_root).resolve() / audio if args.audio_root else manifest.parent / audio
        name = str(sample.get('case', index))
        safe_name = re.sub(r'[^A-Za-z0-9_.-]', '_', name)
        for variant, module in modules.items():
            print(json.dumps({'event': 'case-start', 'case': name, 'variant': variant}), flush=True)
            log = EventLog(output / (safe_name + '-' + variant + '.jsonl'), console, name, variant)
            started = time.monotonic()
            cues, quality, speech = invoke(module, [str(module.__file__), '--audio', str(audio), '--cache', args.cache,
                '--language', sample['language'], '--profile', 'accurate', '--model', args.model,
                '--device', args.device, '--compute-type', args.compute_type], log)
            hypothesis = ''.join(cue['text'] for cue in cues)
            row = {'case': name, 'variant': variant, 'elapsedSeconds': time.monotonic() - started,
                   'sourceSha256': metadata['sources'][variant]['sha256'], 'audioSha256': sha256(audio),
                   'reference': sample['reference'], 'recognized': hypothesis,
                   'overall': character_errors(sample['reference'], hypothesis), 'quality': quality,
                   'blocks': [block_result(block, cues, speech) for block in sample.get('blocks', [])],
                   'captionOverlaps': [{'end': left['end'], 'nextStart': right['start']}
                       for left, right in zip(cues, cues[1:]) if left['end'] > right['start'] + 0.02],
                   'wordOutsideCaption': sum(word['start'] < cue['start'] - 1e-6 or word['end'] > cue['end'] + 1e-6
                       for cue in cues for word in cue.get('words', [])),
                   'attribution': {key: sample[key] for key in ('dataset', 'source', 'license', 'derived') if key in sample}}
            results.append(row)
            (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({'event': 'case-complete', 'case': name, 'variant': variant, 'overall': row['overall'],
                'captionOverlaps': len(row['captionOverlaps']), 'auditComplete': quality['audit']['complete'],
                'elapsedSeconds': row['elapsedSeconds']}, ensure_ascii=False), flush=True)
    for item in metadata['sources'].values():
        item['sourceChangedDuringRun'] = sha256(item['path']) != item['sha256']
    (output / 'metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    print(json.dumps({'event': 'complete', 'comparisons': len(samples), 'rows': len(results), 'output': str(output)}), flush=True)


if __name__ == '__main__':
    main()
