---
"e2e": patch
"@e2e-dev/web": patch
---

`e2e run --codegen` now runs a test from its generated code first when that
code does all the test did: the e2e file and the code unchanged, no failure
in it, and an action or a check for every agent call. No model is called. A
test the code fails, or cannot run, goes to the agent in the same run, and
its code is written again. The engine's `codegen` member takes an optional
`run`; the web engine's runs the Playwright Test file with the project's own
`@playwright/test`, under a config of its own, with the run's action and
assertion timeouts and each configured secret under its override variable.
The `Code` row counts the tests that passed from code and those that went to
the agent, and `report.json` lists them under `run.codegen.ran`.
