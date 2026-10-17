#!/usr/bin/env python3
"""Deployment gate, not application testing. Inspect every bundled Mach-O file."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def version(value):
    return tuple((list(map(int, value.split("."))) + [0, 0])[:3])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This gate requires Apple's macOS binary tools")
    app = args.app.resolve()
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    executable_dir = app / "Contents/MacOS"
    executable = executable_dir / info["CFBundleExecutable"]
    result = {"scope": "Static deployment gate; application/clean-machine testing excluded",
              "bundle_minimum_os": info["LSMinimumSystemVersion"], "files": [], "errors": [], "passed": False}
    qt_info = app / "Contents/Frameworks/QtCore.framework/Resources/Info.plist"
    if qt_info.is_file():
        result["qt_version"] = plistlib.loads(qt_info.read_bytes()).get("CFBundleVersion")
    errors = result["errors"]
    icon_name = info.get("CFBundleIconFile", "")
    try:
        if not isinstance(icon_name, str) or not icon_name or Path(icon_name).name != icon_name or not icon_name.endswith(".icns"):
            raise ValueError("Expected a bundle-relative .icns filename")
        icon = app / "Contents/Resources" / icon_name
        if not icon.resolve().is_relative_to(app):
            raise ValueError("Icon escapes the application")
        data = icon.read_bytes()
        if len(data) <= 8 or data[:4] != b"icns" or int.from_bytes(data[4:8], "big") != len(data):
            raise ValueError("Invalid icon container")
        result["application_icon"] = {"path": str(icon.relative_to(app)), "bytes": len(data),
                                      "sha256": hashlib.sha256(data).hexdigest()}
    except (OSError, ValueError) as error:
        errors.append("Cannot verify application icon: " + str(error))
    magic = {bytes.fromhex(s) for s in ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
    seen = set()
    try:
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", str(app))
        result["signature_verified"] = True
    except subprocess.CalledProcessError as error:
        errors.append("Signature verification failed: " + error.output)
    for candidate in sorted(app.rglob("*")):
        if candidate.is_symlink() and not candidate.resolve().is_relative_to(app):
            errors.append("Bundle symlink escapes the application: " + str(candidate.relative_to(app)))
            continue
        if not candidate.is_file():
            continue
        binary = candidate.resolve()
        if binary in seen:
            continue
        seen.add(binary)
        if not binary.is_relative_to(app):
            errors.append("Bundle symlink escapes the application: " + str(candidate.relative_to(app)))
            continue
        with binary.open("rb") as stream:
            if stream.read(4) not in magic:
                continue
        relative = str(binary.relative_to(app))
        commands = run("/usr/bin/otool", "-l", str(binary))
        rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset", commands)
        identity = re.findall(r"cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset", commands)
        minimum = re.findall(r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \S+\s+minos ([\d.]+)", commands)
        minimum += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)", commands)
        dependencies = [line.strip().split(" (compatibility version", 1)[0]
                        for line in run("/usr/bin/otool", "-L", str(binary)).splitlines()[1:]]
        dependencies = [dep for dep in dependencies if dep not in identity]
        entry = {"path": relative, "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                 "architectures": run("/usr/bin/lipo", "-archs", str(binary)).split(),
                 "minimum_os": minimum, "rpaths": rpaths, "identity": identity, "dependencies": dependencies}
        result["files"].append(entry)
        if entry["architectures"] != ["arm64"]:
            errors.append(relative + ": expected arm64 only")
        if not minimum or any(version(v) > version(result["bundle_minimum_os"]) for v in minimum):
            errors.append(relative + ": missing or excessive minimum OS " + str(minimum))
        for value in rpaths + identity:
            if value.startswith("/"):
                errors.append(relative + ": absolute install/search path " + value)

    executable_rpaths = next((f["rpaths"] for f in result["files"] if app / f["path"] == executable.resolve()), [])

    def expand(value, loader):
        return Path(value.replace("@loader_path", str(loader)).replace("@executable_path", str(executable_dir))).resolve()

    for entry in result["files"]:
        loader = (app / entry["path"]).parent
        for dep in entry["dependencies"]:
            if dep.startswith(("/System/Library/", "/usr/lib/")):
                continue
            if dep.startswith("@rpath/"):
                roots = [expand(value, loader) for value in entry["rpaths"]]
                roots += [expand(value, executable_dir) for value in executable_rpaths]
                paths = [(root / dep[len("@rpath/"):]).resolve() for root in roots]
            else:
                paths = [expand(dep, loader)]
            if dep.startswith("/") or not any(p.is_relative_to(app) and p.is_file() for p in paths):
                errors.append(entry["path"] + ": unresolved or external dependency " + dep)
    if not result["files"]:
        errors.append("No Mach-O files found")
    notices = app / "Contents/Resources/licenses/NativeDependencies"
    try:
        manifest = json.loads((notices / "manifest.json").read_text())
        expected = {"MbedTLS", "libdatachannel", "Opus", "spdlog", "cxxopts", "libjuice",
                    "libsrtp", "usrsctp", "plog", "nlohmann-json", "QtBase"}
        if set(manifest["components"]) != expected:
            errors.append("Native dependency notice inventory is incomplete")
        if manifest.get("qtVersion") != result.get("qt_version"):
            errors.append("Qt notice inventory version differs from the bundled framework")
        files = manifest["files"]
        if not isinstance(files, dict) or not files:
            raise ValueError("empty notice manifest")
        for relative, digest in files.items():
            target = (notices / relative).resolve()
            if not target.is_relative_to(notices) or not target.is_file() or not re.fullmatch(r"[a-f0-9]{64}", digest):
                errors.append("Invalid notice manifest entry: " + relative)
            elif hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                errors.append("Notice hash mismatch: " + relative)
        for component in expected:
            if not any(name.startswith(component + "/") for name in files):
                errors.append("No notice files for " + component)
        result["notice_inventory"] = {"components": len(manifest["components"]), "files": len(files),
                                      "qt_attributions": manifest["components"]["QtBase"].get("attributionCount", 0)}
    except (OSError, ValueError, KeyError, TypeError) as error:
        errors.append("Cannot verify native dependency notices: " + str(error))
    syphon = app / "Contents/Frameworks/Syphon.framework/Syphon"
    if syphon.exists():
        provenance = app / "Contents/Resources/licenses/Syphon"
        archive = provenance / "syphon-f4761677a45b8034a3c2069ec0f3d2553da81fba.tar.gz"
        try:
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            if digest != "a3766088c46588c42b087f4e5ff7ae7bb0f83292af59a0aeb8bba69eba5311c5":
                errors.append("Syphon pinned source archive hash mismatch")
            for name in ["source.txt", "build-syphon-macos.cmake", "source-headers/Syphon.h"]:
                if not (provenance / name).is_file():
                    errors.append("Missing Syphon provenance: " + name)
            result["syphon_source_sha256"] = digest
        except OSError as error:
            errors.append("Missing Syphon corresponding source archive: " + str(error))
    result["passed"] = not errors
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "binaries": len(result["files"]), "errors": errors, "report": str(args.report)}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
