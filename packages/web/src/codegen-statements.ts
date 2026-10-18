/**
 * The Playwright statements `--codegen` writes for what a run recorded: the
 * calls one agent action maps to, the `expect` one judgment check maps to,
 * the locator a recorded node is found by, and the helpers a file needs for
 * them. Shared by the source conversion (`codegen-source.ts`) and the
 * step-list fallback (`codegen.ts`).
 */

import type { CodegenAction, CodegenCheck, CodegenFailure, CodegenJudgmentGap, CodegenScreenNode, CodegenTargetDescriptor } from 'e2e/engine';

/** The roles `page.getByRole` takes that the engine's tree also reports; anything else falls back to text or selector. */
const ARIA_ROLES: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox',
  'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img',
  'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table',
  'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

/** e2e's role names where ARIA, and so `getByRole`, spells the role another way. */
const PLAYWRIGHT_ROLES: Readonly<Record<string, string>> = { image: 'img' };

/**
 * Roles e2e names from their content so the model reads a row or a message
 * by what it says (`NAME_FROM_CONTENT_ROLES` in `in-page/read-semantics.ts`),
 * where by the standard only an author names them. When the recording says
 * the name came from the content (`shownText`), the node is found by the text
 * it shows instead.
 */
const CONTENT_NAMED_ROLES: ReadonlySet<string> = new Set(['listitem', 'status', 'alert']);

/**
 * The containers a recorded `within` key names (`containerKey` in the runner:
 * row, list item, article, group, region, dialog, tab panel), as CSS. The key
 * is the container's first text, so of the nested containers holding it the
 * innermost, the last in document order, is the one the node sat in.
 */
const CONTAINER_SELECTOR =
  ':is(tr, [role=row], li, [role=listitem], article, [role=article], fieldset, [role=group], section, [role=region], dialog, [role=dialog], [role=tabpanel])';

/** How far one recorded `scroll` moves, in CSS pixels: about a screen, as the agent's own scroll does. */
const SCROLL_STEP_PX = 600;

/** The Playwright test id attribute; a different one is set at the top of the file. */
export const PLAYWRIGHT_TEST_ID_ATTRIBUTE = 'data-testid';

/** What the statements written so far need the file to provide. */
export interface FileNeeds {
  secrets: boolean;
  within: boolean;
  testIdAttribute: boolean;
}

/** Writes statements for one file, noting the helpers they need. */
export class StatementWriter {
  readonly needs: FileNeeds = { secrets: false, within: false, testIdAttribute: false };

  constructor(
    private readonly testIdAttribute: string,
    private readonly appUrl: string | undefined,
  ) {}

