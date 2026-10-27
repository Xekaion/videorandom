"""Bounded scheduling with neutral fake models; no inference or media files."""
import concurrent.futures
import importlib.util
import json
import pathlib
import statistics
import threading
import time
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('scheduler_asr', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


class Audio:
    def __init__(self, count, start=0):
        self.count, self.start = count, start

    def __len__(self):
        return self.count

    def __getitem__(self, item):
        start, stop, _ = item.indices(self.count)
        return Audio(stop - start, self.start + start)


def windows(count):
    return [(index * 10, (index + 1) * 10, index * 10, (index + 1) * 10) for index in range(count)]


class Fake:
    def __init__(self, action=None):
        self.action, self.lock, self.calls = action, threading.Lock(), {}
        self.active, self.peak, self.options = 0, 0, []

    def transcribe(self, audio, **options):
        index = audio.start // 10

        def generate():
            with self.lock:
                self.calls[index] = self.calls.get(index, 0) + 1
                attempt = self.calls[index]
                self.active += 1
                self.peak = max(self.peak, self.active)
                self.options.append(options)
            try:
                if self.action:
                    self.action(index, attempt, self)
                yield {'start': .2, 'end': 1.2, 'text': 'neutral-' + str(index),
                       'words': [{'start': .2, 'end': 1.2, 'word': 'neutral-' + str(index)}]}
            finally:
                with self.lock:
                    self.active -= 1
        return generate(), None


def decoded(model, count=12, state=None, options=None, warnings=None, waiting=None):
    return ASR.decode_windows(model, Audio(count * 10), windows(count), options or {}, 1,
                              state if state is not None else {'workers': 2},
                              warnings.append if warnings is not None else lambda event: None, waiting)


class SchedulerTests(unittest.TestCase):
    def test_slow_owner_does_not_idle_second_worker_and_finished_successors_are_bounded(self):
        release, started_ahead = threading.Event(), threading.Event()

        def action(index, attempt, model):
            if index == 0:
                if not release.wait(3):
                    raise RuntimeError('test did not release its owner')
            elif index == 4:
                started_ahead.set()

        model, first, errors = Fake(action), [], []
        output = decoded(model)

        def consume():
            try:
                first.append(next(output))
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=consume)
        thread.start()
        try:
            self.assertTrue(started_ahead.wait(2), 'the free decoder must refill while the earlier owner is still running')
            time.sleep(.02)
            self.assertEqual(sorted(model.calls), [0, 1, 2, 3, 4], 'only four successor windows may wait for their owner')
            self.assertEqual(first, [], 'no successor can publish before its owner')
            self.assertLessEqual(model.peak, 2)
        finally:
            release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive()); self.assertFalse(errors)
        rows = first + list(output)
        self.assertEqual([row[0] for row in rows], list(range(12)))
        self.assertEqual([row[2][0]['text'] for row in rows], ['neutral-' + str(index) for index in range(12)])
        self.assertEqual(model.calls, dict.fromkeys(range(12), 1)); self.assertEqual(model.active, 0)

    def test_observed_successor_error_stops_new_submissions_without_retrying_or_reordering_prefix(self):
        release, failed = threading.Event(), threading.Event()

        def action(index, attempt, model):
            if index == 0:
                if not release.wait(3): raise RuntimeError('test owner not released')
            elif index == 1:
                failed.set()
                raise ValueError('neutral decode error')
        model, prefix, errors = Fake(action), [], []

        def consume():
            try:
                prefix.extend(decoded(model))
            except BaseException as error:
                errors.append(error)
        thread = threading.Thread(target=consume); thread.start()
        try:
            self.assertTrue(failed.wait(2)); time.sleep(.02)
            self.assertEqual(model.calls, {0: 1, 1: 1})
        finally:
            release.set(); thread.join(3)
        self.assertEqual([row[0] for row in prefix], [0]); self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError); self.assertEqual(str(errors[0]), 'neutral decode error')
        self.assertEqual(model.active, 0)

    def test_oom_reuses_buffered_successes_and_retries_the_failed_owner_only_after_all_work_settles(self):
        release, buffered = threading.Event(), threading.Event()

        def action(index, attempt, model):
            if index == 4: buffered.set()
            if index == 0 and attempt == 1:
                if not release.wait(3): raise RuntimeError('test owner not released')
                raise RuntimeError('CUDA out of memory')
            if index == 0 and attempt == 2:
                self.assertEqual(model.active, 1, 'serial retry cannot overlap an earlier decoder')
        model, rows, errors, warnings = Fake(action), [], [], []
        state = {'workers': 2, 'oomFallback': False}

        def consume():
            try: rows.extend(decoded(model, state=state, warnings=warnings))
            except BaseException as error: errors.append(error)
        thread = threading.Thread(target=consume); thread.start()
        try:
            self.assertTrue(buffered.wait(2)); self.assertEqual(sorted(model.calls), [0, 1, 2, 3, 4])
        finally:
            release.set(); thread.join(3)
        self.assertFalse(errors); self.assertFalse(thread.is_alive())
        self.assertEqual([row[0] for row in rows], list(range(12)))
        self.assertEqual(model.calls, {index: 2 if index == 0 else 1 for index in range(12)})
        self.assertEqual(state, {'workers': 1, 'oomFallback': True}); self.assertEqual(len(warnings), 1)
        self.assertEqual(model.active, 0)

    def test_repeated_oom_does_not_replay_the_model_or_certify_unprocessed_windows(self):
        def action(index, attempt, model):
            if index == 0: raise RuntimeError('CUDA out of memory')
        model, warnings = Fake(action), []
        state = {'workers': 2, 'oomFallback': False}
        with self.assertRaisesRegex(RuntimeError, 'CUDA out of memory'):
            list(decoded(model, state=state, warnings=warnings))
        self.assertEqual(model.calls[0], 2); self.assertTrue(all(index < 2 for index in model.calls))
        self.assertEqual(len(warnings), 1); self.assertEqual(state['workers'], 1)
        self.assertEqual(model.active, 0)

    def test_wait_heartbeats_reference_the_unpublished_owner_and_keep_the_public_timeout(self):
        release, heartbeats = threading.Event(), []

        def action(index, attempt, model):
            if not release.wait(3): raise RuntimeError('test heartbeat not released')

        def wait(futures, timeout, return_when):
            self.assertEqual(timeout, 10); self.assertEqual(return_when, ASR.FIRST_COMPLETED)
            return concurrent.futures.wait(futures, timeout=.01, return_when=return_when)

        def waiting(index):
            heartbeats.append(index); release.set()
        with patch.object(ASR, 'wait_futures', wait):
            rows = list(decoded(Fake(action), count=2, waiting=waiting))
        self.assertEqual([row[0] for row in rows], [0, 1]); self.assertTrue(heartbeats)
        self.assertTrue(all(index == 0 for index in heartbeats))

    def test_serial_stream_and_empty_tail_keep_their_original_options_and_sample_windows(self):
        options = {'beam_size': 5, 'best_of': 5, 'word_timestamps': True, 'vad_filter': False,
                   'temperature': (0., .2, .4), 'condition_on_previous_text': False}
        serial, parallel = Fake(), Fake()
        first = [(index, window, list(rows)) for index, window, rows in decoded(serial, state={'workers': 1}, options=options)]
        second = list(decoded(parallel, options=options))
        self.assertEqual(first, second)
        self.assertEqual(serial.options, [options] * 12); self.assertEqual(parallel.options, [options] * 12)
        self.assertEqual(list(decoded(Fake(), count=0)), [])

    def test_closing_the_consumer_settles_started_decoders_without_submitting_more(self):
        release, third = threading.Event(), threading.Event()

        def action(index, attempt, model):
            if index == 2: third.set()
            if index > 0 and not release.wait(3): raise RuntimeError('test close did not release its workers')
        model = Fake(action); output = decoded(model)
        self.assertEqual(next(output)[0], 0)
        self.assertTrue(third.wait(2))
        closer = threading.Thread(target=output.close); closer.start()
        try:
            time.sleep(.02)
            self.assertTrue(closer.is_alive(), 'close waits only for the already started work')
            self.assertEqual(sorted(model.calls), [0, 1, 2])
        finally:
            release.set(); closer.join(3)
        self.assertFalse(closer.is_alive()); self.assertEqual(model.active, 0)
        self.assertEqual(list(output), []); self.assertLessEqual(model.peak, 2)

    def test_an_oom_cannot_hide_a_buffered_non_memory_error_or_trigger_a_retry(self):
        release, failed = threading.Event(), threading.Event()

        def action(index, attempt, model):
            if index == 0:
                if not release.wait(3): raise RuntimeError('test did not release its owner')
                raise RuntimeError('CUDA out of memory')
            failed.set(); raise ValueError('neutral independent error')
        model, errors, warnings = Fake(action), [], []
        state = {'workers': 2, 'oomFallback': False}

        def consume():
            try: list(decoded(model, state=state, warnings=warnings))
            except BaseException as error: errors.append(error)
        thread = threading.Thread(target=consume); thread.start()
        try:
            self.assertTrue(failed.wait(2)); time.sleep(.02)
        finally:
            release.set(); thread.join(3)
        self.assertFalse(thread.is_alive()); self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError); self.assertEqual(str(errors[0]), 'neutral independent error')
        self.assertEqual(model.calls, {0: 1, 1: 1}); self.assertEqual(warnings, [])
        self.assertEqual(state, {'workers': 2, 'oomFallback': False}); self.assertEqual(model.active, 0)


