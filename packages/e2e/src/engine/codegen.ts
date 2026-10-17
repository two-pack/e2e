/**
 * The codegen seam: what `e2e run --codegen` hands an engine so it can write
 * the run's agent steps out as the engine's own test code. The runner records
 * every grammar action an `agent.act` step committed (the same recording the
 * replay cache keeps, independent of the cache mode), groups the passing tests
 * by file, and calls the target engine's `codegen.render` once per file. The
 * runner knows nothing about the code it gets back; it only writes it.
 */

import type { RecordedAction, TraceTargetDescriptor } from '../cache/trace.ts';

/**
 * One grammar action an agent step committed, with the durable descriptor of
 * its node; a node's descriptor may carry `shownText` (`CodegenTargetDescriptor`).
 */
export type CodegenAction = RecordedAction;

/**
 * How a recorded action or check addressed its node: the replay cache's
 * descriptor (role and name, test id, text, and the rest), plus what the node
 * shows on screen when that differs from its name.
 */
export interface CodegenTargetDescriptor extends TraceTargetDescriptor {
  /**
   * The text the node and its descendants show, joined in order, when it
   * differs from the node's name: a list row the engine names from its
   * children's names (a button's label among them) shows their text instead.
   * Bounded and redacted like the other fields.
   */
  readonly shownText?: string;
}

/** What one `agent.act` step did, as recorded while it ran. */
export interface CodegenRecording {
  /** Where the surface was when the step's first action ran, redacted; absent when it has no location. */
  readonly startLocation?: string;
  /** Committed actions in order. Secret fills carry the secret's name, never its value. */
  readonly actions: readonly CodegenAction[];
  /**
   * True when the recording could not keep an action whole: a value that
   * carried a secret or ran over the cap, a node with no durable descriptor,
   * an action over the step's cap. The actions document the step; code
   * written from them may not reproduce it.
   */
  readonly incomplete: boolean;
}

/**
 * One deterministic fact a judgment rested on, as it held on the screen the
 * judgment passed on: what a script asserts in place of asking a model. The
 * judge proposes them after its verdict; the runner keeps only the ones the
 * same observation confirms, each node by its durable descriptor.
 */
export type CodegenCheck =
  /** The node is on screen. */
  | { readonly kind: 'visible'; readonly target: CodegenTargetDescriptor }
  /** The node's text or accessible name contains `text`. */
  | { readonly kind: 'text'; readonly target: CodegenTargetDescriptor; readonly text: string }
  /** The field's current value is `value`. */
  | { readonly kind: 'value'; readonly target: CodegenTargetDescriptor; readonly value: string }
  | { readonly kind: 'checked'; readonly target: CodegenTargetDescriptor; readonly checked: boolean }
  | { readonly kind: 'enabled'; readonly target: CodegenTargetDescriptor; readonly enabled: boolean }
  /** Exactly `count` nodes with the role are on screen. */
  | { readonly kind: 'count'; readonly role: string; readonly count: number }
  /** The nodes with the role show these texts, in this order (others may sit between them). */
  | { readonly kind: 'order'; readonly role: string; readonly texts: readonly string[] }
  /** No node on screen shows `text`. */
  | { readonly kind: 'absent'; readonly text: string }
  /** The surface's location, path and query on the app's own origin, else whole. */
  | { readonly kind: 'url'; readonly location: string };

/**
 * What a judgment step (`agent.assert`, `agent.waitFor`, `agent.extract`)
 * left for code: the checks that prove it, and for an extraction the value it
 * returned to the test. Absent checks mean none could be derived.
 */
export interface CodegenJudgment {
  readonly checks: readonly CodegenCheck[];
  /** The value `agent.extract` returned, redacted; absent when it carried a secret. */
  readonly value?: unknown;
}

/** One step of a passing test, in the order it ran. */
export interface CodegenStep {
  /** The public API the step ran through: `agent.act`, `agent.assert`, a locator action, `app.open`. */
  readonly api: string;
  /** The step's label as the report shows it, redacted: the instruction of an agent step. */
  readonly label: string;
  /** The test file line the step was called from, when known. */
  readonly line?: number;
  /** The column of that call, one-based, when known. */
  readonly column?: number;
  /** Present for an `agent.act` step that committed at least one action. */
  readonly recording?: CodegenRecording;
  /** Present for a judgment step that passed with `--codegen` on. */
  readonly judgment?: CodegenJudgment;
}

/** One passing test, by title, with its steps. */
export interface CodegenTest {
  readonly title: string;
  /** Describe titles, outermost first, then the test's own. */
  readonly titlePath: readonly string[];
  readonly steps: readonly CodegenStep[];
}

/** One test file's passing tests on one target: the unit `render` writes. */
export interface CodegenFile {
  /** The e2e test file, project-root relative with `/` separators. */
  readonly file: string;
  readonly target: string;
  /** The target app's base URL, when it has one. */
  readonly appUrl?: string;
  /** The test file's source text, to convert with its control flow intact; absent when it could not be read. */
  readonly source?: string;
  /** The configured credentials' usernames by credential name; passwords are never handed over. */
  readonly usernames?: Readonly<Record<string, string>>;
  readonly tests: readonly CodegenTest[];
}

/** Writes recorded agent steps out as the engine's own test code (`e2e run --codegen`). */
export interface EngineCodegen {
  /** The extension of the files `render` writes, with its leading dot: `.spec.ts`. */
  readonly extension: string;
  /** Returns the source text for one test file's tests. Runs in the runner process after the run. */
  render(file: CodegenFile): string;
}
