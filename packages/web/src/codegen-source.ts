/**
 * `--codegen` by source conversion: the e2e test file itself, rewritten as a
 * Playwright Test file, so its control flow, helpers, and deterministic steps
 * stay exactly as written and only what needs a model is replaced.
 *
 * - Each `agent.act` call becomes the Playwright calls its recorded actions
 *   map to; each `agent.assert` and `agent.waitFor` the `expect`s its recorded
 *   checks map to (`waitFor`'s with its timeout, since Playwright's
 *   assertions retry as `waitFor` polled); each `agent.extract` the value it
 *   returned, behind the checks that show it on screen.
 * - The rest of the e2e API maps onto Playwright's: the `app`, `screen`, and
 *   `browser` fixtures onto `page`, `app.open` onto `page.goto`, `tap` onto
 *   `click`, and e2e's exact-by-default text matching onto `{ exact: true }`.
 *   The e2e imports go; `credentials`, `secrets`, and `unique` become small
 *   helpers reading the variables that override them in the e2e config.
 *
 * A call is paired with its recording by where the run says it was called
 * from, then by its instruction, then by its order in the test. A call with
 * no recording (its test did not pass, or the run never reached it) throws
 * when the generated test reaches it, rather than passing on nothing.
 */

import { createRequire } from 'node:module';
import type { CodegenFile, CodegenRendered, CodegenStep, CodegenTest } from 'e2e/engine';
import { failureComments, gapComments, gapMarker, literal, oneLine, StatementWriter, takeGapLines } from './codegen-statements.ts';

/** An ESTree node as `oxc-parser` returns it, offsets in UTF-16 code units. */
interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

/** One text replacement on the source; a `block` replaces a whole region, and edits inside it are dropped. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly block?: boolean;
}

/** The fixtures the conversion knows, by their e2e name. */
type FixtureName = 'app' | 'agent' | 'screen' | 'browser' | 'session';

const FIXTURE_NAMES: ReadonlySet<string> = new Set(['app', 'agent', 'screen', 'browser', 'session', 'platform']);

/** Packages whose imports the conversion removes: the runner and its engines. */
const E2E_MODULE = /^(?:e2e(?:\/.*)?|@e2e-dev\/[^/]+)$/u;

/** The judgment and action methods of the `agent` fixture. */
const AGENT_METHODS: ReadonlySet<string> = new Set(['act', 'assert', 'waitFor', 'extract']);

/** e2e's default judgment timeout, the `waitFor` deadline when the call names none. */
const DEFAULT_JUDGMENT_TIMEOUT = '30_000';

/** Methods with the same meaning under another name in Playwright. */
const RENAMED_METHODS: Readonly<Record<string, string>> = {
  tap: 'click',
  doubleTap: 'dblclick',
  scrollIntoView: 'scrollIntoViewIfNeeded',
  textContent: 'innerText',
  allTextContents: 'allInnerTexts',
  setViewport: 'setViewportSize',
};

/** The `app` fixture's steering calls, as `page` calls. */
const APP_METHODS: Readonly<Record<string, string>> = {
  open: 'goto',
  back: 'goBack',
  restart: 'reload',
  screenshot: 'screenshot',
  clearState: 'context().clearCookies',
};

/** Text queries e2e matches whole by default, where Playwright matches a substring unless `exact`. */
const EXACT_BY_DEFAULT: ReadonlySet<string> = new Set(['getByText', 'getByLabel', 'getByPlaceholder']);

/** One `agent.*` call in the source, and where its replacement goes. */
interface AgentSite {
  readonly api: string;
  readonly call: AstNode;
  /** The expression the call's value is: the `await` around it, else the call. */
  readonly expression: AstNode;
  /** The statement that holds the expression; replaced whole when the expression is all it is. */
  readonly statement: AstNode | undefined;
  readonly standalone: boolean;
  readonly test: CodegenTest | undefined;
  /** Whether the call is in a test's own body, where only that test's recording counts, rather than in a hook or helper. */
  readonly inTest: boolean;
  /** Zero-based place among the calls of the same method in its test, in source order. */
  readonly ordinal: number;
}

/** What the walk carries down: the fixtures in scope, the describe titles, and the test being converted. */
interface WalkContext {
  readonly fixtures: ReadonlyMap<string, FixtureName>;
  readonly describes: readonly string[];
  readonly test: CodegenTest | undefined;
  readonly insideTest: boolean;
}

