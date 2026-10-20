"""Exact quiet-noise decisions on synthetic numeric arrays only.

No media, recognition model, provider, GPU or production data is used. The
reference is frozen from v1.9.16. --benchmark times only this CPU predicate;
its numbers do not measure speech recognition or whole-analysis speed.
"""
import importlib.util
import json
import math
import pathlib
import random
import statistics
import sys
import time
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'transcribe_local.py'
SPEC = importlib.util.spec_from_file_location('asr_noise_early_exit_current', SOURCE)
ASR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASR)


def reference_noise(audio, start, end, sample_rate):
    """Frozen predicate, including accumulation order and exact thresholds."""
    left = max(0, int((start - 0.08) * sample_rate))
    right = min(len(audio), int((end + 0.08) * sample_rate))
    if right - left < max(1, int(sample_rate * 0.12)):
        return False
    frame_size = max(1, int(sample_rate * 0.02))
    squares, peak, crossed, product, previous, frame_sum = 0.0, 0.0, 0, 0.0, None, 0.0
    nonzero_count = 0
    energies = []
    for index in range(left, right):
        value = float(audio[index])
        if not math.isfinite(value):
            return False
        square = value * value
        squares += square
        frame_sum += square
        peak = max(peak, abs(value))
        nonzero_count += value != 0
        if previous is not None:
            crossed += value * previous < 0
            product += value * previous
        previous = value
        if (index - left + 1) % frame_size == 0:
            energies.append(math.sqrt(frame_sum / frame_size))
            frame_sum = 0.0
    count = right - left
    rms = math.sqrt(squares / count)
    if rms > 10 ** (-70 / 20) or peak > 10 ** (-55 / 20):
        return False
    if peak <= 1e-7:
        return True
    if len(energies) < 4 or squares <= 0:
        return False
    if (rms <= 10 ** (-90 / 20) and peak <= 10 ** (-65 / 20)
            and sum(value == 0 for value in energies) / len(energies) >= 0.8
            and crossed / max(1, nonzero_count - 1) <= 0.005):
        return True
    ordered = sorted(energies)
    low, high = ordered[int((len(ordered) - 1) * 0.1)], ordered[int((len(ordered) - 1) * 0.9)]
    stationary = high / max(low, 1e-12) <= 1.8
    noise_like = crossed / max(1, count - 1) >= 0.3 and abs(product / squares) <= 0.15
    return stationary and noise_like


class ReadTrackedNumbers:
    """Bounded, generated numeric sequence that records actual sample reads."""
    def __init__(self, count, values=None, default=0.0, forbid_after=None):
        self.count, self.values, self.default = count, values or {}, default
        self.reads, self.forbid_after = [], forbid_after

    def __len__(self):
        return self.count

    def __getitem__(self, index):
        if not isinstance(index, int) or not 0 <= index < self.count:
            raise AssertionError('Unexpected synthetic sample index')
        if self.forbid_after is not None and len(self.reads) >= self.forbid_after:
            raise AssertionError('Read beyond the proven peak rejection')
        self.reads.append(index)
        return self.values.get(index, self.default)


