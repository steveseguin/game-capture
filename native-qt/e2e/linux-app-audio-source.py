#!/usr/bin/env python3
"""Owned real Pulse playback client with dynamic streams and a child process."""
import argparse
from array import array
import ctypes as C
import json
import math
from pathlib import Path
import select
import subprocess
import sys
import time
import threading


class Spec(C.Structure):
    _fields_ = [('format', C.c_int), ('rate', C.c_uint32), ('channels', C.c_uint8)]


class Buffer(C.Structure):
    _fields_ = [(name, C.c_uint32) for name in ('maxlength', 'tlength', 'prebuf', 'minreq', 'fragsize')]


pulse = C.CDLL('libpulse-simple.so.0')
pulse.pa_simple_new.argtypes = [C.c_char_p, C.c_char_p, C.c_int, C.c_char_p, C.c_char_p, C.POINTER(Spec), C.c_void_p, C.POINTER(Buffer), C.POINTER(C.c_int)]
pulse.pa_simple_new.restype = C.c_void_p
pulse.pa_simple_write.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_int)]
pulse.pa_simple_free.argtypes = [C.c_void_p]


class Tone:
    def __init__(self, device, frequencies):
        self.frequencies, self.frames = frequencies, 0
        spec, attributes, error = Spec(5 if sys.byteorder == 'little' else 6, 48000, 2), Buffer(15360, 3840, 0, 1920, 0xffffffff), C.c_int()
        self.stream = pulse.pa_simple_new(None, b'GameCaptureOwnedQAApp', 1, device.encode(), b'Owned app fixture', C.byref(spec), None, C.byref(attributes), C.byref(error))
        if not self.stream:
            raise RuntimeError('Pulse playback creation failed: ' + str(error.value))
        self.running, self.silent, self.error = True, False, None
        # Each stream needs its own blocking writer. Serial writes to two small
        # playback buffers can underrun the other stream and distort the fixture.
        self.worker = threading.Thread(target=self.run)
        self.worker.start()

    def run(self):
        try:
            while self.running:
                self.write(self.silent)
        except Exception as error:
            self.error = error

    def write(self, silent):
        samples = array('f', (0 if silent else .15 * math.sin(2 * math.pi * self.frequencies[channel] * (self.frames + frame) / 48000)
                              for frame in range(480) for channel in range(2)))
        data = samples.tobytes()
        error = C.c_int()
        if pulse.pa_simple_write(self.stream, data, len(data), C.byref(error)) < 0:
            raise RuntimeError('Pulse playback write failed: ' + str(error.value))
        self.frames += 480

    def close(self):
        self.running = False
        self.worker.join(timeout=5)
        if self.worker.is_alive():
            raise RuntimeError('Owned playback writer did not stop')
        pulse.pa_simple_free(self.stream)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--device', required=True)
    parser.add_argument('--child', action='store_true')
    args = parser.parse_args()
    primary = Tone(args.device, [1200, 1200] if args.child else [440, 880])
    extra, child, silent = None, None, False
    print(json.dumps({'ready': True}), flush=True)
    try:
        while True:
            if select.select([sys.stdin], [], [], 0)[0]:
                line = sys.stdin.readline()
                if not line:
                    break
                command = json.loads(line)
                if command.get('quit'):
                    break
                if 'silent' in command:
                    silent = command['silent']
                    for tone in (primary, extra):
                        if tone:
                            tone.silent = silent
                    if child:
                        child.stdin.write(json.dumps({'silent': silent}) + '\n'); child.stdin.flush()
                        child.stdout.readline()
                if 'primary' in command:
                    if primary:
                        primary.close(); primary = None
                    if command['primary']:
                        primary = Tone(args.device, [440, 880])
                if 'extra' in command:
                    if extra:
                        extra.close(); extra = None
                    if command['extra']:
                        extra = Tone(args.device, [1200, 1200])
                if 'child' in command:
                    if child:
                        child.stdin.close(); child.wait(timeout=5); child = None
                    if command['child']:
                        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--device', args.device, '--child'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                        if not json.loads(child.stdout.readline()).get('ready'):
                            raise RuntimeError('Child did not start')
                print(json.dumps({'id': command.get('id'), 'child': child.pid if child else None}), flush=True)
            for tone in (primary, extra):
                if tone and tone.error:
                    raise tone.error
            time.sleep(.01)
    finally:
        if child:
            child.stdin.close(); child.wait(timeout=5)
        for tone in (primary, extra):
            if tone:
                tone.close()


if __name__ == '__main__':
    main()
