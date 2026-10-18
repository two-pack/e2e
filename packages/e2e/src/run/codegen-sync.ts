/**
 * `e2e run --codegen` across runs: one generated file per e2e file and
 * target, kept in step with the tests the way the replay cache keeps its
 * entries.
 *
 * Every test's last recordings are kept in a record per e2e file and target
 * under `<output>/codegen/`, beside the digest of the e2e source they were
 * recorded from and of the code last written from them. A run refreshes the
 * tests it ran: a pass replaces a test's recordings, and so does a failure
 * that says something about the app (as the cache judges it), whose code then
 * stops where it failed; anything else (a test the run did not select, an
 * interrupt, a failure where no model answered) leaves them. A test or an e2e file the project no longer has is
 * dropped with its code. A file none of whose tests ran, and whose source has
 * not changed, is left exactly as it is; any other is written again whole,
 * from the current source and the kept recordings, into `codegen.outDir`.
 *
 * What to keep, drop, and write is decided by `planCodegenSync`, which reads
 * no file; `CodegenSync` gathers its inputs and carries its decisions out.
 * The runner never reads the code an engine returns, except to digest it.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { CodegenFailure, CodegenFile, CodegenRendered, CodegenStep, CodegenTest } from '../engine/codegen.ts';
import type { ReportCodegen, ReportCodegenFailure, ReportCodegenGap } from '../report/build.ts';
import { writeJsonReport, writeTextReport } from '../report/write.ts';
import type { CodegenAttempt, CodegenScreenshot } from './codegen.ts';
import { outputLayout } from './output.ts';
import type { ResultRecord } from './records.ts';

/** The record format's version; a record of another one is read as absent. */
const CODEGEN_RECORD_VERSION = 1;

/** One test as a record keeps it: its last recordings, of a pass or of a failure that implicates the app, and where they came from. */
export interface StoredCodegenTest {
  /** The test's id: its file and title path. */
  readonly id: string;
  readonly test: CodegenTest;
  /** The e2e source the steps' line numbers refer to. */
  readonly sourceDigest: string;
  readonly runId: string;
  readonly recordedAt: string;
}

/** What `--codegen` keeps for one e2e file on one target between runs. */
export interface CodegenRecord {
  readonly version: typeof CODEGEN_RECORD_VERSION;
  /** The e2e file, project-root relative with `/` separators. */
  readonly file: string;
  readonly target: string;
  /** The e2e source the code was last written from. */
  readonly sourceDigest: string;
  /** The generated file, project-root relative. */
  readonly code: string;
  /** SHA-256 of the code as last written, to tell a file edited since. */
  readonly codeDigest: string;
  /** The run that last wrote the code, and when. */
  readonly runId: string;
  readonly writtenAt: string;
  /** The tests in declaration order. */
  readonly tests: readonly StoredCodegenTest[];
  /** The judgments the code did not prove whole when it was written. */
  readonly gaps: readonly CodegenGapRecord[];
  /** The tests whose code stops at a failure, as written. */
  readonly failures: readonly CodegenFailureRecord[];
}

/** One judgment the generated code does not prove whole, as the report and the records keep it. */
export type CodegenGapRecord = ReportCodegenGap;

/** One test whose code stops where it failed, as the report and the records keep it. */
export type CodegenFailureRecord = ReportCodegenFailure;

/** What this run did with one test, for its record. */
export type CodegenOutcome =
  /** It passed, or failed in a way that says something about the app: its recordings replace the kept ones. */
  | { readonly kind: 'recorded'; readonly test: StoredCodegenTest }
  /** It ran, but nothing it did says its kept recordings are wrong. */
  | { readonly kind: 'kept' };

/** The project's test files as this run collected them. */
export interface CodegenCollectionView {
  /** False for a run that did not collect the project's files (tests registered in memory): nothing is pruned. */
  readonly full: boolean;
  /** Each collected file's test ids, in declaration order. */
  readonly files: ReadonlyMap<string, readonly string[]>;
  /** Files that failed to collect: what is kept for them stays as it is. */
  readonly uncollected: ReadonlySet<string>;
}

