---
"e2e": minor
"@e2e-dev/web": minor
---

Add `e2e run --codegen`. It writes each test file as the target engine's own
test code under `<output>/codegen/<target>/`, runnable with no model. The
runner records every action an `agent.act` step commits, whether the model or
the replay cache chose it, and for each passing `agent.assert`,
`agent.waitFor`, and `agent.extract` asks the judge once more for the
deterministic checks that prove it, keeping only those the same screen bears
out. The engine's new `codegen` member gets them with the test source after
the run. The web engine converts the test to Playwright Test: `agent.act` as
the recorded clicks and fills, judgments as `expect` calls (`waitFor`'s with
its timeout), `extract` as the value it returned, and the rest of the e2e API
in its Playwright spelling, control flow kept. Secret fills read their
`E2E_USER_*`/`E2E_SECRET_*` variable.
