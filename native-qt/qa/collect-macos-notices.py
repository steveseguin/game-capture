#!/usr/bin/env python3
"""Collect source notices before bundle signing; this is not a source distribution."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", action="append", default=[], help="NAME=SOURCE_DIRECTORY")
    parser.add_argument("--qt-source", type=Path, required=True)
    parser.add_argument("--qt-version", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    roots = {}
    for item in args.component:
        name, separator, directory = item.partition("=")
        if not separator or name in roots:
            parser.error("Each component must have a unique NAME=SOURCE_DIRECTORY")
        roots[name] = Path(directory).resolve(strict=True)
    required = {"MbedTLS": "LICENSE", "libdatachannel": "LICENSE", "Opus": "COPYING",
                "spdlog": "LICENSE", "cxxopts": "LICENSE"}
    if set(roots) != set(required):
        parser.error("Expected source roots for " + ", ".join(required))
    for name, subdir, license_file in (("libjuice", "libjuice", "LICENSE"),
                                    ("libsrtp", "libsrtp", "LICENSE"),
                                    ("usrsctp", "usrsctp", "LICENSE.md"),
                                    ("plog", "plog", "LICENSE"),
                                    ("nlohmann-json", "json", "LICENSE.MIT")):
        roots[name] = (roots["libdatachannel"] / "deps" / subdir).resolve(strict=True)
        required[name] = license_file
    qt = args.qt_source.resolve(strict=True)
    version = re.search(r'set\(QT_REPO_MODULE_VERSION\s+"([^"]+)"\)', (qt / ".cmake.conf").read_text())
    if not version or version[1] != args.qt_version:
        parser.error("Qt notice source version does not match the linked Qt version")
    roots["QtBase"] = qt
    output = args.output.resolve()
    # A packaging error must not overwrite a dependency/source tree.
    if any(output == root or output.is_relative_to(root) or root.is_relative_to(output) for root in roots.values()):
        parser.error("Notice output must be separate from dependency sources")
    if output.exists() and any(output.iterdir()):
        parser.error("Use a fresh notice output directory")
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"scope": "Source notices for native dependencies; Qt includes its complete src attribution inventory, including components not linked on Mac. Not a complete corresponding-source archive or legal compliance certification.",
                "qtVersion": args.qt_version, "components": {}, "files": {}}

    def copy(name, source):
        root = roots[name]
        source = source.resolve(strict=True)
        if not source.is_file() or not source.is_relative_to(root):
            raise RuntimeError("Notice path escapes its source root: " + str(source))
        if source.stat().st_size > 8 * 1024 * 1024:
            raise RuntimeError("Unexpectedly large notice: " + str(source))
        relative = Path(name) / source.relative_to(root)
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        manifest["files"][relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()

    for name, license_file in required.items():
        root = roots[name]
        copy(name, root / license_file)  # Missing mandatory text fails packaging.
        for source in root.iterdir():
            if source.is_file() and re.match(r"^(licen[cs]e|copying|copyright|notice|authors)([._-]|$)", source.name, re.I):
                copy(name, source)
        revision = None
        if (root / ".git").exists():
            revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        manifest["components"][name] = {"revision": revision, "primaryNotice": license_file}
    # These Mbed TLS subcomponents retain notices inline in their small source
    # files, rather than separate LICENSE files. Preserve those files verbatim.
    for subdir in ("everest", "p256-m"):
        directory = roots["MbedTLS"] / "3rdparty" / subdir
        if not directory.is_dir():
            raise RuntimeError("Missing Mbed TLS notice source: " + subdir)
        for source in directory.rglob("*"):
            if source.is_file() and source.suffix.lower() in (".c", ".h", ".md", ".txt"):
                copy("MbedTLS", source)

    for source in (qt / "LICENSES").iterdir():
        if source.is_file():
            copy("QtBase", source)
    attributions = []
    for source in sorted((qt / "src").rglob("qt_attribution.json")):
        copy("QtBase", source)
        # Upstream metadata includes literal control characters in a few
        # descriptions. Preserve the originals, while parsing their fields.
        data = json.loads(source.read_text(), strict=False)
        for entry in data if isinstance(data, list) else [data]:
            files = list(entry.get("LicenseFiles", []))
            files += [entry[key] for key in ("LicenseFile", "CopyrightFile") if entry.get(key)]
            if not files:
                ids = re.findall(r"[A-Za-z0-9.+-]+", entry.get("LicenseId", ""))
                ids = [value for value in ids if value not in ("AND", "OR", "WITH")]
                if not ids:
                    raise RuntimeError("No license evidence for Qt attribution " + entry.get("Id", "unknown"))
                for value in ids:
                    copy("QtBase", qt / "LICENSES" / (value + ".txt"))
            for filename in files:
                copy("QtBase", source.parent / filename)
            attributions.append({"source": source.relative_to(qt).as_posix(), **entry})
    if not attributions:
        raise RuntimeError("Qt source has no attribution inventory")
    manifest["components"]["QtBase"] = {"version": args.qt_version, "attributionCount": len(attributions)}
    (output / "QtBase/attributions.json").write_text(json.dumps(attributions, ensure_ascii=False, indent=2) + "\n")
    manifest["files"]["QtBase/attributions.json"] = hashlib.sha256((output / "QtBase/attributions.json").read_bytes()).hexdigest()
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "README.txt").write_text(
        "Native dependency notices\n\n" + manifest["scope"] + "\n\n"
        "Original notice texts and Qt attribution metadata are preserved under component directories. "
        "manifest.json records their hashes and dependency revisions where available. "
        "Mbed TLS inline notices are retained with the affected source files. "
        "Game Capture, x264, Qt build provenance and the FFmpeg helper's notices are in the parent licenses directory. "
        "Distribution still requires the matching full source and build materials, plus release qualification.\n")
    print(json.dumps({"components": len(manifest["components"]), "noticeFiles": len(manifest["files"]), "qtAttributions": len(attributions)}))


if __name__ == "__main__":
    main()