/** What to do with one e2e file on one target. */
export type CodegenSyncAction =
  /** Nothing of it changed: its code and record stay as they are. */
  | { readonly kind: 'keep'; readonly record: CodegenRecord }
  /** The project no longer has it: its code and record go. */
  | { readonly kind: 'delete'; readonly record: CodegenRecord }
  /** Write its code again whole, from these tests; `fresh` are the ones this run recorded. */
  | {
      readonly kind: 'render';
      readonly file: string;
      readonly target: string;
      readonly tests: readonly StoredCodegenTest[];
      readonly fresh: ReadonlySet<string>;
      readonly previous: CodegenRecord | undefined;
    };

/** Key of one e2e file on one target. */
function recordKey(file: string, target: string): string {
  return JSON.stringify([target, file]);
}

/**
 * Decides, for every e2e file and target that has a record or ran in this
 * run, whether its code is kept, deleted, or written again, and from which
 * tests. Reads no file: `sources` holds each e2e file's current source digest.
 */
export function planCodegenSync(input: {
  readonly records: readonly CodegenRecord[];
  /** This run's outcomes by e2e file and target, then by test id. */
  readonly outcomes: ReadonlyMap<string, { readonly file: string; readonly target: string; readonly tests: ReadonlyMap<string, CodegenOutcome> }>;
  readonly collection: CodegenCollectionView;
  readonly sources: ReadonlyMap<string, string>;
}): CodegenSyncAction[] {
  const { collection } = input;
  const records = new Map(input.records.map((record) => [recordKey(record.file, record.target), record]));
  const keys = new Map<string, { file: string; target: string }>();
  for (const record of input.records) keys.set(recordKey(record.file, record.target), { file: record.file, target: record.target });
  for (const [key, { file, target }] of input.outcomes) keys.set(key, { file, target });
  const actions: CodegenSyncAction[] = [];
  for (const [key, { file, target }] of keys) {
    const record = records.get(key);
    const outcomes = input.outcomes.get(key)?.tests ?? new Map<string, CodegenOutcome>();
    const declared = collection.files.get(file);
    // A file only a full collection could have found and did not is gone; one
    // that failed to collect is a file mid-edit, kept as it was.
    if (declared === undefined && collection.full && !collection.uncollected.has(file)) {
      if (record !== undefined) actions.push({ kind: 'delete', record });
      continue;
    }
    const tests = new Map((record?.tests ?? []).map((stored) => [stored.id, stored]));
    const fresh = new Set<string>();
    for (const [id, outcome] of outcomes) {
      if (outcome.kind !== 'recorded') continue;
      tests.set(id, outcome.test);
      fresh.add(id);
    }
    let pruned = false;
    if (declared !== undefined) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const id of tests.keys()) {
        if (declared.includes(id)) continue;
        tests.delete(id);
        pruned = true;
      }
    }
    const source = input.sources.get(file);
    const sourceChanged = declared !== undefined && record !== undefined && source !== record.sourceDigest;
    if (record !== undefined && outcomes.size === 0 && !pruned && !sourceChanged) {
      actions.push({ kind: 'keep', record });
      continue;
    }
    // A file with nothing recorded, ever, has no code to write.
    if (record === undefined && tests.size === 0) continue;
    const order = declared ?? (record?.tests ?? []).map((stored) => stored.id);
    const ordered = [...tests.values()].toSorted((a, b) => rank(order, a.id) - rank(order, b.id));
    actions.push({ kind: 'render', file, target, tests: ordered, fresh, previous: record });
  }
  return actions;
}

