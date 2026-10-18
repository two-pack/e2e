/**
 * What `--codegen` offers a judgment as gone: the elements earlier screens of
 * the test showed that the current one does not, an unnamed one by its role
 * alone, kept out while a node of its role is on screen or the engine cannot
 * look for it by that role.
 */

import { describe, expect, it } from 'vitest';
import type { Observation, SemanticNode } from '../../src/engine/surface.ts';
import type { CodegenTargetDescriptor } from '../../src/engine/codegen.ts';
import { prepareObservation } from '../../src/agent/observation.ts';
import { SeenScreens } from '../../src/run/codegen.ts';

function node(id: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return { ref: { id, revision: 'r1' }, ...extra };
}

/** A prepared screen of a document holding `children`. */
function screen(...children: SemanticNode[]) {
  const tree = node('root', { role: 'document', name: 'App', children });
  const raw: Extract<Observation, { kind: 'semantic' }> = {
    kind: 'semantic',
    root: tree.ref,
    truncated: false,
    revision: 'r1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    tree,
    viewport: { width: 1280, height: 720 },
    redaction: { secureNodeCount: 0, maskedRegionCount: 0 },
  };
  const prepared = prepareObservation(raw, { redact: (text) => text, redactCut: (text) => text, maxBytes: 16_384 });
  if (prepared.kind !== 'semantic') throw new Error('expected a semantic screen');
  return prepared;
}

const tasks = () => node('n1', { role: 'list', children: [node('n2', { role: 'listitem', name: 'Buy milk' })] });

/** An engine that finds a target by its role and, when it has one, its name, as the web engine's `getByRole` does. */
const byRole = (current: ReturnType<typeof screen>) => (target: CodegenTargetDescriptor) =>
  [...current.nodes]
    .filter(([, candidate]) => candidate.role === target.role && (target.name === undefined || candidate.name === target.name))
    .map(([id]) => id);

describe('SeenScreens.goneFrom', () => {
  it('offers an unnamed list an earlier screen showed by its role alone, once no list is on screen', () => {
    const seen = new SeenScreens();
    seen.saw(screen(tasks()), (text) => text);
    const signedOut = screen(node('n9', { role: 'button', name: 'Login' }));
    expect(seen.goneFrom(signedOut, 20, byRole(signedOut))).toContainEqual({ role: 'list' });
  });

  it('keeps an unnamed list out while another list is on screen', () => {
    const seen = new SeenScreens();
    seen.saw(screen(tasks()), (text) => text);
    const other = screen(node('n9', { role: 'list', children: [node('n10', { role: 'listitem', name: 'Settings' })] }));
    const gone = seen.goneFrom(other, 20, byRole(other));
    expect(gone.some((target) => target.role === 'list')).toBe(false);
    expect(gone).toContainEqual(expect.objectContaining({ role: 'listitem', name: 'Buy milk' }));
  });

  it('keeps an unnamed element out when the engine cannot look for it, and a named one in', () => {
    const seen = new SeenScreens();
    seen.saw(screen(tasks()), (text) => text);
    const empty = screen();
    const gone = seen.goneFrom(empty, 20, () => undefined);
    expect(gone.some((target) => target.role === 'list')).toBe(false);
    expect(gone).toContainEqual(expect.objectContaining({ role: 'listitem', name: 'Buy milk' }));
  });
});
