/**
 * The codegen seam: what `e2e run --codegen` hands an engine so it can write
 * the run's agent steps out as the engine's own test code. The runner records
 * every grammar action an `agent.act` step committed (the same recording the
 * replay cache keeps, independent of the cache mode), groups the passing tests
 * by file, and calls the target engine's `codegen.render` once per file. The
 * runner knows nothing about the code it gets back; it only writes it.
 */

import type { RecordedAction, TraceTargetDescriptor } from '../cache/trace.ts';

/** One grammar action an agent step committed, with the durable descriptor of its node. */
export type CodegenAction = RecordedAction;

/** How a recorded action addressed its node: role and name, test id, text, and the rest. */
export type CodegenTargetDescriptor = TraceTargetDescriptor;

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

/** One step of a passing test, in the order it ran. */
export interface CodegenStep {
  /** The public API the step ran through: `agent.act`, `agent.assert`, a locator action, `app.open`. */
  readonly api: string;
  /** The step's label as the report shows it, redacted: the instruction of an agent step. */
  readonly label: string;
  /** The test file line the step was called from, when known. */
  readonly line?: number;
  /** Present for an `agent.act` step that committed at least one action. */
  readonly recording?: CodegenRecording;
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
  readonly tests: readonly CodegenTest[];
}

/** Writes recorded agent steps out as the engine's own test code (`e2e run --codegen`). */
export interface EngineCodegen {
  /** The extension of the files `render` writes, with its leading dot: `.spec.ts`. */
  readonly extension: string;
  /** Returns the source text for one test file's tests. Runs in the runner process after the run. */
  render(file: CodegenFile): string;
}
