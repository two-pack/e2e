/**
 * `runFromCode`: which selected tests a `--codegen` run gives to their kept
 * code before the agent, what it does with the engine's answer, and what the
 * code's environment carries.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectedTest } from '../../src/collect/collect.ts';
import type { TestTargetPair } from '../../src/collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '../../src/config/resolve.ts';
import type { CodegenRunRequest, CodegenRunResult } from '../../src/engine/codegen.ts';
import { runFromCode } from '../../src/run/codegen-run.ts';
import type { RunnableCode } from '../../src/run/codegen-sync.ts';
import type { ResultRecord } from '../../src/run/records.ts';
import type { TargetWorkPlan } from '../../src/run/units.ts';

const FILE = 'tests/todo.e2e.ts';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A target whose engine's `run` answers with `answer` and keeps every request it got. */
function target(answer: (request: CodegenRunRequest) => CodegenRunResult, requests: CodegenRunRequest[]): ResolvedTarget {
  return {
    name: 'web',
    app: { base: new URL('http://127.0.0.1:4000/') },
    engine: {
      name: 'web',
      codegen: {
        extension: '.gen.spec.ts',
        render: () => ({ code: '', gaps: [], failures: [] }),
        run: (request: CodegenRunRequest) => {
          requests.push(request);
          return Promise.resolve(answer(request));
        },
      },
    },
  } as unknown as ResolvedTarget;
}

function pair(on: ResolvedTarget, title: string, options: { sessions?: string[]; repeat?: number; agent?: string; serialId?: string } = {}): TestTargetPair {
  const test = {
    kind: 'test',
    title,
    titlePath: [title],
    id: `${FILE}::${title}`,
    file: FILE,
    sessions: options.sessions ?? [],
    serialId: options.serialId,
    tags: [],
    declarationIndex: 0,
    source: undefined,
  } as unknown as CollectedTest;
  return { test, target: on, agent: options.agent ?? 'default', repeat: options.repeat ?? 0, options: {} as TestTargetPair['options'], disposition: 'run', skip: undefined };
}

function plan(on: ResolvedTarget, pairs: readonly TestTargetPair[]): TargetWorkPlan {
  return { target: on, setupUnits: [], immediate: [], fileUnits: [{ id: 'unit', kind: 'file', targetName: on.name, file: FILE, absolutePath: `/p/${FILE}`, pairs }] };
}

function config(extra: Partial<Record<'secrets' | 'credentials', Map<string, unknown>>> = {}): ResolvedConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-code-run-'));
  roots.push(root);
  return {
    projectRoot: root,
    output: path.join(root, '.e2e'),
    timeout: 60_000,
    actionTimeout: 30_000,
    assertionTimeout: 5_000,
    workers: 2,
    secrets: extra.secrets ?? new Map(),
    credentials: extra.credentials ?? new Map(),
  } as unknown as ResolvedConfig;
}

function runnable(root: string, titles: readonly string[]): RunnableCode[] {
  return [{ file: FILE, target: 'web', code: path.join(root, 'e2e-gen', 'tests', 'todo.gen.spec.ts'), tests: new Map(titles.map((title) => [`${FILE}::${title}`, [title]])) }];
}

/** Runs the phase and collects what it reported. */
async function phase(input: { config: ResolvedConfig; plans: TargetWorkPlan[]; runnable: RunnableCode[]; env?: Record<string, string> }) {
  const results: ResultRecord[] = [];
  const notices: string[] = [];
  const output = await runFromCode({
    ...input,
    env: input.env ?? {},
    signal: new AbortController().signal,
    step: (_target, _tests, work) => work(),
    notice: (_target, message) => notices.push(message),
    onResult: (result) => results.push(result),
  });
  return { ...output, results, notices };
}

