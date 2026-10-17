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
import { describeTarget, type RecordableAction } from '../agent/actions.ts';
import { TraceRecorder } from '../cache/recorder.ts';
import { bound, MAX_TRACE_DESCRIPTOR_CHARS, type DerivedReason, type RecordedAction } from '../cache/trace.ts';
import type { AgentObservation, RedactedNode } from '../agent/observation.ts';
import { relocateDescriptor } from '../cache/relocate.ts';
import { carriesSecretMarker } from '../internal/redact.ts';
import { isEditable } from '../internal/roles.ts';
import { collapseText } from '../internal/text.ts';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { ReportCodegen } from '../report/build.ts';
import type {
  CodegenFile,
  CodegenJudgment,
  CodegenRecording,
  CodegenStep,
  CodegenTargetDescriptor,
  CodegenTest,
} from '../engine/codegen.ts';
import type { StandardReading } from '../engine/contract.ts';
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

/** The longest `shownText` kept, as a descriptor field is (`MAX_TRACE_DESCRIPTOR_CHARS`). */
const MAX_SHOWN_TEXT_CHARS = MAX_TRACE_DESCRIPTOR_CHARS;

/**
 * The text a node and its descendants show, their `text` joined in document
 * order and whitespace collapsed: what a script reading the page sees, which
 * leaves out the names an author gave (a button's `aria-label`).
 */
export function displayedTextOf(node: RedactedNode): string {
  const parts: string[] = [];
  const collect = (current: RedactedNode): void => {
    if (current.text !== undefined && current.text.trim() !== '') parts.push(current.text);
    for (const child of current.children ?? []) collect(child);
  };
  collect(node);
  return collapseText(parts.join(' '));
}

/**
 * What a node shows, kept when the platform's standard gives it no name
 * (`standard.name` is `''`) and the engine named it anyway: from its content
 * (a list row by its children's names, a button's label among them), which a
 * script reading the page finds no trace of, while the text shown is there.
 * Undefined otherwise, for nothing shown, or for text the redactor alters.
 */
function shownTextOf(node: RedactedNode | undefined, redact: (text: string) => string): string | undefined {
  if (node === undefined || node.standard?.name !== '' || collapseText(node.name ?? '') === '') return undefined;
  const shown = displayedTextOf(node);
  if (shown === '' || redact(shown) !== shown) return undefined;
  return bound(shown, MAX_SHOWN_TEXT_CHARS);
}

/** What `--codegen` keeps beside a node's descriptor: what it shows, and how the standard reads it. */
export interface CodegenExtras {
  readonly shownText?: string;
  readonly standard?: StandardReading;
}

/** The extras for one node; undefined when it has none. */
export function codegenExtrasOf(node: RedactedNode | undefined, redact: (text: string) => string): CodegenExtras | undefined {
  if (node === undefined) return undefined;
  const shownText = shownTextOf(node, redact);
  const standard =
    node.standard === undefined
      ? undefined
      : node.standard.name === undefined
        ? node.standard
        : { ...node.standard, name: bound(redact(node.standard.name), MAX_SHOWN_TEXT_CHARS) };
  if (shownText === undefined && standard === undefined) return undefined;
  return { ...(shownText === undefined ? {} : { shownText }), ...(standard === undefined ? {} : { standard }) };
}

/** A recorded action's extras, by the index of the action: the target's and a drag destination's. */
interface ActionExtras {
  readonly target?: CodegenExtras | undefined;
  readonly destination?: CodegenExtras | undefined;
}

/** Most elements of earlier screens an attempt remembers, the newest kept. */
const MAX_SEEN_ELEMENTS = 500;

/** Most texts of earlier screens an attempt remembers; past it the oldest go first. */
const MAX_SEEN_TEXTS = 5000;

