"""Characterization gate: demonstrate rawvideo's first-frame loss with nobuffer.

This exercises the bundled encoder process, not the shipped application's E2E
workflow. Supply --ffmpeg and a new --output directory to retain both streams.
"""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import threading
import time


def run(ffmpeg, directory, nobuffer):
    name = 'nobuffer' if nobuffer else 'retained'
    command = [str(ffmpeg), '-hide_banner', '-loglevel', 'error',
               *(['-fflags', '+nobuffer'] if nobuffer else []),
               '-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', '640x360',
               '-framerate', '60', '-i', '-', '-an', '-c:v', 'libvpx-vp9',
               '-deadline', 'realtime', '-cpu-used', '8', '-threads', '4',
               '-lag-in-frames', '0', '-g', '1', '-f', 'ivf', '-flush_packets', '1', 'pipe:1']
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL)
    encoded = bytearray()
    first_frame = threading.Event()

    def read():
        while chunk := process.stdout.read1(65536):
            encoded.extend(chunk)
            if len(encoded) >= 44 and len(encoded) >= 44 + struct.unpack_from('<I', encoded, 32)[0]:
                first_frame.set()

    reader = threading.Thread(target=read)
    reader.start()
    pixels = 640 * 360
    try:
        start = time.monotonic()
        process.stdin.write(bytes([80]) * pixels + bytes([128]) * (pixels // 2))
        process.stdin.flush()
        before_second = first_frame.wait(.75)
        elapsed = time.monotonic() - start
        process.stdin.write(bytes([180]) * pixels + bytes([128]) * (pixels // 2))
        process.stdin.close()
        process.wait(timeout=10)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        reader.join(timeout=5)
    if process.returncode or reader.is_alive():
        raise RuntimeError('Encoder or output reader did not complete')
    stream = directory / (name + '.ivf')
    stream.write_bytes(encoded)
    decoded = subprocess.run([str(ffmpeg), '-v', 'error', '-i', str(stream),
                              '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
                             capture_output=True, check=True, timeout=10).stdout
    means = [sum(decoded[i:i + pixels]) / pixels for i in range(0, len(decoded), pixels)]
    result = {'name': name, 'packetBeforeSecondInput': before_second, 'elapsedSeconds': elapsed,
              'decodedFrames': len(decoded) // pixels, 'decodedLumaMeans': means, 'command': command}
    if not nobuffer and (len(decoded) != 2 * pixels or not before_second or not means[0] < means[1] - 50):
        raise RuntimeError('First input was delayed, lost, or reordered: ' + json.dumps(result))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    options.output.mkdir(parents=True, exist_ok=False)
    results = [run(options.ffmpeg.resolve(), options.output, value) for value in (True, False)]
    (options.output / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results, indent=2))