/**
 * Converts the file's source to Playwright, or returns undefined when there
 * is no source or it does not parse, and the caller falls back to writing the
 * recorded steps alone.
 */
export function convertSource(file: CodegenFile, testIdAttribute: string): CodegenRendered | undefined {
  if (file.source === undefined) return undefined;
  const program = parse(file.file, file.source);
  if (program === undefined) return undefined;
  return new SourceConverter(file, file.source, testIdAttribute).convert(program);
}

/** Whether a value is an ESTree node: an object with a string `type` and its offsets. */
function isAstNode(value: unknown): value is AstNode {
  if (typeof value !== 'object' || value === null) return false;
  const node: { readonly type?: unknown; readonly start?: unknown; readonly end?: unknown } = value;
  return typeof node.type === 'string' && typeof node.start === 'number' && typeof node.end === 'number';
}

function parse(fileName: string, source: string): AstNode | undefined {
  try {
    const { parseSync } = createRequire(import.meta.url)('oxc-parser') as typeof import('oxc-parser');
    const result = parseSync(fileName, source, { sourceType: 'module' });
    if (result.errors.length > 0) return undefined;
    // The parser's own types describe its ESTree; the converter reads it as the plain nodes it is.
    const program: unknown = result.program;
    return isAstNode(program) ? program : undefined;
  } catch {
    return undefined;
  }
}

class SourceConverter {
  private readonly edits: Edit[] = [];
  private readonly sites: AgentSite[] = [];
  /** The judgment steps with a gap, and the tests with a failure, the code marks, by marker index. */
  private readonly marks: { readonly kind: 'gap' | 'failure'; readonly test: number; readonly step: number }[] = [];
  private readonly writer: StatementWriter;
  private readonly lineStarts: number[];
  /** Local names of what the file imported from e2e, by the name e2e exports it under. */
  private readonly imported = new Map<string, string>();
  /** Per test, how many calls of each agent method the walk has met. */
  private readonly ordinals = new Map<CodegenTest | undefined, Map<string, number>>();
  private lastImportEnd = 0;