/**
 * What the screens of one attempt showed, for the checks that a judgment's
 * "is not shown" needs: an element is gone, or a text is absent, only means
 * something when an earlier screen of the same test showed it. Every screen
 * counts, an `agent.act` step's and a judgment's alike, by what a script
 * finds an element by (its descriptor, with no `within` or `position`), since
 * a node id names a node on one screen only.
 */
export class SeenScreens {
  /** Each element with the screen that last showed it, oldest screen first and in document order within one. */
  private readonly elements = new Map<string, { readonly target: CodegenTargetDescriptor; readonly screen: number }>();
  private readonly texts = new Set<string>();
  private screens = 0;

  /** Remembers one screen: every element a script can find by something of its own, and every text shown. */
  saw(observation: AgentObservation, redact: (text: string) => string): void {
    if (observation.kind !== 'semantic') return;
    const screen = (this.screens += 1);
    for (const node of observation.nodes.values()) {
      // A field shows what was typed into it, which a page's text never held;
      // the field itself, by its label, is an element like any other.
      const field = isEditable(node) || node.value !== undefined;
      for (const read of field ? [] : [node.name, node.text]) {
        const text = read === undefined ? '' : collapseText(read);
        if (text !== '') remember(this.texts, text, text, MAX_SEEN_TEXTS);
      }
      const target = seenTarget(node, redact);
      if (target !== undefined) remember(this.elements, JSON.stringify(target), { target, screen }, MAX_SEEN_ELEMENTS);
    }
  }

  /** Whether an earlier screen showed `text`, as a script finds text: within what a node shows. */
  showed(text: string): boolean {
    for (const seen of this.texts) if (seen.includes(text)) return true;
    return false;
  }

  /**
   * The elements earlier screens showed that `observation` does not, at most
   * `limit`: the newest screen's first, in the order that screen listed them.
   */
  goneFrom(observation: Extract<AgentObservation, { kind: 'semantic' }>, limit: number): CodegenTargetDescriptor[] {
    const ordered = [...this.elements.values()]
      .map((entry, index) => ({ ...entry, index }))
      .toSorted((a, b) => b.screen - a.screen || a.index - b.index);
    const gone: CodegenTargetDescriptor[] = [];
    for (const { target } of ordered) {
      if (gone.length >= limit) break;
      if (!stillShown(target, observation)) gone.push(target);
    }
    return gone;
  }
}

/** Adds a key to a bounded map or set as its newest entry, dropping the oldest past `max`. */
function remember<Value>(store: Map<string, Value> | Set<string>, key: string, value: Value, max: number): void {
  store.delete(key);
  if (store instanceof Set) store.add(key);
  else store.set(key, value);
  if (store.size > max) store.delete(store.keys().next().value!);
}

/**
 * A node as a script finds it anywhere on a screen: its descriptor with what
 * it shows, when the node has a role and something of its own to be found by
 * (a test id, a name, the text it shows, a placeholder). A role alone, an
 * unnamed list, finds every node of the role, so its absence says nothing
 * about the one that was there. Undefined, too, for a node that names a secret.
 */
function seenTarget(node: RedactedNode, redact: (text: string) => string): CodegenTargetDescriptor | undefined {
  const described = describeTarget(node);
  if (described?.role === undefined) return undefined;
  // A field's text is what was typed into it: the field is found by its label, whatever it holds.
  const { within: _within, position: _position, text, ...rest } = described;
  const descriptor = isEditable(node) || node.value !== undefined || text === undefined ? rest : { ...rest, text };
  const target: CodegenTargetDescriptor = { ...descriptor, ...codegenExtrasOf(node, redact) };
  const specific = target.testId ?? target.name ?? target.shownText ?? target.placeholder;
  if (specific === undefined) return undefined;
  return Object.values(target).some((value) => typeof value === 'string' && carriesSecretMarker(value)) ? undefined : target;
}

