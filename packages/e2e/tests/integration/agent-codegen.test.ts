/**
 * `e2e run --codegen`: the agent steps of passing tests are written out as the
 * target engine's own test code, `<output>/codegen/<target>/<file>.spec.ts`
 * for the web engine, on both transports. The actions are recorded whatever
 * the cache mode, so a step the cache replayed writes the same code as one the
 * model drove.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
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

const SUITE = `import { test, expect } from 'e2e';

test.describe('counter', () => {
  test('increments through the agent', async ({ app, agent, screen }) => {
    await app.open();
    await agent.act('increment the counter once');
    await agent.assert('the counter shows 1');
    await expect(screen.getByRole('status')).toHaveText('1');
  });
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

const SPEC = path.join('.e2e', 'codegen', 'web', 'tests', 'counter.spec.ts');

describe('--codegen on the in-process transport', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  let executor: StepExecutor;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/counter.e2e.ts': SUITE, 'tapper.ts': EXECUTOR_MODULE });
    executor = ((await import(path.join(project.dir, 'tapper.ts'))) as { tapper: StepExecutor }).tapper;
    outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } } },
      runOptions: { codegen: true },
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

  it('turns the act into Playwright calls and keeps the other steps as TODOs, in order', () => {
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).toContain('import { test } from "@playwright/test";');
    expect(code).toContain(`test.use({ baseURL: process.env["BASE_URL"] ?? ${JSON.stringify(new URL(app.url).href)} });`);
    expect(code).toContain('test.describe("counter", () => {');
    expect(code).toContain('test("increments through the agent", async ({ page }) => {');
    const body = code.slice(code.indexOf('increments through the agent'));
    const order = [
      'await page.goto("/");',
      '// agent.act: increment the counter once (tests/counter.e2e.ts:',
      'await page.getByRole("button", { name: "Increment", exact: true }).click();',
      '// TODO: agent.assert was a model judgment',
      '// TODO: expect.toHaveText ran as test code',
    ].map((line) => body.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it('leaves a failing test out: code from a run that did not pass would freeze a broken flow', () => {
    const code = readFileSync(path.join(project.dir, SPEC), 'utf8');
    expect(code).not.toContain('fails after the agent acted');
  });

  it('writes the same code when the cache replays the step, and replaces the previous files', async () => {
    const before = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const replayed = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } } },
      runOptions: { codegen: true, grep: [/increments through the agent/] },
    });
    expect(resultByTitle(replayed, 'increments through the agent').status).toBe('passed');
    const step = resultByTitle(replayed, 'increments through the agent').attempts[0]!.steps.find((candidate) => candidate.api === 'agent.act');
    expect(step?.cache?.mode).toBe('self-finalized');
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toBe(before);
  });

  it('writes nothing without the flag', async () => {
    const plain = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor } } },
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

export default {
  targets: [{ name: 'web', platform: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 2,
  agents: { default: { executor: tapper } },
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
    expect(code).toContain('test.describe("counter again", () => {');
    expect(code).toContain('await page.getByRole("button", { name: "Increment", exact: true }).click();');
  });
});
