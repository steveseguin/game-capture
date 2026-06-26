# AGENTS.md

## EXTREMELY IMPORTANT: Testing Rule

- This rule is EXTREMELY IMPORTANT and must be treated as a hard requirement.
- Do not describe `lint`, `unit`, `smoke`, build-only, or syntax-only checks as "testing".
- Treat those checks as gates or sanity checks only.
- "Testing" means running the shipped application through real end-to-end user workflows and verifying actual behavior and output.
- When asked to test, prefer packaged/release artifacts over dev-only binaries unless the task explicitly says otherwise.
- If only lint/unit/smoke/build checks were run, state clearly that testing has not been completed.
