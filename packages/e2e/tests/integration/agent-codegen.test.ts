/**
 * `e2e run --codegen`: the agent steps of passing tests are written out as the
 * target engine's own test code, `<output>/codegen/<target>/<file>.gen.spec.ts`
 * for the web engine, on both transports. The actions are recorded whatever
 * the cache mode, so a step the cache replayed writes the same code as one the
 * model drove.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import {
  createProject,
  resultByTitle,
  runExisting,
  runProjectWithConfigFile,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { ModelInstance } from '../../src/types.ts';
import { installFakeModel, type FakeCall } from '../helpers/fake-model.ts';
import { createScriptedInstance } from '../helpers/scripted-model.ts';
import { codegen as codegenCommand } from '../../src/cli/codegen.ts';

const SUITE = `import { test, expect } from 'e2e';

test.describe('counter', () => {
  test('increments through the agent', async ({ app, agent, screen }) => {
    await app.open();
    await agent.act('increment the counter once');
    await agent.assert('the counter shows 1');
    await expect(screen.getByRole('status')).toHaveText('1');
  });
});

test('leaves the counter behind', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the counter is on screen');
  await app.open('/about');
  await agent.assert('the Increment button is gone and nothing is broken');
});

test('remembers what a screen step went through', async ({ app, agent }) => {
  await app.open();
  await app.open('/about');
  await agent.assert('the Increment button was replaced, and nothing is broken');
});

test('leaves the list behind', async ({ app, agent }) => {
  await app.open('/delayed');
  await app.open('/about');
  await agent.assert('the list is not shown');
});

test('shows the sign-in card', async ({ app, agent }) => {
  await app.open('/sign-in-card');
  await agent.assert('the sign-in card is shown');
});

test('fails after the agent acted', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await expect(screen.getByRole('status')).toHaveText('2', { timeout: 200 });
});
`;

/**
 * A second e2e file, whose tests a later run breaks, takes the model from, or
 * removes, to see the code follow: a failure that implicates the app drops a
 * test's code, one where no model answered keeps it.
 */
const OTHER_SUITE = `import { test, expect } from 'e2e';

test('breaks on demand', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await agent.assert('the counter shows 1');
  if (process.env.CODEGEN_BREAK === '1') await expect(screen.getByRole('status')).toHaveText('9', { timeout: 200 });
});

test('waits on demand', async ({ app, agent }) => {
  await app.open();
  await agent.act('increment the counter once');
  await agent.assert('the counter shows 1');
  if (process.env.CODEGEN_PROVIDER_DOWN === '1') await agent.waitFor('the counter shows 1', { agent: 'judge', timeout: 2_000 });
});
`;

/** A judge that never answers: what a missing key or an outage looks like to a run. */
const unreachableModel = createScriptedInstance('fake', 'unreachable', async () => {
  throw new Error('401 Unauthorized: no API key was provided');
});

/**
 * Taps Increment once per act and passes every judgment, with no model: the
 * custom executor sees `act` and `assert` alike through `runStep`. A project
 * file, so the in-process run and a child-process worker's config share it.
 */
const EXECUTOR_MODULE = `export const tapper = {
  name: 'tapper',
  version: '1',
  async runStep(context) {
    if (context.step.kind !== 'act') return { status: 'passed', summary: 'judged' };
    const observation = await context.observe();
    const line = observation.text.split('\\n').find((candidate) => /button "Increment"/.test(candidate)) ?? '';
    const match = /#(\\S+)/.exec(line);
    if (match === null) return { status: 'failed', summary: 'no Increment button' };
    await context.actions.tap({ id: match[1] });
    return { status: 'passed', summary: 'tapped Increment' };
  },
};
`;

/**
 * The judge the codegen question goes to. On the counter it proposes the
 * counter's text, which the screen bears out, a node the screen never showed,
 * which the runner must drop, and a word the assertion never said was
 * missing. Once the counter is left behind it proposes the Increment button
 * an earlier screen showed as gone and its text as absent, and names what it
 * could not check. Self-contained, so a worker's config embeds its source.
 */
