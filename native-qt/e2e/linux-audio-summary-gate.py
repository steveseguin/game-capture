#!/usr/bin/env python3
"""Deterministic reporting gates, not packaged application testing.

Run: python3 native-qt/e2e/linux-audio-summary-gate.py
Needs the same NumPy/Pillow dependencies as linux-arm64-bringup.py.
"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location(
    'bringup', Path(__file__).with_name('linux-arm64-bringup.py'))
bringup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bringup)


def tones(system=.05, microphone=.05):
    time = np.arange(48000 * 4) / 48000
    return np.column_stack([
        system * np.sin(2 * np.pi * frequency * time)
        + microphone * np.sin(2 * np.pi * mic_frequency * time)
        for frequency, mic_frequency in [(440, 660), (880, 1320)]])


class AudioSummaryGate(unittest.TestCase):
    def run_phase(self, samples, microphone=True, diagnostics=None):
        result = {'phases': []}
        phase = {'name': 'selected-app-before-move', 'spectra': []}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'results.json'
            def save():
                output.write_text(json.dumps(result))
            error = None
            try:
                with bringup.recorded_phase(result, phase, save,
                        diagnostics or (lambda: {'app': {'live': True}})):
                    bringup.verify_audio(samples, microphone, phase)
            except Exception as caught:
                error = caught
            saved = json.loads(output.read_text())
        self.assertEqual(len(saved['phases']), 1)
        return saved['phases'][0], error

    def test_missing_system_preserves_failed_phase_and_original_error(self):
        phase, error = self.run_phase(tones(system=0))
        self.assertIsInstance(error, AssertionError)
        self.assertEqual(str(error), 'System audio missing')
        self.assertFalse(phase['passed'])
        self.assertEqual(phase['name'], 'selected-app-before-move')
        self.assertEqual(phase['error'], repr(error))
        self.assertEqual(phase['diagnostics'], {'app': {'live': True}})
        self.assertEqual(len(phase['spectra']), 1)
        self.assertEqual(set(phase['spectra'][0]), {'440', '660', '880', '1320'})
        self.assertLess(phase['spectra'][0]['440'], .003)
        self.assertGreater(phase['spectra'][0]['660'], .02)
        self.assertEqual(len(phase['crosstalk'][0]), 4)

    def test_system_threshold_not_relaxed(self):
        for amplitude, passes in [(.019, False), (.021, True)]:
            # Existing Hann-window FFT normalization recovers tone amplitude.
            with self.subTest(amplitude=amplitude):
                phase, error = self.run_phase(tones(system=amplitude))
                self.assertEqual(phase['passed'], passes)
                self.assertEqual(error is None, passes)
                if error: self.assertEqual(str(error), 'System audio missing')

    def test_successful_and_muted_phases(self):
        for microphone in (True, False):
            with self.subTest(microphone=microphone):
                phase, error = self.run_phase(tones(microphone=.05 if microphone else 0), microphone)
                self.assertIsNone(error)
                self.assertTrue(phase['passed'])
                self.assertEqual(len(phase['spectra']), 5)
                self.assertNotIn('error', phase)

    def test_microphone_gates_preserved(self):
        for microphone in (True, False):
            phase, error = self.run_phase(tones(microphone=0 if microphone else .05), microphone)
            self.assertFalse(phase['passed'])
            self.assertEqual(str(error), 'Microphone mix/mute incorrect')

    def test_crosstalk_gate_preserved(self):
        samples = tones()
        samples[:, 0] += .01 * np.sin(2 * np.pi * 880 * np.arange(len(samples)) / 48000)
        phase, error = self.run_phase(samples)
        self.assertEqual(str(error), 'Stereo channel crosstalk')
        self.assertGreater(phase['crosstalk'][0][0], .003)

    def test_clipping_gate_preserved(self):
        samples = tones()
        samples[48000, 0] = 1
        phase, error = self.run_phase(samples)
        self.assertEqual(str(error), 'Clipped audio')
        self.assertFalse(phase['passed'])

    def test_diagnostics_failure_does_not_replace_audio_failure(self):
        def unavailable():
            raise RuntimeError('diagnostics unavailable')
        phase, error = self.run_phase(tones(system=0), diagnostics=unavailable)
        self.assertEqual(str(error), 'System audio missing')
        self.assertEqual(phase['diagnosticsError'], "RuntimeError('diagnostics unavailable')")
        self.assertEqual(len(phase['spectra']), 1)

    def test_invalid_samples_still_record_failed_phase(self):
        for samples in (np.zeros((100, 2)), np.full((48000 * 4, 2), np.nan)):
            phase, error = self.run_phase(samples)
            self.assertIsInstance(error, AssertionError)
            self.assertFalse(phase['passed'])
            self.assertEqual(phase['spectra'], [])


if __name__ == '__main__':
    unittest.main()