  /** The Playwright statements one recorded action maps to. */
  action(action: CodegenAction): string[] {
    switch (action.name) {
      case 'tap':
        return [`await ${this.locator(action.target)}.click();`];
      case 'doubleTap':
        return [`await ${this.locator(action.target)}.dblclick();`];
      case 'longPress':
        return [`await ${this.locator(action.target)}.click({ delay: 1000 });`];
      case 'secondaryTap':
        return [`await ${this.locator(action.target)}.click({ button: "right" });`];
      case 'hover':
        return [`await ${this.locator(action.target)}.hover();`];
      case 'scrollTo':
        return [`await ${this.locator(action.target)}.scrollIntoViewIfNeeded();`];
      case 'type':
        return [`await ${this.locator(action.target)}.fill(${literal(action.value)});`];
      case 'typeSecret':
        this.needs.secrets = true;
        return [`await ${this.locator(action.target)}.fill(secret(${literal(secretVariable(action.secret))}));`];
      case 'press':
        return [`await ${this.locator(action.target)}.press(${literal(action.key)});`];
      case 'select':
        return [`await ${this.locator(action.target)}.selectOption({ label: ${literal(action.value)} });`];
      case 'check':
        return [`await ${this.locator(action.target)}.setChecked(${String(action.checked)});`];
      case 'upload':
        return [
          '// Paths are relative to the e2e project root.',
          `await ${this.locator(action.target)}.setInputFiles(${literal(action.paths)});`,
        ];
      case 'drag':
        return [`await ${this.locator(action.target)}.dragTo(${this.locator(action.destination)});`];
      case 'scroll':
        return this.scroll(action.direction, action.target, action.times ?? 1);
      case 'scrollUntil':
        return [`await page.getByText(${literal(action.text)}).first().scrollIntoViewIfNeeded();`];
      case 'navigate':
        return [`await page.goto(${literal(this.relative(action.url))});`];
      case 'back':
        return ['await page.goBack();'];
      case 'tapAt':
      case 'hoverAt': {
        const verb = action.name === 'tapAt' ? 'click' : 'move';
        if (action.within !== undefined) {
          return [
            '{',
            `  const box = await ${this.locator(action.within.target)}.boundingBox();`,
            '  if (box === null) throw new Error("the element the agent pointed into is not visible");',
            `  await page.mouse.${verb}(box.x + box.width * ${String(action.within.fx)}, box.y + box.height * ${String(action.within.fy)});`,
            '}',
          ];
        }
        return [
          `// A bare point on the ${String(action.viewport.width)}x${String(action.viewport.height)} viewport the run used.`,
          `await page.mouse.${verb}(${String(action.point.x)}, ${String(action.point.y)});`,
        ];
      }
      case 'typeText':
        return [
          ...(action.replace ? ['await page.keyboard.press("ControlOrMeta+A");'] : []),
          `await page.keyboard.type(${literal(action.value)});`,
        ];
      case 'pressKey':
        return [`await page.keyboard.press(${literal(action.key)});`];
      case 'dismissKeyboard':
        return [];
      case 'tool':
        return [
          action.derived === undefined
            ? `// TODO: ${oneLine(action.summary)}: a project tool the agent called; repeat it here by hand.`
            : `// TODO: the agent typed a value this run read off the screen (${action.derived}); type it here by hand.`,
        ];
    }
  }

  /**
   * The `expect` one judgment check maps to. `timeout` is a `waitFor`'s:
   * Playwright's assertions retry until it, as `waitFor` polled.
   */
  check(check: CodegenCheck, timeout?: string): string {
    const options = timeout === undefined ? '' : `{ timeout: ${timeout} }`;
    const withOptions = (args: string): string => (options === '' ? args : args === '' ? options : `${args}, ${options}`);
    switch (check.kind) {
      case 'visible':
        return `await expect(${this.locator(check.target)}).toBeVisible(${withOptions('')});`;
      case 'text':
        return `await expect(${this.locator(check.target)}).toContainText(${withOptions(textMatcher(check.text))});`;
      case 'value':
        return `await expect(${this.locator(check.target)}).toHaveValue(${withOptions(literal(check.value))});`;
      case 'checked':
        return `await expect(${this.locator(check.target)})${check.checked ? '' : '.not'}.toBeChecked(${withOptions('')});`;
      case 'enabled':
        return `await expect(${this.locator(check.target)}).${check.enabled ? 'toBeEnabled' : 'toBeDisabled'}(${withOptions('')});`;
      case 'count': {
        const role = ariaRole(check.role);
        return role === undefined
          ? `// TODO: ${String(check.count)} ${oneLine(check.role)} nodes were on screen; ARIA has no such role to count.`
          : `await expect(page.getByRole(${literal(role)})).toHaveCount(${withOptions(String(check.count))});`;
      }
      case 'order': {
        const role = ariaRole(check.role);
        return role === undefined
          ? `// TODO: the ${oneLine(check.role)} nodes read ${oneLine(check.texts.join(', '))} in order; ARIA has no such role to list.`
          : `await expect(page.getByRole(${literal(role)})).toContainText(${withOptions(`[${check.texts.map(textMatcher).join(', ')}]`)});`;
      }
      case 'absent':
        return `await expect(page.getByText(${textMatcher(check.text)})).toHaveCount(${withOptions('0')});`;
      case 'gone':
        return `await expect(${this.locator(check.target)}).toHaveCount(${withOptions('0')});`;
      case 'url':
        return `await expect(page).toHaveURL(${withOptions(literal(this.relative(check.location)))});`;
    }
  }