def reference_ordered(model, count):
    # Frozen former policy for the neutral scheduling comparison only.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        def decode(index): return list(model.transcribe(Audio(10, index * 10))[0])
        pending = [(index, executor.submit(decode, index)) for index in range(min(2, count))]
        cursor, rows = min(2, count), []
        while pending:
            index, future = pending.pop(0); result = future.result()
            if cursor < count:
                pending.append((cursor, executor.submit(decode, cursor))); cursor += 1
            rows.append((index, windows(count)[index], result))
        return rows


def benchmark():
    samples = []
    for _ in range(3):
        def action(index, attempt, model): time.sleep(.08 if index % 2 == 0 else .005)
        before, after = Fake(action), Fake(action)
        start = time.perf_counter(); original = reference_ordered(before, 12); old = time.perf_counter() - start
        start = time.perf_counter(); current = list(decoded(after, count=12)); new = time.perf_counter() - start
        if original != current or before.calls != after.calls or before.peak > 2 or after.peak > 2:
            raise AssertionError('neutral scheduling comparison changed decoded work')
        samples.append({'beforeSeconds': old, 'afterSeconds': new})
    old = statistics.median(sample['beforeSeconds'] for sample in samples)
    new = statistics.median(sample['afterSeconds'] for sample in samples)
    print(json.dumps({'scope': '12 neutral delayed decoder windows; no model, GPU or audio',
                      'medianBeforeSeconds': old, 'medianAfterSeconds': new, 'ratio': old / new,
                      'sameOutputsAndWork': True, 'peakWorkers': 2, 'samples': samples}))


if __name__ == '__main__':
    import sys
    if '--benchmark' in sys.argv: benchmark()
    else: unittest.main(verbosity=2)
