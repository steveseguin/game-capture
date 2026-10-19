#!/usr/bin/env python3
"""Create a distribution-dependent Ubuntu DEB and extracted E2E payload.

Run from any directory: python3 native-qt/qa/package-linux.py --build native-qt/build-linux
The package uses Ubuntu libraries and FFmpeg; it is not a self-contained binary.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def native_architecture(binary):
    """Reject cross-built/mislabelled payloads before using host shlibdeps."""
    architecture = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    if architecture not in ("amd64", "arm64"):
        raise SystemExit(f"Unsupported Linux package architecture: {architecture}")
    with binary.open("rb") as stream:
        header = stream.read(64)
    # ELF64, little endian, current ELF version; ET_EXEC or PIE (ET_DYN).
    if (len(header) != 64 or header[:7] != b"\x7fELF\x02\x01\x01"
            or int.from_bytes(header[16:18], "little") not in (2, 3)):
        raise SystemExit("Package payload must be a little-endian ELF64 executable")
    machine = int.from_bytes(header[18:20], "little")
    expected = {"amd64": 62, "arm64": 183}[architecture]
    if machine != expected:
        raise SystemExit(f"ELF machine {machine} does not match native {architecture}; "
                         "build and package in the target architecture's environment")
    return architecture


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    native = root / "native-qt"
    build = args.build.resolve()
    binary = build / "bin/game-capture"
    if not binary.is_file():
        raise SystemExit("Build game-capture first")
    architecture = native_architecture(binary)
    version = re.search(r"project\(game-capture-native-qt VERSION ([0-9.]+)", (native / "CMakeLists.txt").read_text())[1]
    # Increment the Linux package revision for installation-layout changes.
    version += "~linux.2"
    output = (args.output or native / "dist").resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Refuse to overwrite an evidence-bearing payload; each package is immutable.
    files = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    source_files = sorted({entry for entry in files.decode().split("\0") if entry and (root / entry).is_file()})
    source_digest = hashlib.sha256()
    for entry in source_files:
        source_digest.update(entry.encode() + b"\0" + bytes.fromhex(sha(root / entry)))
    source_identity = source_digest.hexdigest()
    identity = sha(binary)[:12] + "-" + source_identity[:12]
    destination = output / f"game-capture-{version}-{architecture}-{identity}"
    if destination.exists():
        raise SystemExit(f"Package directory already exists: {destination}")
    with tempfile.TemporaryDirectory(prefix="gc-package-") as temporary:
        work = Path(temporary)
        stage = work / "payload"
        (stage / "usr/bin").mkdir(parents=True)
        shutil.copy2(binary, stage / "usr/bin/game-capture")
        notices = stage / "usr/share/doc/game-capture"
        notices.mkdir(parents=True)
        shutil.copy2(root / "LICENSE", notices / "copyright")
        shutil.copy2(native / "qa/linux-parity.json", notices / "linux-parity.json")
        qualification = "development; see linux-parity.json"
        if architecture == "arm64":
            shutil.copy2(native / "qa/linux-arm64.json", notices / "linux-arm64.json")
            qualification = "experimental ARM64; see linux-arm64.json and linux-parity.json"
        desktop = stage / "usr/share/applications/game-capture.desktop"
        desktop.parent.mkdir(parents=True)
        desktop.write_text("[Desktop Entry]\nType=Application\nName=Game Capture\nComment=Publish windows and cameras to VDO.Ninja and OBS\nExec=game-capture\nIcon=game-capture\nTerminal=false\nCategories=AudioVideo;Video;Network;\nStartupWMClass=game-capture\n")
        icon = stage / "usr/share/icons/hicolor/256x256/apps/game-capture.png"
        icon.parent.mkdir(parents=True)
        shutil.copy2(native / "resources/vdoninja.png", icon)
        debian = work / "debian"
        debian.mkdir()
        (debian / "control").write_text(f"Source: game-capture\nSection: video\nPriority: optional\nMaintainer: Game Capture contributors <noreply@vdo.ninja>\n\nPackage: game-capture\nArchitecture: {architecture}\nDescription: Native Game Capture Linux development package\n")
        dependencies = subprocess.check_output(["dpkg-shlibdeps", "-O", "-e" + str(stage / "usr/bin/game-capture")], cwd=work, text=True).strip()
        dependencies = dependencies.removeprefix("shlibs:Depends=")
        dependencies += ", ffmpeg (>= 7:6.1), qt6-wayland, xdg-desktop-portal, pipewire, ca-certificates"
        control = stage / "DEBIAN"
        control.mkdir()
        (control / "control").write_text(f"Package: game-capture\nVersion: {version}\nArchitecture: {architecture}\nMaintainer: Game Capture contributors <noreply@vdo.ninja>\nSection: video\nPriority: optional\nDepends: {dependencies}\nRecommends: gnome-keyring\nDescription: Native Game Capture for Linux (development)\n Linux parity qualification remains in progress; see linux-parity.json.\n")
        # Preserve notices for all statically linked fetched dependencies.
        materials = []
        for dependency in sorted((build / "_deps").glob("*-src")):
            revision = subprocess.check_output(["git", "-C", str(dependency), "rev-parse", "HEAD"], text=True).strip()
            licenses = []
            for file in sorted(dependency.rglob("*")):
                if file.is_file() and file.name.lower().startswith(("license", "copying")) and ".git" not in file.parts:
                    target = notices / "licenses" / dependency.name / file.relative_to(dependency)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(file, target)
                    licenses.append(str(target.relative_to(notices)))
            materials.append({"name": dependency.name, "revision": revision, "licenses": licenses})
        revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        # Include exact tracked and untracked source files, excluding ignored build/data artifacts.
        source = work / "source"
        for entry in source_files:
            target = source / entry
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / entry, target)
        source_archive = output / (destination.name + "-source.tar.gz")
        subprocess.run(["tar", "-czf", str(source_archive), "-C", str(source), "."], check=True)
        payload = [{"relativePath": str(p.relative_to(stage)), "sha256": sha(p), "size": p.stat().st_size}
                   for p in sorted(stage.rglob("*")) if p.is_file()]
        manifest = {"schema": 1, "version": version, "architecture": architecture,
                    "sourceRevision": revision, "sourceTreeSha256": source_identity, "sourceArchive": source_archive.name,
                    "sourceSha256": sha(source_archive), "buildDirectory": str(build),
                    "artifact": {"path": "usr/bin/game-capture", "sha256": sha(binary)},
                    "dependencies": dependencies, "materials": materials,
                    "qualification": qualification, "payload": {"files": payload, "fileCount": len(payload)}}
        installed_manifest = notices / "release-artifact-manifest.json"
        installed_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
        # Never inherit the builder's umask or group-write bits into system
        # directories and data files installed by dpkg.
        stage.chmod(0o755)
        for item in stage.rglob("*"):
            item.chmod(0o755 if item.is_dir() or item == stage / "usr/bin/game-capture" else 0o644)
        archive = output / (destination.name + ".deb")
        subprocess.run(["dpkg-deb", "--root-owner-group", "--build", str(stage), str(archive)], check=True, stdout=sys.stderr)
        destination.mkdir()
        subprocess.run(["dpkg-deb", "--extract", str(archive), str(destination)], check=True)
        # Preserve the existing extracted-artifact QA interface without
        # installing a generic metadata file into the filesystem root.
        shutil.copy2(destination / "usr/share/doc/game-capture/release-artifact-manifest.json",
                     destination / "release-artifact-manifest.json")
        # DEBIAN metadata is not in an extracted runtime payload.
        for item in payload:
            if item["relativePath"].startswith("DEBIAN/"):
                target = destination / item["relativePath"]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(stage / item["relativePath"], target)
        print(json.dumps({"package": str(archive), "sha256": sha(archive), "payload": str(destination),
                          "manifestSha256": sha(destination / "release-artifact-manifest.json")}, indent=2))


if __name__ == "__main__":
    main()