  private scroll(direction: 'up' | 'down' | 'left' | 'right', target: CodegenTargetDescriptor | undefined, times: number): string[] {
    const delta = SCROLL_STEP_PX * times;
    const [dx, dy] =
      direction === 'down' ? [0, delta] : direction === 'up' ? [0, -delta] : direction === 'right' ? [delta, 0] : [-delta, 0];
    return [
      ...(target === undefined ? [] : [`await ${this.locator(target)}.hover();`]),
      `await page.mouse.wheel(${String(dx)}, ${String(dy)});`,
    ];
  }

  /** A Playwright locator expression for a recorded node, most durable field first. */
  locator(target: CodegenTargetDescriptor): string {
    if (target.within !== undefined) this.needs.within = true;
    const scope = target.within === undefined ? 'page' : `within(page, ${literal(target.within)})`;
    const role = ariaRole(target.role);
    let base: string;
    if (target.testId !== undefined) {
      if (this.testIdAttribute !== PLAYWRIGHT_TEST_ID_ATTRIBUTE) this.needs.testIdAttribute = true;
      base = `${scope}.getByTestId(${literal(target.testId)})`;
    } else if (target.standard?.role === null) {
      base = `${scope}.${this.roleless(target)}`;
    } else if (role !== undefined && CONTENT_NAMED_ROLES.has(role) && target.shownText !== undefined) {
      // e2e named it from its content; by the standard it has no name, so it is found by what it shows.
      base = `${scope}.getByRole(${literal(role)}).filter({ hasText: ${wholeTextPattern(target.shownText)} })`;
    } else if (role !== undefined && target.name !== undefined && target.standard?.name !== undefined && isGlyphsOnly(target.standard.name)) {
      // The standard names it by its icon glyph alone; e2e reads the title a person hovering it sees.
      base = `${scope}.getByTitle(${literal(target.name)}, { exact: true })`;
    } else if (role !== undefined && target.name !== undefined) {
      // The standard's name where it differs from e2e's (icon glyphs kept), else e2e's own.
      const name = target.standard?.name ?? target.name;
      base = name === '' ? `${scope}.getByRole(${literal(role)})` : `${scope}.getByRole(${literal(role)}, { name: ${nameLiteral(name)}, exact: true })`;
    } else if (target.role === 'iframe' && target.name !== undefined) {
      // ARIA has no iframe role; a frame's name is its title, or a label an author gave it.
      const name = JSON.stringify(target.name);
      base = `${scope}.locator(${literal(`iframe[title=${name}], iframe[aria-label=${name}]`)})`;
    } else if (target.placeholder !== undefined) {
      base = `${scope}.getByPlaceholder(${literal(target.placeholder)}, { exact: true })`;
    } else if (target.selector !== undefined) {
      base = `${scope}.locator(${literal(target.selector)})`;
    } else if (target.name !== undefined || target.text !== undefined) {
      base = `${scope}.getByText(${literal((target.name ?? target.text)!)}, { exact: true })`;
    } else if (role !== undefined) {
      base = `${scope}.getByRole(${literal(role)})`;
    } else {
      base = `${scope}.locator(":focus") /* TODO: the recording kept nothing to find this node by */`;
    }
    return target.position !== undefined && target.position.of > 1 ? `${base}.nth(${String(target.position.index)})` : base;
  }

  /**
   * A node the standard gives no role, an editor's `contenteditable` host
   * e2e reads as a textbox: by the label the standard names it with, else by
   * the `data-placeholder` e2e named it from, else as the editing host.
   */
  private roleless(target: CodegenTargetDescriptor): string {
    const standardName = target.standard?.name ?? target.name;
    if (standardName !== undefined && standardName !== '') return `getByLabel(${nameLiteral(standardName)}, { exact: true })`;
    if (target.name !== undefined) return `locator(${literal(`[data-placeholder=${JSON.stringify(target.name)}]`)})`;
    return `locator(${literal(':is([contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"])')})`;
  }

