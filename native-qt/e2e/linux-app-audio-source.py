#!/usr/bin/env python3
"""Owned Pulse or native PipeWire playback with dynamic streams and descendants."""
import argparse
from array import array
import ctypes as C
import json
import math
import os
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


class PipeWireTone(Tone):
    """pw-cat uses native libpipewire; each playback stream is a real child PID.

    The parent identity is selected by the application's process-tree capture.
    Never forge application.process.id to disguise children as same-PID streams.
    """
    def __init__(self, device, frequencies):
        self.frequencies, self.frames = frequencies, 0
        self.client = subprocess.Popen(['pw-cat', '--playback', '--target', device,
            '--rate', '48000', '--channels', '2', '--format', 'f32', '--latency', '20ms',
            '--properties', '{ application.name = GameCaptureOwnedQAApp }', '-'],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
        self.running, self.silent, self.error = True, False, None
        self.worker = threading.Thread(target=self.run)
        self.worker.start()

    def write(self, silent):
        samples = array('f', (0 if silent else .15 * math.sin(2 * math.pi * self.frequencies[channel] * (self.frames + frame) / 48000)
                              for frame in range(480) for channel in range(2)))
        self.client.stdin.write(samples.tobytes()); self.client.stdin.flush()
        self.frames += 480

    def close(self):
        self.running = False
        self.worker.join(timeout=5)
        if self.worker.is_alive():
            self.client.terminate(); self.client.wait(timeout=5)
            self.worker.join(timeout=5)
            raise RuntimeError('Native PipeWire writer did not stop')
        self.client.stdin.close()
        try: self.client.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.client.kill(); self.client.wait(timeout=5)
            raise RuntimeError('Native PipeWire client did not retire')
        assert self.client.returncode == 0, 'Native PipeWire playback failed'


class JackTone:
    """Actual JACK API playback, loaded through pw-jack in the owned server.

    Precomputed periodic PCM keeps the Python callback small. This is a routing
    fixture, not a realtime performance reference.
    """
    def __init__(self, device, frequencies):
        self.silent, self.error, self.frames = False, None, 0
        self.jack = jack = C.CDLL('libjack.so.0')
        callback_type = C.CFUNCTYPE(C.c_int, C.c_uint32, C.c_void_p)
        for name, arguments, result in [
            ('jack_client_open', [C.c_char_p, C.c_uint, C.POINTER(C.c_uint)], C.c_void_p),
            ('jack_client_close', [C.c_void_p], C.c_int),
            ('jack_get_sample_rate', [C.c_void_p], C.c_uint32),
            ('jack_set_process_callback', [C.c_void_p, callback_type, C.c_void_p], C.c_int),
            ('jack_activate', [C.c_void_p], C.c_int),
            ('jack_deactivate', [C.c_void_p], C.c_int),
            ('jack_port_register', [C.c_void_p,C.c_char_p,C.c_char_p,C.c_ulong,C.c_ulong], C.c_void_p),
            ('jack_port_name', [C.c_void_p], C.c_char_p),
            ('jack_port_get_buffer', [C.c_void_p,C.c_uint32], C.c_void_p),
            ('jack_get_ports', [C.c_void_p,C.c_char_p,C.c_char_p,C.c_ulong], C.POINTER(C.c_char_p)),
            ('jack_connect', [C.c_void_p,C.c_char_p,C.c_char_p], C.c_int),
            ('jack_free', [C.c_void_p], None),
        ]:
            function = getattr(jack, name); function.argtypes = arguments; function.restype = result
        status = C.c_uint()
        self.client = jack.jack_client_open(b'GameCaptureOwnedQAApp', 1, C.byref(status))
        assert self.client, 'JACK connection failed: '+str(status.value)
        try:
            assert jack.jack_get_sample_rate(self.client) == 48000
            self.samples = [array('f', (.15*math.sin(2*math.pi*f*i/48000) for i in range(1200))) for f in frequencies]
            self.ports = [jack.jack_port_register(self.client, name, b'32 bit float mono audio', 2, 0) for name in (b'left',b'right')]
            assert all(self.ports)
            def process(count, _):
                for channel, port in enumerate(self.ports):
                    output = jack.jack_port_get_buffer(port, count)
                    if self.silent:
                        C.memset(output, 0, count*4)
                    else:
                        written = 0
                        while written < count:
                            offset = (self.frames+written) % 1200
                            length = min(count-written, 1200-offset)
                            C.memmove(output+written*4, self.samples[channel].buffer_info()[0]+offset*4, length*4)
                            written += length
                self.frames += count
                return 0
            self.callback = callback_type(process)
            assert jack.jack_set_process_callback(self.client, self.callback, None) == 0
            assert jack.jack_activate(self.client) == 0
            ports = jack.jack_get_ports(self.client, None, b'32 bit float mono audio', 1)
            names = []
            if ports:
                index = 0
                while ports[index]: names.append(ports[index].decode()); index += 1
                jack.jack_free(ports)
            for channel, suffix in enumerate(('playback_FL', 'playback_FR')):
                matches = [name for name in names if name in (device+':'+suffix, device+' Audio/Sink sink:'+suffix)]
                assert len(matches)==1, 'Owned JACK destination missing: '+repr(names)
                assert jack.jack_connect(self.client, jack.jack_port_name(self.ports[channel]), matches[0].encode()) == 0
        except Exception:
            jack.jack_client_close(self.client); self.client = None
            raise

    def close(self):
        assert self.jack.jack_deactivate(self.client) == 0
        assert self.jack.jack_client_close(self.client) == 0
        self.client = None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--device', required=True)
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--backend', choices=['pulse', 'pipewire', 'jack'], default='pulse')
    args = parser.parse_args()
    tone_type = {'pulse':Tone, 'pipewire':PipeWireTone, 'jack':JackTone}[args.backend]
    primary = tone_type(args.device, [1200, 1200] if args.child else [440, 880])
    extra, child, silent = None, None, False
    print(json.dumps({'ready': True, 'backend': args.backend,
                      'playbackPid': primary.client.pid if args.backend == 'pipewire' else os.getpid()}), flush=True)
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
                        primary = tone_type(args.device, [440, 880])
                if 'extra' in command:
                    if extra:
                        extra.close(); extra = None
                    if command['extra']:
                        extra = tone_type(args.device, [1200, 1200])
                if 'child' in command:
                    if child:
                        child.stdin.close(); child.wait(timeout=5); child = None
                    if command['child']:
                        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--device', args.device, '--child', '--backend', args.backend], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
                        if not json.loads(child.stdout.readline()).get('ready'):
                            raise RuntimeError('Child did not start')
                print(json.dumps({'id': command.get('id'), 'child': child.pid if child else None,
                    'playbackPid': primary.client.pid if primary and args.backend == 'pipewire' else None}), flush=True)
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
