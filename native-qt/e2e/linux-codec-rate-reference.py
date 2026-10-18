#!/usr/bin/env python3
"""Independent FFmpeg rate calibration; this is not application testing.

Reuses a packaged workflow's exact helper arguments with deterministic noise
and barcode geometry resembling linux-window-publish.js. No publisher runs.
The synthetic source excludes browser decorations and capture resampling, so
this diagnoses codec limits rather than claiming pixel-identical input.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workflow-report', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--noise-grid', choices=['160x90', '80x45', '40x23'], default='160x90')
    args = parser.parse_args()
    workflow = json.loads(args.workflow_report.read_text())
    original = workflow['helperProcesses'][0]['argv']
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'reference.py').write_bytes(Path(__file__).read_bytes())
    result = {'classification': 'Independent codec calibration, not application testing',
              'workflowReport': str(args.workflow_report), 'workflowSha256': sha(args.workflow_report),
              'harnessSha256': sha(__file__), 'ffmpegSha256': sha(original[0]),
              'noiseGrid': args.noise_grid,
              'limits': 'Synthetic noise/barcode geometry; no browser decorations, capture resampling, transport or application',
              'cases': []}
    assert result['ffmpegSha256'] == workflow['helperSha256']
    width, height = workflow['requested']['width'], workflow['requested']['height']
    noise_width, noise_height = map(int, args.noise_grid.split('x'))
    for bitrate in (2000, 500):
        output = args.output / f'{bitrate}.ivf'
        command = list(original)
        for flag in ('-b:v', '-minrate', '-maxrate'):
            command[command.index(flag) + 1] = f'{bitrate}k'
        command[command.index('-bufsize') + 1] = f'{bitrate * 2}k'
        command[-1] = str(output)
        with (args.output / f'{bitrate}.log').open('wb') as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=log)
            try:
                for frame in range(360):
                    identity = frame * 2
                    seed = identity + 1
                    noise = bytearray(noise_width * noise_height)
                    for i in range(len(noise)):
                        seed = (seed * 1664525 + 1013904223) & 0xffffffff
                        noise[i] = seed >> 24
                    picture = Image.frombytes('L', (noise_width, noise_height), bytes(noise)).resize((width, height), Image.Resampling.NEAREST).convert('RGB')
                    draw = ImageDraw.Draw(picture)
                    draw.rectangle((.1*width, .25*height, .15*width-1, .75*height-1), fill='cyan')
                    draw.rectangle((.85*width, .25*height, .9*width-1, .75*height-1), fill='magenta')
                    for bit in range(16):
                        left = (.2 + bit*.6/16)*width
                        draw.rectangle((left, .25*height, left+.6/16*width-1, .75*height-1), fill='white' if identity >> bit & 1 else 'black')
                    process.stdin.write(picture.convert('RGBA').tobytes('raw', 'BGRA'))
                process.stdin.close()
                assert process.wait(timeout=30) == 0
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        packets = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_packets', '-select_streams', 'v', '-of', 'json', str(output)]))['packets']
        selected = [p for p in packets if 3 <= float(p['pts_time']) < 12]
        assert len(packets) == 360 and len(selected) == 270
        result['cases'].append({'requestedKbps': bitrate, 'encodedKbps': sum(int(p['size']) for p in selected)*8/9/1000,
                                'frames': len(packets), 'argv': command, 'outputSha256': sha(output)})
        (args.output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['cases'], indent=2))


if __name__ == '__main__':
    main()
