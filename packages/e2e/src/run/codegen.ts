/**
 * `e2e run --codegen`: the agent steps of passing tests, written out as each
 * target engine's own test code.
 *
 * In the worker, every attempt keeps a `CodegenLog`: each `agent.act` step
 * records the grammar actions it committed through a `TraceRecorder` of its
 * own, the recorder the replay cache uses, so the actions carry the same
 * durable, redacted descriptors whatever the cache mode is and whether the
 * model or a replay performed them. The last attempt's recordings ride the
 * test's result message to the runner.
 *
 * In the runner, `CodegenCollector` pairs the recordings with the steps of the
 * passing results, groups the tests by file and target, and hands each group
 * to the target engine's `codegen.render`. The runner never reads the code it
 * gets back; it writes it under `<output>/codegen/<target>/`.
 */

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RecordableAction } from '../agent/actions.ts';
import { TraceRecorder } from '../cache/recorder.ts';
import type { DerivedReason } from '../cache/trace.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { CodegenFile, CodegenJudgment, CodegenRecording, CodegenStep, CodegenTest } from '../engine/codegen.ts';
import { writeTextReport } from '../report/write.ts';
import { sanitizePathSegment } from './artifacts.ts';
import { outputLayout } from './output.ts';
import type { ResultRecord } from './records.ts';

/** What one step left for code: an act's actions, or a judgment's checks. */
export interface CodegenStepData {
  readonly recording?: CodegenRecording;
  readonly judgment?: CodegenJudgment;
}

/** One attempt's recordings, keyed by the step id the report gives the step. */
export interface CodegenAttempt {
  readonly attemptId: string;
  readonly steps: Readonly<Record<string, CodegenStepData>>;
}

/** What an `agent.act` step tells its recording, mirroring the replay cache's recording calls. */
export interface CodegenStepRecorder {
  /** One committed grammar action, and where the surface was when it ran. */
  record(action: RecordableAction, location: string | undefined): void;
  /** A mutating project-tool call: code cannot reproduce it. */
  recordGap(toolName: string): void;
  /** A typed value that was this run's data rather than the flow's. */
  recordDerivedGap(reason: DerivedReason): void;
}

/** The recording of one attempt's `agent.act` steps. */
export class CodegenLog {
  private readonly steps = new Map<string, { readonly recorder: TraceRecorder; startLocation: string | undefined }>();
  private readonly judgments = new Map<string, CodegenJudgment>();

  constructor(readonly attemptId: string) {}

  /**
   * Opens one step's recording. `redact` and `redactCut` are the attempt's
   * ledger, so a recorded string never carries a registered secret: a value
   * the ledger would alter is masked and the recording marked incomplete.
   */
  open(stepId: string, redaction: { readonly redact: (text: string) => string; readonly redactCut: (text: string) => string }): CodegenStepRecorder {
    const step = { recorder: new TraceRecorder(redaction), startLocation: undefined as string | undefined };
    this.steps.set(stepId, step);
    return {
      record: (action, location) => {
        if (step.recorder.recordedCount === 0) step.startLocation = location;
        step.recorder.record(action);
      },
      recordGap: (toolName) => step.recorder.recordGap(toolName),
      recordDerivedGap: (reason) => step.recorder.recordDerivedGap(reason),
    };
  }

  /** Keeps what a passing judgment step left for code: the checks that prove it, and an extraction's value. */
  judged(stepId: string, judgment: CodegenJudgment): void {
    this.judgments.set(stepId, judgment);
  }

  /** The act steps that committed at least one action and the judgments that passed, by step id. */
  snapshot(): CodegenAttempt {
    const steps: Record<string, CodegenStepData> = {};
    for (const [stepId, { recorder, startLocation }] of this.steps) {
      if (recorder.recordedCount === 0) continue;
      steps[stepId] = {
        recording: {
          ...(startLocation === undefined ? {} : { startLocation }),
          actions: [...recorder.recorded],
          incomplete: recorder.incomplete,
        },
      };
    }
    for (const [stepId, judgment] of this.judgments) steps[stepId] = { ...steps[stepId], judgment };
    return { attemptId: this.attemptId, steps };
  }
}

/** What one `--codegen` write produced. */
export interface CodegenOutput {
  /** Absolute `<output>/codegen` directory. */
  readonly dir: string;
  /** Absolute paths of the files written, in write order. */
  readonly files: readonly string[];
  /** Targets with passing tests whose engine declares no `codegen`. */
  readonly unsupported: readonly { readonly target: string; readonly engine: string }[];
}