/** A test's place in declaration order, unknown ids last. */
function rank(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * A kept test as the engine gets it to write from the current source: its
 * steps' lines dropped when the source changed since it was recorded, so a
 * call is matched by its instruction and order rather than by a line that
 * now belongs to another call.
 */
export function testForSource(stored: StoredCodegenTest, sourceDigest: string | undefined): CodegenTest {
  if (stored.sourceDigest === sourceDigest) return stored.test;
  return {
    ...stored.test,
    steps: stored.test.steps.map(({ line: _line, column: _column, ...step }) => step),
  };
}

/** What one `--codegen` write produced. */
export interface CodegenOutput {
  /** Absolute `codegen.outDir`. */
  readonly dir: string;
  /** Absolute paths of the files written in this run, in write order. */
  readonly files: readonly string[];
  /** Absolute paths of the files deleted because their e2e file or every test of it is gone. */
  readonly deleted: readonly string[];
  /** Targets with tests that ran whose engine declares no `codegen`. */
  readonly unsupported: readonly { readonly target: string; readonly engine: string }[];
  /** Every judgment the code does not prove whole, written in this run or kept from an earlier one. */
  readonly gaps: readonly CodegenGapRecord[];
  /** Every test whose code stops where it failed, written in this run or kept from an earlier one. */
  readonly failures: readonly CodegenFailureRecord[];
  /** Generated files that were edited by hand and written over, project-root relative. */
  readonly overwritten: readonly string[];
}

/** One test's result in this run, before its screenshots are placed. */
interface PendingOutcome {
  readonly result: ResultRecord;
  readonly outcome: 'passed' | 'failed' | 'kept';
  readonly recordings: CodegenAttempt | undefined;
}

/** The suffixes a test file name carries that the written file replaces with the engine's extension. */
const TEST_FILE_SUFFIX = /(?:\.e2e)?\.[cm]?[jt]sx?$/u;

/**
 * Where one e2e file's code goes: the e2e file's own path under `outDir`, its
 * test suffix replaced by the engine's extension, with the target's name
 * before it when more than one target writes code. Undefined for a path that
 * would climb out of `outDir`.
 */
export function generatedPath(outDir: string, file: string, extension: string, target: string | undefined): string | undefined {
  const segments = file.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return undefined;
  const name = segments.pop();
  if (name === undefined) return undefined;
  const stem = name.replace(TEST_FILE_SUFFIX, '');
  return path.join(outDir, ...segments, `${stem}${target === undefined ? '' : `.${target}`}${extension}`);
}

/** Where one e2e file's record goes under `<output>/codegen`. */
function recordPath(recordsDir: string, file: string, target: string): string {
  return path.join(recordsDir, encodeURIComponent(target), ...file.split('/').map((segment) => (segment === '..' ? '%2E%2E' : segment))) + '.json';
}

/** SHA-256 of a text, hex. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A path as the report keeps them: project-root relative with `/` separators. */
function relativeTo(projectRoot: string, absolute: string): string {
  return path.relative(projectRoot, absolute).split(path.sep).join('/');
}

/** Collects this run's results and their recordings in the runner, then brings the generated code in step with them. */
export class CodegenSync {
  private readonly pending: PendingOutcome[] = [];

  /**
   * Notes what a result's last attempt did. A pass is kept with its
   * recordings, and so is a failure the attempt says implicates the app, the
   * test's code then stopping where it failed; anything else (skipped,
   * interrupted, a failure where no model answered, a result whose attempt
   * recorded nothing) leaves the test's earlier code.
   */
  add(result: ResultRecord, recordings: CodegenAttempt | undefined): void {
    const attempt = result.attempts.at(-1);
    if (attempt === undefined) return;
    const own = recordings?.attemptId === attempt.id ? recordings : undefined;
    const outcome = attempt.status === 'passed' ? 'passed' : own?.implicates === true ? 'failed' : 'kept';
    this.pending.push({ result, outcome, recordings: own });
  }

  /**
   * Brings `codegen.outDir` and the records under `<output>/codegen` in step
   * with this run (`planCodegenSync`), and returns what it wrote, deleted,
   * and still leaves unproven.
   */
  async write(config: ResolvedConfig, collection: CodegenCollectionView, runId: string): Promise<CodegenOutput> {
    const recordsDir = outputLayout(config.output).codegen;
    const outDir = config.codegen.outDir;
    const writers = new Map(config.targets.flatMap((target) => (target.engine?.codegen === undefined ? [] : [[target.name, target.engine.codegen] as const])));
    // The name a file gets cannot depend on which targets a run selected, or it would move between runs.
    const named = writers.size > 1;
    const unsupported = new Map<string, string>();
    const outcomes = new Map<string, { file: string; target: string; tests: Map<string, CodegenOutcome> }>();
    const failedRuns = new Set<string>();
    const artifactsRoot = outputLayout(config.output).artifacts;
    const now = new Date().toISOString();
    for (const { result, outcome, recordings } of this.pending) {
      const target = result.target.name;
      if (!writers.has(target)) {
        if (outcome === 'passed') unsupported.set(target, result.target.engine?.name ?? 'none');
        continue;
      }
      const file = result.test.file;
      const key = recordKey(file, target);
      const entry = outcomes.get(key) ?? { file, target, tests: new Map<string, CodegenOutcome>() };
      outcomes.set(key, entry);
      const id = result.test.id;
      const current = entry.tests.get(id);
      const failed = failedRuns.has(`${key}\u0000${id}`);
      // A test run several times (repeats, agents) is written from its first failure that implicates the app, else its first pass.
      if (outcome === 'kept' ? current !== undefined : current?.kind === 'recorded' && (failed || outcome === 'passed')) continue;
      if (outcome === 'failed') failedRuns.add(`${key}\u0000${id}`);
      entry.tests.set(
        id,
        outcome === 'kept'
          ? { kind: 'kept' }
          : { kind: 'recorded', test: { id, test: codegenTest(result, recordings, config.projectRoot, artifactsRoot), sourceDigest: '', runId, recordedAt: now } },
      );
    }
    const records = await readRecords(recordsDir);
    const files = new Set([...records.map((record) => record.file), ...[...outcomes.values()].map((entry) => entry.file)]);
    const sources = new Map<string, string>();
    const texts = new Map<string, string>();
    for (const file of files) {
      const text = await readFile(path.join(config.projectRoot, file), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      texts.set(file, text);
      sources.set(file, digest(text));
    }
    // A pass this run was recorded against the source as it is now.
    for (const entry of outcomes.values()) {
      for (const [id, outcome] of entry.tests) {
        if (outcome.kind === 'recorded') entry.tests.set(id, { kind: 'recorded', test: { ...outcome.test, sourceDigest: sources.get(entry.file) ?? '' } });
      }
    }

    const written: string[] = [];
    const deleted: string[] = [];
    const overwritten: string[] = [];
    const gaps: CodegenGapRecord[] = [];
    const failures: CodegenFailureRecord[] = [];
    for (const action of planCodegenSync({ records, outcomes, collection, sources })) {
      if (action.kind === 'keep') {
        gaps.push(...action.record.gaps.map((gap) => carriedGap(gap, config.projectRoot)));
        failures.push(...(action.record.failures ?? []).map((failure) => carriedGap(failure, config.projectRoot)));
        continue;
      }
      if (action.kind === 'delete') {
        const code = path.join(config.projectRoot, action.record.code);
        if (isInside(code, outDir)) {
          await rm(code, { force: true });
          deleted.push(code);
          await pruneEmpty(path.dirname(code), outDir);
        }
        const record = recordPath(recordsDir, action.record.file, action.record.target);
        await rm(record, { force: true });
        await pruneEmpty(path.dirname(record), recordsDir);
        continue;
      }
      const codegen = writers.get(action.target)!;
      const output = generatedPath(outDir, action.file, codegen.extension, named ? action.target : undefined);
      if (output === undefined) continue;
      const source = texts.get(action.file);
      const sourceDigest = sources.get(action.file) ?? '';
      const target = config.targets.find((candidate) => candidate.name === action.target);
      const usernames = Object.fromEntries([...config.credentials.values()].map((credential) => [credential.name, credential.username]));
      const file: CodegenFile = {
        file: action.file,
        target: action.target,
        ...(target?.app.base === undefined ? {} : { appUrl: target.app.base.href }),
        ...(source === undefined ? {} : { source }),
        ...(Object.keys(usernames).length === 0 ? {} : { usernames }),
        tests: action.tests.map((stored) => testForSource(stored, sourceDigest)),
      };
      const rendered: CodegenRendered = codegen.render(file);
      const existing = await readFile(output, 'utf8').catch(() => undefined);
      if (existing !== undefined && existing !== rendered.code && (action.previous === undefined || digest(existing) !== action.previous.codeDigest)) {
        overwritten.push(relativeTo(config.projectRoot, output));
      }
      if (existing !== rendered.code) await writeTextReport(output, rendered.code);
      written.push(output);
      const code = relativeTo(config.projectRoot, output);
      const fileGaps = renderedGaps(rendered, action, code, config.projectRoot);
      gaps.push(...fileGaps);
      const fileFailures = renderedFailures(rendered, action, code, config.projectRoot);
      failures.push(...fileFailures);
      const record: CodegenRecord = {
        version: CODEGEN_RECORD_VERSION,
        file: action.file,
        target: action.target,
        sourceDigest,
        code,
        codeDigest: digest(rendered.code),
        runId,
        writtenAt: now,
        tests: action.tests,
        gaps: fileGaps.map(({ carried: _carried, ...gap }) => gap),
        failures: fileFailures.map(({ carried: _carried, ...failure }) => failure),
      };
      await writeJsonReport(recordPath(recordsDir, action.file, action.target), record);
    }
    return {
      dir: outDir,
      files: written,
      deleted,
      unsupported: [...unsupported].map(([target, engine]) => ({ target, engine })),
      gaps,
      failures,
      overwritten,
    };
  }
}

/** Why a failure's comment names no screenshot. */
const NO_FAILURE_SCREENSHOT = 'no screenshot was taken at the failure';

/**
 * A result's test with the recordings its attempt shipped, each judgment's
 * screenshot named on its gap by its project-root relative path, and, for a
 * failed attempt, the failure on the agent step it happened at or on the
 * test, with the screenshot taken at the failure.
 */
function codegenTest(result: ResultRecord, recordings: CodegenAttempt | undefined, projectRoot: string, artifactsRoot: string): CodegenTest {
  const attempt = result.attempts.at(-1);
  const recorded = recordings?.steps ?? {};
  const failedAt = attempt?.status === 'passed' ? -1 : (attempt?.steps ?? []).findIndex((step) => step.status !== 'passed' && step.error !== undefined);
  const failedStep = failedAt === -1 ? undefined : attempt?.steps[failedAt];
  const error = failedStep?.error ?? attempt?.error;
  let failure: CodegenFailure | undefined;
  if (attempt !== undefined && attempt.status !== 'passed' && error !== undefined) {
    const shot = attempt.failure?.screenshot === undefined ? undefined : attempt.artifacts.find((artifact) => artifact.id === attempt.failure?.screenshot)?.path;
    failure = {
      code: error.code,
      message: error.message,
      ...(failedStep?.explanation === undefined ? {} : { explanation: failedStep.explanation }),
      ...(shot === undefined ? { screenshotWithheld: NO_FAILURE_SCREENSHOT } : { screenshot: relativeTo(projectRoot, path.join(artifactsRoot, shot)) }),
    };
  }
  const onAgentStep = failure !== undefined && failedStep !== undefined && failedStep.api.startsWith('agent.');
  const steps = (attempt?.steps ?? []).map((step, index): CodegenStep => {
    const data = recorded[step.id];
    const judgment = data?.judgment === undefined ? undefined : withScreenshot(data.judgment, data.screenshot, projectRoot);
    return {
      api: step.api,
      label: step.label,
      ...(step.source === undefined ? {} : { line: step.source.line, column: step.source.column }),
      ...(data?.recording === undefined ? {} : { recording: data.recording }),
      ...(judgment === undefined ? {} : { judgment }),
      ...(onAgentStep && index === failedAt && failure !== undefined ? { failure } : {}),
    };
  });
  const testFailure =
    failure === undefined || onAgentStep
      ? undefined
      : {
          ...failure,
          ...(failedStep === undefined ? {} : { api: failedStep.api, label: failedStep.label }),
          ...(failedStep?.source === undefined ? {} : { line: failedStep.source.line }),
        };
  return { title: result.test.title, titlePath: [...result.test.titlePath], steps, ...(testFailure === undefined ? {} : { failure: testFailure }) };
}

/** A judgment with its gap naming the screenshot the step took, or why there is none. */
function withScreenshot(
  judgment: NonNullable<CodegenStep['judgment']>,
  screenshot: CodegenScreenshot | undefined,
  projectRoot: string,
): NonNullable<CodegenStep['judgment']> {
  const { gap } = judgment;
  if (gap === undefined || screenshot === undefined) return judgment;
  return 'withheld' in screenshot
    ? { ...judgment, gap: { ...gap, screenshotWithheld: screenshot.withheld } }
    : { ...judgment, gap: { ...gap, screenshot: relativeTo(projectRoot, screenshot.file) } };
}

/** Why a gap kept from an earlier run names no screenshot once that run's artifacts are gone. */
const SCREENSHOT_GONE = 'the screenshot was in an earlier run’s artifacts, which a later run cleared';

/** A gap or a failure kept from an earlier run, its screenshot named only while the file is still there. */
function carriedGap<Record extends { readonly screenshot?: string; readonly screenshotWithheld?: string; readonly carried?: boolean }>(
  gap: Record,
  projectRoot: string,
): Record {
  if (gap.screenshot === undefined || existsSync(path.join(projectRoot, gap.screenshot))) return { ...gap, carried: true };
  const { screenshot: _screenshot, ...rest } = gap;
  return { ...rest, screenshotWithheld: SCREENSHOT_GONE, carried: true } as Record;
}

/** The gaps `render` reported for a file, each with its test's judgment, carried when this run did not record the test. */
function renderedGaps(
  rendered: CodegenRendered,
  action: Extract<CodegenSyncAction, { kind: 'render' }>,
  code: string,
  projectRoot: string,
): CodegenGapRecord[] {
  return rendered.gaps.flatMap((site) => {
    const stored = action.tests[site.test];
    const step = stored?.test.steps[site.step];
    const gap = step?.judgment?.gap;
    if (stored === undefined || step === undefined || gap === undefined) return [];
    const record: CodegenGapRecord = {
      file: code,
      line: site.line,
      kind: (step.judgment?.checks.length ?? 0) === 0 ? 'unconverted' : 'partial',
      source: action.file,
      test: stored.test.title,
      api: step.api,
      instruction: step.label,
      uncovered: gap.uncovered,
      ...(gap.screenshot === undefined ? {} : { screenshot: gap.screenshot }),
      ...(gap.screenshotWithheld === undefined ? {} : { screenshotWithheld: gap.screenshotWithheld }),
    };
    return action.fresh.has(stored.id) ? [record] : [carriedGap(record, projectRoot)];
  });
}

/** The failures `render` reported for a file, each with its test's failure, carried when this run did not record the test. */
function renderedFailures(
  rendered: CodegenRendered,
  action: Extract<CodegenSyncAction, { kind: 'render' }>,
  code: string,
  projectRoot: string,
): CodegenFailureRecord[] {
  return (rendered.failures ?? []).flatMap((site) => {
    const stored = action.tests[site.test];
    if (stored === undefined) return [];
    const step = stored.test.steps.find((candidate) => candidate.failure !== undefined);
    const failure = step?.failure ?? stored.test.failure;
    if (failure === undefined) return [];
    const record: CodegenFailureRecord = {
      file: code,
      line: site.line,
      source: action.file,
      test: stored.test.title,
      ...(step === undefined ? {} : { api: step.api, label: step.label }),
      code: failure.code,
      message: failure.message,
      ...(failure.screenshot === undefined ? {} : { screenshot: failure.screenshot }),
      ...(failure.screenshotWithheld === undefined ? {} : { screenshotWithheld: failure.screenshotWithheld }),
    };
    return action.fresh.has(stored.id) ? [record] : [carriedGap(record, projectRoot)];
  });
}

/** Whether `inner` is below `outer`. */
function isInside(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Removes `dir` and its parents up to, not including, `stop`, while each is empty. */
async function pruneEmpty(dir: string, stop: string): Promise<void> {
  for (let current = dir; isInside(current, stop); current = path.dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
  }
}

/**
 * What the record of an e2e file on a target keeps for one test, read in the
 * worker as an attempt starts: the judgments it checked last time, for a
 * judgment to reuse when they still hold. Undefined when there is none or it
 * cannot be read.
 */
export function readStoredTest(recordsDir: string, file: string, target: string, testId: string): StoredCodegenTest | undefined {
  try {
    const value = JSON.parse(readFileSync(recordPath(recordsDir, file, target), 'utf8')) as Partial<CodegenRecord>;
    if (value.version !== CODEGEN_RECORD_VERSION || !Array.isArray(value.tests)) return undefined;
    return value.tests.find((stored) => stored.id === testId);
  } catch {
    return undefined;
  }
}

/** Every record under `<output>/codegen`, read as absent when unreadable or of another version; other files there are left alone. */
async function readRecords(recordsDir: string): Promise<CodegenRecord[]> {
  const entries = await readdir(recordsDir, { recursive: true, withFileTypes: true }).catch(() => []);
  const records: CodegenRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const text = await readFile(path.join(entry.parentPath, entry.name), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    try {
      const value = JSON.parse(text) as Partial<CodegenRecord>;
      if (
        value.version === CODEGEN_RECORD_VERSION &&
        typeof value.file === 'string' &&
        typeof value.target === 'string' &&
        typeof value.code === 'string' &&
        Array.isArray(value.tests) &&
        Array.isArray(value.gaps)
      ) {
        records.push(value as CodegenRecord);
      }
    } catch {
      // Not a record: left alone, read as absent.
    }
  }
  return records;
}

/**
 * Deletes every record under `<output>/codegen` and the generated file each
 * one names, when that file is inside `codegen.outDir`, then the folders that
 * leaves empty. Nothing a record does not name is touched, so a hand-written
 * file beside the generated ones stays. Returns what went.
 */
export async function clearCodegen(config: ResolvedConfig): Promise<{ readonly records: number; readonly files: readonly string[] }> {
  const recordsDir = outputLayout(config.output).codegen;
  const outDir = config.codegen.outDir;
  const files: string[] = [];
  const records = await readRecords(recordsDir);
  for (const record of records) {
    const code = path.join(config.projectRoot, record.code);
    if (isInside(code, outDir) && existsSync(code)) {
      await rm(code, { force: true });
      files.push(code);
      await pruneEmpty(path.dirname(code), outDir);
    }
    const file = recordPath(recordsDir, record.file, record.target);
    await rm(file, { force: true });
    await pruneEmpty(path.dirname(file), recordsDir);
  }
  return { records: records.length, files };
}

/** The report's `run.codegen` block for what a write produced, its paths project-root relative. */
export function reportCodegen(output: CodegenOutput, projectRoot: string): ReportCodegen {
  return {
    dir: relativeTo(projectRoot, output.dir) || '.',
    files: output.files.map((file) => relativeTo(projectRoot, file)),
    gaps: output.gaps,
    failures: output.failures,
  };
}

/** Most file locations one warning lists; the rest are counted. */
const MAX_WARNED_LOCATIONS = 5;

/**
 * The warnings a run prints for the judgments its code does not prove whole:
 * one line for those only partly converted, one for those not converted at
 * all, each naming where they are in the written files and how many an
 * earlier run recorded.
 */
export function codegenGapWarnings(gaps: readonly CodegenGapRecord[]): string[] {
  const line = (kind: CodegenGapRecord['kind'], says: (count: number) => string): string[] => {
    const matching = gaps.filter((gap) => gap.kind === kind);
    if (matching.length === 0) return [];
    const locations = matching
      .slice(0, MAX_WARNED_LOCATIONS)
      .map((gap) => `${gap.file}:${String(gap.line)}${gap.screenshot === undefined ? '' : ` (screenshot ${gap.screenshot})`}`);
    const more = matching.length - locations.length;
    const carried = matching.filter((gap) => gap.carried === true).length;
    const earlier = carried === 0 ? '' : `, ${String(carried)} of them from an earlier run`;
    return [`--codegen: ${says(matching.length)}${earlier}: ${locations.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`];
  };
  const judgments = (count: number): string => `${String(count)} ${count === 1 ? 'judgment was' : 'judgments were'}`;
  return [
    ...line('partial', (count) => `${judgments(count)} only partly converted`),
    ...line('unconverted', (count) => `${judgments(count)} not converted; the code throws in place of each`),
  ];
}

/**
 * The warning a run prints for the tests whose code stops where they failed:
 * where in the written files, with the screenshot at the failure, and how
 * many an earlier run recorded.
 */
export function codegenFailureWarnings(failures: readonly CodegenFailureRecord[]): string[] {
  if (failures.length === 0) return [];
  const locations = failures
    .slice(0, MAX_WARNED_LOCATIONS)
    .map((failure) => `${failure.file}:${String(failure.line)}${failure.screenshot === undefined ? '' : ` (screenshot ${failure.screenshot})`}`);
  const more = failures.length - locations.length;
  const carried = failures.filter((failure) => failure.carried === true).length;
  const earlier = carried === 0 ? '' : `, ${String(carried)} of them from an earlier run`;
  const tests = failures.length === 1 ? '1 test failed' : `${String(failures.length)} tests failed`;
  return [`--codegen: ${tests} in the run its code was written from, and the code stops there${earlier}: ${locations.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`];
}

