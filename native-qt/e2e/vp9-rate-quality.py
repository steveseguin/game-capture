"""Encoder characterization gate, not application E2E testing.

Compare VP9's default intra boost with a one-frame bitrate budget, using the
packaged FFmpeg binary and the same source frames. Retain bitstreams and SSIM.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', required=True, type=Path)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    ffmpeg, source = args.ffmpeg.resolve(), args.source.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    results = []
    report = {'source': str(source),
              'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
              'ffmpegSha256': hashlib.sha256(ffmpeg.read_bytes()).hexdigest(),
              'results': results}
    for kbps, width, height, fps in [(1000, 640, 360, 30),
                                    (4000, 1280, 720, 60),
                                    (8000, 1280, 720, 60)]:
        for name, extra in [('baseline', []), ('intra100', ['-max-intra-rate', '100'])]:
            output = args.output / f'{name}-{kbps}.ivf'
            command = [str(ffmpeg), '-hide_banner', '-loglevel', 'error',
                       '-i', str(source), '-t', '8', '-vf', f'scale={width}:{height},fps={fps}',
                       '-an', '-c:v', 'libvpx-vp9', '-b:v', f'{kbps}k',
                       '-minrate', f'{kbps}k', '-maxrate', f'{kbps}k', '-bufsize', f'{kbps * 2}k',
                       '-deadline', 'realtime', '-cpu-used', '8', '-threads', '4',
                       '-lag-in-frames', '0', '-row-mt', '1', '-tile-columns', '2',
                       '-tile-rows', '1', '-frame-parallel', '1', '-g', '1',
                       '-keyint_min', '1', '-pix_fmt', 'yuv420p', *extra, str(output)]
            subprocess.run(command, check=True, timeout=120)
            data = output.read_bytes()
            if data[:4] != b'DKIF':
                raise ValueError('Expected IVF output')
            sizes, offset = [], 32
            while offset < len(data):
                if offset + 12 > len(data):
                    raise ValueError('Truncated IVF frame header')
                size = struct.unpack_from('<I', data, offset)[0]
                sizes.append(size)
                offset += 12 + size
            if offset != len(data) or len(sizes) != 8 * fps:
                raise ValueError('Missing, extra, or truncated encoded frames')
            quality = subprocess.run([
                str(ffmpeg), '-hide_banner', '-i', str(output), '-i', str(source),
                '-filter_complex', f'[0:v]setpts=PTS-STARTPTS[dist];'
                f'[1:v]scale={width}:{height},fps={fps},setpts=PTS-STARTPTS[ref];'
                '[dist][ref]ssim=shortest=1', '-an', '-f', 'null', '-'],
                capture_output=True, text=True, check=True, timeout=120)
            summary = [line for line in quality.stderr.splitlines() if 'SSIM Y:' in line]
            if not summary:
                raise ValueError('No SSIM measurement')
            result = {'name': name, 'targetKbps': kbps, 'width': width, 'height': height,
                      'fps': fps, 'frames': len(sizes), 'kbps': sum(sizes) / 1000,
                      'maxFrameBytes': max(sizes), 'ssim': summary, 'command': command}
            results.append(result)
            print(json.dumps({key: value for key, value in result.items() if key != 'command'}), flush=True)
            (args.output / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
