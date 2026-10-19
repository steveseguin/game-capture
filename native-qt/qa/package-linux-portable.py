#!/usr/bin/env python3
"""Bundle a native Linux build made on Ubuntu 22.04 (glibc <= 2.35).

No host loader, libc, C++ runtime or GPU drivers are bundled. Library RPATHs,
Qt plugins and PipeWire client modules are private to the extracted archive.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def output(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


# These belong to the host ABI/driver stack. Keep the C++ runtime on the host
# too: newer Mesa/NVIDIA components may require newer symbols than our build.
HOST = re.compile(r"^(?:ld-linux.*|lib(?:c|m|dl|pthread|rt|resolv|util|anl|nss_[^.]+|"
                  r"stdc\+\+|gcc_s|GL[^.]*|EGL|GLES[^.]*|OpenGL|glapi|gbm|drm[^.]*|"
                  r"vulkan|LLVM[^.]*))\.so(?:\..*)?$")


def abi_versions(path):
    symbols = output('readelf', '--version-info', str(path))
    versions = {}
    for family in ('GLIBC', 'GLIBCXX'):
        values = [tuple(map(int, v.split('.'))) for v in re.findall(r'\b'+family+r'_([0-9.]+)', symbols)]
        if values:
            versions[family] = max(values)
    return versions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', required=True, type=Path)
    parser.add_argument('--ffmpeg-prefix', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    native = root/'native-qt'
    build = args.build.resolve(); ffmpeg = args.ffmpeg_prefix.resolve()
    binary = build/'bin/game-capture'
    cache = (build/'CMakeCache.txt').read_text()
    if 'VERSUS_LINUX_PORTABLE:BOOL=ON' not in cache:
        raise SystemExit('Configure with -DVERSUS_LINUX_PORTABLE=ON to select portable updates')
    spec = importlib.util.spec_from_file_location('deb_packager', Path(__file__).with_name('package-linux.py'))
    deb = importlib.util.module_from_spec(spec); spec.loader.exec_module(deb)
    architecture = deb.native_architecture(binary)
    if output('getconf', 'GNU_LIBC_VERSION') != 'glibc 2.35':
        raise SystemExit('Build/package on the Ubuntu 22.04 glibc 2.35 baseline')
    multiarch = output('dpkg-architecture', '-qDEB_HOST_MULTIARCH')
    system_lib = Path('/usr/lib')/multiarch
    plugins = system_lib/'qt6/plugins'
    destination = (args.output or native/'dist').resolve()
    destination.mkdir(parents=True, exist_ok=True)
    version = re.search(r'project\(game-capture-native-qt VERSION ([0-9.]+)', (native/'CMakeLists.txt').read_text())[1]+'~linux.2'
    source_files = sorted(set(output('git', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0')))
    source_files = [p for p in source_files if p and (root/p).is_file()]
    source_revision = output('git', '-C', str(root), 'rev-parse', 'HEAD')
    environment = dict(os.environ, LD_LIBRARY_PATH=str(ffmpeg/'lib'))
    ffmpeg_version = output(str(ffmpeg/'bin/ffmpeg'), '-version', env=environment)
    if '--enable-nonfree' in ffmpeg_version:
        raise SystemExit('Nonfree FFmpeg builds are not supported in portable packages')
    for feature in ('--enable-libx264', '--enable-libvpx', '--enable-libaom', '--enable-libsrt', '--enable-librist'):
        if feature not in ffmpeg_version:
            raise SystemExit('Rebuild the pinned portable FFmpeg: missing '+feature)
    with tempfile.TemporaryDirectory(prefix='gc-portable-') as temporary:
        work = Path(temporary); stage = work/'payload'
        # Hash the exact bytes we archive. Packaging may take several minutes;
        # rereading the working tree later can silently mislabel the source.
        source = work/'source'
        source_digest = hashlib.sha256()
        for name in source_files:
            data = (root/name).read_bytes()
            target = source/name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data); shutil.copystat(root/name, target)
            source_digest.update(name.encode()+b'\0'+hashlib.sha256(data).digest())
        source_identity = source_digest.hexdigest()
        libraries = stage/'usr/lib/game-capture'
        libraries.mkdir(parents=True)
        notices = stage/'usr/share/doc/game-capture'; notices.mkdir(parents=True)
        seeds = []; origins = {}; host = {}; materials = {}

        def copy(src, relative):
            target = stage/relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            if target.read_bytes()[:4] == b'\x7fELF':
                deb.native_architecture(target)
                seeds.append(target); origins[target] = Path(src).resolve()
            return target

        executable = copy(binary, 'usr/bin/game-capture')
        copy(ffmpeg/'bin/ffmpeg', 'usr/lib/game-capture/ffmpeg')
        copy(ffmpeg/'bin/ffprobe', 'usr/lib/game-capture/ffprobe')
        for group in ('platforms', 'xcbglintegrations', 'imageformats', 'platforminputcontexts', 'tls',
                      'wayland-decoration-client', 'wayland-graphics-integration-client', 'wayland-shell-integration'):
            for plugin in sorted((plugins/group).glob('*.so')):
                copy(plugin, f'usr/plugins/{group}/{plugin.name}')
        for required in ('platforms/libqxcb.so', 'platforms/libqwayland-generic.so', 'tls/libqopensslbackend.so'):
            if not (stage/'usr/plugins'/required).is_file():
                raise SystemExit('Missing Qt plugin: '+required)
        for directory in ('pipewire-0.3', 'spa-0.2'):
            for module in sorted((system_lib/directory).rglob('*.so')):
                copy(module, Path('usr/lib')/directory/module.relative_to(system_lib/directory))
        if not (stage/'usr/lib/spa-0.2/support/libspa-support.so').is_file():
            raise SystemExit('Install libspa-0.2-modules before packaging')
        if not (stage/'usr/lib/pipewire-0.3/libpipewire-module-protocol-native.so').is_file():
            raise SystemExit('Install libpipewire-0.3-modules before packaging')
        shutil.copytree('/usr/share/pipewire', stage/'usr/share/pipewire')
        (stage/'usr/lib/gio/modules').mkdir(parents=True)

        seen = set()
        for seed in seeds:  # copy() extends this queue with dependencies
            origin = origins[seed]
            if origin in seen: continue
            seen.add(origin)
            dependencies = output('ldd', str(origin), env=environment)
            if 'not found' in dependencies:
                raise SystemExit('Unresolved build dependency: '+str(origin)+'\n'+dependencies)
            for name, path in re.findall(r'^\s*(\S+) => (/\S+) \(', dependencies, re.M):
                if HOST.fullmatch(name):
                    host[name] = 'host ABI or GPU driver'; continue
                target = libraries/name
                if target.exists():
                    if sha(target) != sha(path):
                        raise SystemExit('Conflicting dependency: '+name)
                else:
                    copy(path, Path('usr/lib/game-capture')/name)

        maxima = {}
        for file, origin in origins.items():
            for family, required in abi_versions(file).items():
                maxima[family] = max(maxima.get(family, (0,)), required)
            # DT_RPATH is inherited by dlopen/transitive dependencies. Avoid
            # exporting LD_LIBRARY_PATH into browsers or other host programs.
            relative = os.path.relpath(libraries, file.parent)
            rpath = '$ORIGIN' if relative == '.' else '$ORIGIN/'+relative
            subprocess.run(['patchelf', '--force-rpath', '--set-rpath', rpath, str(file)], check=True)
            if origin.is_relative_to(ffmpeg) or origin == binary: continue
            try:
                owner = output('dpkg-query', '-S', str(origin)).split(': ', 1)[0]
            except subprocess.CalledProcessError:
                alternate = str(origin).removeprefix('/usr') if str(origin).startswith('/usr/lib/') else '/usr'+str(origin)
                owner = output('dpkg-query', '-S', alternate).split(': ', 1)[0]
            if owner in materials: continue
            info = output('dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}', owner).split('\t')
            copyright_file = Path('/usr/share/doc')/owner.split(':')[0]/'copyright'
            if not copyright_file.is_file():
                raise SystemExit('Missing dependency copyright: '+owner)
            copy(copyright_file, Path('usr/share/doc/game-capture/licenses')/owner/'copyright')
            materials[owner] = dict(zip(('package', 'version', 'sourcePackage', 'sourceVersion'), info))
        if maxima.get('GLIBC', (0,)) > (2, 35) or maxima.get('GLIBCXX', (0,)) > (3, 4, 30):
            raise SystemExit('Bundle exceeds baseline ABI: '+str(maxima))
        (stage/'usr/bin/qt.conf').write_text('[Paths]\nPrefix=..\nPlugins=plugins\nLibraries=lib/game-capture\n')
        launcher = stage/'AppRun'
        machine = {'arm64':'aarch64', 'amd64':'x86_64'}[architecture]
        launcher.write_text('''#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -m)" != "@MACHINE@" ]; then
    echo 'This Game Capture package requires @MACHINE@ Linux.' >&2; exit 1
fi
libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
case "$libc" in
    'glibc 2.'*) minor=${libc#glibc 2.}; minor=${minor%%.*}
        if [ "$minor" -lt 35 ]; then echo 'Game Capture requires glibc 2.35 or newer.' >&2; exit 1; fi ;;
    *) echo 'Game Capture requires a glibc-based Linux system (2.35 or newer).' >&2; exit 1 ;;
esac
unset LD_LIBRARY_PATH QT_PLUGIN_PATH QT_QPA_PLATFORM_PLUGIN_PATH GIO_EXTRA_MODULES
export PIPEWIRE_CONFIG_DIR="$base/usr/share/pipewire"
export PIPEWIRE_MODULE_DIR="$base/usr/lib/pipewire-0.3"
export SPA_PLUGIN_DIR="$base/usr/lib/spa-0.2"
export GIO_MODULE_DIR="$base/usr/lib/gio/modules"
exec "$base/usr/bin/game-capture" "$@"
'''.replace('@MACHINE@', machine))
        launcher.chmod(0o755)
        copy(root/'LICENSE', 'usr/share/doc/game-capture/copyright')
        for ledger in ('linux-parity.json', 'linux-arm64.json', 'linux-portable.json'):
            copy(native/'qa'/ledger, 'usr/share/doc/game-capture/'+ledger)
        static_materials = []
        for dependency in sorted((build/'_deps').glob('*-src')):
            revision = output('git', '-C', str(dependency), 'rev-parse', 'HEAD')
            static_materials.append({'name': dependency.name, 'revision': revision})
            for file in sorted(dependency.rglob('*')):
                if file.is_file() and file.name.lower().startswith(('license', 'copying')) and '.git' not in file.parts:
                    copy(file, Path('usr/share/doc/game-capture/licenses')/dependency.name/file.relative_to(dependency))
        ffmpeg_source = next((ffmpeg/'source').glob('ffmpeg-*.tar.xz'))
        custom_sources = []
        for archive_source in sorted((ffmpeg/'source').glob('*.tar.*')):
            copy(archive_source, 'usr/share/doc/game-capture/sources/'+archive_source.name)
            custom_sources.append({'name': archive_source.name, 'sha256': sha(archive_source)})
        (notices/'ffmpeg-build.txt').write_text(ffmpeg_version+'\n')
        for file in sorted((ffmpeg/'source').glob('ffmpeg-*/COPYING*')):
            copy(file, 'usr/share/doc/game-capture/licenses/ffmpeg/'+file.name)
        copy(ffmpeg/'source/librist-v0.2.20/COPYING', 'usr/share/doc/game-capture/licenses/librist/COPYING')
        (stage/'README.txt').write_text('Extract the entire archive, then run ./AppRun. No installation or FUSE required.\n'
            'Experimental Linux '+architecture+'; glibc >= 2.35, GLIBCXX >= 3.4.30.\n'
            'Requires a working X11 or Wayland desktop, host OpenGL/EGL drivers, and PulseAudio or PipeWire-Pulse for audio.\n'
            'Wayland capture also requires a working ScreenCast portal and PipeWire service.\n'
            'Do not copy usr/bin/game-capture out of this directory. See docs/linux-portable.md in the source archive.\n')
        payload = [{'relativePath': str(p.relative_to(stage)), 'sha256': sha(p), 'size': p.stat().st_size}
                   for p in sorted(stage.rglob('*')) if p.is_file()]
        payload_digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        name = f'game-capture-{version}-{architecture}-{payload_digest[:12]}-{source_identity[:12]}-portable'
        final = destination/name
        archive = destination/(name+'.tar.gz')
        if final.exists() or archive.exists(): raise SystemExit('Refusing to overwrite '+str(final))
        source_archive = destination/(name+'-source.tar.gz')
        subprocess.run(['tar', '-czf', str(source_archive), '-C', str(source), '.'], check=True)
        manifest = {'schema': 1, 'version': version, 'architecture': architecture, 'packageFormat': 'portable-tar',
            'launcher': 'AppRun', 'sourceRevision': source_revision,
            'sourceTreeSha256': source_identity, 'sourceArchive': source_archive.name, 'sourceSha256': sha(source_archive),
            'artifact': {'path': 'usr/bin/game-capture', 'sha256': sha(executable)},
            'buildDirectory': str(build), 'buildOS': Path('/etc/os-release').read_text(),
            'abiRequirements': {k:'.'.join(map(str,v)) for k,v in maxima.items()}, 'hostLibraries': host,
            'materials': list(materials.values()), 'staticMaterials': static_materials,
            'ffmpeg': {'version': ffmpeg_version, 'sourceSha256': sha(ffmpeg_source), 'customSources': custom_sources},
            'qualification': 'experimental; see Linux ARM64 and portable evidence ledgers',
            'payload': {'files': payload, 'fileCount': len(payload)}}
        (stage/'release-artifact-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
        stage.rename(work/name)
        subprocess.run(['tar', '-czf', str(archive), '-C', str(work), name], check=True)
        # Observe the actual archive bytes, not the pre-archive staging tree.
        subprocess.run(['tar', '-xzf', str(archive), '-C', str(destination)], check=True)
        print(json.dumps({'package': str(archive), 'sha256': sha(archive), 'payload': str(final),
                          'manifestSha256': sha(final/'release-artifact-manifest.json')}, indent=2))


if __name__ == '__main__':
    main()