  /** A location on the app's own origin as a path the `baseURL` resolves; any other location whole. */
  relative(location: string): string {
    if (this.appUrl === undefined) return location;
    let app: URL;
    let target: URL;
    try {
      app = new URL(this.appUrl);
      target = new URL(location, app);
    } catch {
      return location;
    }
    return target.origin === app.origin ? `${target.pathname}${target.search}${target.hash}` : target.href;
  }

  /** The helper definitions and settings the statements written so far need, for the top of the file. */
  helpers(): string[] {
    return [
      ...(this.needs.testIdAttribute ? [`selectors.setTestIdAttribute(${literal(this.testIdAttribute)});`, ''] : []),
      ...(this.needs.secrets ? SECRET_HELPER : []),
      ...(this.needs.within ? WITHIN_HELPER : []),
    ];
  }

  /** The `@playwright/test` imports the statements need, `test` and `expect` always. */
  imports(): string[] {
    return [
      `import { ${this.needs.testIdAttribute ? 'expect, selectors, test' : 'expect, test'} } from "@playwright/test";`,
      ...(this.needs.within ? ['import type { Locator, Page } from "@playwright/test";'] : []),
    ];
  }
}

/**
 * The comment lines that say what a judgment's checks leave unproven, for
 * above them: the judge's explanation, marked as its reasoning rather than a
 * fact the code checks, the parts of the instruction left unchecked, the
 * checks dropped with why, which a reader who agrees can add as an `expect`,
 * and where the screenshot of the screen it passed on is, or why there is none.
 * `converted` is false for a judgment with no checks, which throws instead.
 */
export function gapComments(gap: CodegenJudgmentGap, converted: boolean): string[] {
  return [
    converted
      ? '// NOTE: the checks below prove only part of this judgment.'
      : '// NOTE: no check below proves this judgment.',
    ...(gap.explanation === undefined ? [] : [`//   The judge's explanation of its verdict (its reasoning, not a checked fact): ${commentText(gap.explanation)}`]),
    ...gap.uncovered.map((part) => `//   Not checked: ${commentText(part)}`),
    ...gap.dropped.map(({ check, reason }) => `//   Dropped ${check === undefined ? 'a check whose content is withheld' : commentText(check)}: ${commentText(reason)}`),
    ...(gap.screenshot !== undefined
      ? [`//   Screenshot of the screen it passed on: ${commentText(gap.screenshot)}`]
      : gap.screenshotWithheld === undefined
        ? []
        : [`//   No screenshot: ${commentText(gap.screenshotWithheld)}`]),
  ];
}

/** Model-written text on one comment line: whitespace collapsed and control characters dropped. */
function commentText(text: string): string {
  return oneLine(text.replaceAll(/\p{Cc}/gu, ' '));
}

/**
 * The comment lines that say a test failed here in the run its code was
 * written from: the error, the judge's explanation for a judgment that did
 * not hold (its reasoning, not a checked fact), and the screenshot taken at
 * the failure, or why there is none. `where` names the step for a failure
 * the comment is not placed at.
 */
export function failureComments(failure: CodegenFailure, where?: string): string[] {
  return [
    `// FAILED: in the run this code was written from, the test failed ${where === undefined ? 'here' : `at ${commentText(where)}`}: ${commentText(failure.code)}: ${commentText(failure.message)}`,
    ...(failure.explanation === undefined ? [] : [`//   The judge's explanation of its verdict (its reasoning, not a checked fact): ${commentText(failure.explanation)}`]),
    ...(failure.screenshot !== undefined
      ? [`//   Screenshot at the failure: ${commentText(failure.screenshot)}`]
      : failure.screenshotWithheld === undefined
        ? []
        : [`//   No screenshot: ${commentText(failure.screenshotWithheld)}`]),
  ];
}

/** Marks a line as the start of a judgment with a gap, for `takeGapLines` to find once the file is whole. */
export function gapMarker(index: number): string {
  return `${GAP_MARKER}${String(index)}${GAP_MARKER}`;
}

/** A character no source text or literal written here holds: the marker's delimiter. */
const GAP_MARKER = '\u0000';

