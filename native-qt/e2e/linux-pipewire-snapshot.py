#!/usr/bin/env python3
"""Snapshot PipeWire, preserving raw JSON and applying ordered object updates.

pw-dump 1.0.5 can emit removal arrays even without --monitor. A single
json.loads therefore cannot reliably read a snapshot during graph changes.
See registry_event_global_remove and on_core_done in upstream src/tools/pw-dump.c.
"""
import argparse
import json
from pathlib import Path
import subprocess


def parse_dump(raw):
    decoder = json.JSONDecoder()
    objects = {}
    batches = 0
    offset = 0
    while offset < len(raw):
        if raw[offset].isspace():
            offset += 1
            continue
        changes, offset = decoder.raw_decode(raw, offset)
        if not isinstance(changes, list):
            raise ValueError('Expected a PipeWire object array')
        batches += 1
        for change in changes:
            if not isinstance(change, dict) or type(change.get('id')) is not int:
                raise ValueError('Expected a PipeWire object with an integer ID')
            identity = change['id']
            if ('info' in change and change['info'] is None or
                    'props' in change and change['props'] is None):
                objects.pop(identity, None)
                continue
            previous = objects.get(identity, {})
            # Properties, parameters and other changed fields replace their
            # previous values. Unchanged info fields may be omitted by pw-dump.
            updated = {**previous, **change}
            if isinstance(change.get('info'), dict):
                updated['info'] = {**previous.get('info', {}), **change['info']}
            objects[identity] = updated
    if not batches:
        raise ValueError('Empty PipeWire snapshot')
    return {'batches': batches, 'objects': list(objects.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raw = subprocess.check_output(['pw-dump', '--no-colors'], text=True, timeout=5)
    args.output.write_text(raw)
    print(json.dumps(parse_dump(raw)))


if __name__ == '__main__':
    main()