function judge(call: FakeCall): unknown {
  if (call.schemaName !== 'agent-codegen-checks-1') throw new Error(`unexpected ${call.schemaName}`);
  // Counted on the global, so a worker's config that embeds this function's source counts too.
  const counted = globalThis as { codegenChecksAsked?: string[] };
  counted.codegenChecksAsked = [...(counted.codegenChecksAsked ?? []), call.instruction];
  if (call.instruction.includes('replaced')) {
    const earlier = /^(p\d+) button "Increment"/mu.exec(call.prompt)?.[1] ?? null;
    return { checks: [{ kind: 'gone', node: earlier, text: null, covers: 'the Increment button was replaced' }], uncovered: ['nothing is broken'] };
  }
  if (call.instruction.includes('the list is not shown')) {
    // The list had no name: the question lists it by its role alone.
    const earlier = /^(p\d+) list$/mu.exec(call.prompt)?.[1] ?? null;
    return { checks: [{ kind: 'gone', node: earlier, text: null, covers: 'the list is not shown' }], uncovered: [] };
  }
  if (call.instruction.includes('sign-in card')) {
    // The title reads "Login" like the button does: a script can find only the button by it.
    const title = call.lines.find((candidate) => /text="Login"/u.test(candidate) && !/button/u.test(candidate)) ?? '';
    const button = call.lines.find((candidate) => /button "Login"/u.test(candidate)) ?? '';
    const idOf = (line: string): string | null => /#(\S+)/u.exec(line)?.[1] ?? null;
    return {
      checks: [
        { kind: 'visible', node: idOf(title), text: null, covers: 'the sign-in card is shown' },
        { kind: 'visible', node: idOf(button), text: null, covers: 'the sign-in card is shown' },
      ],
      uncovered: [],
    };
  }
  if (call.instruction.includes('is gone')) {
    const earlier = /^(p\d+) button "Increment"/mu.exec(call.prompt)?.[1] ?? null;
    const field = /^(p\d+) textbox "Email"/mu.exec(call.prompt)?.[1] ?? null;
    return {
      checks: [
        { kind: 'gone', node: earlier, text: null, covers: 'the Increment button is gone' },
        { kind: 'gone', node: field, text: null, covers: 'the Increment button is gone' },
        { kind: 'absent', node: null, text: 'Increment', covers: 'the Increment button is gone' },
        { kind: 'absent', node: null, text: 'Error', covers: 'nothing is broken' },
        // A check that claims the whole instruction hides nothing the judge said it left out.
        { kind: 'url', node: null, text: '/about', covers: call.instruction },
      ],
      uncovered: ['nothing is broken'],
    };
  }
  const line = call.lines.find((candidate) => /status "Counter"/u.test(candidate)) ?? '';
  const id = /#(\S+)/u.exec(line)?.[1] ?? null;
  if (call.instruction.includes('is on screen')) return { checks: [{ kind: 'visible', node: id, text: null, covers: 'the counter is on screen' }], uncovered: [] };
  return {
    checks: [
      { kind: 'text', node: id, text: '1', covers: 'the counter shows 1' },
      { kind: 'count', node: id, text: '1', covers: null },
      { kind: 'visible', node: 'n9999', text: null, covers: 'the counter shows 1' },
      { kind: 'absent', node: null, text: 'Error', covers: null },
    ],
    uncovered: [],
  };
}

/** The counter as the generated code finds it: by the name its author gave it. */
const COUNTER = 'page.getByRole("status", { name: "Counter", exact: true })';

const HELPER = fileURLToPath(new URL('../helpers/fake-model.ts', import.meta.url));

const SPEC = path.join('e2e-gen', 'tests', 'counter.gen.spec.ts');
const OTHER = path.join('e2e-gen', 'tests', 'other.gen.spec.ts');

/** A path as the report spells it. */
const posix = (file: string): string => file.split(path.sep).join('/');

