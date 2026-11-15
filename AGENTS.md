# AGENTS.md

## Git workflow

- Work only on `main` in this existing primary checkout.
- Never create or use feature branches or linked Git worktrees. Do not switch away from `main` unless the user explicitly changes this instruction.
- Commit and push requested changes on `main`, preserving unrelated local edits.

## EXTREMELY IMPORTANT: Testing Rule

- This rule is EXTREMELY IMPORTANT and must be treated as a hard requirement.
- Do not describe `lint`, `unit`, `smoke`, build-only, or syntax-only checks as "testing".
- Treat those checks as gates or sanity checks only.
- "Testing" means running the shipped application through real end-to-end user workflows and verifying actual behavior and output.
- When asked to test, prefer packaged/release artifacts over dev-only binaries unless the task explicitly says otherwise.
- If only lint/unit/smoke/build checks were run, state clearly that testing has not been completed.