  constructor(
    private readonly file: CodegenFile,
    private readonly source: string,
    testIdAttribute: string,
  ) {
    this.writer = new StatementWriter(testIdAttribute, file.appUrl);
    this.lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === '\n') this.lineStarts.push(index + 1);
    }
  }

  convert(program: AstNode): CodegenRendered {
    for (const statement of children(program)) {
      if (statement.type === 'ImportDeclaration') this.visitImport(statement);
    }
    this.walk(program, [], { fixtures: new Map(), describes: [], test: undefined, insideTest: false });
    for (const site of this.sites) this.replaceSite(site);
    const top = this.topLines();
    const helpers = this.helperLines();
    this.edits.push({ start: 0, end: 0, text: `${top.join('\n')}\n` });
    this.edits.push({ start: this.lastImportEnd, end: this.lastImportEnd, text: `${this.lastImportEnd === 0 ? '' : '\n'}\n${helpers.join('\n')}\n` });
    const { code, lines } = takeGapLines(`${applyEdits(this.source, this.edits).replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`);
    const marked = this.marks.flatMap(({ kind, test, step }, index) => {
      const line = lines.get(index);
      return line === undefined ? [] : [{ kind, test, step, line }];
    });
    return {
      code,
      gaps: marked.filter((mark) => mark.kind === 'gap').map(({ test, step, line }) => ({ test, step, line })),
      failures: marked.filter((mark) => mark.kind === 'failure').map(({ test, line }) => ({ test, line })),
    };
  }

  /** Drops an import from e2e or an engine, remembering its names; keeps every other import. */
  private visitImport(declaration: AstNode): void {
    const from = (declaration['source'] as AstNode)['value'];
    if (typeof from !== 'string' || !E2E_MODULE.test(from)) {
      this.lastImportEnd = Math.max(this.lastImportEnd, declaration.end);
      return;
    }
    for (const specifier of (declaration['specifiers'] as AstNode[] | undefined) ?? []) {
      const local = (specifier['local'] as AstNode)['name'];
      const importedNode = specifier['imported'] as AstNode | undefined;
      const name = importedNode === undefined ? 'default' : (importedNode['name'] ?? importedNode['value']);
      if (typeof local === 'string' && typeof name === 'string') this.imported.set(name, local);
    }
    const end = this.source[declaration.end] === '\n' ? declaration.end + 1 : declaration.end;
    this.edits.push({ start: declaration.start, end, text: '' });
    // Past the removed text, so the helpers inserted here land after it rather than inside it.
    this.lastImportEnd = Math.max(this.lastImportEnd, end);
  }

  private walk(node: AstNode, ancestors: readonly AstNode[], context: WalkContext): void {
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'CallExpression') {
      const handled = this.visitCall(node, ancestors, context);
      if (handled === 'done') return;
      if (handled !== undefined) {
        // A test, describe, or hook: its callback is walked with the fixtures it destructures.
        this.walkHarnessCall(node, ancestors, context, handled);
        return;
      }
    }
    if (node.type === 'Identifier') this.visitIdentifier(node, ancestors, context);
    const next = [...ancestors, node];
    for (const child of children(node)) this.walk(child, next, context);
  }

  /**
   * Handles one call: an `agent.*` call becomes a site, an e2e API call gets
   * its Playwright spelling. Returns the kind of a test, describe, or hook
   * call for the caller to walk, `done` when nothing under it needs walking.
   */
  private visitCall(call: AstNode, ancestors: readonly AstNode[], context: WalkContext): HarnessKind | 'done' | undefined {
    const harness = this.harnessKind(call['callee'] as AstNode);
    if (harness !== undefined) return harness;
    const callee = call['callee'] as AstNode;
    if (callee.type !== 'MemberExpression' || callee['computed'] === true) return undefined;
    const object = callee['object'] as AstNode;
    const property = callee['property'] as AstNode;
    const method = property['name'];
    if (typeof method !== 'string') return undefined;
    const fixture = object.type === 'Identifier' ? context.fixtures.get(object['name'] as string) : undefined;
    if (fixture === 'agent' && AGENT_METHODS.has(method)) {
      this.addSite(call, `agent.${method}`, ancestors, context);
      return 'done';
    }
    const args = (call['arguments'] as AstNode[] | undefined) ?? [];
    if (fixture === 'app') {
      const mapped = APP_METHODS[method];
      this.edits.push({ start: object.start, end: object.end, text: 'page' });
      if (mapped === undefined) {
        this.edits.push({ start: property.start, end: property.end, text: `${method} /* TODO: e2e app.${method} has no Playwright counterpart */` });
      } else {
        this.edits.push({ start: property.start, end: property.end, text: mapped });
        if (method === 'open' && args.length === 0) this.edits.push({ start: call.end - 1, end: call.end - 1, text: '"/"' });
      }
      return undefined;
    }
    if (fixture === 'session') {
      const statement = enclosingStatement(ancestors, call);
      if (statement !== undefined) {
        this.edits.push({
          start: statement.start,
          end: statement.end,
          text: `// e2e ${oneLine(this.source.slice(call.start, call.end))}: keep sign-in with Playwright's storageState instead.`,
          block: true,
        });
      }
      return 'done';
    }
    if (fixture === 'browser' && method === 'setCookies') this.edits.push({ start: property.start, end: property.end, text: 'context().addCookies' });
    if (fixture === 'browser' && method === 'cookies') this.edits.push({ start: property.start, end: property.end, text: 'context().cookies' });
    this.mapLocatorCall(method, property, args);
    return undefined;
  }

  /** Playwright spellings of e2e's locator and matcher calls, by method name. */
  private mapLocatorCall(method: string, property: AstNode, args: readonly AstNode[]): void {
    const renamed = RENAMED_METHODS[method];
    if (renamed !== undefined) this.edits.push({ start: property.start, end: property.end, text: renamed });
    if (method === 'secondaryTap') {
      this.edits.push({ start: property.start, end: property.end, text: 'click' });
      this.mergeOption(args[0], property, 'button: "right"');
    }
    if (method === 'toBeSelected' || method === 'toBeExpanded') {
      if (args.length === 0) {
        const attribute = method === 'toBeSelected' ? 'aria-selected' : 'aria-expanded';
        this.edits.push({ start: property.start, end: property.end, text: `toHaveAttribute(${literal(attribute)}, "true"` });
        this.edits.push({ start: property.end, end: property.end + 1, text: '' });
      }
    }
    if (method === 'selectOption' && args.length >= 1 && isStringNode(args[0]!)) {
      const arg = args[0]!;
      this.edits.push({ start: arg.start, end: arg.end, text: `{ label: ${this.source.slice(arg.start, arg.end)} }` });
    }
    if (method === 'getByRole' && args.length >= 2) {
      const name = args[1]!;
      if (name.type === 'ObjectExpression') {
        if (hasProperty(name, 'name') && !hasProperty(name, 'exact')) this.insertIntoObject(name, 'exact: true');
      } else {
        this.edits.push({ start: name.start, end: name.end, text: `{ name: ${this.source.slice(name.start, name.end)}, exact: true }` });
      }
    }
    if (EXACT_BY_DEFAULT.has(method) && args.length >= 1 && !isRegExpNode(args[0]!)) {
      const options = args[1];
      if (options === undefined) this.edits.push({ start: args[0]!.end, end: args[0]!.end, text: ', { exact: true }' });
      else if (options.type === 'ObjectExpression' && !hasProperty(options, 'exact')) this.insertIntoObject(options, 'exact: true');
    }
  }

  /** Adds `entry` to an options argument: into its object literal, or as the argument when there is none. */
  private mergeOption(options: AstNode | undefined, property: AstNode, entry: string): void {
    if (options === undefined) {
      const open = this.source.indexOf('(', property.end);
      if (open !== -1) this.edits.push({ start: open + 1, end: open + 1, text: `{ ${entry} }` });
      return;
    }
    if (options.type === 'ObjectExpression') this.insertIntoObject(options, entry);
  }

  private insertIntoObject(object: AstNode, entry: string): void {
    const empty = ((object['properties'] as AstNode[] | undefined) ?? []).length === 0;
    this.edits.push({ start: object.start + 1, end: object.start + 1, text: empty ? ` ${entry} ` : ` ${entry},` });
  }

  /** Renames a reference to the `screen` or `browser` fixture to `page`, and a standalone e2e hook to `test.<hook>`. */
  private visitIdentifier(identifier: AstNode, ancestors: readonly AstNode[], context: WalkContext): void {
    const parent = ancestors.at(-1);
    const kind = parent === undefined ? undefined : referenceKind(identifier, parent);
    if (kind === undefined) return;
    const name = identifier['name'] as string;
    const fixture = context.fixtures.get(name);
    if (fixture === 'screen' || fixture === 'browser') {
      this.edits.push({ start: identifier.start, end: identifier.end, text: kind === 'shorthand' ? `${name}: page` : 'page' });
    }
  }

  /** Whether a callee is one of e2e's `test`, `test.describe`, or hook calls, and which. */
  private harnessKind(callee: AstNode): HarnessKind | undefined {
    const path = memberPath(callee);
    if (path === undefined) return undefined;
    const [root, ...rest] = path;
    const testName = this.imported.get('test');
    if (root === testName) {
      if (rest.length === 0 || ['only', 'skip', 'fixme', 'fail', 'setup'].includes(rest[0]!)) {
        return rest.length <= 1 ? (rest[0] === 'setup' ? 'setup' : 'test') : undefined;
      }
      if (rest[0] === 'describe') return 'describe';
      if (['beforeEach', 'afterEach', 'beforeAll', 'afterAll'].includes(rest[0]!)) return 'hook';
      return undefined;
    }
    for (const hook of ['describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']) {
      if (root === this.imported.get(hook) && root !== undefined) {
        // A standalone `describe` or hook from e2e lives on `test` in Playwright.
        this.edits.push({ start: callee.start, end: callee.start + root.length, text: `test.${hook}` });
        return hook === 'describe' ? 'describe' : 'hook';
      }
    }
    return undefined;
  }

  /** Walks a test, describe, or hook call: its options become a comment, its callback's fixtures become `page`. */
  private walkHarnessCall(call: AstNode, ancestors: readonly AstNode[], context: WalkContext, kind: HarnessKind): void {
    const args = (call['arguments'] as AstNode[] | undefined) ?? [];
    const callee = call['callee'] as AstNode;
    if (kind === 'setup') {
      const property = callee['property'] as AstNode;
      this.edits.push({ start: (callee['object'] as AstNode).end, end: property.end, text: '' });
    }
    const title = args[0] !== undefined ? stringValue(args[0]) : undefined;
    if ((kind === 'test' || kind === 'setup' || kind === 'describe') && args.length === 3 && args[1]!.type === 'ObjectExpression') {
      const options = this.source.slice(args[1]!.start, args[1]!.end);
      this.edits.push({ start: args[0]!.end, end: args[1]!.end, text: ` /* e2e options: ${oneLine(options).replaceAll('*/', '* /')} */` });
    }
    const describes = kind === 'describe' && title !== undefined ? [...context.describes, title] : context.describes;
    const test = kind === 'test' || kind === 'setup' ? this.testFor([...context.describes, title ?? '']) : context.test;
    const callback = args.at(-1);
    if ((kind === 'test' || kind === 'setup') && test?.failure !== undefined && callback !== undefined && isFunction(callback)) this.noteTestFailure(test, callback);
    const next = [...ancestors, call];
    for (const arg of args) {
      if (arg === callback && isFunction(arg)) {
        const fixtures = this.fixturesOf(arg, context.fixtures);
        this.walk(arg, next, {
          fixtures,
          describes,
          test,
          insideTest: context.insideTest || kind === 'test' || kind === 'setup',
        });
      } else {
        this.walk(arg, next, context);
      }
    }
  }

  /**
   * Puts a test's failure at the top of its body when no agent call carries
   * it: the test's own code failed (an `expect`, a locator action) or threw,
   * and Playwright stops at the same line, so only the comment is added.
   */
  private noteTestFailure(test: CodegenTest, callback: AstNode): void {
    const failure = test.failure!;
    const body = callback['body'] as AstNode | undefined;
    const first = body?.type === 'BlockStatement' ? ((body['body'] as AstNode[] | undefined) ?? [])[0] : undefined;
    if (first === undefined) return;
    const index = this.mark('failure', this.file.tests.indexOf(test), -1);
    const where = failure.line === undefined ? (failure.api ?? 'the test') : `line ${String(failure.line)}${failure.api === undefined ? '' : ` (${failure.api}${failure.label === undefined || failure.label === '' ? '' : ` ${failure.label}`})`}`;
    const lines = failureComments(failure, where);
    if (index !== undefined) lines[0] = `${gapMarker(index)}${lines[0]!}`;
    const indent = this.indentAt(first.start);
    this.edits.push({ start: first.start, end: first.start, text: lines.map((line) => `${line}\n${indent}`).join('') });
  }

  /** The fixtures a callback destructures, by local name; its pattern becomes `{ page }`. */
  private fixturesOf(callback: AstNode, outer: ReadonlyMap<string, FixtureName>): ReadonlyMap<string, FixtureName> {
    const param = ((callback['params'] as AstNode[] | undefined) ?? [])[0];
    if (param?.type !== 'ObjectPattern') return outer;
    const fixtures = new Map(outer);
    let any = false;
    for (const property of (param['properties'] as AstNode[] | undefined) ?? []) {
      if (property.type !== 'Property') continue;
      const key = (property['key'] as AstNode)['name'];
      const value = property['value'] as AstNode;
      if (typeof key !== 'string' || !FIXTURE_NAMES.has(key)) continue;
      any = true;
      if (value.type === 'Identifier' && key !== 'platform') fixtures.set(value['name'] as string, key as FixtureName);
    }
    if (any) {
      const typed = param['typeAnnotation'] as AstNode | undefined | null;
      this.edits.push({ start: param.start, end: typed === undefined || typed === null ? param.end : typed.end, text: '{ page }', block: true });
    }
    return fixtures;
  }

  /** The recorded test a source test is, by its title path, else by its title alone. */
  private testFor(titlePath: readonly string[]): CodegenTest | undefined {
    const title = titlePath.at(-1);
    return (
      this.file.tests.find((test) => sameList(test.titlePath, titlePath)) ??
      this.file.tests.find((test) => test.title === title)
    );
  }

  private addSite(call: AstNode, api: string, ancestors: readonly AstNode[], context: WalkContext): void {
    const parent = ancestors.at(-1);
    const expression = parent?.type === 'AwaitExpression' ? parent : call;
    const holder = ancestors.at(expression === call ? -1 : -2);
    const statement = enclosingStatement(ancestors, call);
    const counts = this.ordinals.get(context.test) ?? new Map<string, number>();
    this.ordinals.set(context.test, counts);
    const ordinal = counts.get(api) ?? 0;
    counts.set(api, ordinal + 1);
    this.sites.push({
      api,
      call,
      expression,
      statement,
      standalone: holder?.type === 'ExpressionStatement',
      test: context.insideTest ? context.test : undefined,
      inTest: context.insideTest,
      ordinal,
    });
  }

  /** The recorded step a call ran as: by its source position, then its instruction, then its order in the test. */
  private stepFor(site: AgentSite): CodegenStep | undefined {
    // A test that did not pass recorded nothing to write; another test's recording is not its.
    if (site.inTest && site.test === undefined) return undefined;
    const pool = (site.test === undefined ? this.file.tests : [site.test]).flatMap((test) => test.steps.filter((step) => step.api === site.api));
    const first = this.lineOf(site.call.start);
    const last = this.lineOf(site.call.end);
    const byLine = pool.filter((step) => step.line !== undefined && step.line >= first && step.line <= last);
    const withData = (steps: readonly CodegenStep[]): CodegenStep | undefined =>
      steps.find((step) => step.recording !== undefined || step.judgment !== undefined) ?? steps[0];
    const instruction = stringValue(((site.call['arguments'] as AstNode[] | undefined) ?? [])[0]);
    const labelled = (steps: readonly CodegenStep[]): CodegenStep[] =>
      instruction === undefined
        ? [...steps]
        : steps.filter((step) => step.label === instruction || (step.label.endsWith('…') && instruction.startsWith(step.label.slice(0, -1))));
    // A line a loader reported off by a few is still a line: of the steps on
    // it, the one whose instruction this call spells is the call's.
    const onLine = labelled(byLine);
    if (onLine.length > 0) return withData(onLine);
    if (byLine.length > 0 && instruction === undefined) return withData(byLine);
    const byLabel = instruction === undefined ? [] : labelled(pool);
    if (byLabel.length > 0) return withData(byLabel);
    if (byLine.length > 0) return withData(byLine);
    return site.test === undefined ? undefined : pool[site.ordinal];
  }

  private replaceSite(site: AgentSite): void {
    const step = this.stepFor(site);
    const args = (site.call['arguments'] as AstNode[] | undefined) ?? [];
    // The instruction as it ran: a template's or a variable's value is in the
    // recorded label. With no recording the value exists only when the test
    // runs, so the error reads it then, from the expression the test passed.
    const instruction = args[0] === undefined ? '' : (stringValue(args[0]) ?? step?.label);
    const expression = args[0] === undefined ? '""' : this.source.slice(args[0].start, args[0].end);
    const header = instruction === undefined ? `// ${site.api}(${oneLine(expression)})` : `// ${site.api}: ${oneLine(instruction)}`;
    const missing = (why: string): string =>
      instruction === undefined
        ? `throw new Error(\`${site.api}(\${JSON.stringify(${expression})}) ${why}\`);`
        : `throw new Error(${literal(`${site.api}(${JSON.stringify(oneLine(instruction))}) ${why}`)});`;
    let lines: string[];
    let value = 'undefined';
    let marked: number | undefined;
    if (step === undefined) {
      lines = [`// TODO: the run this code was written from did not reach this call, so nothing was recorded for it.`, missing('was not recorded by e2e run --codegen')];
    } else if (step.failure !== undefined) {
      // The run failed here: what the step did before it failed, then the failure, and the code stops.
      lines = [
        ...(step.recording?.actions ?? []).flatMap((action) => this.writer.action(action)),
        ...failureComments(step.failure),
        missing(`failed in the run this code was written from (${step.failure.code})`),
      ];
      marked = this.markStep('failure', step);
    } else if (site.api === 'agent.act') {
      const recording = step.recording;
      lines =
        recording === undefined
          ? ['// The agent found nothing to do here in the recorded run.']
          : [
              ...(recording.incomplete
                ? ['// NOTE: this step was not recorded whole (a secret in a value, an action over the cap, or a node', '// with nothing durable to find it by); check the calls below against the run.']
                : []),
              ...recording.actions.flatMap((action) => this.writer.action(action)),
            ];
    } else {
      const checks = step.judgment?.checks ?? [];
      const gap = step.judgment?.gap;
      const timeout = site.api === 'agent.waitFor' ? (optionText(args[1], 'timeout', this.source) ?? DEFAULT_JUDGMENT_TIMEOUT) : undefined;
      lines =
        checks.length === 0
          ? [
              '// TODO: no deterministic check could be derived from the screen this judgment passed on.',
              ...(gap === undefined ? [] : gapComments(gap, false).slice(1)),
              missing('has no recorded check; write it as an expect()'),
            ]
          : [...(gap === undefined ? [] : gapComments(gap, true)), ...checks.map((check) => this.writer.check(check, timeout))];
      if (gap !== undefined) marked = this.markStep('gap', step);
      if (site.api === 'agent.extract') {
        if (step.judgment?.value === undefined) lines.push(missing('returned a value that was not recorded'));
        else value = literal(step.judgment.value);
      }
    }
    lines.unshift(marked === undefined ? header : `${gapMarker(marked)}${header}`);
    const indent = this.indentAt(site.statement?.start ?? site.call.start);
    if (site.standalone && site.statement !== undefined) {
      this.edits.push({ start: site.statement.start, end: site.statement.end, text: lines.join(`\n${indent}`), block: true });
      return;
    }
    // A call the code did not await on the spot (`agent.assert(…).catch(…)`, a
    // promise kept for later) still stands for a promise.
    const replacement = site.expression === site.call ? `Promise.resolve(${value === 'undefined' ? '' : value})` : value === 'undefined' ? 'undefined' : `(${value})`;
    this.edits.push({ start: site.expression.start, end: site.expression.end, text: replacement, block: true });
    if (site.statement !== undefined) {
      this.edits.push({ start: site.statement.start, end: site.statement.start, text: lines.map((line) => `${line}\n${indent}`).join('') });
    }
  }

  /** Notes a judgment step with a gap, or a step a test failed at, once, and returns the marker index its header carries. */
  private markStep(kind: 'gap' | 'failure', step: CodegenStep): number | undefined {
    const test = this.file.tests.findIndex((candidate) => candidate.steps.includes(step));
    if (test === -1) return undefined;
    return this.mark(kind, test, this.file.tests[test]!.steps.indexOf(step));
  }

  /** Notes one mark once; a step a loop or a helper reaches from several call sites is reported where the first one writes it. */
  private mark(kind: 'gap' | 'failure', test: number, step: number): number | undefined {
    if (this.marks.some((mark) => mark.kind === kind && mark.test === test && mark.step === step)) return undefined;
    this.marks.push({ kind, test, step });
    return this.marks.length - 1;
  }

  /** The comment, imports, and settings the converted file opens with. */
  private topLines(): string[] {
    return [
      `// Generated by \`e2e run --codegen\` from ${this.file.file} (target "${oneLine(this.file.target)}").`,
      '// The agent steps are what the agent did and checked in that run; the rest is the test as written.',
      ...this.writer.imports(),
    ];
  }

  /** The helpers the converted code calls, after the file's own imports. */
  private helperLines(): string[] {
    const lines: string[] = [];
    if (this.file.appUrl !== undefined) lines.push(`test.use({ baseURL: process.env["BASE_URL"] ?? ${literal(this.file.appUrl)} });`, '');
    const credentials = this.imported.get('credentials');
    const secrets = this.imported.get('secrets');
    const unique = this.imported.get('unique');
    if (credentials !== undefined || secrets !== undefined) this.writer.needs.secrets = true;
    lines.push(...this.writer.helpers());
    if (credentials !== undefined) {
      lines.push(
        `/** e2e's \`${credentials}\`: each account's username and password, from E2E_USER_<NAME>_USERNAME and _PASSWORD. */`,
        `const ${credentials} = {`,
        '  user(name: string): { readonly username: string; readonly password: string } {',
        `    const prefix = \`E2E_USER_\${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}\`;`,
        `    const usernames: Record<string, string> = ${literal(this.file.usernames ?? {})};`,
        '    return {',
        '      username: process.env[`${prefix}_USERNAME`] ?? usernames[name] ?? "",',
        '      get password() {',
        '        return secret(`${prefix}_PASSWORD`);',
        '      },',
        '    };',
        '  },',
        '};',
        '',
      );
    }
    if (secrets !== undefined) {
      lines.push(
        `/** e2e's \`${secrets}\`: each secret's value, from E2E_SECRET_<NAME>. */`,
        `const ${secrets} = { get: (name: string): string => secret(\`E2E_SECRET_\${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}\`) };`,
        '',
      );
    }
    if (unique !== undefined) {
      lines.push(`/** e2e's \`${unique}\` marks a value the replay cache records as a slot; a script uses the value. */`, `const ${unique} = (value: string): string => value;`, '');
    }
    return lines;
  }

  private lineOf(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  private indentAt(offset: number): string {
    const start = this.lineStarts[this.lineOf(offset) - 1]!;
    return /^[ \t]*/u.exec(this.source.slice(start, offset))?.[0] ?? '';
  }
}

