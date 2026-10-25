/**
 * `e2e run --codegen` runs a test from its generated code when its kept code
 * proves it: the web engine hands the Playwright Test file to the project's
 * own `@playwright/test`, no model and no agent step involved. A test the code
 * fails goes to the agent in the same run, and its code is written again; a
 * project without `@playwright/test` says so once and runs every test on the
 * agent, as before.
 */

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import type { ModelInstance } from '../../src/types.ts';
import { installFakeModel, type FakeCall } from '../helpers/fake-model.ts';
import type { RunEvent } from '../../src/run/events.ts';

const SUITE = `import { test, expect } from 'e2e';

test('increments through the agent', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('increment the counter once');
  await agent.assert('the counter shows 1');
  await expect(screen.getByRole('status')).toHaveText('1');
});

test('opens the about page', async ({ app, screen }) => {
  await app.open('/about');
  await expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
});
`;

/**
 * An e2e file that imports a helper by a relative path: its generated file
 * keeps the import, which points nowhere from the generated folder, so the
 * file never loads. It must not keep the other file's tests from their code.
 */
const HELPED_SUITE = `import { test, expect } from 'e2e';
import { aboutPath } from './paths.ts';

test('opens the about page through a helper', async ({ app, screen }) => {
  await app.open(aboutPath);
  await expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
});
`;

