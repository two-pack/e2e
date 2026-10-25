/**
 * `codegen.run` for the web engine: the Playwright Test files `render` wrote,
 * run with the project's own `@playwright/test` and a config of the engine's
 * own, so the project's `playwright.config.ts` (its web server, projects,
 * retries, test directory) never applies. The tests are named exactly with
 * `--test-list`, one title path per line, and the results read from the
 * json reporter's file. Nothing the tests print is kept: a failure's reason is
 * its error message, which the runner redacts.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CodegenRunOutcome, CodegenRunRequest, CodegenRunResult } from 'e2e/engine';
import type { BrowserName } from './browser-connection.ts';

/** What of the engine's options the generated code runs with, as Playwright Test's `use` spells them. */
export interface CodegenRunUse {
  readonly browserName?: BrowserName;
  readonly viewport?: { readonly width: number; readonly height: number } | null;
  readonly userAgent?: string;
  readonly locale?: string;
  readonly timezoneId?: string;
}

/** The separator a `--test-list` line splits a title path on. */
const TITLE_SEPARATOR = '›';
/** The most characters of the test runner's own error output a reason quotes. */
const MAX_DIAGNOSTIC_LENGTH = 1_000;

/**
 * Runs the requested tests of the generated files with Playwright Test and
 * returns how each ended. `unavailable` when `@playwright/test` cannot be
 * found from the project, its browser is not installed, or it wrote no report.
 */
export async function runGeneratedCode(request: CodegenRunRequest, use: CodegenRunUse): Promise<CodegenRunResult> {
  const cli = resolveCli(request.projectRoot);
  if (cli === undefined) {
    return {
      kind: 'unavailable',
      reason: '@playwright/test is not installed in the project; add it as a dev dependency to run the generated code',
    };
  }
  await mkdir(request.workDir, { recursive: true });
  const rootDir = commonDir(request.files.map((file) => path.dirname(file.path)));
  const reportFile = path.join(request.workDir, 'report.json');
  const configFile = path.join(request.workDir, 'playwright.config.mjs');
  const listFile = path.join(request.workDir, 'tests.txt');
  const wanted = new Map<string, string>();
  const lines: string[] = [];
  for (const file of request.files) {
    const relative = toPosix(path.relative(rootDir, file.path));
    for (const test of file.tests) {
      // A title the list cannot spell is left out: the test goes to the agent.
      if ([relative, ...test.titlePath].some((part) => part.includes(TITLE_SEPARATOR) || part.includes('\n') || part.trim() !== part)) continue;
      lines.push([relative, ...test.titlePath].join(` ${TITLE_SEPARATOR} `));
      wanted.set(testKey(relative, test.titlePath), test.id);
    }
  }
  if (lines.length === 0) return { kind: 'ran', tests: [], notRun: 'no title of these tests can be named to Playwright Test' };
  await writeFile(listFile, `${lines.join('\n')}\n`);
  await writeFile(configFile, configSource({ rootDir, reportFile, outputDir: path.join(request.workDir, 'output'), request, use }));
  const exit = await runCli(cli, ['test', '--config', configFile, '--test-list', listFile], request);
  const text = await readFile(reportFile, 'utf8').catch(() => undefined);
  if (text === undefined) {
    const said = exit.stderr.trim() === '' ? '' : `: ${clip(stripVTControlCharacters(exit.stderr).trim())}`;
    return { kind: 'unavailable', reason: `Playwright Test exited with ${exit.code === null ? 'a signal' : `code ${String(exit.code)}`} and wrote no report${said}` };
  }
  return readReport(text, rootDir, wanted);
}

/**
 * The path of the project's `@playwright/test` command line, looked up the
 * way Node finds a package from the project root, or undefined when the
 * project has none. Looked up on disk every time: a resolver's cache would
 * keep answering with a package the project has since removed.
 */
