#!/usr/bin/env python3
"""Read fixture identities from the packaged application's actual preview pixels."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from PIL import Image, ImageGrab

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--expected', required=True)
args = parser.parse_args()
ui = Path(__file__).with_name('linux-ui-control.py')
metadata = json.loads(subprocess.check_output(['python3', str(ui), str(args.pid), 'preview'], text=True))
if os.environ.get('QT_QPA_PLATFORM') == 'wayland':
    subprocess.run(['gnome-screenshot', '-w', '-f', str(args.output)], check=True, timeout=10)
else:
    x, y, width, height = metadata['frame']
    ImageGrab.grab().crop((x, y, x+width, y+height)).save(args.output)
image = Image.open(args.output).convert('RGB')
# Restrict anchors to the accessible preview rectangle. The selected-source
# outline can also be cyan and must never be interpreted as image content.
# GNOME's window screenshot includes decorations outside Qt's client frame;
# conservatively allow that size difference at the right and bottom edges.
px, py, pw, ph = metadata['preview']
fx, fy, fw, fh = metadata['frame']
assert pw > 0 and ph > 0
region_left, region_top = max(0, px-fx), max(0, py-fy)
region_right = min(image.width, region_left+pw+max(0,image.width-fw))
region_bottom = min(image.height, region_top+ph+max(0,image.height-fh))
assert region_left < region_right and region_top < region_bottom
# Cyan/magenta anchors establish scale independently of borders/letterbox.
identities = []
for y in range(region_top, region_bottom):
    row = [image.getpixel((x, y)) for x in range(image.width)]
    cyan = next((x for x in range(region_left, region_right) if row[x][0] < 70 and row[x][1] > 170 and row[x][2] > 170), None)
    if cyan is None:
        continue
    magenta = next((x for x in range(cyan+1, region_right) if row[x][0] > 170 and row[x][1] < 70 and row[x][2] > 170), None)
    if magenta is None or magenta-cyan < 80:
        continue
    width = (magenta-cyan)/.75
    left = cyan-width*.1
    value = 0
    valid = True
    for bit in range(16):
        x = round(left+width*(.2+(bit+.5)*.6/16))
        if not 0 <= x < len(row):
            valid = False; break
        r, g, b = row[x]
        if max(r,g,b)-min(r,g,b) > 45 or 85 < r < 170:
            valid = False; break
        if r > 127:
            value |= 1 << bit
    if valid:
        identities.append(value)
result = {**metadata, 'imageSize': list(image.size), 'previewRegion': [region_left,region_top,region_right,region_bottom], 'decodedRows': len(identities), 'identities': sorted(set(identities)), 'expected': args.expected}
args.output.with_suffix(".json").write_text(json.dumps(result, indent=2)+"\n")
print(json.dumps(result))
if args.expected == 'none':
    assert not identities, 'Stopped Wayland preview retained source pixels'
else:
    assert len(identities) >= 12, 'No readable selected-source preview'
    assert all(value == int(args.expected) for value in identities), 'Preview is stale or displays the wrong source'
