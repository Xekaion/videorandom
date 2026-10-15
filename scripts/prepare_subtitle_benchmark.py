"""Download six public Google FLEURS test samples and make deterministic ASR fixtures.

Optional benchmark dependencies: huggingface_hub, pyarrow, numpy, faster-whisper.
Downloads about 1.3 GB of public dataset shards, never reads personal media.
Google FLEURS (CC BY 4.0): https://huggingface.co/datasets/google/fleurs
"""
import argparse
import concurrent.futures
import json
import pathlib
import sys
import wave

import numpy as np
import pyarrow.parquet as pq
from faster_whisper.audio import decode_audio
from huggingface_hub import hf_hub_download

DATASET_REVISION = '168de341b3db6859a9bac1c50a2ef5e3b47647e0'


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--include-auto-language-case', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)

    def fetch_samples(item):
        config, language = item
        parquet = hf_hub_download('google/fleurs', config + '/test/0000.parquet', repo_type='dataset',
                                  revision=DATASET_REVISION, cache_dir=str(root / 'dataset-cache'))
        rows = next(pq.ParquetFile(parquet).iter_batches(batch_size=3)).to_pylist()
        samples = []
        for index, row in enumerate(rows):
            destination = root / (language + '-' + str(index) + '.wav')
            destination.write_bytes(row['audio']['bytes'])
            samples.append({'language': language, 'file': str(destination),
                            'reference': row.get('raw_transcription') or row['transcription'],
                            'dataset': 'google/fleurs', 'revision': DATASET_REVISION,
                            'config': config, 'split': 'test', 'row': index,
                            'source': 'https://huggingface.co/datasets/google/fleurs', 'license': 'cc-by-4.0',
                            'case': language + '-clean-' + str(index)})
        return samples

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        samples = [sample for group in pool.map(fetch_samples, [('ja_jp', 'ja'), ('cmn_hans_cn', 'zh')]) for sample in group]
    output = list(samples)
    rng = np.random.default_rng(7126)
    for language in ['ja', 'zh']:
        selected = [sample for sample in samples if sample['language'] == language]
        first, second = [decode_audio(sample['file']) for sample in selected[:2]]
        variants = {
            'quiet-after-loud': np.concatenate([np.zeros(16000), first, np.zeros(3 * 16000), second * 0.06, np.zeros(2 * 16000)]),
            'window-boundary': np.concatenate([np.zeros(84 * 16000), first, np.zeros(2 * 16000), second, np.zeros(3 * 16000)])
        }
        for kind, audio in variants.items():
            if kind == 'quiet-after-loud':
                audio += rng.normal(0, 0.0002, len(audio)).astype(np.float32)
            destination = root / (language + '-' + kind + '.wav')
            with wave.open(str(destination), 'wb') as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes((np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes())
            output.append({**selected[0], 'file': str(destination),
                           'reference': selected[0]['reference'] + selected[1]['reference'],
                           'case': language + '-' + kind, 'derived': kind, 'rows': [0, 1]})
    if args.include_auto_language_case:
        sample = next(item for item in output if item['case'] == 'ja-window-boundary')
        output.append({**sample, 'language': 'auto', 'case': 'ja-long-silence-auto-language'})
    (root / 'manifest.json').write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'cases': len(output), 'manifest': str(root / 'manifest.json')}))


if __name__ == '__main__':
    main()
