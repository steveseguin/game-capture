#!/usr/bin/env python3
"""Verify an extracted source bundle and prepare its cached dependency sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--verify-only',action='store_true')
    args=parser.parse_args()
    root=args.bundle.resolve(strict=True)
    if sys.version_info<(3,12):
        parser.error('Python 3.12+ is required for filtered archive extraction')
    manifest=json.loads((root/'manifest.json').read_text())
    if manifest['format']!=1:
        parser.error('Unsupported source manifest')
    for name,entry in manifest['files'].items():
        path=root/name
        if Path(name).is_absolute() or '..' in Path(name).parts or not path.resolve().is_relative_to(root):
            raise ValueError('Source path escapes bundle: '+name)
        if entry['link'] is not None:
            if not path.is_symlink() or os.readlink(path)!=entry['link']:
                raise ValueError('Symlink mismatch: '+name)
            data=os.readlink(path).encode()
        else:
            if path.is_symlink():
                raise ValueError('Unexpected symlink: '+name)
            data=path.read_bytes()
        if hashlib.sha256(data).hexdigest()!=entry['sha256']:
            raise ValueError('Source hash mismatch: '+name)
    if not args.verify_only:
        work=root/'repository/native-qt/build-macos-deps'
        if work.exists():
            raise ValueError('Use a fresh extraction; dependency work directory already exists')
        (work/'downloads').mkdir(parents=True)
        for entry in manifest['upstream']:
            archive=root/entry['archive']
            target=work/archive.name if archive.name.startswith('syphon-') else work/'downloads'/archive.name
            shutil.copyfile(archive,target)
            with tarfile.open(archive) as tar:
                tar.extractall(work,filter='data')
            for changed in entry['overrides']:
                relative=changed['path']
                if Path(relative).is_absolute() or '..' in Path(relative).parts:
                    raise ValueError('Unsafe override')
                shutil.copyfile(root/'overrides'/relative,work/relative)
        print(json.dumps({'verifiedFiles':len(manifest['files']),'preparedArchives':len(manifest['upstream'])}))
    else:
        print(json.dumps({'verifiedFiles':len(manifest['files'])}))


if __name__=='__main__':
    main()