/** Taps Increment once per act and passes every judgment, with no model; counts the steps it was given. */
const EXECUTOR_MODULE = `export const tapper = {
  name: 'tapper',
  version: '1',
  async runStep(context) {
    const counted = globalThis;
    counted.tapperSteps = (counted.tapperSteps ?? 0) + 1;
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

/** The judge of the checks question: the counter's text proves the assertion. */
function judge(call: FakeCall): unknown {
  if (call.schemaName !== 'agent-codegen-checks-1') throw new Error(`unexpected ${call.schemaName}`);
  const line = call.lines.find((candidate) => /status "Counter"/u.test(candidate)) ?? '';
  return { checks: [{ kind: 'text', node: /#(\S+)/u.exec(line)?.[1] ?? null, text: '1', covers: 'the counter shows 1' }], uncovered: [] };
}

const SPEC = path.join('e2e-gen', 'tests', 'counter.gen.spec.ts');
const RECORD = path.join('.e2e', 'codegen', 'web', 'tests', 'counter.e2e.ts.json');
/** Where the workspace keeps `@playwright/test`: a dev dependency of the web engine. */
const PLAYWRIGHT_TEST = path.dirname(createRequire(new URL('../../../web/package.json', import.meta.url)).resolve('@playwright/test/package.json'));

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('--codegen runs a test from its generated code', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let executor: StepExecutor;
  let model: ModelInstance;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'tests/counter.e2e.ts': SUITE,
      'tests/helped.e2e.ts': HELPED_SUITE,
      'tests/paths.ts': "export const aboutPath = '/about';\n",
      'tapper.ts': EXECUTOR_MODULE,
    });
    mkdirSync(path.join(project.dir, 'node_modules', '@playwright'), { recursive: true });
    symlinkSync(PLAYWRIGHT_TEST, path.join(project.dir, 'node_modules', '@playwright', 'test'), 'dir');
    executor = ((await import(path.join(project.dir, 'tapper.ts'))) as { tapper: StepExecutor }).tapper;
    model = installFakeModel(judge);
    const first = await codegenRun();
    expect(first.outcome.results.map((result) => [result.test.title, result.status])).toEqual([
      ['increments through the agent', 'passed'],
      ['opens the about page', 'passed'],
      ['opens the about page through a helper', 'passed'],
    ]);
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  /** One `--codegen` run, with the steps the agent ran and the events it emitted. */
  async function codegenRun() {
    const counted = globalThis as { tapperSteps?: number };
    counted.tapperSteps = 0;
    const events: RunEvent[] = [];
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor, model } } },
      runOptions: {
        codegen: true,
        onEvent: (event) => {
          events.push(event);
        },
      },
    });
    return { outcome, events, agentSteps: counted.tapperSteps };
  }

  const finished = (events: readonly RunEvent[]) => events.find((event) => event.type === 'run-finished');

  it('passes every test from its code, with no agent step, and keeps the code as it was', async () => {
    const before = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const { outcome, events, agentSteps } = await codegenRun();
    expect(agentSteps).toBe(0);
    const steps = (title: string) => resultByTitle(outcome, title).attempts[0]?.steps.length;
    expect(['increments through the agent', 'opens the about page'].map((title) => [resultByTitle(outcome, title).status, steps(title)])).toEqual([
      ['passed', 0],
      ['passed', 0],
    ]);
    // The file that cannot load runs on its own and goes to the agent; the other's tests still passed from code.
    expect(resultByTitle(outcome, 'opens the about page through a helper').status).toBe('passed');
    expect(steps('opens the about page through a helper')).toBeGreaterThan(0);
    const ran = outcome.report.run.codegen?.ran ?? [];
    expect(ran.map((entry) => [entry.test, entry.status, entry.file])).toEqual([
      ['increments through the agent', 'passed', 'e2e-gen/tests/counter.gen.spec.ts'],
      ['opens the about page', 'passed', 'e2e-gen/tests/counter.gen.spec.ts'],
      ['opens the about page through a helper', 'not-run', 'e2e-gen/tests/helped.gen.spec.ts'],
    ]);
    expect(ran[2]!.reason).toContain('paths');
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toBe(before);
    const end = finished(events);
    expect(end?.type === 'run-finished' ? end.codegen?.fromCode : undefined).toEqual({ passed: 2, toAgent: 1 });
    expect(events.some((event) => event.type === 'setup' && event.step.kind === 'code' && event.state === 'finished')).toBe(true);
  }, 120_000);

  it('runs a test the code fails on the agent in the same run, and writes its code again', async () => {
    // The app moved under the code: the button the code clicks is gone, as a renamed one would be.
    const good = readFileSync(path.join(project.dir, SPEC), 'utf8');
    const drifted = good.replace('{ name: "Increment", exact: true }', '{ name: "Add one", exact: true }');
    expect(drifted).not.toBe(good);
    writeFileSync(path.join(project.dir, SPEC), drifted, 'utf8');
    const record = JSON.parse(readFileSync(path.join(project.dir, RECORD), 'utf8')) as { codeDigest: string };
    record.codeDigest = sha(drifted);
    writeFileSync(path.join(project.dir, RECORD), JSON.stringify(record), 'utf8');

    const { outcome, events, agentSteps } = await codegenRun();
    expect(agentSteps).toBeGreaterThan(0);
    const counter = resultByTitle(outcome, 'increments through the agent');
    expect(counter.status).toBe('passed');
    expect(counter.attempts[0]!.steps.map((step) => step.api)).toContain('agent.act');
    const ran = outcome.report.run.codegen?.ran ?? [];
    expect(ran.map((entry) => [entry.test, entry.status])).toEqual([
      ['increments through the agent', 'failed'],
      ['opens the about page', 'passed'],
      ['opens the about page through a helper', 'not-run'],
    ]);
    expect(ran[0]!.reason).toContain('Add one');
    expect(readFileSync(path.join(project.dir, SPEC), 'utf8')).toBe(good);
    expect(events.some((event) => event.type === 'notice' && event.message.includes('the generated code did not pass 2 tests of target "web"'))).toBe(true);
    const end = finished(events);
    expect(end?.type === 'run-finished' ? end.codegen?.fromCode : undefined).toEqual({ passed: 1, toAgent: 2 });
  }, 120_000);

  it('runs every test on the agent, with one notice, when the project has no @playwright/test', async () => {
    rmSync(path.join(project.dir, 'node_modules'), { recursive: true, force: true });
    const { outcome, events, agentSteps } = await codegenRun();
    expect(agentSteps).toBeGreaterThan(0);
    expect(outcome.results.every((result) => result.status === 'passed')).toBe(true);
    expect(outcome.report.run.codegen?.ran?.map((entry) => [entry.test, entry.status])).toEqual([
      ['increments through the agent', 'not-run'],
      ['opens the about page', 'not-run'],
      ['opens the about page through a helper', 'not-run'],
    ]);
    const notices = events.flatMap((event) => (event.type === 'notice' && event.message.includes('ran no generated code') ? [event.message] : []));
    expect(notices).toEqual([
      '--codegen ran no generated code for target "web", so the agent runs its tests: @playwright/test is not installed in the project; add it as a dev dependency to run the generated code',
    ]);
  }, 120_000);
});