type HarnessKind = 'test' | 'setup' | 'describe' | 'hook';

/** Applies non-overlapping edits from the end, dropping any inside a block edit. */
function applyEdits(source: string, edits: readonly Edit[]): string {
  const blocks = edits.filter((edit) => edit.block === true);
  const kept = edits.filter(
    (edit) => !blocks.some((block) => block !== edit && block.start <= edit.start && edit.end <= block.end && !(edit.start === edit.end && edit.start === block.start)),
  );
  const ordered = kept.toSorted((a, b) => b.start - a.start || b.end - a.end);
  let text = source;
  for (const edit of ordered) text = `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`;
  return text;
}

/** The child nodes of a node, in source order. */
function children(node: AstNode): AstNode[] {
  const found: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found.toSorted((a, b) => a.start - b.start);
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' && typeof (value as { start?: unknown }).start === 'number';
}

/** `a.b.c` as `['a', 'b', 'c']`, or undefined for anything but plain identifiers and dotted members. */
function memberPath(node: AstNode): string[] | undefined {
  if (node.type === 'Identifier') return [node['name'] as string];
  if (node.type !== 'MemberExpression' || node['computed'] === true) return undefined;
  const object = memberPath(node['object'] as AstNode);
  const property = (node['property'] as AstNode)['name'];
  return object === undefined || typeof property !== 'string' ? undefined : [...object, property];
}