/**
 * Whether a screen still has a node a script looking for `target` would find:
 * e2e's own relocation finds it, or a node of its role reads the same way a
 * generated locator matches (the same test id, the same name, or the same
 * shown text, whitespace aside). Either one keeps a "gone" check from being
 * written, since it would fail on this very screen.
 */
function stillShown(target: CodegenTargetDescriptor, observation: Extract<AgentObservation, { kind: 'semantic' }>): boolean {
  const relocated = relocateDescriptor(target, observation.nodes);
  if (relocated.kind === 'found' || relocated.failure === 'target-ambiguous') return true;
  const name = target.standard?.name ?? target.name;
  const shown = target.shownText === undefined ? undefined : squashed(target.shownText);
  for (const node of observation.nodes.values()) {
    if (target.testId !== undefined && node.testId !== undefined && collapseText(node.testId) === target.testId) return true;
    if (node.role !== target.role) continue;
    if (name !== undefined && name !== '' && collapseText(node.standard?.name ?? node.name ?? '') === name) return true;
    if (target.placeholder !== undefined && collapseText(node.attributes?.['placeholder'] ?? '') === target.placeholder) return true;
    if (shown !== undefined) {
      const reads = squashed(displayedTextOf(node));
      if (shown.endsWith('…') ? reads.startsWith(shown.slice(0, -1)) : reads === shown) return true;
    }
  }
  return false;
}

/** A text with its whitespace removed, as a locator that takes the whitespace between words as optional compares it. */
function squashed(text: string): string {
  return text.replaceAll(/\s+/gu, '');
}

/** The recording of one attempt's `agent.act` steps. */
export class CodegenLog {
  private readonly steps = new Map<
    string,
    { readonly recorder: TraceRecorder; startLocation: string | undefined; readonly extras: Map<number, ActionExtras> }
  >();
  private readonly judgments = new Map<string, CodegenJudgment>();
  /** What the attempt's screens showed, oldest first. */
  readonly seen = new SeenScreens();

  constructor(readonly attemptId: string) {}

