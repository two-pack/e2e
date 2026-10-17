/**
 * `--codegen` for the judgment tier: the deterministic checks a script makes
 * in place of `agent.assert`, `agent.waitFor`, and `agent.extract`.
 *
 * Once a judgment passed, the judge is asked one more question about the very
 * observation it passed on: which facts on this screen prove the condition, as
 * checks a script can make without a model (this node is visible, reads this
 * text, holds this value, is checked; this text is nowhere; the location is
 * this; this text, or this element an earlier screen of the test showed, is
 * gone), each with the part of the instruction it proves, and which parts no
 * such check can prove. The answer is evidence to verify, never trusted: every
 * check is held against the same observation and dropped when the screen does
 * not bear it out, and every node is kept by the durable descriptor the replay
 * cache records, so a script finds it the way a replay would. What the kept
 * checks leave unproven goes with them (`CodegenJudgmentGap`), for the code to
 * say and the run to warn about.
 *
 * The question runs only in a `--codegen` run, after the verdict, on its own
 * budget; whatever goes wrong with it leaves the step's outcome untouched and
 * the step without checks.
 */

import { describeTarget, containerKey } from './actions.ts';
import { Invocation, type AgentContext } from './invocation.ts';
import type { AgentObservation, RedactedNode } from './observation.ts';
import { isRelocatableDescriptor, describePosition } from '../cache/relocate.ts';
import type { TraceTargetDescriptor } from '../cache/trace.ts';
import type { CodegenCheck, CodegenDroppedCheck, CodegenJudgmentGap, CodegenTargetDescriptor } from '../engine/codegen.ts';
import { codegenExtrasOf, displayedTextOf, type SeenScreens } from '../run/codegen.ts';
import { carriesSecretMarker } from '../internal/redact.ts';
import { bound } from '../cache/trace.ts';
import { collapseText } from '../internal/text.ts';
import { CHECKS_SCHEMA, CHECKS_SCHEMA_NAME, MAX_CHECKS, validateChecksResponse, type ProposedCheck } from './protocol.ts';

/** One call and one repair round, as an assertion gets. */
const CHECKS_MODEL_CALLS = 2;

/** Most elements of earlier screens the question lists for a "gone" check, the newest. */
const MAX_EARLIER_ELEMENTS = 20;

/** Longest explanation or proposed check a gap keeps, in characters. */
const MAX_GAP_TEXT = 300;

const CHECKS_REQUEST = [
  'The instruction below held on this observation. A script that cannot ask a model has to verify the same thing on this screen.',
  `List the fewest checks, at most ${String(MAX_CHECKS)}, that together prove it, each a fact the observation shows right now:`,
  '- "visible": node is on screen. "text": node\'s text or name contains text. "value": the field node holds exactly text.',
  '- "checked", "unchecked", "enabled", "disabled": node is in that state.',
  '- "count": exactly text (a number) nodes with node\'s role are on screen. "order": the nodes with node\'s role appear in the order the screen shows them.',
  '- "absent": no node on screen shows text; only for words the instruction itself says are missing, gone, or not shown.',
  '- "gone": node, an element listed under <shown-earlier>, is no longer on screen; for what the instruction says is missing, gone, or not shown.',
  '- "url": the location is exactly text, as the observation reports it.',
  'Cover every part of the instruction: a number of items is a "count", an order is an "order", an empty field is a "value" with text "".',
  'node is the id of a node in the observation, such as "n12", or of an element under <shown-earlier>, such as "p3"; null for "absent" and "url". text is null where the kind takes none.',
  'Prefer a node with a role and a name, and the shortest text that still proves the point. Never invent a node or a text the observation does not show.',
  'covers is the part of the instruction the check proves, copied word for word from the instruction.',
  'uncovered lists, copied word for word, each part of the instruction that none of these checks can prove; [] when the checks prove all of it.',
  'Respond with { "checks": [{ "kind": <kind>, "node": <id or null>, "text": <text or null>, "covers": <part of the instruction> }], "uncovered": [<part of the instruction>] }.',
].join('\n');