/**
 * Removes the `gapMarker`s from a written file, and returns it with the
 * one-based line each marker stood on, by its index.
 */
export function takeGapLines(code: string): { readonly code: string; readonly lines: ReadonlyMap<number, number> } {
  const lines = new Map<number, number>();
  const pattern = new RegExp(`${GAP_MARKER}(\\d+)${GAP_MARKER}`, 'gu');
  const written = code.split('\n').map((line, index) =>
    line.replaceAll(pattern, (_marker, marked: string) => {
      lines.set(Number(marked), index + 1);
      return '';
    }),
  );
  return { code: written.join('\n'), lines };
}

/**
 * The nodes of a screen the locator `StatementWriter.locator` writes for
 * `target` finds, in document order, read the way Playwright matches: the
 * same branch, the same field, exact. Undefined for a locator the screen
 * cannot answer for (a structural selector, the focused element).
 */
export function locateOnScreen(target: CodegenTargetDescriptor, screen: readonly CodegenScreenNode[]): readonly string[] | undefined {
  const scoped = target.within === undefined ? screen : screen.filter((node) => node.within === target.within);
  const visible = scoped.filter((node) => node.hidden !== true);
  const role = ariaRole(target.role);
  const standardName = (node: CodegenScreenNode): string => node.standard?.name ?? node.name ?? '';
  const ids = (nodes: readonly CodegenScreenNode[]): string[] => nodes.map((node) => node.id);
  if (target.testId !== undefined) return ids(scoped.filter((node) => node.testId === target.testId));
  if (target.standard?.role === null) {
    const name = target.standard.name ?? target.name;
    // A label names the field it labels, whatever its role.
    return name === undefined || name === '' ? undefined : ids(visible.filter((node) => standardName(node) === name));
  }
  if (role !== undefined && CONTENT_NAMED_ROLES.has(role) && target.shownText !== undefined) {
    const shown = squash(target.shownText);
    return ids(visible.filter((node) => ariaRole(node.role) === role && wholeTextMatches(squash(node.shownText), shown)));
  }
  if (role !== undefined && target.name !== undefined && target.standard?.name !== undefined && isGlyphsOnly(target.standard.name)) {
    return ids(visible.filter((node) => node.name === target.name));
  }
  if (role !== undefined && target.name !== undefined) {
    const name = target.standard?.name ?? target.name;
    return ids(visible.filter((node) => ariaRole(node.role) === role && (name === '' || standardName(node) === name)));
  }
  if (target.role === 'iframe' && target.name !== undefined) return ids(scoped.filter((node) => node.role === 'iframe' && node.name === target.name));
  if (target.placeholder !== undefined) return ids(scoped.filter((node) => node.placeholder === target.placeholder));
  if (target.selector !== undefined) return undefined;
  const text = target.name ?? target.text;
  if (text !== undefined) return ids(innermost(scoped.filter((node) => node.shownText === text), screen));
  if (role !== undefined) return ids(visible.filter((node) => ariaRole(node.role) === role));
  return undefined;
}

/** A text with its whitespace removed, as a whole-text pattern with optional whitespace compares it. */
function squash(text: string): string {
  return text.replaceAll(/\s+/gu, '');
}

/** Whether a node's text is the whole of `shown`, a cut `shown` (ending in `…`) as its prefix. */
function wholeTextMatches(text: string, shown: string): boolean {
  return shown.endsWith('…') ? text.startsWith(shown.slice(0, -1)) : text === shown;
}

/**
 * The matches no other match sits inside: `getByText` finds the element
 * holding the text, not every ancestor whose text is the same text.
 */
function innermost(matches: readonly CodegenScreenNode[], screen: readonly CodegenScreenNode[]): CodegenScreenNode[] {
  const parents = new Map(screen.map((node) => [node.id, node.parent]));
  const matched = new Set(matches.map((node) => node.id));
  const holders = new Set<string>();
  for (const node of matches) {
    for (let cursor = parents.get(node.id); cursor !== undefined; cursor = parents.get(cursor)) {
      if (matched.has(cursor)) holders.add(cursor);
    }
  }
  return matches.filter((node) => !holders.has(node.id));
}