class NoiseEarlyExitTests(unittest.TestCase):
    def assert_same(self, values, start=0.0, end=None, rate=1000):
        end = len(values) / rate if end is None else end
        expected = reference_noise(values, start, end, rate)
        actual = ASR.very_quiet_stationary_noise(values, start, end, rate)
        self.assertIs(type(actual), bool)
        self.assertIs(actual, expected)
        return actual

    def test_positive_and_negative_peak_stop_before_unread_tail(self):
        peak = 10 ** (-55 / 20)
        for value in (math.nextafter(peak, math.inf), -math.nextafter(peak, math.inf), 1.0, -1.0, 1e308, -1e308):
            with self.subTest(value=value):
                audio = ReadTrackedNumbers(16000 * 30, {0: value}, forbid_after=1)
                self.assertIs(ASR.very_quiet_stationary_noise(audio, 0, 30, 16000), False)
                self.assertEqual(audio.reads, [0])
                self.assertIs(reference_noise([value] + [0.0] * 999, 0, 1, 1000), False)

    def test_peak_at_later_sample_reads_no_following_sample(self):
        for position in (1, 19, 137, 999):
            with self.subTest(position=position):
                audio = ReadTrackedNumbers(1000, {position: 0.01}, forbid_after=position + 1)
                self.assertIs(ASR.very_quiet_stationary_noise(audio, 0, 1, 1000), False)
                self.assertEqual(audio.reads, list(range(position + 1)))

    def test_equal_and_below_peak_limits_do_not_short_circuit(self):
        peak = 10 ** (-55 / 20)
        for value in (peak, -peak, math.nextafter(peak, 0), -math.nextafter(peak, 0)):
            with self.subTest(value=value):
                tracked = ReadTrackedNumbers(1000, {0: value})
                actual = ASR.very_quiet_stationary_noise(tracked, 0, 1, 1000)
                self.assertIs(actual, reference_noise([value] + [0.0] * 999, 0, 1, 1000))
                self.assertEqual(tracked.reads, list(range(1000)))

    def test_nonfinite_samples_keep_rejection_before_or_after_peak(self):
        for nonfinite in (math.nan, math.inf, -math.inf):
            for position in (0, 50, 999):
                for peak_at in (None, 1, 700):
                    with self.subTest(nonfinite=nonfinite, position=position, peak_at=peak_at):
                        values = [0.0] * 1000
                        if peak_at is not None:
                            values[peak_at] = 0.01
                        values[position] = nonfinite
                        self.assertIs(self.assert_same(values), False)

    def test_padding_is_included_and_loud_samples_outside_window_are_ignored(self):
        left = int((1.0 - 0.08) * 1000)
        padded = ReadTrackedNumbers(3000, {left: -0.01}, forbid_after=1)
        self.assertIs(ASR.very_quiet_stationary_noise(padded, 1, 2, 1000), False)
        self.assertEqual(padded.reads, [left])
        values = [0.0] * 3000
        values[left - 1] = 0.01
        values[int((2 + 0.08) * 1000)] = -0.01
        self.assertIs(self.assert_same(values, 1, 2), True)

    def test_empty_short_and_outside_ranges_read_no_samples(self):
        for count, start, end, rate in ((0, 0, 1, 1000), (1000, 2, 3, 1000),
                                        (1000, 0, 0.01, 1000), (1000, 1, 0, 1000),
                                        (1, 0, 0, 1000)):
            with self.subTest(count=count, start=start, end=end, rate=rate):
                audio = ReadTrackedNumbers(count, default=0.01, forbid_after=0)
                self.assertIs(ASR.very_quiet_stationary_noise(audio, start, end, rate), False)
                self.assertEqual(audio.reads, [])

    def test_silence_stationary_noise_and_quantized_tails_match_reference(self):
        rng = random.Random(1917001)
        values = [rng.uniform(-1e-5, 1e-5) for _ in range(6000)]
        cases = [[0.0] * 6000, [-0.0] * 6000, [1e-8] * 6000, values,
                 [0.0] * 5600 + [1e-6] * 400,
                 [1e-6 * math.sin(index * 0.04) for index in range(6000)]]
        decisions = [self.assert_same(item) for item in cases]
        self.assertTrue(any(decisions))
        self.assertTrue(any(not item for item in decisions))

    def test_rms_and_near_zero_threshold_neighbors_match_reference(self):
        thresholds = (10 ** (-70 / 20), 1e-7, 10 ** (-90 / 20), 10 ** (-65 / 20))
        for threshold in thresholds:
            for value in (math.nextafter(threshold, 0), threshold, math.nextafter(threshold, math.inf)):
                for sign in (-1, 1):
                    with self.subTest(threshold=threshold, value=value, sign=sign):
                        self.assert_same([sign * value] * 1000)

    def test_randomized_finite_arrays_and_ranges_match_reference(self):
        rng = random.Random(1917002)
        scales = (0.0, 1e-10, 1e-7, 1e-5, 0.0003, 0.001, 0.002, 0.5)
        for case in range(400):
            count = rng.randrange(1, 2000)
            rate = rng.choice((80, 1000, 16000))
            scale = rng.choice(scales)
            values = [rng.uniform(-scale, scale) for _ in range(count)]
            start = rng.uniform(-0.3, count / rate + 0.1)
            end = rng.uniform(start, count / rate + 0.3)
            with self.subTest(case=case):
                self.assert_same(values, start, end, rate)

    def test_sparse_adversarial_peak_positions_match_reference_without_mutation(self):
        peak = 10 ** (-55 / 20)
        for position in (0, 1, 19, 20, 21, 998, 999):
            for value in (peak, -peak, math.nextafter(peak, math.inf), -math.nextafter(peak, math.inf)):
                with self.subTest(position=position, value=value):
                    values = [0.0] * 1000
                    values[position] = value
                    before = list(values)
                    self.assert_same(values)
                    self.assertEqual(values, before)


def benchmark():
    """Bounded CPU-only comparison; never treat this as overall ASR speed."""
    for seconds, peak_position in ((30, 0), (90, 0), (30, 16000 * 30 - 1), (30, None)):
        values = [0.0] * (16000 * seconds)
        if peak_position is not None:
            values[peak_position] = 0.01
        expected = reference_noise(values, 0, seconds, 16000)
        results, measurements = {}, {}
        for name, function in (('before', reference_noise), ('after', ASR.very_quiet_stationary_noise)):
            elapsed = []
            for _ in range(3):
                started = time.perf_counter()
                results[name] = function(values, 0, seconds, 16000)
                elapsed.append(time.perf_counter() - started)
            measurements[name] = statistics.median(elapsed)
        if any(value is not expected for value in results.values()):
            raise AssertionError('Quiet-noise classification changed')
        print(json.dumps({'kind': 'synthetic_numeric_predicate_cpu_only', 'function': 'very_quiet_stationary_noise',
                          'representedSeconds': seconds, 'samples': len(values), 'peakPosition': peak_position,
                          'beforeSeconds': round(measurements['before'], 9), 'afterSeconds': round(measurements['after'], 9),
                          'sameBoolean': True, 'result': expected,
                          'limitation': 'Not speech recognition, GPU inference, real audio or whole-analysis speed.'}), flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--benchmark']:
        benchmark()
    else:
        unittest.main()
