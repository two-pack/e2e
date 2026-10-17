/**
 * `e2e run --codegen`: the agent steps of passing tests are written out as the
 * target engine's own test code, `<output>/codegen/<target>/<file>.spec.ts`
 * for the web engine, on both transports. The actions are recorded whatever
 * the cache mode, so a step the cache replayed writes the same code as one the
 * model drove.
 */

import { existsSync, readFileSync } from 'node:fs';
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

test('fails after the agent acted', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await expect(screen.getByRole('status')).toHaveText('2', { timeout: 200 });
});
`;

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

const SPEC = path.join('.e2e', 'codegen', 'web', 'tests', 'counter.spec.ts');

describe('--codegen on the in-process transport', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let executor: StepExecutor;
  let model: ModelInstance;
  const warnings: string[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/counter.e2e.ts': SUITE, 'tapper.ts': EXECUTOR_MODULE });
    executor = ((await import(path.join(project.dir, 'tapper.ts'))) as { tapper: StepExecutor }).tapper;
    model = installFakeModel(judge);
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor, model } } },
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

  it('writes one Playwright file per test file and reports it', () => {
    expect(resultByTitle(outcome, 'increments through the agent').status).toBe('passed');
    expect(resultByTitle(outcome, 'fails after the agent acted').status).toBe('failed');
    expect(outcome.codegenFiles).toEqual([path.join(project.dir, SPEC)]);
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
    expect(lines.slice(header, header + 6).map((line) => line.trim())).toEqual([
      '// agent.assert: the Increment button is gone and nothing is broken',
      '// NOTE: the checks below prove only part of this judgment.',
      "//   The judge's explanation of its verdict (its reasoning, not a checked fact): judged",
      '//   Not checked: nothing is broken',
      '//   Dropped absent "Error": the instruction does not say this text is missing',
      'await expect(page.getByRole("button", { name: "Increment", exact: true })).toHaveCount(0);',
    ]);
    // A field is an element too, found by its label whatever was typed into it.
    expect(lines[header + 6]?.trim()).toBe('await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveCount(0);');
    expect(lines[header + 7]?.trim()).toBe('await expect(page.getByText("Increment")).toHaveCount(0);');
    expect(lines[header + 8]?.trim()).toBe('await expect(page).toHaveURL("/about");');
    // The first judgment's checks prove all of it: no note.
    expect(code).toContain('  // agent.assert: the counter is on screen\n  await expect');
    const gap = {
      file: SPEC.split(path.sep).join('/'),
      line: header + 1,
      kind: 'partial',
      source: 'tests/counter.e2e.ts',
      test: 'leaves the counter behind',
      api: 'agent.assert',
      instruction: 'the Increment button is gone and nothing is broken',
      uncovered: ['nothing is broken'],
    };
    expect(outcome.report.run.codegen).toEqual({ dir: '.e2e/codegen', files: [SPEC.split(path.sep).join('/')], gaps: [gap] });
    expect(warnings).toEqual([
      `--codegen: 1 judgment was only partly converted (${gap.file}:${String(gap.line)})`,
    ]);
  });

  it('keeps a failing test, whose agent call recorded nothing, throwing where the call was', () => {
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).toContain(
      [
        "test('fails after the agent acted', async ({ page }) => {",
        '  await page.goto("/");',
        '  // agent.act: increment the counter once',
        '  // TODO: no passing run reached this call, so nothing was recorded for it.',
        '  throw new Error("agent.act(\\"increment the counter once\\") was not recorded by e2e run --codegen");',
      ].join('\n'),
    );
  });

  it('writes the same code when the cache replays the step, and replaces the previous files', async () => {
    const before = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const replayed = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor, model } } },
      runOptions: { codegen: true, grep: [/increments through the agent|leaves the counter behind/] },
    });
    expect(resultByTitle(replayed, 'increments through the agent').status).toBe('passed');
    const step = resultByTitle(replayed, 'increments through the agent').attempts[0]!.steps.find((candidate) => candidate.api === 'agent.act');
    expect(step?.cache?.mode).toBe('self-finalized');
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toBe(before);
  });

  it('writes nothing without the flag', async () => {
    const plain = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor, model } } },
      runOptions: { grep: [/increments through the agent/] },
    });
    expect(plain.codegenFiles).toBeUndefined();
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
    const nested = path.join(project.dir, '.e2e', 'codegen', 'web', 'tests', 'nested', 'again.spec.ts');
    expect(outcome.codegenFiles?.toSorted()).toEqual([path.join(project.dir, SPEC), nested].toSorted());
    expect(existsSync(nested)).toBe(true);
    const code = readFileSync(nested, 'utf8');
    expect(code).toContain("test.describe('counter again', () => {");
    expect(code).toContain('await page.getByRole("button", { name: "Increment", exact: true }).click();');
    expect(code).toContain(`await expect(${COUNTER}).toContainText("1");`);
  });
});