/** Parents under which an identifier names something rather than refers to a binding. */
const NAMING_PARENTS: ReadonlySet<string> = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'ImportSpecifier',
  'LabeledStatement',
  'TSTypeReference',
  'TSQualifiedName',
  'MethodDefinition',
  'PropertyDefinition',
]);

/** How an identifier is used: a reference to a binding, the value of a shorthand property, or a name. */
function referenceKind(identifier: AstNode, parent: AstNode): 'reference' | 'shorthand' | undefined {
  if (parent.type === 'MemberExpression') return parent['object'] === identifier || parent['computed'] === true ? 'reference' : undefined;
  if (parent.type === 'Property') {
    if (parent['value'] !== identifier) return undefined;
    return parent['shorthand'] === true ? 'shorthand' : 'reference';
  }
  if (parent.type === 'VariableDeclarator') return parent['init'] === identifier ? 'reference' : undefined;
  return NAMING_PARENTS.has(parent.type) ? undefined : 'reference';
}

/** The statement directly inside a block or program that holds a node. */
function enclosingStatement(ancestors: readonly AstNode[], node: AstNode): AstNode | undefined {
  const chain = [...ancestors, node];
  for (let index = chain.length - 1; index > 0; index -= 1) {
    const parent = chain[index - 1]!;
    if (parent.type === 'BlockStatement' || parent.type === 'Program' || parent.type === 'StaticBlock') return chain[index];
    if (parent.type === 'ArrowFunctionExpression' && parent['body'] === chain[index]) return chain[index];
  }
  return undefined;
}