/** One test on its way to a file: its target, file, and steps. */
interface CollectedTest {
  readonly result: ResultRecord;
  readonly test: CodegenTest;
}

/** Collects passing results and their recordings in the runner, then writes the engines' code. */
export class CodegenCollector {
  private readonly tests: CollectedTest[] = [];

  /**
   * Keeps a result whose last attempt passed, with the recordings that
   * attempt shipped. A serial member carries its steps on its group and is
   * left out, as is a failing, skipped, or interrupted result: code written
   * from a run that did not pass would freeze a broken flow.
   */
  add(result: ResultRecord, recordings: CodegenAttempt | undefined): void {
    const attempt = result.attempts.at(-1);
    if (attempt === undefined || attempt.status !== 'passed') return;
    const recorded = recordings?.attemptId === attempt.id ? recordings.steps : {};
    const steps = attempt.steps.map((step): CodegenStep => {
      const data = recorded[step.id];
      return {
        api: step.api,
        label: step.label,
        ...(step.source === undefined ? {} : { line: step.source.line, column: step.source.column }),
        ...(data?.recording === undefined ? {} : { recording: data.recording }),
        ...(data?.judgment === undefined ? {} : { judgment: data.judgment }),
      };
    });
    this.tests.push({ result, test: { title: result.test.title, titlePath: [...result.test.titlePath], steps } });
  }

  /**
   * Replaces `<output>/codegen` with one file per test file and target, in
   * the order the tests were declared. A target whose engine writes no code
   * is reported back, not failed: the run asked every target, and only some
   * engines speak a test language of their own.
   */
  async write(config: ResolvedConfig): Promise<CodegenOutput> {
    const dir = outputLayout(config.output).codegen;
    await rm(dir, { recursive: true, force: true });
    const groups = new Map<string, CollectedTest[]>();
    for (const collected of this.tests) {
      const key = JSON.stringify([collected.result.target.name, collected.result.test.file]);
      const group = groups.get(key) ?? [];
      group.push(collected);
      groups.set(key, group);
    }
    const files: string[] = [];
    const unsupported = new Map<string, string>();
    for (const group of groups.values()) {
      const first = group[0]!;
      const { target } = first.result;
      const codegen = target.engine?.codegen;
      if (codegen === undefined) {
        unsupported.set(target.name, target.engine?.name ?? 'none');
        continue;
      }
      const ordered = group.toSorted(
        (a, b) => a.result.test.declarationIndex - b.result.test.declarationIndex || a.result.repeat - b.result.repeat,
      );
      const source = await readFile(path.join(config.projectRoot, first.result.test.file), 'utf8').catch(() => undefined);
      const usernames = Object.fromEntries([...config.credentials.values()].map((credential) => [credential.name, credential.username]));
      const file: CodegenFile = {
        file: first.result.test.file,
        target: target.name,
        ...(target.app.base === undefined ? {} : { appUrl: target.app.base.href }),
        ...(source === undefined ? {} : { source }),
        ...(Object.keys(usernames).length === 0 ? {} : { usernames }),
        tests: uniqueTests(ordered),
      };
      const output = path.join(dir, sanitizePathSegment(target.name), ...outputSegments(file.file, codegen.extension));
      await writeTextReport(output, codegen.render(file));
      files.push(output);
    }
    return { dir, files, unsupported: [...unsupported].map(([targetName, engine]) => ({ target: targetName, engine })) };
  }
}

/**
 * One entry per test: a test run as several agents or repeats passed more
 * than once, and its first passing run stands for the rest.
 */
function uniqueTests(ordered: readonly CollectedTest[]): CodegenTest[] {
  const seen = new Set<string>();
  const tests: CodegenTest[] = [];
  for (const { result, test } of ordered) {
    if (seen.has(result.test.id)) continue;
    seen.add(result.test.id);
    tests.push(test);
  }
  return tests;
}

/** The suffixes a test file name carries that the written file replaces with the engine's extension. */
const TEST_FILE_SUFFIX = /(?:\.e2e)?\.[cm]?[jt]sx?$/u;

/**
 * The path segments a test file's code is written at under the target's
 * directory: the file's own path, each segment sanitized so nothing climbs
 * out of it, with the engine's extension in place of the test suffix.
 */
function outputSegments(file: string, extension: string): string[] {
  const segments = file.split('/').filter((segment) => segment !== '' && segment !== '.');
  const name = segments.pop() ?? 'tests';
  return [...segments.map(sanitizePathSegment), sanitizePathSegment(`${name.replace(TEST_FILE_SUFFIX, '')}${extension}`)];
}
