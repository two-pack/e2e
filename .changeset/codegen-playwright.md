---
"e2e": minor
"@e2e-dev/web": minor
---

Add `e2e run --codegen`. It writes the agent steps of passing tests as the
target engine's own test code under `<output>/codegen/<target>/`. The runner
records every action an `agent.act` step commits, whether the model or the
replay cache chose it, and hands them to the engine's new `codegen` member
after the run. The web engine writes one Playwright Test file per test file:
clicks, fills, selects, and key presses addressed by test id or role and
accessible name, secret fills read from their `E2E_USER_*`/`E2E_SECRET_*`
variable, and judgments and test-code steps kept in order as `TODO` comments.