/** What the judgment was, as the question frames it. */
export interface CodegenChecksRequest {
  /** The public API of the judgment step: `agent.assert`, `agent.waitFor`, `agent.extract`. */
  readonly api: string;
  /** The configured agent the judgment ran with. */
  readonly agent: string | undefined;
  /** The test's instruction or condition. */
  readonly instruction: string;
  /** The observation the judgment passed on; a fresh one when the executor that judged kept its own. */
  readonly observation: AgentObservation | undefined;
  /** For `agent.extract`: the value it returned, which the checks should show on screen. */
  readonly value?: unknown;
  /** The judge's explanation of the verdict, when it gave one. */
  readonly explanation?: string | undefined;
  readonly timeoutMs: number;
}

/**
 * For `--codegen`: keeps what a passed judgment step leaves for code, the
 * checks that prove it and, for an extraction, the value it returned when
 * that value carries nothing the redactor masks. Does nothing in a run that
 * asked for no code; never fails the step.
 */
export async function recordCodegenJudgment(runtime: AgentContext, request: CodegenChecksRequest): Promise<void> {
  const stepId = runtime.steps.currentStepId;
  const codegen = runtime.codegen;
  if (codegen === undefined || stepId === undefined) return;
  const derived = await deriveCodegenChecks(runtime, codegen.seen, request);
  const checks = derived?.checks ?? [];
  const serialized = request.value === undefined ? undefined : JSON.stringify(request.value);
  const keepValue = serialized !== undefined && runtime.redact(serialized) === serialized;
  const uncovered = derived?.uncovered ?? [];
  const explanation = request.explanation === undefined ? undefined : safeText(request.explanation, runtime.redact);
  const gap: CodegenJudgmentGap | undefined =
    checks.length > 0 && uncovered.length === 0
      ? undefined
      : { ...(explanation === undefined ? {} : { explanation }), uncovered, dropped: derived?.dropped ?? [] };
  codegen.judged(stepId, {
    checks,
    ...(keepValue ? { value: request.value } : {}),
    ...(gap === undefined ? {} : { gap }),
  });
}

/** What the question left: the kept checks, the parts of the instruction they leave unproven, and the checks dropped. */
interface DerivedChecks {
  readonly checks: readonly CodegenCheck[];
  readonly uncovered: readonly string[];
  readonly dropped: readonly CodegenDroppedCheck[];
}

/** What one proposed check came to: kept as a check, or dropped for a reason. */
type Confirmation = { readonly check: CodegenCheck } | { readonly reason: string };

/** What a proposed check is held against: the screen, what earlier screens showed, and the instruction. */
interface CheckContext {
  readonly observation: Extract<AgentObservation, { kind: 'semantic' }>;
  readonly instruction: string;
  readonly seen: SeenScreens;
  /** The elements the question listed under `<shown-earlier>`, by the id it gave them. */
  readonly earlier: ReadonlyMap<string, CodegenTargetDescriptor>;
  readonly redact: (text: string) => string;
}

/**
 * Asks for the checks that prove a passed judgment and keeps the ones the
 * observation confirms. Undefined when the observation has no tree to check
 * against or the question failed in any way.
 */