/** Icon-font glyphs: private-use code points, which render as a picture and read as no word. */
const ICON_GLYPHS = /\p{Co}/gu;

/** Whether a name is icon glyphs and whitespace only. */
function isGlyphsOnly(name: string): boolean {
  return name.trim() !== '' && name.replaceAll(ICON_GLYPHS, '').trim() === '';
}

/** A name as a string literal, an icon glyph written as its escape so the code shows what it matches. */
function nameLiteral(name: string): string {
  return literal(name).replaceAll(ICON_GLYPHS, (glyph) => {
    const code = glyph.codePointAt(0)!;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** The role `getByRole` takes for an e2e role, or undefined when ARIA has none (`box`, `iframe`). */
function ariaRole(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  const mapped = PLAYWRIGHT_ROLES[role] ?? role;
  return ARIA_ROLES.has(mapped) ? mapped : undefined;
}

/**
 * What a text expectation compares against: the text as written when it is
 * one word, else a pattern with the whitespace between its words optional.
 * e2e joins the text of separate elements with a space; the elements' own
 * text, which Playwright reads, may have none between them.
 */
function textMatcher(text: string): string {
  const words = text.trim().split(/\s+/u);
  return words.length < 2 ? literal(text) : `/${words.map(escapeRegExp).join('\\s*')}/u`;
}

/** A word escaped for a regular expression literal: its syntax characters and the slash. */
function escapeRegExp(word: string): string {
  return word.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

/**
 * A regular expression literal matching an element whose text is `name` and
 * nothing more, as `filter({ hasText })` reads it: whitespace between the
 * words optional, since e2e joins its parts with spaces the markup may not
 * have. A name e2e cut at its limit (ending in `…`) matches as a prefix.
 */
function wholeTextPattern(name: string): string {
  const cut = name.endsWith('…');
  const words = (cut ? name.slice(0, -1) : name).trim().split(/\s+/u).map(escapeRegExp);
  return `/^\\s*${words.join('\\s*')}${cut ? '' : '\\s*$'}/u`;
}

/** Reads a secret from the variable that overrides it in the e2e config; see `secretVariable`. */
const SECRET_HELPER = [
  '/** A secret the agent filled, read from the environment; the generated file never holds its value. */',
  'function secret(variable: string): string {',
  '  const value = process.env[variable];',
  '  if (value === undefined) throw new Error(`set ${variable} to run this test`);',
  '  return value;',
  '}',
  '',
];

/**
 * Scopes a locator to the container the agent found its node in, by the
 * container's first text. Nested containers holding the key come outermost
 * first in document order, so the last one is the node's own.
 */
const WITHIN_HELPER = [
  '/** The innermost row, list item, group, region, or dialog whose text includes `key`: where the agent found the element. */',
  'function within(page: Page, key: string): Locator {',
  `  return page.locator(${literal(CONTAINER_SELECTOR)}).filter({ hasText: key }).last();`,
  '}',
  '',
];

/** How the config names a credential's password secret: `<credential>.password`. */
const CREDENTIAL_PASSWORD_SUFFIX = '.password';

/** A name as the config spells it in an environment variable: uppercased, everything outside A-Z and 0-9 as `_`. */
function envSegment(name: string): string {
  return name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_');
}

/**
 * The environment variable that overrides a secret in the e2e config: a
 * credential's password (`<credential>.password`) is `E2E_USER_<CREDENTIAL>_PASSWORD`,
 * any other secret `E2E_SECRET_<NAME>`, as the config resolves them.
 */
function secretVariable(name: string): string {
  return name.endsWith(CREDENTIAL_PASSWORD_SUFFIX)
    ? `E2E_USER_${envSegment(name.slice(0, -CREDENTIAL_PASSWORD_SUFFIX.length))}_PASSWORD`
    : `E2E_SECRET_${envSegment(name)}`;
}

/** A JavaScript literal for a JSON value: strings, lists, and the values `agent.extract` returns. */
export function literal(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/** Text on one comment line: whitespace collapsed, so a newline in a label cannot end the comment. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}
