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
`E2E_USER_*`/`E2E_SECRET_*` variable. Locators follow the standard accessible
names: the web engine's nodes now carry `standard`, the standard's reading
where e2e reads a node its own way for the model, and the code is written from
it (a list row e2e named from its content by the text it shows, a name with
its icon glyph, an editor's host by its label).

A check that something is not shown counts only for what an earlier screen
of the same test showed: an element gone (`toHaveCount(0)` on its locator) or
a text absent. The judge also says which part of the instruction each check
proves and which it could not check; a judgment the kept checks prove only in
part gets a `NOTE` comment with the judge's explanation, the unchecked parts,
and the dropped checks with why, a closing warning naming its line, and an
entry under `run.codegen.gaps` in the report. `render` returns the code with
those lines, and a `notice` event can carry `level: 'warning'`.