function resolveCli(projectRoot: string): string | undefined {
  for (let dir = path.resolve(projectRoot); ; dir = path.dirname(dir)) {
    const cli = path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js');
    if (existsSync(cli)) return cli;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * The config the tests run with: no retries, no web server, no projects, the
 * json reporter to `reportFile`, the engine's page options, and the run's
 * action and assertion timeouts, so a step that no longer finds its element
 * fails as soon as it would in e2e instead of at the test's timeout.
 */
function configSource(input: {
  readonly rootDir: string;
  readonly reportFile: string;
  readonly outputDir: string;
  readonly request: CodegenRunRequest;
  readonly use: CodegenRunUse;
}): string {
  const config = {
    testDir: input.rootDir,
    testMatch: '**/*.@(spec|test).?(c|m)[jt]s?(x)',
    retries: 0,
    workers: Math.max(1, input.request.workers),
    timeout: input.request.timeoutMs,
    expect: { timeout: input.request.assertionTimeoutMs },
    reporter: [['json', { outputFile: input.reportFile }]],
    outputDir: input.outputDir,
    use: { ...input.use, actionTimeout: input.request.actionTimeoutMs, navigationTimeout: input.request.actionTimeoutMs },
  };
  return `// Written by e2e to run the generated code; every run writes it again.\nexport default ${JSON.stringify(config, null, 2)};\n`;
}

/** Runs the command line to its end, or until the request's signal stops it, keeping only its error output. */
function runCli(cli: string, args: readonly string[], request: CodegenRunRequest): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.env)) if (value !== undefined) env[name] = value;
    if (request.appUrl !== undefined) env['BASE_URL'] = request.appUrl;
    env['FORCE_COLOR'] = '0';
    const child = spawn(process.execPath, [cli, ...args], { cwd: request.projectRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_DIAGNOSTIC_LENGTH * 4) stderr += chunk;
    });
    const stop = (): void => {
      child.kill('SIGTERM');
    };
    request.signal.addEventListener('abort', stop, { once: true });
    const done = (code: number | null): void => {
      request.signal.removeEventListener('abort', stop);
      resolve({ code, stderr });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

/** A JSON object's fields, or none for anything else. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A JSON array's items, or none for anything else. */
function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The `message` of the first of these errors that has one. */
function firstMessage(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    const message = fields(error)['message'];
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/**
 * How each wanted test ended, from the json report: its suites are files,
 * then describes, each with its specs and a spec's results. A browser that
 * is not installed fails every test with the same message, which says
 * nothing about the code: the run is `unavailable` instead.
 */
function readReport(text: string, rootDir: string, wanted: ReadonlyMap<string, string>): CodegenRunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unavailable', reason: 'Playwright Test wrote a report that is not JSON' };
  }
  const report = fields(parsed);
  const configured = fields(report['config'])['rootDir'];
  const reportRoot = typeof configured === 'string' ? configured : rootDir;
  const tests: CodegenRunOutcome[] = [];
  const visit = (suite: Readonly<Record<string, unknown>>, titles: readonly string[]): void => {
    for (const spec of items(suite['specs']).map(fields)) {
      const { title, file } = spec;
      if (typeof title !== 'string' || typeof file !== 'string') continue;
      const relative = toPosix(path.relative(rootDir, path.resolve(reportRoot, file)));
      const id = wanted.get(testKey(relative, [...titles, title]));
      const results = items(fields(items(spec['tests'])[0])['results']);
      if (id === undefined || results.length === 0) continue;
      const result = fields(results.at(-1));
      const passed = result['status'] === 'passed';
      const message = firstMessage([result['error'], ...items(result['errors'])]);
      tests.push({
        id,
        status: passed ? 'passed' : 'failed',
        startedAt: typeof result['startTime'] === 'string' ? result['startTime'] : new Date().toISOString(),
        durationMs: typeof result['duration'] === 'number' ? Math.round(result['duration']) : 0,
        ...(passed ? {} : { error: message === undefined ? `the test ended ${String(result['status'])}` : stripVTControlCharacters(message) }),
      });
    }
    for (const child of items(suite['suites']).map(fields)) {
      const title = child['title'];
      visit(child, typeof title === 'string' ? [...titles, title] : titles);
    }
  };
  // The top suites are files: their titles are paths, and only the suites inside them are describes.
  for (const suite of items(report['suites']).map(fields)) visit(suite, []);
  const browserMissing = tests.length > 0 && tests.every((test) => test.error?.includes("Executable doesn't exist") === true);
  if (browserMissing) {
    return { kind: 'unavailable', reason: "Playwright Test's browser is not installed; run `npx playwright install` in the project" };
  }
  const error = firstMessage(items(report['errors']));
  return { kind: 'ran', tests, ...(error === undefined ? {} : { notRun: clip(stripVTControlCharacters(error)) }) };
}

/** A test's key: its file relative to the run's root and its title path. */
function testKey(file: string, titlePath: readonly string[]): string {
  return JSON.stringify([file, ...titlePath]);
}

/** The deepest directory holding every one of `dirs`. */
function commonDir(dirs: readonly string[]): string {
  const [first, ...rest] = dirs.map((dir) => path.resolve(dir).split(path.sep));
  if (first === undefined) return process.cwd();
  let length = first.length;
  for (const parts of rest) {
    let shared = 0;
    while (shared < Math.min(length, parts.length) && parts[shared] === first[shared]) shared += 1;
    length = shared;
  }
  return first.slice(0, length).join(path.sep) || path.sep;
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

/** Text cut to what a reason quotes. */
function clip(text: string): string {
  return text.length <= MAX_DIAGNOSTIC_LENGTH ? text : `${text.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}