async function deriveCodegenChecks(runtime: AgentContext, seen: SeenScreens, request: CodegenChecksRequest): Promise<DerivedChecks | undefined> {
  try {
    // A custom executor may run with no model at all; then there is no one to ask.
    if (runtime.select(request.agent).config.judge === undefined) return undefined;
    const invocation = new Invocation(runtime, {
      api: request.api,
      agent: request.agent,
      label: request.instruction,
      task: 'write deterministic checks that prove a judgment',
      timeoutMs: request.timeoutMs,
      maxModelCalls: CHECKS_MODEL_CALLS,
      vision: false,
    });
    const observation = request.observation ?? (await invocation.observe());
    if (observation.kind !== 'semantic') return undefined;
    // A screen not listed whole may hold what looks gone; nothing earlier is offered then.
    const earlier = new Map(
      (observation.truncated ? [] : seen.goneFrom(observation, MAX_EARLIER_ELEMENTS)).map((target, index) => [`p${String(index + 1)}`, target] as const),
    );
    const instruction =
      request.value === undefined
        ? request.instruction
        : `${request.instruction}\nThe data extracted from this screen was: ${JSON.stringify(request.value)}\nThe checks should show where the screen shows these values.`;
    const proposed = await invocation.ask({
      schemaName: CHECKS_SCHEMA_NAME,
      schema: CHECKS_SCHEMA,
      validate: validateChecksResponse,
      prompt: {
        request: CHECKS_REQUEST,
        instruction,
        observation,
        earlier: [...earlier].map(([id, target]) => `${id} ${describeElement(target)}`),
      },
    });
    const context: CheckContext = { observation, instruction: request.instruction, seen, earlier, redact: runtime.redact };
    const kept: { readonly check: CodegenCheck; readonly covers: string | undefined }[] = [];
    const dropped: { readonly proposed: ProposedCheck; readonly reason: string }[] = [];
    for (const check of proposed.checks) {
      const confirmed = confirmCheck(check, context);
      if ('check' in confirmed) kept.push({ check: confirmed.check, covers: partOf(check.covers) });
      else dropped.push({ proposed: check, reason: confirmed.reason });
    }
    const keptParts = kept.flatMap(({ covers }) => (covers === undefined ? [] : [covers]));
    const coveredByKept = (part: string): boolean => keptParts.some((keptPart) => squashPart(keptPart).includes(squashPart(part)));
    // What the judge itself says it could not check stays, whatever a kept
    // check claims to cover: a check that says it covers the whole
    // instruction must not hide the part the same answer left out.
    const uncovered = distinctParts([
      ...proposed.uncovered.flatMap((part) => (partOf(part) === undefined ? [] : [partOf(part)!])),
      ...dropped.flatMap(({ proposed: check }) => {
        const part = partOf(check.covers);
        return part === undefined || coveredByKept(part) ? [] : [part];
      }),
    ]);
    return {
      checks: dedupe(kept.map(({ check }) => check)),
      uncovered: uncovered.map((part) => safeText(part, runtime.redact) ?? WITHHELD_PART),
      dropped: dropped.map(({ proposed: check, reason }) => {
        const described = describeProposed(check, context);
        return described === undefined ? { reason } : { check: described, reason };
      }),
    };
  } catch {
    // The checks are a by-product of a verdict already reached; a failed
    // question costs the generated code its assertion, never the test.
    return undefined;
  }
}

/** What an uncovered part that the redactor would alter reads as: the part itself never leaves. */
const WITHHELD_PART = '(a part of the instruction left out here: it carries a secret)';

/** A part of the instruction as the judge named it, whitespace collapsed; undefined for none. */
function partOf(part: string | null): string | undefined {
  const collapsed = part === null ? '' : collapseText(part);
  return collapsed === '' ? undefined : collapsed;
}

/** A part reduced to its letters and digits, so `ログイン画面が表示されていて、` and `ログイン画面が表示されていて` compare equal. */
function squashPart(part: string): string {
  return part.replaceAll(/[\s\p{P}\p{S}]+/gu, '');
}

/** The parts in order, each once by its letters and digits, leaving out one another part already holds. */
function distinctParts(parts: readonly string[]): string[] {
  const keys = parts.map(squashPart);
  return parts.filter((_part, index) => {
    const key = keys[index]!;
    if (key === '') return false;
    // The first of equal parts stays; a part inside a longer one adds nothing to it.
    return keys.every((other, at) => at === index || !other.includes(key) || (other === key && at > index));
  });
}

/** A model-written text for a comment: bounded, or undefined when the redactor would alter it or it names a secret. */
function safeText(text: string, redact: (text: string) => string): string | undefined {
  const collapsed = collapseText(text);
  if (collapsed === '' || redact(collapsed) !== collapsed || carriesSecretMarker(collapsed)) return undefined;
  return bound(collapsed, MAX_GAP_TEXT);
}

/** An element of an earlier screen as the question lists it: its role and what it reads. */
function describeElement(target: CodegenTargetDescriptor): string {
  const reads = target.shownText ?? target.name ?? target.placeholder;
  return [
    target.role ?? 'node',
    ...(reads === undefined ? [] : [JSON.stringify(reads)]),
    ...(target.testId === undefined ? [] : [`testid=${JSON.stringify(target.testId)}`]),
  ].join(' ');
}

