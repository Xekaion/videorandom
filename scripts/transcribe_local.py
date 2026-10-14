"""Stream local speech recognition as UTF-8 JSON lines. No account or API key."""
import argparse
import json
import os
import sys


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda", "auto"))
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()
    from faster_whisper import WhisperModel

    emit({"type": "loading", "model": args.model})
    # The first run downloads a model. Subsequent runs reuse this local cache.
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                         download_root=os.path.abspath(args.cache))
    segments, info = model.transcribe(os.path.abspath(args.audio), beam_size=5,
                                      vad_filter=True, condition_on_previous_text=False)
    emit({"type": "info", "language": info.language, "duration": info.duration})
    count = 0
    for segment in segments:
        text = segment.text.strip()
        if text and segment.end > segment.start:
            emit({"type": "segment", "start": segment.start, "end": segment.end,
                  "text": text})
            count += 1
    emit({"type": "complete", "segments": count})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "message": str(error)[:1000]})
        sys.exit(1)
