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
 * In the runner, `CodegenSync` (`codegen-sync.ts`) keeps each test's last
 * passing recordings across runs and hands each e2e file to the target
 * engine's `codegen.render`, one generated file per e2e file.
 */

import { containerKey, describeTarget, type RecordableAction } from '../agent/actions.ts';
import { TraceRecorder } from '../cache/recorder.ts';
import { bound, MAX_TRACE_DESCRIPTOR_CHARS, type DerivedReason, type RecordedAction } from '../cache/trace.ts';
import type { AgentObservation, RedactedNode } from '../agent/observation.ts';
import { relocateDescriptor } from '../cache/relocate.ts';
import { carriesSecretMarker } from '../internal/redact.ts';
import { isEditable } from '../internal/roles.ts';
import { collapseText } from '../internal/text.ts';
import type {
  CodegenJudgment,
  CodegenRecording,
  CodegenTest,
  CodegenScreenNode,
  CodegenTargetDescriptor,
  EngineCodegen,
} from '../engine/codegen.ts';
import type { StandardReading } from '../engine/contract.ts';

/** Where the screen a judgment passed on was saved in the worker, as an absolute file, or why it was not. */
export type CodegenScreenshot = { readonly file: string } | { readonly withheld: string };

/** What one step left for code: an act's actions, or a judgment's checks. */
export interface CodegenStepData {
  readonly recording?: CodegenRecording;
  readonly judgment?: CodegenJudgment;
  /** For a judgment with a gap: where the screen it passed on was saved in the worker, or why it was not. */
  readonly screenshot?: CodegenScreenshot;
}

/** One attempt's recordings, keyed by the step id the report gives the step. */
export interface CodegenAttempt {
  readonly attemptId: string;
  readonly steps: Readonly<Record<string, CodegenStepData>>;
  /**
   * True when the attempt failed in a way that says something about the app,
   * as the replay cache judges it: the test's earlier code is then dropped.
   * False for a pass, an interrupt, and a failure where no model answered.
   */
  readonly implicates: boolean;
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
   * `shown` says whether the code would still find one on it.
   */
  goneFrom(
    observation: Extract<AgentObservation, { kind: 'semantic' }>,
    limit: number,
    shown: (target: CodegenTargetDescriptor) => boolean = () => false,
  ): CodegenTargetDescriptor[] {
    const ordered = [...this.elements.values()]
      .map((entry, index) => ({ ...entry, index }))
      .toSorted((a, b) => b.screen - a.screen || a.index - b.index);
    const gone: CodegenTargetDescriptor[] = [];
    for (const { target } of ordered) {
      if (gone.length >= limit) break;
      if (!stillShown(target, observation) && !shown(target)) gone.push(target);
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
export function stillShown(target: CodegenTargetDescriptor, observation: Extract<AgentObservation, { kind: 'semantic' }>): boolean {
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

/** Each screen as `locate` reads it, built once per observation. */
const screens = new WeakMap<ReadonlyMap<string, RedactedNode>, readonly CodegenScreenNode[]>();

/** A screen's nodes as the engine's `locate` reads them: what code could find each by. */
function screenOf(observation: Extract<AgentObservation, { kind: 'semantic' }>): readonly CodegenScreenNode[] {
  const cached = screens.get(observation.nodes);
  if (cached !== undefined) return cached;
  const read = [...observation.nodes].map(([id, node]): CodegenScreenNode => {
    const parent = observation.parents.get(id);
    const within = containerKey(id, observation.nodes, observation.parents);
    const placeholder = node.attributes?.['placeholder'];
    // A leaf whose text the tree folded into its name shows that name.
    const shownText = displayedTextOf(node) || ((node.children ?? []).length === 0 ? collapseText(node.name ?? '') : '');
    return {
      id,
      ...(parent === undefined ? {} : { parent }),
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.name === undefined ? {} : { name: collapseText(node.name) }),
      shownText,
      ...(node.testId === undefined ? {} : { testId: collapseText(node.testId) }),
      ...(placeholder === undefined ? {} : { placeholder: collapseText(placeholder) }),
      ...(node.standard === undefined ? {} : { standard: node.standard }),
      ...(within === undefined ? {} : { within }),
      ...(node.states?.hidden === true ? { hidden: true } : {}),
    };
  });
  screens.set(observation.nodes, read);
  return read;
}

/** The recording of one attempt's `agent.act` steps. */
export class CodegenLog {
  private readonly steps = new Map<
    string,
    { readonly recorder: TraceRecorder; startLocation: string | undefined; readonly extras: Map<number, ActionExtras> }
  >();
  private readonly judgments = new Map<string, { readonly judgment: CodegenJudgment; readonly screenshot: CodegenScreenshot | undefined }>();
  /** What the attempt's screens showed, oldest first. */
  readonly seen = new SeenScreens();
  private implicates = false;

  constructor(
    readonly attemptId: string,
    private readonly engine?: Pick<EngineCodegen, 'locate'>,
    /** What the test's last recorded run kept, for a judgment to reuse the checks it made then. */
    private readonly previous?: { readonly test: CodegenTest },
  ) {}

  /**
   * The judgment the test's last recorded run kept for the `occurrence`-th
   * step with this api and label, when it kept checks: what a judgment
   * reuses, rather than asking the judge again, when every check still holds.
   */
  previousJudgment(api: string, label: string, occurrence: number): CodegenJudgment | undefined {
    const matching = (this.previous?.test.steps ?? []).filter((step) => step.api === api && step.label === label);
    const judgment = matching[occurrence]?.judgment;
    return judgment === undefined || judgment.checks.length === 0 ? undefined : judgment;
  }

  /**
   * The nodes of a screen the target engine's code would find `target` by,
   * by id; undefined when the engine cannot tell or writes no code.
   */
  locate(target: CodegenTargetDescriptor, observation: Extract<AgentObservation, { kind: 'semantic' }>): readonly string[] | undefined {
    if (this.engine?.locate === undefined) return undefined;
    try {
      return this.engine.locate(target, screenOf(observation));
    } catch {
      // An engine that cannot read the screen leaves the check as the tree confirmed it.
      return undefined;
    }
  }

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
  judged(stepId: string, judgment: CodegenJudgment, screenshot?: CodegenScreenshot): void {
    this.judgments.set(stepId, { judgment, screenshot });
  }

  /** Records how the attempt ended: whether its failure says something about the app (`CodegenAttempt.implicates`). */
  settle(implicates: boolean): void {
    this.implicates = implicates;
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
    for (const [stepId, { judgment, screenshot }] of this.judgments) {
      steps[stepId] = { ...steps[stepId], judgment, ...(screenshot === undefined ? {} : { screenshot }) };
    }
    return { attemptId: this.attemptId, steps, implicates: this.implicates };
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
