/**
 * `--codegen` for the judgment tier: the deterministic checks a script makes
 * in place of `agent.assert`, `agent.waitFor`, and `agent.extract`.
 *
 * Once a judgment passed, the judge is asked one more question about the very
 * observation it passed on: which facts on this screen prove the condition, as
 * checks a script can make without a model (this node is visible, reads this
 * text, holds this value, is checked; this text is nowhere; the location is
 * this). The answer is evidence to verify, never trusted: every check is held
 * against the same observation and dropped when the screen does not bear it
 * out, and every node is kept by the durable descriptor the replay cache
 * records, so a script finds it the way a replay would.
 *
 * The question runs only in a `--codegen` run, after the verdict, on its own
 * budget; whatever goes wrong with it leaves the step's outcome untouched and
 * the step without checks.
 */

import { describeTarget, containerKey } from './actions.ts';
import { Invocation, type AgentContext } from './invocation.ts';
import type { AgentObservation } from './observation.ts';
import { isRelocatableDescriptor, describePosition } from '../cache/relocate.ts';
import type { TraceTargetDescriptor } from '../cache/trace.ts';
import type { CodegenCheck } from '../engine/codegen.ts';
import { collapseText } from '../internal/text.ts';
import { CHECKS_SCHEMA, CHECKS_SCHEMA_NAME, MAX_CHECKS, validateChecksResponse, type ProposedCheck } from './protocol.ts';

/** One call and one repair round, as an assertion gets. */
const CHECKS_MODEL_CALLS = 2;

const CHECKS_REQUEST = [
  'The instruction below held on this observation. A script that cannot ask a model has to verify the same thing on this screen.',
  `List the fewest checks, at most ${String(MAX_CHECKS)}, that together prove it, each a fact the observation shows right now:`,
  '- "visible": node is on screen. "text": node\'s text or name contains text. "value": the field node holds exactly text.',
  '- "checked", "unchecked", "enabled", "disabled": node is in that state.',
  '- "absent": no node on screen shows text. "url": the location is exactly text, as the observation reports it.',
  'node is the id of a node in the observation, such as "n12", or null for "absent" and "url". text is null where the kind takes none.',
  'Prefer a node with a role and a name, and the shortest text that still proves the point. Never invent a node or a text the observation does not show.',
  'Respond with { "checks": [{ "kind": <kind>, "node": <id or null>, "text": <text or null> }] }.',
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
  if (runtime.codegen === undefined || stepId === undefined) return;
  const checks = await deriveCodegenChecks(runtime, request);
  const serialized = request.value === undefined ? undefined : JSON.stringify(request.value);
  const keepValue = serialized !== undefined && runtime.redact(serialized) === serialized;
  runtime.codegen.judged(stepId, { checks: checks ?? [], ...(keepValue ? { value: request.value } : {}) });
}

/**
 * Asks for the checks that prove a passed judgment and keeps the ones the
 * observation confirms. Undefined when the observation has no tree to check
 * against or the question failed in any way.
 */
async function deriveCodegenChecks(runtime: AgentContext, request: CodegenChecksRequest): Promise<readonly CodegenCheck[] | undefined> {
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
    const instruction =
      request.value === undefined
        ? request.instruction
        : `${request.instruction}\nThe data extracted from this screen was: ${JSON.stringify(request.value)}\nThe checks should show where the screen shows these values.`;
    const proposed = await invocation.ask({
      schemaName: CHECKS_SCHEMA_NAME,
      schema: CHECKS_SCHEMA,
      validate: validateChecksResponse,
      prompt: { request: CHECKS_REQUEST, instruction, observation },
    });
    const checks = proposed.flatMap((check) => {
      const confirmed = confirmCheck(check, observation, runtime.redact);
      return confirmed === undefined ? [] : [confirmed];
    });
    return dedupe(checks);
  } catch {
    // The checks are a by-product of a verdict already reached; a failed
    // question costs the generated code its assertion, never the test.
    return undefined;
  }
}

/**
 * Holds one proposed check against the observation it was proposed on, and
 * returns it with the node as its durable descriptor; undefined when the
 * screen does not bear it out, the node has nothing durable to find it by, or
 * a text would carry something the redactor masks.
 */
function confirmCheck(
  check: ProposedCheck,
  observation: Extract<AgentObservation, { kind: 'semantic' }>,
  redact: (text: string) => string,
): CodegenCheck | undefined {
  const text = check.text === null ? undefined : collapseText(check.text);
  if (text !== undefined && (text === '' || redact(text) !== text)) return undefined;
  switch (check.kind) {
    case 'url': {
      // The observation shows the model the path; the check keeps the whole
      // location, which the engine writes relative to the app where it can.
      const { location, path } = observation;
      return text !== undefined && location !== undefined && (text === path || text === location) ? { kind: 'url', location } : undefined;
    }
    case 'absent': {
      if (text === undefined) return undefined;
      const shown = [...observation.nodes.values()].some((node) => readsOf(node).some((read) => read.includes(text)));
      return shown ? undefined : { kind: 'absent', text };
    }
    default:
      break;
  }
  const node = check.node === null ? undefined : observation.nodes.get(check.node.replace(/^#/u, ''));
  if (node === undefined) return undefined;
  const target = durableTarget(node.ref.id, observation);
  if (target === undefined) return undefined;
  const states = node.states ?? {};
  switch (check.kind) {
    case 'visible':
      return { kind: 'visible', target };
    case 'text':
      return text !== undefined && readsOf(node).some((read) => read.includes(text)) ? { kind: 'text', target, text } : undefined;
    case 'value':
      return text !== undefined && node.value !== undefined && collapseText(node.value) === text ? { kind: 'value', target, value: text } : undefined;
    case 'checked':
    case 'unchecked': {
      const checked = check.kind === 'checked';
      return (states.checked === true) === checked ? { kind: 'checked', target, checked } : undefined;
    }
    case 'enabled':
    case 'disabled': {
      const enabled = check.kind === 'enabled';
      return (states.disabled !== true) === enabled ? { kind: 'enabled', target, enabled } : undefined;
    }
  }
}

/** The texts a node reads as, whitespace collapsed: its name, text, and value. */
function readsOf(node: { readonly name?: string; readonly text?: string; readonly value?: string }): string[] {
  return [node.name, node.text, node.value].filter((read): read is string => read !== undefined).map(collapseText);
}

/** A node's descriptor as an action on it would record it, or undefined when nothing durable names it. */
function durableTarget(id: string, observation: Extract<AgentObservation, { kind: 'semantic' }>): TraceTargetDescriptor | undefined {
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
  return isRelocatableDescriptor(descriptor) ? descriptor : undefined;
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
