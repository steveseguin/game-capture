#!/usr/bin/env python3
"""Exercise real local Git hooks using synthetic secrets and an isolated bare remote."""
import argparse
import hashlib
from pathlib import Path
import secrets
import shutil
import string
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="Pinned Gitleaks archive for this machine")
    args = parser.parse_args()
    archive = Path(args.archive).resolve()
    scratch = ROOT / ".tools" / "secret-guard-checks"
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="repo with spaces-", dir=scratch) as directory:
        repo = Path(directory).resolve()
        assert repo.is_relative_to(scratch.resolve())
        # Never touch the real repository index or any external remote.
        for name in ("tools/secret_scan.py", ".gitleaks.toml", ".gitignore",
                     ".githooks/pre-commit", ".githooks/pre-push", ".githooks/run-secret-check"):
            target = repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

        def run(*command, ok=True):
            result = subprocess.run(command, cwd=repo, capture_output=True, text=True)
            if (result.returncode == 0) != ok:
                # Do not echo arbitrary Git output: a failing guard must not disclose a fixture secret.
                raise AssertionError(f"Unexpected exit {result.returncode}: {command[:2]}")
            return result

        def write(name, content):
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

        run("git", "init", "-b", "main")
        run("git", "config", "user.name", "Secret guard fixture")
        run("git", "config", "user.email", "fixture@example.invalid")
        run("git", "config", "commit.gpgsign", "false")
        run("git", "config", "core.hooksPath", "existing-hooks")
        run(sys.executable, "tools/secret_scan.py", "install", "--archive", str(archive), ok=False)
        assert run("git", "config", "--get", "core.hooksPath").stdout.strip() == "existing-hooks"
        run("git", "config", "--unset", "core.hooksPath")
        run(sys.executable, "tools/secret_scan.py", "install", "--archive", str(archive))
        scanner = repo / ".tools/gitleaks/8.30.1" / ("gitleaks.exe" if sys.platform == "win32" else "gitleaks")
        before = hashlib.sha256(scanner.read_bytes()).hexdigest()
        write(".tools/tampered.zip", "not the official archive")
        run(sys.executable, "tools/secret_scan.py", "install", "--archive", str(repo / ".tools/tampered.zip"), ok=False)
        assert hashlib.sha256(scanner.read_bytes()).hexdigest() == before
        run("git", "add", ".")
        run("git", "commit", "-m", "Clean fixture")
        bare = repo / ".tools/remote.git"
        run("git", "init", "--bare", str(bare))
        run("git", "remote", "add", "origin", str(bare))
        run("git", "push", "origin", "main")
        print("PASS: pinned installer, existing-hook preservation, clean commit and local push")

        token = "gh" + "p_" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        write("credential.txt", "TOKEN=" + token + "\n")
        run("git", "add", "credential.txt")
        write("credential.txt", "TOKEN=example\n")
        blocked = run("git", "commit", "-m", "Must reject staged secret", ok=False)
        assert token not in blocked.stdout + blocked.stderr
        assert "Possible secrets found" in blocked.stderr
        run("git", "reset", "--", "credential.txt")
        (repo / "credential.txt").unlink()
        print("PASS: staged secret blocked despite clean working copy; output redacted")

        for filename in (".env", ".env.production", "signing.pfx", "private.key"):
            write(filename, "VALUE=x\n")
            run("git", "check-ignore", filename)
            run("git", "add", "-f", filename)
            blocked = run("git", "commit", "-m", "Must reject local credential file", ok=False)
            assert "Sensitive local file names" in blocked.stderr
            run("git", "reset", "--", filename)
            (repo / filename).unlink()
        write(".env.example", "TOKEN=example\n")
        run("git", "add", ".env.example")
        run("git", "commit", "-m", "Safe template")
        print("PASS: forced sensitive files blocked; safe template accepted")

        windows_id_path = "native-qt/e2e/capture-session-compatibility.js"
        turn_path = "native-qt/e2e/signaling-media-fixture-regression.js"
        public_id = "70d33e74ec064050a58a901f0f757095"
        fixture_value = "round10-" + "secret"
        write(windows_id_path, "const ids = { accessStatics: '" + public_id + "' };\n")
        write(turn_path, "const mock = { credential: '" + fixture_value + "' };\n")
        run("git", "add", "native-qt")
        run("git", "commit", "-m", "Known inert fixtures")
        write(turn_path, "const mock = { credential: '" + token + "' };\n")
        run("git", "add", turn_path)
        run("git", "commit", "-m", "Same path must not exempt another secret", ok=False)
        run("git", "reset", "--", turn_path)
        run("git", "checkout", "--", turn_path)
        print("PASS: exact inert exceptions accepted; other secrets in the same file blocked")

        missing = scanner.with_suffix(".temporarily-unavailable")
        scanner.rename(missing)
        try:
            run("git", "commit", "--allow-empty", "-m", "Missing scanner must block", ok=False)
            run("git", "push", "origin", "main", ok=False)
        finally:
            missing.rename(scanner)
        print("PASS: missing scanner blocks commits and pushes")

        # Deliberately bypass only the isolated fixture's commit hook to prove push protection.
        empty_hooks = repo / ".tools/empty-hooks"
        empty_hooks.mkdir()
        write("old-secret.txt", token + "\n")
        run("git", "add", "old-secret.txt")
        run("git", "-c", "core.hooksPath=" + str(empty_hooks), "commit", "-m", "Synthetic old secret")
        run("git", "rm", "old-secret.txt")
        run("git", "commit", "-m", "Delete synthetic old secret")
        blocked = run("git", "push", "origin", "main", ok=False)
        assert "Possible secrets found" in blocked.stderr
        assert token not in blocked.stdout + blocked.stderr
        print("PASS: deleted historical secret still blocks local push")
    print("All secret-guard Git workflows passed. No network remote was used.")


if __name__ == "__main__":
    main()