/**
 * A dropped check as the judge proposed it, for the code to show: its kind,
 * the node by role and name, and its text. Undefined when any of it carries a
 * secret, so a comment never holds what the redactor caught.
 */
function describeProposed(check: ProposedCheck, context: CheckContext): string | undefined {
  const id = check.node?.replace(/^#/u, '');
  const node = id === undefined ? undefined : context.observation.nodes.get(id);
  const earlier = id === undefined ? undefined : context.earlier.get(id);
  const where =
    node !== undefined
      ? [node.role ?? 'node', ...(node.name === undefined || node.name === '' ? [] : [JSON.stringify(collapseText(node.name))])].join(' ')
      : earlier !== undefined
        ? describeElement(earlier)
        : id === undefined
          ? undefined
          : `node ${id}`;
  const parts = [check.kind, ...(where === undefined ? [] : [where]), ...(check.text === null ? [] : [JSON.stringify(collapseText(check.text))])];
  return safeText(parts.join(' '), context.redact);
}

/**
 * Holds one proposed check against the observation it was proposed on, and
 * returns it with the node as its durable descriptor, or why it was dropped:
 * the screen does not bear it out, the node has nothing durable to find it by,
 * a text would carry something the redactor masks, or an absence proves
 * nothing because no earlier screen of the test showed the thing.
 */
function confirmCheck(check: ProposedCheck, context: CheckContext): Confirmation {
  const { observation, redact } = context;
  const text = check.text === null ? undefined : collapseText(check.text);
  if (text !== undefined && redact(text) !== text) return { reason: 'its text carries a secret' };
  // Only a field can be shown to be empty; any other check needs something to look for.
  if (text === '' && check.kind !== 'value') return { reason: 'it has an empty text' };
  switch (check.kind) {
    case 'url': {
      // The observation shows the model the path; the check keeps the whole
      // location, which the engine writes relative to the app where it can.
      const { location, path } = observation;
      if (text === undefined || location === undefined) return { reason: 'the screen reports no location' };
      return text === path || text === location ? { check: { kind: 'url', location } } : { reason: 'the location differs' };
    }
    case 'absent':
      return confirmAbsent(text, context);
    case 'gone': {
      if (observation.truncated) return { reason: 'the screen was not listed whole, so something missing from it proves nothing' };
      const target = check.node === null ? undefined : context.earlier.get(check.node.replace(/^#/u, ''));
      return target === undefined ? { reason: 'it names no element listed as shown earlier' } : { check: { kind: 'gone', target } };
    }
    default:
      break;
  }
  if (check.node === null) return { reason: 'it names no node' };
  const node = observation.nodes.get(check.node.replace(/^#/u, ''));
  if (node === undefined) return { reason: 'no node on the screen has this id' };
  if (check.kind === 'count' || check.kind === 'order') return confirmCollection(check.kind, node, text, observation, redact);
  const target = durableTarget(node.ref.id, observation, redact);
  if (target === undefined) return { reason: 'the node has nothing durable to find it by' };
  const states = node.states ?? {};
  switch (check.kind) {
    case 'visible':
      return { check: { kind: 'visible', target } };
    case 'text':
      // A script reads the text on screen, not a name an author or the engine gave the node.
      if (text === undefined) return { reason: 'it has no text' };
      return shownReadsOf(node).some((read) => read.includes(text)) ? { check: { kind: 'text', target, text } } : { reason: 'the node does not show this text' };
    case 'value':
      if (text === undefined) return { reason: 'it has no value' };
      return collapseText(node.value ?? '') === text ? { check: { kind: 'value', target, value: text } } : { reason: 'the field holds another value' };
    case 'checked':
    case 'unchecked': {
      const checked = check.kind === 'checked';
      return (states.checked === true) === checked ? { check: { kind: 'checked', target, checked } } : { reason: `the node is not ${check.kind}` };
    }
    case 'enabled':
    case 'disabled': {
      const enabled = check.kind === 'enabled';
      return (states.disabled !== true) === enabled ? { check: { kind: 'enabled', target, enabled } } : { reason: `the node is not ${check.kind}` };
    }
  }
}

/**
 * An `absent` check, kept only when its absence means something: the
 * instruction itself says the text is missing, the screen was listed whole and
 * shows it nowhere, and an earlier screen of the test did show it. A word no
 * screen of the test ever showed is absent on every screen, so a check for it
 * could not fail; the word an instruction uses ("the task list") is seldom
 * what the app shows.
 */
function confirmAbsent(text: string | undefined, context: CheckContext): Confirmation {
  const { observation, instruction, seen } = context;
  if (text === undefined) return { reason: 'it has no text' };
  if (observation.truncated) return { reason: 'the screen was not listed whole, so something missing from it proves nothing' };
  if (!collapseText(instruction).includes(text)) return { reason: 'the instruction does not say this text is missing' };
  if ([...observation.nodes.values()].some((node) => readsOf(node).some((read) => read.includes(text)))) return { reason: 'the screen shows this text' };
  if (!seen.showed(text)) return { reason: 'no earlier screen of this test showed this text, so the check could not fail' };
  return { check: { kind: 'absent', text } };
}

/** Most items an `order` check lists: past it a list is data, not the point of a check. */
const MAX_ORDER_ITEMS = 20;

/**
 * A check over every node on screen with `node`'s role: how many there are
 * (`count`, which the observation must show exactly), or what each reads, in
 * document order (`order`), each as the text a script would see.
 */
function confirmCollection(
  kind: 'count' | 'order',
  node: RedactedNode,
  text: string | undefined,
  observation: Extract<AgentObservation, { kind: 'semantic' }>,
  redact: (text: string) => string,
): Confirmation {
  const role = node.role;
  if (role === undefined) return { reason: 'the node has no role to count' };
  const items = [...observation.nodes.values()].filter((candidate) => candidate.role === role && candidate.states?.hidden !== true);
  if (kind === 'count') {
    if (text === undefined || !/^\d+$/u.test(text)) return { reason: 'its text is not a number' };
    return Number(text) === items.length
      ? { check: { kind: 'count', role, count: items.length } }
      : { reason: `the screen shows ${String(items.length)} nodes with this role` };
  }
  if (items.length < 2 || items.length > MAX_ORDER_ITEMS) return { reason: `the screen shows ${String(items.length)} nodes with this role` };
  const texts = items.map((item) => displayedTextOf(item) || collapseText(item.name ?? ''));
  return texts.every((item) => item !== '' && redact(item) === item)
    ? { check: { kind: 'order', role, texts } }
    : { reason: 'a node with this role shows no text, or one that carries a secret' };
}

/**
 * The texts a node shows as a script reads them, whitespace collapsed: its
 * own text, what its descendants show, its value, and its name only when
 * nothing else does (a leaf named by its own content).
 */
function shownReadsOf(node: RedactedNode): string[] {
  const shown = [displayedTextOf(node), node.value].filter((read): read is string => read !== undefined && read.trim() !== '');
  return (shown.length > 0 ? shown : [node.name ?? '']).map(collapseText);
}

/** The texts a node reads as, whitespace collapsed: its name, text, and value. */
function readsOf(node: { readonly name?: string; readonly text?: string; readonly value?: string }): string[] {
  return [node.name, node.text, node.value].filter((read): read is string => read !== undefined).map(collapseText);
}

/** A node's descriptor as an action on it would record it, with what it shows, or undefined when nothing durable names it. */
function durableTarget(
  id: string,
  observation: Extract<AgentObservation, { kind: 'semantic' }>,
  redact: (text: string) => string,
): CodegenTargetDescriptor | undefined {
  const node = observation.nodes.get(id);
  if (node === undefined) return undefined;
  const described = describeTarget(node);
  if (described === undefined) return undefined;
  const within = containerKey(id, observation.nodes, observation.parents);
  const position = describePosition(node, within, observation.nodes);
  const descriptor: TraceTargetDescriptor = {
    ...described,
    ...(within === undefined ? {} : { within }),
    ...(position === undefined ? {} : { position }),
  };
  if (!isRelocatableDescriptor(descriptor)) return undefined;
  return { ...descriptor, ...codegenExtrasOf(node, redact) };
}

/** The checks in order, each once. */
function dedupe(checks: readonly CodegenCheck[]): CodegenCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = JSON.stringify(check);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