  /**
   * Opens one step's recording. `redact` and `redactCut` are the attempt's
   * ledger, so a recorded string never carries a registered secret: a value
   * the ledger would alter is masked and the recording marked incomplete.
   */
  open(stepId: string, redaction: { readonly redact: (text: string) => string; readonly redactCut: (text: string) => string }): CodegenStepRecorder {
    const step = { recorder: new TraceRecorder(redaction), startLocation: undefined as string | undefined, extras: new Map<number, ActionExtras>() };
    this.steps.set(stepId, step);
    return {
      record: (action, location) => {
        const index = step.recorder.recordedCount;
        if (index === 0) step.startLocation = location;
        step.recorder.record(action);
        // A scroll folded into the one before it, or an action over the cap, added no entry.
        if (step.recorder.recordedCount !== index + 1) return;
        const target = codegenExtrasOf('node' in action ? action.node : undefined, redaction.redact);
        const destination = action.name === 'drag' ? codegenExtrasOf(action.destination.node, redaction.redact) : undefined;
        if (target !== undefined || destination !== undefined) step.extras.set(index, { target, destination });
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
    for (const [stepId, { recorder, startLocation, extras }] of this.steps) {
      if (recorder.recordedCount === 0) continue;
      steps[stepId] = {
        recording: {
          ...(startLocation === undefined ? {} : { startLocation }),
          actions: recorder.recorded.map((action, index) => withExtras(action, extras.get(index))),
          incomplete: recorder.incomplete,
        },
      };
    }
    for (const [stepId, judgment] of this.judgments) steps[stepId] = { ...steps[stepId], judgment };
    return { attemptId: this.attemptId, steps };
  }
}

/** A recorded action with its nodes' extras added to their descriptors. */
function withExtras(action: RecordedAction, extras: ActionExtras | undefined): RecordedAction {
  if (extras === undefined || !('target' in action) || action.target === undefined) return action;
  const target = extras.target === undefined ? action.target : { ...action.target, ...extras.target };
  if (action.name === 'drag') {
    const destination = extras.destination === undefined ? action.destination : { ...action.destination, ...extras.destination };
    return { ...action, target, destination };
  }
  return { ...action, target };
}

/** What one `--codegen` write produced. */
export interface CodegenOutput {
  /** Absolute `<output>/codegen` directory. */
  readonly dir: string;
  /** Absolute paths of the files written, in write order. */
  readonly files: readonly string[];
  /** Targets with passing tests whose engine declares no `codegen`. */
  readonly unsupported: readonly { readonly target: string; readonly engine: string }[];
  /** The judgments the code does not prove whole, in write order. */
  readonly gaps: readonly CodegenGapRecord[];
}

/**
 * One judgment the generated code does not prove whole: `partial` when its
 * checks prove only some of it, `unconverted` when no check could be kept and
 * the code throws in its place.
 */
export interface CodegenGapRecord {
  /** The written file, project-root relative with `/` separators. */
  readonly file: string;
  /** The one-based line of the file the judgment starts at. */
  readonly line: number;
  readonly kind: 'partial' | 'unconverted';
  /** The e2e test file the judgment ran in, project-root relative. */
  readonly source: string;
  readonly test: string;
  readonly api: string;
  /** The judgment's instruction, as the report labels the step. */
  readonly instruction: string;
  /** The parts of the instruction the code does not check, as the judge named them. */
  readonly uncovered: readonly string[];
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
    const gaps: CodegenGapRecord[] = [];
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
      const rendered = codegen.render(file);
      await writeTextReport(output, rendered.code);
      files.push(output);
      const written = path.relative(config.projectRoot, output).split(path.sep).join('/');
      for (const site of rendered.gaps) {
        const test = file.tests[site.test];
        const step = test?.steps[site.step];
        const gap = step?.judgment?.gap;
        if (test === undefined || step === undefined || gap === undefined) continue;
        gaps.push({
          file: written,
          line: site.line,
          kind: (step.judgment?.checks.length ?? 0) === 0 ? 'unconverted' : 'partial',
          source: file.file,
          test: test.title,
          api: step.api,
          instruction: step.label,
          uncovered: gap.uncovered,
        });
      }
    }
    return { dir, files, unsupported: [...unsupported].map(([targetName, engine]) => ({ target: targetName, engine })), gaps };
  }
}

/** The report's `run.codegen` block for what a write produced, its paths project-root relative. */
export function reportCodegen(output: CodegenOutput, projectRoot: string): ReportCodegen {
  const relative = (file: string): string => path.relative(projectRoot, file).split(path.sep).join('/') || '.';
  return { dir: relative(output.dir), files: output.files.map(relative), gaps: output.gaps };
}

/** Most file locations one warning lists; the rest are counted. */
const MAX_WARNED_LOCATIONS = 5;

/**
 * The warnings a run prints for the judgments its code does not prove whole:
 * one line for those only partly converted, one for those not converted at
 * all, each naming where they are in the written files.
 */
export function codegenGapWarnings(gaps: readonly CodegenGapRecord[]): string[] {
  const line = (kind: CodegenGapRecord['kind'], says: (count: number) => string): string[] => {
    const matching = gaps.filter((gap) => gap.kind === kind);
    if (matching.length === 0) return [];
    const locations = matching.slice(0, MAX_WARNED_LOCATIONS).map((gap) => `${gap.file}:${String(gap.line)}`);
    const more = matching.length - locations.length;
    return [`--codegen: ${says(matching.length)} (${locations.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''})`];
  };
  const judgments = (count: number): string => `${String(count)} ${count === 1 ? 'judgment was' : 'judgments were'}`;
  return [
    ...line('partial', (count) => `${judgments(count)} only partly converted`),
    ...line('unconverted', (count) => `${judgments(count)} not converted; the code throws in place of each`),
  ];
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
