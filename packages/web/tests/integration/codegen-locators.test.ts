/**
 * The locators `e2e run --codegen` writes, run in Playwright: for every node
 * the engine reads on the cross-check fixture pages, the locator the code
 * generation builds from the node's recorded descriptor must reach that
 * node's element. The engine's tree and Playwright's accessible names part
 * ways on purpose in places (a list row named from its content), and code
 * that reads a name the tree gave cannot assume Playwright gives it too.
 */

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { CodegenTargetDescriptor, SemanticNode } from 'e2e/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatementWriter } from '../../src/codegen-statements.ts';
import { captureTagged, MARKER } from '../crosscheck/crosscheck.ts';
import { FIXTURE_PAGES } from '../crosscheck/fixtures.ts';

/** Roles the tree keeps for structure and prose; nothing addresses them. */
const STRUCTURAL_ROLES = new Set(['document', 'text', 'generic', 'none', 'presentation']);

/** The longest descriptor field the recording keeps, as `MAX_TRACE_DESCRIPTOR_CHARS` in e2e cuts it. */
const MAX_FIELD_CHARS = 300;

/**
 * Nodes whose generated locator is known not to reach them, by page and
 * `role "name"`, each with its reason. A new miss fails; so does one listed
 * here that started to match.
 */
const KNOWN_MISSES: Readonly<Record<string, string>> = {
  'generated content | link "Sign out"':
    'the browser names a glyph-only link by its glyph, so the title the tree shows is no accessible name to Playwright (expected.txt, crosscheck)',
  'shadow and custom elements | textbox "Editor"':
    "the tree reads an editor's contenteditable host as a textbox, which the standard gives no role, so getByRole finds nothing",
  'generated content | button "Sign in"':
    'the standard keeps an icon-font glyph in the name, which the tree drops, so the generated exact name does not match it',
};

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

/** A field as the recording keeps it: whitespace collapsed, cut with an ellipsis at the limit. */
function field(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length <= MAX_FIELD_CHARS ? collapsed : `${collapsed.slice(0, MAX_FIELD_CHARS - 1)}…`;
}

/** A node's name as its content makes it: its own text, then each child's name or content name, joined. */
function contentNameOf(node: SemanticNode): string {
  const parts = [node.text ?? '', ...(node.children ?? []).map((child) => field(child.name) ?? contentNameOf(child))];
  return field(parts.join(' ')) ?? '';
}

/** What a node shows when its name came from its content, as `shownTextOf` in e2e records it beside the descriptor. */
function shownTextOf(node: SemanticNode): string | undefined {
  const name = field(node.name);
  if (name === undefined || contentNameOf(node) !== name) return undefined;
  const parts: string[] = [];
  const collect = (current: SemanticNode): void => {
    if (current.text !== undefined && current.text.trim() !== '') parts.push(current.text);
    for (const child of current.children ?? []) collect(child);
  };
  collect(node);
  return field(parts.join(' '));
}

/** The descriptor the recording would keep for a node it acted on (`describeTarget` in e2e), without placement. */
function descriptorOf(node: SemanticNode): CodegenTargetDescriptor | undefined {
  const name = field(node.name);
  const text = field(node.text);
  const shownText = shownTextOf(node);
  const testId = field(node.testId);
  const placeholder = field(node.attributes?.['placeholder']);
  if (name === undefined && testId === undefined && placeholder === undefined) return undefined;
  return {
    ...(node.role === undefined ? {} : { role: node.role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined || text === name ? {} : { text }),
    ...(testId === undefined ? {} : { testId }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(shownText === undefined ? {} : { shownText }),
  };
}

/**
 * Evaluates one generated locator expression against the page, with the
 * helpers the generated file would define for it (`within`), their
 * type annotations stripped so they run as the JavaScript they compile to.
 */
function evaluate(expression: string, helpers: readonly string[]): Locator {
  const source = helpers.join('\n').replaceAll(/: (?:string|RegExp|Locator|Page)\b/gu, '');
  // The expression and helpers are the generator's own output for a fixture node, never page or model text.
  // oxlint-disable-next-line no-new-func
  return new Function('page', `${source}\nreturn ${expression};`)(page) as Locator;
}

/** A running web-benchmark app, whose scenarios are checked too, as `crosscheck.test.ts` does. */
const BENCHMARK = process.env['CROSSCHECK_BENCHMARK_URL'];

describe('codegen locators in Playwright', () => {
  const misses = new Map<string, string>();
  const pages = new Set<string>();

  /** Checks every addressable node of the page as loaded, recording misses under `name`. */
  async function check(name: string): Promise<void> {
    pages.add(name);
    const { nodes, elements, facts } = await captureTagged(page);
    const writer = new StatementWriter('data-testid', undefined);
    let checked = 0;
    try {
      for (const node of nodes) {
        const fact = facts.get(node.ref.id);
        if (node.role === undefined || STRUCTURAL_ROLES.has(node.role) || fact === undefined) continue;
        // Playwright reads neither a closed shadow root nor, from the top page, a child frame.
        if (fact.inChildFrame || fact.inClosedShadow || node.states?.hidden === true) continue;
        const descriptor = descriptorOf(node);
        if (descriptor === undefined) continue;
        const expression = writer.locator(descriptor);
        checked += 1;
        let reached: boolean;
        try {
          reached = await evaluate(expression, writer.helpers()).evaluateAll(
            (found, [attribute, id]) => found.some((element) => element.getAttribute(attribute!) === id),
            [MARKER, node.ref.id],
          );
        } catch {
          reached = false;
        }
        if (!reached) misses.set(`${name} | ${node.role} ${JSON.stringify(node.name ?? '')}`, expression);
      }
    } finally {
      await Promise.all([...elements.values()].map((element) => element.dispose()));
    }
    expect(checked, `${name} checked no node`).toBeGreaterThan(0);
  }

  for (const fixture of FIXTURE_PAGES) {
    it(`reach every addressable node: ${fixture.name}`, async () => {
      await page.setContent(`<!doctype html><html lang="en"><body>${fixture.html}</body></html>`);
      await check(fixture.name);
    });
  }

  describe.skipIf(BENCHMARK === undefined)('web-benchmark scenarios', () => {
    it('reach every addressable node of every scenario', { timeout: 600_000 }, async () => {
      await page.goto(BENCHMARK!);
      const slugs = await page.locator('a[href^="/e/"]').evaluateAll((links) =>
        [...new Set(links.map((link) => new URL((link as HTMLAnchorElement).href).pathname.slice('/e/'.length)))]);
      expect(slugs.length).toBeGreaterThan(0);
      for (const slug of slugs.toSorted()) {
        await page.goto(new URL(`/e/${slug}`, BENCHMARK).href, { waitUntil: 'networkidle' });
        await check(`benchmark: ${slug}`);
      }
    });
  });

  it('miss only the known nodes', () => {
    const unexpected = [...misses].filter(([key]) => KNOWN_MISSES[key] === undefined).map(([key, expression]) => `${key}: ${expression}`);
    const fixed = Object.keys(KNOWN_MISSES).filter((key) => pages.has(key.slice(0, key.indexOf(' | '))) && !misses.has(key));
    expect({ unexpected, fixed }).toEqual({ unexpected: [], fixed: [] });
  });
});