/** The screenshot line of a judgment's note, naming a file in the run's artifacts. */
const SCREENSHOT_LINE = /^\/\/ {3}Screenshot of the screen it passed on: (\.e2e\/results\/\S+\.png)$/u;

describe('--codegen on the in-process transport', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let executor: StepExecutor;
  let model: ModelInstance;
  const warnings: string[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/counter.e2e.ts': SUITE, 'tests/other.e2e.ts': OTHER_SUITE, 'tapper.ts': EXECUTOR_MODULE });
    executor = ((await import(path.join(project.dir, 'tapper.ts'))) as { tapper: StepExecutor }).tapper;
    model = installFakeModel(judge);
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: config(),
      runOptions: {
        codegen: true,
        onEvent: (event) => {
          if (event.type === 'notice' && event.level === 'warning') warnings.push(event.message);
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  /** The run's config: the tapping executor, the judge the checks question goes to, and an agent whose judge never answers. */
  const config = () => ({ tests: 'tests/**/*.e2e.ts', agents: { default: { executor, model }, judge: { model: unreachableModel } } });

  /** One more `--codegen` run of the tests the pattern selects. */
  const rerun = (grep: RegExp) => runExisting(project, { appUrl: app.url, config: config(), runOptions: { codegen: true, grep: [grep] } });

  it('writes one Playwright file per e2e file under codegen.outDir and reports it', () => {
    expect(resultByTitle(outcome, 'increments through the agent').status).toBe('passed');
    expect(resultByTitle(outcome, 'fails after the agent acted').status).toBe('failed');
    expect(outcome.codegenFiles?.toSorted()).toEqual([path.join(project.dir, OTHER), path.join(project.dir, SPEC)].toSorted());
  });

  it('converts the test source: the act becomes its actions, the assert the check the screen bore out', () => {
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).toContain('import { expect, test } from "@playwright/test";');
    expect(code).not.toContain("from 'e2e'");
    expect(code).toContain(`test.use({ baseURL: process.env["BASE_URL"] ?? ${JSON.stringify(new URL(app.url).href)} });`);
    expect(code).toContain(
      [
        "test.describe('counter', () => {",
        "  test('increments through the agent', async ({ page }) => {",
        '    await page.goto("/");',
        '    // agent.act: increment the counter once',
        '    await page.getByRole("button", { name: "Increment", exact: true }).click();',
        '    // agent.assert: the counter shows 1',
        `    await expect(${COUNTER}).toContainText("1");`,
        '    await expect(page.getByRole("status")).toHaveCount(1);',
        "    await expect(page.getByRole('status')).toHaveText('1');",
      ].join('\n'),
    );
    // A node the screen never showed, and a word the assertion never said was missing, are dropped, not written.
    const counted = code.slice(code.indexOf('// agent.assert: the counter shows 1'), code.indexOf("test('leaves the counter behind'"));
    expect(counted).not.toContain('toBeVisible');
    expect(counted).not.toContain('getByText("Error")');
  });

  it('checks that an element an earlier screen showed is gone, and says what the checks leave unproven', () => {
    expect(resultByTitle(outcome, 'leaves the counter behind').status).toBe('passed');
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const lines = code.split('\n');
    const header = lines.findIndex((line) => line.trim() === '// agent.assert: the Increment button is gone and nothing is broken');
    expect(lines.slice(header, header + 5).map((line) => line.trim())).toEqual([
      '// agent.assert: the Increment button is gone and nothing is broken',
      '// NOTE: the checks below prove only part of this judgment.',
      "//   The judge's explanation of its verdict (its reasoning, not a checked fact): judged",
      '//   Not checked: nothing is broken',
      '//   Dropped absent "Error": the instruction does not say this text is missing',
    ]);
    // The custom executor took no screenshot of its own; the gap took one of the screen it passed on, kept in the artifacts.
    const shot = SCREENSHOT_LINE.exec(lines[header + 5]!.trim())?.[1];
    expect(shot).toBeDefined();
    expect(existsSync(path.join(project.dir, shot!))).toBe(true);
    expect(lines[header + 6]?.trim()).toBe('await expect(page.getByRole("button", { name: "Increment", exact: true })).toHaveCount(0);');
    // A field is an element too, found by its label whatever was typed into it.
    expect(lines[header + 7]?.trim()).toBe('await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveCount(0);');
    expect(lines[header + 8]?.trim()).toBe('await expect(page.getByText("Increment")).toHaveCount(0);');
    expect(lines[header + 9]?.trim()).toBe('await expect(page).toHaveURL("/about");');
    // The first judgment's checks prove all of it: no note.
    expect(code).toContain('  // agent.assert: the counter is on screen\n  await expect');
    const gap = {
      file: posix(SPEC),
      line: header + 1,
      kind: 'partial',
      source: 'tests/counter.e2e.ts',
      test: 'leaves the counter behind',
      api: 'agent.assert',
      instruction: 'the Increment button is gone and nothing is broken',
      uncovered: ['nothing is broken'],
      screenshot: shot,
    };
    const replacedHeader = lines.findIndex((line) => line.trim() === '// agent.assert: the Increment button was replaced, and nothing is broken');
    const replaced = {
      ...gap,
      line: replacedHeader + 1,
      test: 'remembers what a screen step went through',
      instruction: 'the Increment button was replaced, and nothing is broken',
      screenshot: SCREENSHOT_LINE.exec(lines[replacedHeader + 4]!.trim())?.[1],
    };
    const report = outcome.report.run.codegen!;
    expect(report.dir).toBe('e2e-gen');
    expect([...report.files].toSorted()).toEqual([posix(OTHER), posix(SPEC)].toSorted());
    expect(report.gaps).toEqual([gap, replaced]);
    expect(report.failures.map((failure) => [failure.test, failure.code])).toEqual([['fails after the agent acted', 'ASSERTION_FAILED']]);
    const failure = report.failures[0]!;
    expect(warnings).toEqual([
      `--codegen: 1 test failed in the run its code was written from, and the code stops there: ${failure.file}:${String(failure.line)} (screenshot ${failure.screenshot!})`,
      `--codegen: 2 judgments were only partly converted: ${gap.file}:${String(gap.line)} (screenshot ${gap.screenshot!}), ${replaced.file}:${String(replaced.line)} (screenshot ${replaced.screenshot!})`,
    ]);
  });

  it('counts a screen a screen step went through as an earlier screen', () => {
    expect(resultByTitle(outcome, 'remembers what a screen step went through').status).toBe('passed');
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).toContain(
      [
        '  // agent.assert: the Increment button was replaced, and nothing is broken',
        '  // NOTE: the checks below prove only part of this judgment.',
        "  //   The judge's explanation of its verdict (its reasoning, not a checked fact): judged",
        '  //   Not checked: nothing is broken',
      ].join('\n'),
    );
    expect(code).toMatch(/ {2}\/\/ {3}Screenshot of the screen it passed on: \.e2e\/results\/\S+\.png\n {2}await expect\(page\.getByRole\("button", \{ name: "Increment", exact: true \}\)\)\.toHaveCount\(0\);/u);
  });

  it('checks that an unnamed list an earlier screen showed is gone, by its role alone', () => {
    expect(resultByTitle(outcome, 'leaves the list behind').status).toBe('passed');
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).toContain(
      [
        '  // agent.assert: the list is not shown',
        '  await expect(page.getByRole("list")).toHaveCount(0);',
      ].join('\n'),
    );
  });

  it('keeps a check only on a node the code finds alone, saying why it dropped the other', () => {
    expect(resultByTitle(outcome, 'shows the sign-in card').status).toBe('passed');
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).toContain(
      [
        '  // agent.assert: the sign-in card is shown',
        '  await expect(page.getByRole("button", { name: "Login", exact: true })).toBeVisible();',
      ].join('\n'),
    );
    expect(code).not.toContain('getByText("Login"');
  });

  it('writes a test that failed up to its failure, with the error and the screenshot at the failure on top', () => {
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const block = code.slice(code.indexOf("test('fails after the agent acted'"));
    const lines = block.split('\n');
    expect(lines[1]).toMatch(/^ {2}\/\/ FAILED: in the run this code was written from, the test failed at line \d+ \(expect\.toHaveText getByRole\("status"\)\): ASSERTION_FAILED: /u);
    expect(lines[2]).toMatch(/^ {2}\/\/ {3}Screenshot at the failure: \.e2e\/results\/\S+\.png$/u);
    expect(existsSync(path.join(project.dir, /: (\S+)$/u.exec(lines[2]!)![1]!))).toBe(true);
    // What the agent did before the test failed is written as the run did it; the test's own expect fails on its own line.
    expect(lines.slice(3, 7).join('\n')).toBe(
      [
        '  await page.goto("/");',
        '  // agent.act: increment the counter once',
        '  await page.getByRole("button", { name: "Increment", exact: true }).click();',
        "  await expect(page.getByRole('status')).toHaveText('2', { timeout: 200 });",
      ].join('\n'),
    );
  });

  it('writes the same code when the cache replays the step, and leaves a file none of whose tests ran as it was', async () => {
    const before = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const other = statSync(path.join(project.dir, OTHER));
    const counted = globalThis as { codegenChecksAsked?: string[] };
    counted.codegenChecksAsked = [];
    const replayed = await rerun(/increments through the agent/);
    // The judgment's checks still held on the screen, so they were reused and the judge was not asked again.
    expect(counted.codegenChecksAsked).toEqual([]);
    expect(resultByTitle(replayed, 'increments through the agent').status).toBe('passed');
    const step = resultByTitle(replayed, 'increments through the agent').attempts[0]!.steps.find((candidate) => candidate.api === 'agent.act');
    expect(step?.cache?.mode).toBe('self-finalized');
    // The tests the run did not select keep their code, and the gaps they had are reported as an earlier run's.
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toBe(before);
    expect(statSync(path.join(project.dir, OTHER)).mtimeMs).toBe(other.mtimeMs);
    expect(replayed.report.run.codegen?.gaps.map((gap) => gap.carried)).toEqual([true, true]);
  });

  it("asks the judge again when a judgment's last checks no longer hold on the screen", async () => {
    // The record says the counter read 7: on a screen that reads 1, that check fails, so it cannot be reused.
    const recordFile = path.join(project.dir, '.e2e', 'codegen', 'web', 'tests', 'counter.e2e.ts.json');
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as {
      tests: { test: { title: string; steps: { judgment?: { checks: { kind: string; text?: string }[] } }[] } }[];
    };
    const checks = record.tests.find((stored) => stored.test.title === 'increments through the agent')!.test.steps.flatMap((step) => step.judgment?.checks ?? []);
    const text = checks.find((check) => check.kind === 'text')!;
    text.text = '7';
    writeFileSync(recordFile, JSON.stringify(record), 'utf8');
    const counted = globalThis as { codegenChecksAsked?: string[] };
    counted.codegenChecksAsked = [];
    await rerun(/increments through the agent/);
    expect(counted.codegenChecksAsked).toEqual(['the counter shows 1']);
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toContain(`await expect(${COUNTER}).toContainText("1");`);
  });

  it("asks the judge again when a judgment's last checks proved it only in part, even though they still hold", async () => {
    // The checks are the ones the judge gave and still hold; only the gap the record now carries keeps them from being reused.
    const recordFile = path.join(project.dir, '.e2e', 'codegen', 'web', 'tests', 'counter.e2e.ts.json');
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as {
      tests: { test: { title: string; steps: { judgment?: { gap?: unknown } }[] } }[];
    };
    const judgment = record.tests.find((stored) => stored.test.title === 'increments through the agent')!.test.steps.find((step) => step.judgment !== undefined)!.judgment!;
    judgment.gap = { uncovered: ['shows 1'], dropped: [] };
    writeFileSync(recordFile, JSON.stringify(record), 'utf8');
    const counted = globalThis as { codegenChecksAsked?: string[] };
    counted.codegenChecksAsked = [];
    const rerunOutcome = await rerun(/increments through the agent/);
    expect(counted.codegenChecksAsked).toEqual(['the counter shows 1']);
    // The new answer proves the whole judgment, so it replaces the old one and the code says nothing is left unchecked.
    expect(rerunOutcome.report.run.codegen?.gaps.filter((gap) => gap.carried !== true) ?? []).toEqual([]);
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).not.toContain('Not checked: shows 1');
  });

  it("writes a test's code again up to a failure that implicates the app, and keeps it when only the model did not answer", async () => {
    const before = readFileSync(path.join(project.dir, OTHER), 'utf8');
    expect(before).toContain("test('breaks on demand', async ({ page }) => {\n  await page.goto(\"/\");\n  // agent.act: increment the counter once\n  await page.getByRole");
    process.env['CODEGEN_BREAK'] = '1';
    process.env['CODEGEN_PROVIDER_DOWN'] = '1';
    let broken: RunOutcome;
    try {
      broken = await rerun(/on demand/);
    } finally {
      delete process.env['CODEGEN_BREAK'];
      delete process.env['CODEGEN_PROVIDER_DOWN'];
    }
    expect(resultByTitle(broken, 'breaks on demand').status).toBe('failed');
    expect(resultByTitle(broken, 'waits on demand').attempts.at(-1)!.steps.find((step) => step.api === 'agent.waitFor')?.error?.code).toBe(
      'MODEL_PROVIDER_FAILED',
    );
    const code = readFileSync(path.join(project.dir, OTHER), 'utf8');
    const breaks = code.slice(code.indexOf("test('breaks on demand'"), code.indexOf("test('waits on demand'"));
    const waits = code.slice(code.indexOf("test('waits on demand'"));
    expect(breaks).toMatch(/^test\('breaks on demand', async \(\{ page \}\) => \{\n {2}\/\/ FAILED: in the run this code was written from, the test failed at line \d+ \(expect\.toHaveText/u);
    expect(breaks).toContain('  // agent.act: increment the counter once\n  await page.getByRole("button", { name: "Increment", exact: true }).click();');
    expect(broken.report.run.codegen?.failures.map((failure) => [failure.test, failure.carried])).toEqual([
      ['fails after the agent acted', true],
      ['breaks on demand', undefined],
    ]);
    expect(waits).toBe(before.slice(before.indexOf("test('waits on demand'")));
  });

  it('drops the code of a test the e2e file no longer declares, and the file of an e2e file that is gone', async () => {
    writeFileSync(path.join(project.dir, 'tests', 'other.e2e.ts'), OTHER_SUITE.slice(0, OTHER_SUITE.indexOf("test('waits on demand'")), 'utf8');
    await rerun(/increments through the agent/);
    const code = readFileSync(path.join(project.dir, OTHER), 'utf8');
    expect(code).toContain("test('breaks on demand'");
    expect(code).not.toContain('waits on demand');

    rmSync(path.join(project.dir, 'tests', 'other.e2e.ts'));
    const gone = await rerun(/increments through the agent/);
    expect(existsSync(path.join(project.dir, OTHER))).toBe(false);
    expect(gone.report.run.codegen?.gaps.every((gap) => gap.file === posix(SPEC))).toBe(true);
    const records = readdirSync(path.join(project.dir, '.e2e', 'codegen'), { recursive: true }).map(String);
    expect(records.filter((file) => file.endsWith('.json')).map(posix)).toEqual(['web/tests/counter.e2e.ts.json']);
  });

  it('writes nothing without the flag', async () => {
    const before = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const plain = await runExisting(project, { appUrl: app.url, config: config(), runOptions: { grep: [/increments through the agent/] } });
    expect(plain.codegenFiles).toBeUndefined();
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toBe(before);
  });

  it('warns when it writes over a generated file edited by hand, or one it has no record of', async () => {
    const warned: string[] = [];
    const onEvent = (event: { type: string; level?: string; message?: string }): void => {
      if (event.type === 'notice' && event.level === 'warning' && event.message?.includes(' over ') === true) warned.push(event.message);
    };
    const spec = path.join(project.dir, SPEC);
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}// edited by hand\n`, 'utf8');
    await runExisting(project, { appUrl: app.url, config: config(), runOptions: { codegen: true, grep: [/increments through the agent/], onEvent } });
    expect(warned).toEqual([`--codegen wrote ${posix(SPEC)} over edits made to it since e2e last wrote it`]);
    expect(readFileSync(spec, 'utf8')).not.toContain('// edited by hand');

    warned.length = 0;
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}// edited by hand\n`, 'utf8');
    rmSync(path.join(project.dir, '.e2e', 'codegen', 'web', 'tests', 'counter.e2e.ts.json'));
    await runExisting(project, { appUrl: app.url, config: config(), runOptions: { codegen: true, grep: [/increments through the agent/], onEvent } });
    expect(warned).toEqual([`--codegen wrote ${posix(SPEC)} over a file e2e has no record of writing`]);
  });

  it('clears the generated code and its records, leaving a file no record names', async () => {
    // The command reads the project's config file, as a run from the command line does.
    writeFileSync(
      path.join(project.dir, 'e2e.config.ts'),
      "import { web } from '@e2e-dev/web';\n\nexport default { targets: [{ name: 'web', platform: 'web', engine: web(), app: { url: 'http://127.0.0.1:1' } }] };\n",
      'utf8',
    );
    const mine = path.join(project.dir, 'e2e-gen', 'tests', 'mine.spec.ts');
    writeFileSync(mine, '// written by hand\n', 'utf8');
    const write = process.stdout.write.bind(process.stdout);
    let printed = '';
    process.stdout.write = ((chunk: string) => {
      printed += chunk;
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await codegenCommand('clear', { cwd: project.dir });
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    expect(printed).toBe('cleared 1 generated file(s) from e2e-gen and 1 record(s)\n');
    expect(existsSync(path.join(project.dir, SPEC))).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(readdirSync(path.join(project.dir, '.e2e', 'codegen'), { recursive: true }).map(String).filter((file) => file.endsWith('.json'))).toEqual([]);
  });
});

describe('--codegen on child-process workers', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    // A worker re-loads the config module itself, so the executor is written into it.
    const configSource = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { tapper } from './tapper.ts';
import { installFakeModel } from ${JSON.stringify(HELPER)};

export default {
  targets: [{ name: 'web', platform: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 2,
  agents: { default: { executor: tapper, model: installFakeModel(${judge.toString()}) } },
} satisfies E2EConfig;
`;
    const result = await runProjectWithConfigFile(
      {
        'tests/counter.e2e.ts': SUITE,
        'tests/nested/again.e2e.ts': SUITE.replace("'counter'", "'counter again'"),
        'tapper.ts': EXECUTOR_MODULE,
      },
      { appUrl: app.url, configSource, runOptions: { codegen: true, noCache: true } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('collects every worker’s recordings and writes each file under its own path', () => {
    expect(outcome.exitCode).toBe(1);
    const nested = path.join(project.dir, 'e2e-gen', 'tests', 'nested', 'again.gen.spec.ts');
    expect(outcome.codegenFiles?.toSorted()).toEqual([path.join(project.dir, SPEC), nested].toSorted());
    expect(existsSync(nested)).toBe(true);
    const code = readFileSync(nested, 'utf8');
    expect(code).toContain("test.describe('counter again', () => {");
    expect(code).toContain('await page.getByRole("button", { name: "Increment", exact: true }).click();');
    expect(code).toContain(`await expect(${COUNTER}).toContainText("1");`);
  });
});