describe('runFromCode', () => {
  it("reports the tests the code passed as passed and takes them out of the plans; the agent gets the rest", async () => {
    const requests: CodegenRunRequest[] = [];
    const web = target(
      () => ({
        kind: 'ran',
        tests: [
          { id: `${FILE}::passes`, status: 'passed', startedAt: '2026-10-25T00:00:00.000Z', durationMs: 120 },
          { id: `${FILE}::fails`, status: 'failed', startedAt: '2026-10-25T00:00:00.000Z', durationMs: 900, error: 'locator not found' },
        ],
      }),
      requests,
    );
    const settings = config();
    const pairs = [pair(web, 'passes'), pair(web, 'fails'), pair(web, 'skipped by the code')];
    const out = await phase({ config: settings, plans: [plan(web, pairs)], runnable: runnable(settings.projectRoot, ['passes', 'fails', 'skipped by the code']) });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ appUrl: 'http://127.0.0.1:4000/', timeoutMs: 60_000, actionTimeoutMs: 30_000, assertionTimeoutMs: 5_000, workers: 2 });
    expect(requests[0]!.files[0]!.tests.map((test) => test.titlePath)).toEqual([['passes'], ['fails'], ['skipped by the code']]);
    expect(out.results.map((result) => [result.test.title, result.status, result.attempts[0]?.durationMs])).toEqual([['passes', 'passed', 120]]);
    expect(out.plans[0]!.fileUnits[0]!.pairs.map((left) => left.test.title)).toEqual(['fails', 'skipped by the code']);
    expect(out.ran.map((entry) => [entry.test, entry.status, entry.reason])).toEqual([
      ['passes', 'passed', undefined],
      ['fails', 'failed', 'locator not found'],
      ['skipped by the code', 'not-run', 'the generated code did not run this test'],
    ]);
    expect(out.ran[0]).toMatchObject({ source: FILE, target: 'web', file: 'e2e-gen/tests/todo.gen.spec.ts' });
    expect(out.notices).toEqual(['--codegen: the generated code did not pass 2 tests of target "web", so the agent runs them and writes their code again']);
  });

  it('never gives the code a setup test, a test with a session or in a serial group, a repeat, or a test run as several agents', async () => {
    const requests: CodegenRunRequest[] = [];
    const web = target(() => ({ kind: 'ran', tests: [] }), requests);
    const settings = config();
    const setup = pair(web, 'setup');
    const pairs = [
      { ...setup, test: { ...setup.test, kind: 'setup' } } as TestTargetPair,
      pair(web, 'session', { sessions: ['admin'] }),
      pair(web, 'serial', { serialId: 'group' }),
      pair(web, 'repeated', { repeat: 1 }),
      pair(web, 'two agents', { agent: 'a' }),
      pair(web, 'two agents', { agent: 'b' }),
      pair(web, 'not kept'),
    ];
    const out = await phase({ config: settings, plans: [plan(web, pairs)], runnable: runnable(settings.projectRoot, ['setup', 'session', 'serial', 'repeated', 'two agents']) });
    expect(requests).toEqual([]);
    expect(out.ran).toEqual([]);
    expect(out.plans[0]!.fileUnits[0]!.pairs).toHaveLength(pairs.length);
  });

  it('says once why the code could not run and leaves every test to the agent, the reason redacted', async () => {
    const web = target(() => ({ kind: 'unavailable', reason: 'could not log in with hunter2-pass' }), []);
    const settings = config({ secrets: new Map([['token', { name: 'token', purpose: 'generic-secret', value: 'hunter2-pass' }]]) });
    const out = await phase({ config: settings, plans: [plan(web, [pair(web, 'a')])], runnable: runnable(settings.projectRoot, ['a']) });
    expect(out.results).toEqual([]);
    expect(out.plans[0]!.fileUnits[0]!.pairs).toHaveLength(1);
    expect(out.notices).toEqual(['--codegen ran no generated code for target "web", so the agent runs its tests: could not log in with <secret:token>']);
    expect(out.ran.map((entry) => [entry.status, entry.reason])).toEqual([['not-run', 'could not log in with <secret:token>']]);
  });

  it("hands the code each configured secret and credential under the variable that overrides it, never over one the environment sets", async () => {
    const requests: CodegenRunRequest[] = [];
    const web = target(() => ({ kind: 'ran', tests: [] }), requests);
    const settings = config({
      secrets: new Map([
        ['api-key', { name: 'api-key', purpose: 'generic-secret', value: 'static-api-key' }],
        ['otp', { name: 'otp', purpose: 'generic-secret', value: () => Promise.resolve('provided-otp') }],
      ]),
      credentials: new Map([['admin', { name: 'admin', username: 'root', password: { name: 'admin.password', purpose: 'password', value: 'admin-pass' } }]]),
    });
    await phase({ config: settings, plans: [plan(web, [pair(web, 'a')])], runnable: runnable(settings.projectRoot, ['a']), env: { E2E_SECRET_API_KEY: 'from-the-shell', HOME: '/home/me' } });
    expect(requests[0]!.env).toEqual({
      E2E_SECRET_API_KEY: 'from-the-shell',
      HOME: '/home/me',
      E2E_SECRET_OTP: 'provided-otp',
      E2E_USER_ADMIN_USERNAME: 'root',
      E2E_USER_ADMIN_PASSWORD: 'admin-pass',
    });
  });
});
