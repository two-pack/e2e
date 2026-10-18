---
"e2e": minor
"@e2e-dev/web": minor
---

Add `e2e run --codegen`. It writes each test file as the target engine's own
test code under `codegen.outDir` (`e2e-gen/` by default; `<file>.gen.spec.ts` on the web engine), runnable with no model. The
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
of the same test showed, an agent step's or, in a `--codegen` run, the
screen each other step left once it passed: an element gone (`toHaveCount(0)` on its locator) or
a text absent. The judge also says which part of the instruction each check
proves and which it could not check; a judgment the kept checks prove only in
part gets a `NOTE` comment with the judge's explanation, the unchecked parts,
and the dropped checks with why, a closing warning naming its line, and an
entry under `run.codegen.gaps` in the report. `render` returns the code with
those lines, and a `notice` event can carry `level: 'warning'`.

A check is kept only when the locator written for it finds its node alone:
the engine's new optional `codegen.locate` says which nodes of a screen a
locator finds, so a title reading "Login" beside a button reading the same
is dropped, not written as a `getByText` that matches both.

A judgment with a gap also names a screenshot of the screen it passed on, in
the run's artifacts, in its comment, the warning, and the report; none once a
secret was filled, and the comment says why.

The code is kept in step across runs, one file per e2e file: each test's last
passing recordings are kept under `<output>/codegen/`, a test the run did not
refresh (or that failed only because no model answered) keeps its code, one
that failed otherwise is written up to its failure with a `FAILED` comment and
the screenshot at the failure (`run.codegen.failures`), a test or e2e file the project no longer has
loses its code, and a file none of whose tests ran is not written. `e2e
codegen clear` deletes the generated files and their records.

A judgment reuses the checks its test's last recorded run made while every
one still holds on the screen, so the code stays the same while the page does
and the judge is not asked again.