function isFunction(node: AstNode): boolean {
  return node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';
}

/** A string literal's or a plain template's value; undefined for anything computed. */
function stringValue(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type === 'TemplateLiteral' && ((node['expressions'] as unknown[] | undefined) ?? []).length === 0) {
    const quasi = ((node['quasis'] as AstNode[] | undefined) ?? [])[0];
    const cooked = (quasi?.['value'] as { cooked?: unknown } | undefined)?.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

function isStringNode(node: AstNode): boolean {
  return stringValue(node) !== undefined || node.type === 'TemplateLiteral';
}

function isRegExpNode(node: AstNode): boolean {
  return node.type === 'Literal' && node['regex'] !== undefined && node['regex'] !== null;
}

function hasProperty(object: AstNode, name: string): boolean {
  return ((object['properties'] as AstNode[] | undefined) ?? []).some((property) => {
    const key = property['key'] as AstNode | undefined;
    return key !== undefined && (key['name'] === name || key['value'] === name);
  });
}

/** The source text of one property's value in an options object literal. */
function optionText(options: AstNode | undefined, name: string, source: string): string | undefined {
  if (options?.type !== 'ObjectExpression') return undefined;
  const property = ((options['properties'] as AstNode[] | undefined) ?? []).find((candidate) => {
    const key = candidate['key'] as AstNode | undefined;
    return key !== undefined && (key['name'] === name || key['value'] === name);
  });
  const value = property?.['value'] as AstNode | undefined;
  return value === undefined ? undefined : source.slice(value.start, value.end);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

