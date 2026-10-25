/**
 * `e2e run --codegen` before the agent: every selected test whose kept code
 * proves it (`runnableCode`) runs from that code first, through its target
 * engine's `codegen.run`, once the app is up and before any worker starts. A
 * test the code passed is done, its result the code's, and its code and record
 * stay as they are. A test the code failed, or could not run, goes to the agent
 * as if the code were not there, and its code is written again from that run.
 *
 * Only a test that runs alone on its target can stand on its code: a setup
 * test, a test that uses a saved session or belongs to a serial group, and a
 * test run as several agents or repeats always go to the agent.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { TestTargetPair } from '../collect/select.ts';
import { envName } from '../config/secrets.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { CodegenRunFile, CodegenRunResult } from '../engine/codegen.ts';
import { errorMessage } from '../internal/errors.ts';
import { uuidv7 } from '../internal/ids.ts';
import { createRedactor } from '../internal/redact.ts';
import type { CodeRun, RunnableCode } from './codegen-sync.ts';
import { outputLayout } from './output.ts';
import type { ResultRecord } from './records.ts';
import { pairResult, pairKey, type TargetWorkPlan, type WorkUnit } from './units.ts';

/** What the runner hands the code phase. */
export interface CodeRunInput {
  readonly config: ResolvedConfig;
  readonly plans: readonly TargetWorkPlan[];
  readonly runnable: readonly RunnableCode[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  /** Wraps one target's code run as a setup step. */
  readonly step: <T>(target: string, tests: number, work: () => Promise<T>) => Promise<T>;
  readonly notice: (target: string, message: string) => void;
  /** A test the code passed: its result, final. */
  readonly onResult: (result: ResultRecord) => void;
}

/** What the code phase leaves for the agent, and what it did. */
export interface CodeRunOutput {
  /** The plans without the pairs the code passed. */
  readonly plans: TargetWorkPlan[];
  readonly ran: readonly CodeRun[];
}

/** The most characters of one failure's reason the report keeps. */
const MAX_REASON_LENGTH = 2_000;

/**
 * Runs each target's runnable tests from their code, then returns the plans
 * with the pairs it passed taken out. A target whose engine cannot run code,
 * or whose code could not run, keeps all its pairs, with one notice.
 */
export async function runFromCode(input: CodeRunInput): Promise<CodeRunOutput> {
  const { config } = input;
  const ran: CodeRun[] = [];
  const passed = new Set<string>();
  const secrets = await codeSecrets(config, input.env);
  const redact = createRedactor(secrets.values);
  const workRoot = outputLayout(config.output).codeRun;
  await rm(workRoot, { recursive: true, force: true });
  try {
    await runTargets();
  } finally {
    // What the engine wrote there (its report, the code's own output) is unredacted. A
    // failure here must not throw away the results already reported; the next run empties it.
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  return { plans: input.plans.map((plan) => withoutPassed(plan, passed)), ran };

  async function runTargets(): Promise<void> {
    for (const plan of input.plans) {
      if (input.signal.aborted) break;
      const engine = plan.target.engine?.codegen;
      if (engine?.run === undefined) continue;
      const pairs = runnablePairs(plan, input.runnable);
      if (pairs.length === 0) continue;
      const target = plan.target.name;
      const files = new Map<string, { code: string; tests: { id: string; titlePath: readonly string[] }[] }>();
      for (const { pair, code } of pairs) {
        const entry = files.get(code.code) ?? { code: code.code, tests: [] };
        entry.tests.push({ id: pair.test.id, titlePath: [...pair.test.titlePath] });
        files.set(code.code, entry);
      }
      const request: CodegenRunFile[] = [...files.values()].map(({ code, tests }) => ({ path: code, tests }));
      let result: CodegenRunResult;
      try {
        result = await input.step(target, pairs.length, () =>
          engine.run!({
            projectRoot: config.projectRoot,
            workDir: path.join(workRoot, encodeURIComponent(target)),
            files: request,
            ...(plan.target.app.base === undefined ? {} : { appUrl: plan.target.app.base.href }),
            timeoutMs: config.timeout,
            actionTimeoutMs: config.actionTimeout,
            assertionTimeoutMs: config.assertionTimeout,
            workers: config.workers,
            env: { ...input.env, ...secrets.env },
            signal: input.signal,
          }),
        );
      } catch (cause) {
        result = { kind: 'unavailable', reason: errorMessage(cause) };
      }
      if (input.signal.aborted) break;
      const relative = (absolute: string): string => path.relative(config.projectRoot, absolute).split(path.sep).join('/');
      const entry = (pair: TestTargetPair, code: RunnableCode): Pick<CodeRun, 'source' | 'test' | 'target' | 'file'> => ({
        source: pair.test.file,
        test: pair.test.title,
        target,
        file: relative(code.code),
      });
      if (result.kind === 'unavailable') {
        const reason = bounded(redact(result.reason));
        input.notice(target, `--codegen ran no generated code for target "${target}", so the agent runs its tests: ${reason}`);
        for (const { pair, code } of pairs) ran.push({ ...entry(pair, code), status: 'not-run', reason });
        continue;
      }
      const outcomes = new Map(result.tests.map((outcome) => [outcome.id, outcome]));
      let fellBack = 0;
      for (const { pair, code } of pairs) {
        const outcome = outcomes.get(pair.test.id);
        if (outcome === undefined) {
          fellBack += 1;
          ran.push({ ...entry(pair, code), status: 'not-run', reason: result.notRun === undefined ? 'the generated code did not run this test' : bounded(redact(result.notRun)) });
          continue;
        }
        if (outcome.status === 'failed') {
          fellBack += 1;
          ran.push({
            ...entry(pair, code),
            status: 'failed',
            durationMs: outcome.durationMs,
            ...(outcome.error === undefined ? {} : { reason: bounded(redact(outcome.error)) }),
          });
          continue;
        }
        ran.push({ ...entry(pair, code), status: 'passed', durationMs: outcome.durationMs });
        passed.add(planKey(target, pair));
        input.onResult(
          pairResult(pair, {
            status: 'passed',
            selected: true,
            attempts: [
              {
                id: uuidv7(),
                index: 0,
                status: 'passed',
                startedAt: outcome.startedAt,
                durationMs: outcome.durationMs,
                steps: [],
                artifacts: [],
                secondaryErrors: [],
                cleanup: 'complete',
              },
            ],
          }),
        );
      }
      if (fellBack > 0) {
        input.notice(target, `--codegen: the generated code did not pass ${String(fellBack)} ${fellBack === 1 ? 'test' : 'tests'} of target "${target}", so the agent runs ${fellBack === 1 ? 'it' : 'them'} and writes ${fellBack === 1 ? 'its' : 'their'} code again`);
      }
    }
  }
}

/** The pairs of a plan the code may run: each with the code that proves it. */
function runnablePairs(plan: TargetWorkPlan, runnable: readonly RunnableCode[]): { pair: TestTargetPair; code: RunnableCode }[] {
  const target = plan.target.name;
  const byFile = new Map(runnable.filter((code) => code.target === target).map((code) => [code.file, code]));
  const pairs = plan.fileUnits.flatMap((unit) => unit.pairs);
  const runs = new Map<string, number>();
  for (const pair of pairs) runs.set(pair.test.id, (runs.get(pair.test.id) ?? 0) + 1);
  return pairs.flatMap((pair) => {
    const { test } = pair;
    if (test.kind !== 'test' || test.serialId !== undefined || test.sessions.length > 0 || pair.repeat !== 0 || runs.get(test.id) !== 1) return [];
    const code = byFile.get(test.file);
    return code?.tests.has(test.id) === true ? [{ pair, code }] : [];
  });
}

/** A pair's key across a run's plans. */
function planKey(target: string, pair: TestTargetPair): string {
  return `${target}\u0000${pairKey(pair.test.id, pair.agent, pair.repeat)}`;
}

/** A plan without the pairs the code passed, and without the file units that leaves empty. */
function withoutPassed(plan: TargetWorkPlan, passed: ReadonlySet<string>): TargetWorkPlan {
  if (passed.size === 0) return plan;
  const fileUnits = plan.fileUnits.flatMap((unit): WorkUnit[] => {
    const pairs = unit.pairs.filter((pair) => !passed.has(planKey(plan.target.name, pair)));
    if (pairs.length === unit.pairs.length) return [unit];
    return pairs.length === 0 ? [] : [{ ...unit, pairs }];
  });
  return { ...plan, fileUnits };
}

/**
 * The variables the generated code reads a configured secret or credential
 * from, set to the configured value where the environment does not already
 * set them, and every value, for the redactor of what the code reports. A
 * provider is asked once; one that fails leaves its variable unset, so a test
 * that needs it fails in the code and goes to the agent.
 */
async function codeSecrets(
  config: ResolvedConfig,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ env: Record<string, string>; values: [string, string][] }> {
  const set: Record<string, string> = {};
  const values: [string, string][] = [];
  const resolve = async (value: string | (() => string | Promise<string>)): Promise<string | undefined> => {
    try {
      return typeof value === 'string' ? value : await value();
    } catch {
      return undefined;
    }
  };
  const put = (variable: string, value: string | undefined): void => {
    if (value === undefined || value === '') return;
    if (env[variable] === undefined) set[variable] = value;
  };
  for (const secret of config.secrets.values()) {
    const value = await resolve(secret.value);
    if (value !== undefined) values.push([secret.name, value]);
    put(envName('E2E_SECRET', secret.name), value);
  }
  for (const credential of config.credentials.values()) {
    const value = await resolve(credential.password.value);
    if (value !== undefined) values.push([credential.password.name, value]);
    put(`${envName('E2E_USER', credential.name)}_USERNAME`, credential.username);
    put(`${envName('E2E_USER', credential.name)}_PASSWORD`, value);
  }
  return { env: set, values };
}

/** A reason cut to what the report keeps. */
function bounded(text: string): string {
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}
