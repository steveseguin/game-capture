#!/usr/bin/env python3
"""Packaging architecture sanity gate; this does not exercise the application."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('packager', Path(__file__).with_name('package-linux.py'))
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageArchitectureGate(unittest.TestCase):
    def test_native_and_foreign_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'game-capture'
            for host in ('amd64', 'arm64'):
                with patch.object(packager.subprocess, 'check_output', return_value=host+'\n'):
                    for architecture, machine in [('amd64', 62), ('arm64', 183), ('armhf', 40)]:
                        for kind in (2, 3):
                            header = bytearray(64)
                            header[:7] = b'\x7fELF\x02\x01\x01'
                            struct.pack_into('<HH', header, 16, kind, machine)
                            binary.write_bytes(header)
                            if architecture == host:
                                self.assertEqual(packager.native_architecture(binary), host)
                            else:
                                with self.assertRaisesRegex(SystemExit, 'does not match native'):
                                    packager.native_architecture(binary)
                    for bad in (b'', b'#!/bin/sh\n', b'\x7fELF\x01\x01\x01'+bytes(57),
                                b'\x7fELF\x02\x02\x01'+bytes(57)):
                        binary.write_bytes(bad)
                        with self.assertRaisesRegex(SystemExit, 'ELF64 executable'):
                            packager.native_architecture(binary)
            with patch.object(packager.subprocess, 'check_output', return_value='armhf\n'):
                with self.assertRaisesRegex(SystemExit, 'Unsupported'):
                    packager.native_architecture(binary)


if __name__ == '__main__':
    unittest.main()
