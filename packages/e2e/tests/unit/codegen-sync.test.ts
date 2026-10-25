/**
 * `planCodegenSync`: which generated files a `--codegen` run keeps, deletes,
 * and writes again, and from which tests, the way the replay cache keeps its
 * entries but with one file per e2e file; and `runnableCode`: which kept tests
 * a later run may run from their code in place of the agent.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../src/config/resolve.ts';
import type { CodegenStep } from '../../src/engine/codegen.ts';
import {
  generatedPath,
  planCodegenSync,
  runnableCode,
  testForSource,
  type CodegenCollectionView,
  type CodegenOutcome,
  type CodegenRecord,
  type StoredCodegenTest,
} from '../../src/run/codegen-sync.ts';

const FILE = 'tests/todo.e2e.ts';

function stored(id: string, sourceDigest = 'source-1'): StoredCodegenTest {
  return {
    id,
    test: { title: id, titlePath: [id], steps: [{ api: 'agent.act', label: `do ${id}`, line: 3, column: 5 }] },
    sourceDigest,
    runId: 'run-0',
    recordedAt: '2026-10-18T00:00:00.000Z',
  };
}

function record(tests: readonly StoredCodegenTest[], sourceDigest = 'source-1'): CodegenRecord {
  return {
    version: 1,
    file: FILE,
    target: 'web',
    sourceDigest,
    code: 'e2e-gen/tests/todo.gen.spec.ts',
    codeDigest: 'code-1',
    runId: 'run-0',
    writtenAt: '2026-10-18T00:00:00.000Z',
    tests,
    gaps: [],
    failures: [],
  };
}

function collection(files: Record<string, readonly string[]>, options: Partial<CodegenCollectionView> = {}): CodegenCollectionView {
  return { full: true, files: new Map(Object.entries(files)), uncollected: new Set(), ...options };
}

function outcomes(tests: Record<string, CodegenOutcome>): Map<string, { file: string; target: string; tests: Map<string, CodegenOutcome> }> {
  return new Map([[JSON.stringify(['web', FILE]), { file: FILE, target: 'web', tests: new Map(Object.entries(tests)) }]]);
}

const sources = new Map([[FILE, 'source-1']]);

describe('planCodegenSync', () => {
  it('leaves a file none of whose tests ran, and whose source is unchanged, exactly as it is', () => {
    const kept = record([stored('a'), stored('b')]);
    const actions = planCodegenSync({ records: [kept], outcomes: new Map(), collection: collection({ [FILE]: ['a', 'b'] }), sources });
    expect(actions).toEqual([{ kind: 'keep', record: kept }]);
  });

  it('writes a file again when one of its tests passed, from that pass and the kept recordings of the rest', () => {
    const fresh = stored('b');
    const actions = planCodegenSync({
      records: [record([stored('a'), stored('b', 'old')])],
      outcomes: outcomes({ b: { kind: 'recorded', test: fresh } }),
      collection: collection({ [FILE]: ['a', 'b'] }),
      sources,
    });
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('render');
    if (action.kind !== 'render') return;
    expect(action.tests.map((test) => test.id)).toEqual(['a', 'b']);
    expect(action.tests[1]).toBe(fresh);
    expect([...action.fresh]).toEqual(['b']);
  });

  it('writes a test again from a failure that implicates the app, and keeps one that failed where no model answered', () => {
    const failed = stored('a', 'source-1');
    const kept = stored('b');
    const actions = planCodegenSync({
      records: [record([stored('a', 'old'), kept])],
      outcomes: outcomes({ a: { kind: 'recorded', test: failed }, b: { kind: 'kept' } }),
      collection: collection({ [FILE]: ['a', 'b'] }),
      sources,
    });
    const action = actions[0]!;
    expect(action.kind).toBe('render');
    if (action.kind !== 'render') return;
    expect(action.tests).toEqual([failed, kept]);
    expect([...action.fresh]).toEqual(['a']);
  });

  it('drops a test the e2e file no longer declares, and orders the rest as the file now does', () => {
    const actions = planCodegenSync({
      records: [record([stored('a'), stored('b'), stored('c')])],
      outcomes: new Map(),
      collection: collection({ [FILE]: ['c', 'a'] }),
      sources,
    });
    const action = actions[0]!;
    expect(action.kind).toBe('render');
    if (action.kind === 'render') expect(action.tests.map((test) => test.id)).toEqual(['c', 'a']);
  });

  it('writes a file again when its source changed, even with no test run', () => {
    const actions = planCodegenSync({
      records: [record([stored('a')])],
      outcomes: new Map(),
      collection: collection({ [FILE]: ['a'] }),
      sources: new Map([[FILE, 'source-2']]),
    });
    expect(actions[0]?.kind).toBe('render');
  });

  it('deletes the code of an e2e file a full collection no longer finds', () => {
    const gone = record([stored('a')]);
    expect(planCodegenSync({ records: [gone], outcomes: new Map(), collection: collection({}), sources: new Map() })).toEqual([
      { kind: 'delete', record: gone },
    ]);
  });

  it('keeps the code of a file that failed to collect, and prunes nothing when the run collected in memory', () => {
    const kept = record([stored('a'), stored('b')]);
    expect(
      planCodegenSync({ records: [kept], outcomes: new Map(), collection: collection({}, { uncollected: new Set([FILE]) }), sources }),
    ).toEqual([{ kind: 'keep', record: kept }]);
    expect(planCodegenSync({ records: [kept], outcomes: new Map(), collection: collection({}, { full: false }), sources })).toEqual([
      { kind: 'keep', record: kept },
    ]);
  });

  it('writes nothing for a file none of whose tests ever recorded anything', () => {
    expect(
      planCodegenSync({ records: [], outcomes: outcomes({ a: { kind: 'kept' } }), collection: collection({ [FILE]: ['a'] }), sources }),
    ).toEqual([]);
  });
});

describe('testForSource', () => {
  it('keeps the lines of a test recorded against this source, and drops them for an older one', () => {
    expect(testForSource(stored('a'), 'source-1').steps[0]?.line).toBe(3);
    const moved = testForSource(stored('a'), 'source-2').steps[0]!;
    expect(moved.line).toBeUndefined();
    expect(moved.column).toBeUndefined();
    expect(moved.label).toBe('do a');
  });
});

describe('generatedPath', () => {
  it("puts an e2e file's code at its own path under the out dir, naming the target only when several write code", () => {
    const outDir = path.join('/project', 'e2e-gen');
    expect(generatedPath(outDir, 'tests/ログイン.e2e.ts', '.gen.spec.ts', undefined)).toBe(path.join(outDir, 'tests', 'ログイン.gen.spec.ts'));
    expect(generatedPath(outDir, 'tests/todo.e2e.ts', '.gen.spec.ts', 'web')).toBe(path.join(outDir, 'tests', 'todo.web.gen.spec.ts'));
    expect(generatedPath(outDir, '../outside.e2e.ts', '.gen.spec.ts', undefined)).toBeUndefined();
  });
});

describe('runnableCode', () => {
  const SOURCE = "test('a', async () => {});\n";
  const CODE = '// generated\n';
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A project whose one e2e file has a record and generated code, as a `--codegen` run leaves them. */
  function project(tests: readonly StoredCodegenTest[], change: { source?: string; code?: string } = {}): ResolvedConfig {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-runnable-code-'));
    roots.push(root);
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    mkdirSync(path.join(root, 'e2e-gen', 'tests'), { recursive: true });
    mkdirSync(path.join(root, '.e2e', 'codegen', 'web', 'tests'), { recursive: true });
    writeFileSync(path.join(root, FILE), change.source ?? SOURCE);
    writeFileSync(path.join(root, 'e2e-gen', 'tests', 'todo.gen.spec.ts'), change.code ?? CODE);
    const kept = { ...record(tests, sha(SOURCE)), codeDigest: sha(CODE) };
    writeFileSync(path.join(root, '.e2e', 'codegen', 'web', 'tests', 'todo.e2e.ts.json'), JSON.stringify(kept));
    return { projectRoot: root, output: path.join(root, '.e2e'), codegen: { outDir: path.join(root, 'e2e-gen') } } as unknown as ResolvedConfig;
  }

  function withSteps(id: string, steps: readonly CodegenStep[]): StoredCodegenTest {
    return { ...stored(id, sha(SOURCE)), test: { title: id, titlePath: ['group', id], steps } };
  }

  const act: CodegenStep = { api: 'agent.act', label: 'add a todo', recording: { actions: [], incomplete: false } };
  const checked: CodegenStep = {
    api: 'agent.assert',
    label: 'the todo is listed',
    judgment: { checks: [{ kind: 'url', location: '/todos' }] },
  };

  it('offers the tests whose code does everything they did, a judgment proved only in part among them', () => {
    const partial: CodegenStep = { ...checked, judgment: { checks: checked.judgment!.checks, gap: { uncovered: ['the rest'], dropped: [] } } };
    const config = project([withSteps('whole', [act, checked, { api: 'expect.toBeVisible', label: 'x' }]), withSteps('partial', [act, partial])]);
    return expect(runnableCode(config)).resolves.toEqual([
      {
        file: FILE,
        target: 'web',
        code: path.join(config.projectRoot, 'e2e-gen', 'tests', 'todo.gen.spec.ts'),
        tests: new Map([
          ['whole', ['group', 'whole']],
          ['partial', ['group', 'partial']],
        ]),
      },
    ]);
  });

  it('leaves out a test whose code throws: a failure, an act with no actions, a judgment with no check', async () => {
    const failure = { code: 'ASSERTION_FAILED', message: 'no' };
    const config = project([
      withSteps('failed-step', [{ ...act, failure }]),
      { ...withSteps('failed-test', [act]), test: { title: 'failed-test', titlePath: ['failed-test'], steps: [act], failure } },
      withSteps('unrecorded-act', [{ api: 'agent.act', label: 'add a todo' }]),
      withSteps('unconverted', [{ ...checked, judgment: { checks: [], gap: { uncovered: ['all'], dropped: [] } } }]),
      withSteps('unjudged', [{ api: 'agent.waitFor', label: 'the list loads' }]),
    ]);
    expect(await runnableCode(config)).toEqual([]);
  });

  it('offers nothing once the e2e file or the generated file changed, or for a test recorded from an older source', async () => {
    expect(await runnableCode(project([withSteps('a', [act])], { source: `${SOURCE}// edited\n` }))).toEqual([]);
    expect(await runnableCode(project([withSteps('a', [act])], { code: `${CODE}// edited by hand\n` }))).toEqual([]);
    expect(await runnableCode(project([{ ...withSteps('a', [act]), sourceDigest: 'older' }]))).toEqual([]);
  });
});
