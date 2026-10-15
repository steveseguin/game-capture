#!/usr/bin/env python3
"""Offline Git secret guards. Installation alone downloads the pinned scanner."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "8.30.1"
ARCHIVES = {
    ("Windows", "x64"): ("zip", "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e"),
    ("Windows", "arm64"): ("zip", "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f"),
    ("Linux", "x64"): ("tar.gz", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"),
    ("Linux", "arm64"): ("tar.gz", "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"),
    ("Darwin", "x64"): ("tar.gz", "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"),
    ("Darwin", "arm64"): ("tar.gz", "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"),
}
CACHE = ROOT / ".tools" / "gitleaks" / VERSION
EXE = CACHE / ("gitleaks.exe" if os.name == "nt" else "gitleaks")


def git(*args, check=True):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if check and result.returncode:
        raise RuntimeError("Git command failed: " + args[0])
    return result


def install(archive):
    existing = git("config", "--get", "core.hooksPath", check=False)
    hooks = existing.stdout.decode().strip()
    if hooks and hooks != ".githooks":
        raise RuntimeError("Existing core.hooksPath was preserved; integrate the secret checks with those hooks manually.")
    default_hooks = Path(git("rev-parse", "--git-path", "hooks").stdout.decode().strip())
    if not default_hooks.is_absolute():
        default_hooks = ROOT / default_hooks
    if not hooks and any((default_hooks / name).is_file() for name in ("pre-commit", "pre-push")):
        raise RuntimeError("Existing Git hooks were preserved; integrate the secret checks manually.")
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    key = (platform.system(), arch)
    if key not in ARCHIVES:
        raise RuntimeError("Unsupported scanner platform: " + str(key))
    extension, expected = ARCHIVES[key]
    filename = f"gitleaks_{VERSION}_{key[0].lower()}_{arch}.{extension}"
    if archive:
        payload = Path(archive).read_bytes()
    else:
        url = f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{filename}"
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = response.read(32 * 1024 * 1024 + 1)
        if len(payload) > 32 * 1024 * 1024:
            raise RuntimeError("Scanner download exceeded its size limit")
    if hashlib.sha256(payload).hexdigest() != expected:
        raise RuntimeError("Scanner archive SHA-256 mismatch; nothing was installed")
    # Extract only the expected executable; never trust archive paths or links.
    if extension == "zip":
        with zipfile.ZipFile(io.BytesIO(payload)) as package:
            executable = package.read(EXE.name)
    else:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as package:
            member = package.getmember(EXE.name)
            if not member.isfile():
                raise RuntimeError("Scanner archive does not contain a regular executable")
            executable = package.extractfile(member).read()
    CACHE.mkdir(parents=True, exist_ok=True)
    temporary = EXE.with_suffix(".new")
    temporary.write_bytes(executable)
    temporary.chmod(0o755)
    temporary.replace(EXE)
    for name in ("pre-commit", "pre-push", "run-secret-check"):
        (ROOT / ".githooks" / name).chmod(0o755)
    git("config", "--local", "core.hooksPath", ".githooks")
    print(f"Installed Gitleaks {VERSION} and local commit/push guards. Scans use no network or GitHub Actions.")
    return 0


def sensitive_path(path):
    name = Path(path).name.lower()
    if name in (".env.example", ".env.sample", ".env.template"):
        return False
    return (name == ".env" or name.startswith(".env.")
            or Path(name).suffix in (".pfx", ".p12", ".pem", ".key")
            or name in ("id_rsa", "id_ed25519", "id_ecdsa", ".netrc", ".npmrc"))


def scan(mode):
    if not EXE.is_file():
        raise RuntimeError("Scanner missing. Run: python tools/secret_scan.py install")
    version = subprocess.run([str(EXE), "version"], capture_output=True, text=True)
    if version.returncode or version.stdout.strip() != VERSION:
        raise RuntimeError("Scanner version mismatch. Re-run the local installer.")
    if mode == "staged":
        raw = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").stdout
        paths = raw.decode("utf-8", errors="replace").split("\0")
    else:
        raw = git("log", "--all", "--full-history", "-m", "--format=", "--name-only", "-z").stdout
        paths = [p.strip("\r\n") for p in raw.decode("utf-8", errors="replace").split("\0")]
    blocked = sorted({p for p in paths if p and sensitive_path(p)})
    if blocked:
        print("Sensitive local file names cannot be committed or pushed:", file=sys.stderr)
        for path in blocked:
            print("  " + json.dumps(path), file=sys.stderr)
        return 1
    env = os.environ.copy()
    env.pop("GITLEAKS_CONFIG", None)
    env.pop("GITLEAKS_CONFIG_TOML", None)
    with tempfile.TemporaryDirectory(prefix="local-secret-check-") as directory:
        report = Path(directory) / "redacted.json"
        ignore = Path(directory) / "empty-ignore"
        ignore.touch()
        args = [str(EXE), "git", str(ROOT), "--config=" + str(ROOT / ".gitleaks.toml"),
                "--redact=100", "--ignore-gitleaks-allow", "--gitleaks-ignore-path=" + str(ignore),
                "--report-format=json", "--report-path=" + str(report), "--no-banner", "--no-color"]
        args += ["--staged"] if mode == "staged" else ["--log-opts=--all --full-history -m"]
        result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True)
        if result.returncode not in (0, 1) or not report.is_file():
            raise RuntimeError("Gitleaks could not complete the check; the Git operation was blocked.")
        findings = json.loads(report.read_text(encoding="utf-8"))
        if findings or result.returncode:
            print("Possible secrets found; values are withheld:", file=sys.stderr)
            for finding in findings:
                print("  " + json.dumps({key: finding.get(key) for key in
                      ("File", "StartLine", "RuleID")}), file=sys.stderr)
            return 1
    print(f"Local secret check passed ({mode}).")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("install", "staged", "history"))
    parser.add_argument("--archive", help="Install from an existing archive; the pinned checksum is still required")
    args = parser.parse_args()
    if args.archive and args.mode != "install":
        parser.error("--archive is only valid for install")
    try:
        return install(args.archive) if args.mode == "install" else scan(args.mode)
    except (OSError, RuntimeError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
        print("Secret guard: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
