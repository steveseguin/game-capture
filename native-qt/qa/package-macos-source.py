#!/usr/bin/env python3
"""Assemble source/build materials matching a local Mac development bundle."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, required=True)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--native-build', type=Path,
                        help='Git-backed native dependency build tree, when --build used exported sources')
    parser.add_argument('--dependencies', type=Path, required=True)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, build, deps, app = [p.resolve(strict=True) for p in [args.repository, args.build, args.dependencies, args.app]]
    native_build = args.native_build.resolve(strict=True) if args.native_build else build
    output = args.output.resolve()
    if output.exists() or output.with_suffix(output.suffix+'.json').exists():
        parser.error('Use a new output path; existing source artifacts are immutable')
    output.parent.mkdir(parents=True, exist_ok=True)
    inputs = {}
    components = {}
    upstream = []

    def add(name, source=None, data=None, executable=False, link=None):
        if name in inputs or Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Unsafe or duplicate archive path: '+name)
        if source is not None:
            if source.is_symlink():
                link = os.readlink(source)
            else:
                executable = bool(source.stat().st_mode & stat.S_IXUSR)
        if link is not None:
            if Path(link).is_absolute():
                raise ValueError('Absolute source symlink: '+name)
            normalized = os.path.normpath(str(Path(name).parent / link))
            if normalized == '..' or normalized.startswith('../'):
                raise ValueError('Escaping source symlink: '+name)
            payload = link.encode()
        else:
            payload = source.read_bytes() if source is not None else data
        inputs[name] = dict(source=source, data=data, link=link, executable=executable, sha256=sha(payload), bytes=len(payload))

    for entry in sorted(set(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0'))):
        if not entry or '__pycache__' in Path(entry).parts or entry.endswith('.pyc'):
            continue
        source = root/entry
        if source.is_file() or source.is_symlink():
            add('repository/'+entry, source=source)

    def native(name, directory, prefix, expected=None):
        revision = git(directory, 'rev-parse', 'HEAD').decode().strip()
        if expected and revision != expected:
            raise ValueError('Unexpected dependency revision: '+name)
        patch = git(directory, 'diff', '--binary', 'HEAD', '--', '.')
        components[name] = dict(revision=revision, path=prefix, trackedPatchSha256=sha(patch))
        if patch:
            add('provenance/'+name.replace('/', '_')+'.patch', data=patch)
        for entry in git(directory, 'ls-files', '--stage', '-z').decode().split('\0'):
            if not entry:
                continue
            metadata, relative = entry.split('\t', 1)
            mode, object_id, stage = metadata.split()
            if stage != '0':
                raise ValueError('Unmerged dependency: '+name)
            if mode == '160000':
                native(name+'/'+relative, directory/relative, prefix+'/'+relative, object_id)
            else:
                add(prefix+'/'+relative, source=directory/relative)

    notices = app/'Contents/Resources/licenses'
    native_manifest = json.loads((notices/'NativeDependencies/manifest.json').read_text())
    for name, notice_name in [('mbedtls','MbedTLS'),('libdatachannel','libdatachannel'),('opus','Opus'),('spdlog','spdlog'),('cxxopts','cxxopts')]:
        native(name, native_build/'_deps'/(name+'-src'), 'native/'+name, native_manifest['components'][notice_name]['revision'])
    native('x264', native_build/'versus-x264-build-prefix/src/versus-x264-build', 'native/x264', 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55')

    source_text = (notices/'FFmpeg/sources.txt').read_text()
    archive_specs = [(deps/'downloads'/name, url, digest) for name,url,digest in
                     re.findall(r'([^\n]+\.tar\.(?:gz|xz))\nURL: ([^\n]+)\nSHA-256: ([0-9a-f]{64})', source_text)]
    if len(archive_specs) != 6:
        raise ValueError('Expected six FFmpeg/dependency source archives')
    qt_text = (notices/'Qt/source.txt').read_text()
    syphon_text = (notices/'Syphon/source.txt').read_text()
    for text, download in [(qt_text, True), (syphon_text, False)]:
        url = re.search(r'^Source: (.+)$', text, re.M)[1]
        digest = re.search(r'^SHA-256: ([0-9a-f]{64})$', text, re.M)[1]
        archive = deps/'downloads'/url.rsplit('/',1)[1] if download else deps/('syphon-'+re.search(r'^Revision: (.+)$', text, re.M)[1]+'.tar.gz')
        archive_specs.append((archive,url,digest))
    for archive, url, digest in archive_specs:
        if sha(archive.read_bytes()) != digest:
            raise ValueError('Source archive hash mismatch: '+archive.name)
        name = 'archives/'+archive.name
        add(name, source=archive)
        changed = []
        count = 0
        with tarfile.open(archive) as tar:
            for member in tar:
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts:
                    raise ValueError('Unsafe upstream archive entry')
                if not member.isfile():
                    continue
                count += 1
                source = deps/path
                if not source.is_file():
                    raise ValueError('Missing built dependency source: '+str(path))
                original = sha(tar.extractfile(member).read())
                actual = sha(source.read_bytes())
                if actual != original:
                    add('overrides/'+path.as_posix(), source=source)
                    changed.append(dict(path=path.as_posix(),originalSha256=original,sha256=actual))
        upstream.append(dict(archive=name,url=url,sha256=digest,sourceFilesCompared=count,overrides=changed))

    for source in sorted(notices.rglob('*')):
        if source.is_file():
            add('notices/'+source.relative_to(notices).as_posix(), source=source)
    # Preserve generated build configuration as evidence, not reusable absolute paths.
    for name in ['CMakeCache.txt','compile_commands.json']:
        add('provenance/application-'+name, source=build/name)
    offline = ['# Local source overrides; no FetchContent downloads.',
               'set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "" FORCE)']
    for name in ['mbedtls','libdatachannel','opus','spdlog','cxxopts']:
        offline.append(f'set(FETCHCONTENT_SOURCE_DIR_{name.upper()} "${{CMAKE_CURRENT_LIST_DIR}}/native/{name}" CACHE PATH "" FORCE)')
    offline.append('set(VERSUS_MAC_X264_SOURCE_ROOT "${CMAKE_CURRENT_LIST_DIR}/native/x264" CACHE PATH "" FORCE)')
    add('offline-native.cmake', data=('\n'.join(offline)+'\n').encode())
    readme = '''Game Capture Apple Silicon source/build materials

This source candidate binds the development app and its dependency sources.
It includes the working repository, recursively populated native dependency
sources, eight hash-checked upstream archives, local source overrides, notices,
recipes and the app build configuration. No Apple SDK, Xcode or tool binaries
are redistributed. Install Xcode/Metal tools, CMake, Ninja, pkg-config, Meson,
make and Python 3.12+ separately. Toolchain availability is a prerequisite.

From this extracted directory:
  python3 repository/native-qt/qa/prepare-macos-source.py --bundle .
  cd repository
  cmake -DQT_SDK=/path/to/MacOSX.sdk -P native-qt/cmake/build-qt-macos.cmake
  cmake -DFFMPEG_SDK=/path/to/MacOSX.sdk -P native-qt/cmake/build-ffmpeg-macos.cmake
  cmake -DSYPHON_SDK=/path/to/Xcode/MacOSX.sdk -P native-qt/cmake/build-syphon-macos.cmake
  cmake -C ../offline-native.cmake -S native-qt -B native-qt/build-macos-arm64 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_SYSROOT=/path/to/MacOSX.sdk -DCMAKE_PREFIX_PATH="$PWD/native-qt/build-macos-deps/qt-6.9.3"
  cmake --build native-qt/build-macos-arm64 --target macos-dev-bundle -j 2

Use the recorded SDK/compiler versions for closer reproduction. Absolute paths
in provenance are historical evidence; use paths appropriate to your machine.
Build gates are not application testing. A fresh rebuild, packaged workflows,
minimum-OS checks and release/legal review remain necessary before calling this
a qualified distribution. This archive is not a legal compliance certification
or a claim of bit-for-bit reproducibility. Do not substitute it for a source
archive bound to a different executable.
'''
    add('README.txt', data=readme.encode())
    # Bind every deployed Mach-O, including QtWidgets: its accessibility code
    # can change while the Qt Cocoa plugin and media helpers remain identical.
    magic = {bytes.fromhex(s) for s in ('feedface','cefaedfe','feedfacf','cffaedfe',
                                      'cafebabe','bebafeca','cafebabf','bfbafeca')}
    binaries = set()
    for candidate in app.rglob('*'):
        if not candidate.is_file():
            continue
        binary = candidate.resolve(strict=True)
        if not binary.is_relative_to(app):
            raise ValueError('Bundle file escapes application: '+str(candidate))
        with binary.open('rb') as stream:
            if stream.read(4) in magic:
                binaries.add(binary.relative_to(app).as_posix())
    if 'Contents/MacOS/game-capture' not in binaries:
        raise ValueError('Missing Mach-O application executable')
    manifest = dict(format=1, scope='Mac development source candidate; fresh rebuild/release qualification pending',
                    branch=git(root,'branch','--show-current').decode().strip(),baseCommit=git(root,'rev-parse','HEAD').decode().strip(),
                    binaries={p:sha((app/p).read_bytes()) for p in sorted(binaries)},nativeComponents=components,upstream=upstream,
                    files={n:{k:v[k] for k in ['sha256','bytes','link','executable']} for n,v in sorted(inputs.items())})
    add('manifest.json', data=(json.dumps(manifest,indent=2)+'\n').encode())
    # Normalize archive metadata; do not package Git credentials, build trees or QA recordings.
    with output.open('xb') as target, gzip.GzipFile(filename='',mode='wb',fileobj=target,mtime=0,compresslevel=3) as gz, tarfile.open(fileobj=gz,mode='w|') as tar:
        for name, item in sorted(inputs.items()):
            info = tarfile.TarInfo(name);info.mode=0o755 if item['executable'] else 0o644
            if item['link'] is not None:
                info.type=tarfile.SYMTYPE;info.linkname=item['link'];tar.addfile(info)
            else:
                data=item['source'].read_bytes() if item['source'] is not None else item['data']
                if sha(data)!=item['sha256']:
                    raise ValueError('Source changed while packaging: '+name)
                info.size=len(data);tar.addfile(info,io.BytesIO(data))
    receipt=dict(archive=output.name,sha256=sha(output.read_bytes()),bytes=output.stat().st_size,files=len(inputs),nativeRepositories=len(components),upstreamArchives=len(upstream),binaries=manifest['binaries'])
    output.with_suffix(output.suffix+'.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))


if __name__=='__main__':
    main()
