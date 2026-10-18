/**
 * `planCodegenSync`: which generated files a `--codegen` run keeps, deletes,
 * and writes again, and from which tests, the way the replay cache keeps its
 * entries but with one file per e2e file.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generatedPath,
  planCodegenSync,
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
      outcomes: outcomes({ b: { kind: 'passed', test: fresh } }),
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

  it('drops a test whose failure implicates the app, and keeps one that failed where no model answered', () => {
    const actions = planCodegenSync({
      records: [record([stored('a'), stored('b')])],
      outcomes: outcomes({ a: { kind: 'dropped' }, b: { kind: 'kept' } }),
      collection: collection({ [FILE]: ['a', 'b'] }),
      sources,
    });
    const action = actions[0]!;
    expect(action.kind).toBe('render');
    if (action.kind === 'render') expect(action.tests.map((test) => test.id)).toEqual(['b']);
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

  it('writes nothing for a file no test of which ever passed', () => {
    expect(
      planCodegenSync({ records: [], outcomes: outcomes({ a: { kind: 'dropped' } }), collection: collection({ [FILE]: ['a'] }), sources }),
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
