/**
 * The Playwright statements `--codegen` writes for what a run recorded: the
 * calls one agent action maps to, the `expect` one judgment check maps to,
 * the locator a recorded node is found by, and the helpers a file needs for
 * them. Shared by the source conversion (`codegen-source.ts`) and the
 * step-list fallback (`codegen.ts`).
 */

import type { CodegenAction, CodegenCheck, CodegenTargetDescriptor } from 'e2e/engine';

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
        return `await expect(${this.locator(check.target)}).toContainText(${withOptions(literal(check.text))});`;
      case 'value':
        return `await expect(${this.locator(check.target)}).toHaveValue(${withOptions(literal(check.value))});`;
      case 'checked':
        return `await expect(${this.locator(check.target)})${check.checked ? '' : '.not'}.toBeChecked(${withOptions('')});`;
      case 'enabled':
        return `await expect(${this.locator(check.target)}).${check.enabled ? 'toBeEnabled' : 'toBeDisabled'}(${withOptions('')});`;
      case 'absent':
        return `await expect(page.getByText(${literal(check.text)})).toHaveCount(${withOptions('0')});`;
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
    let base: string;
    if (target.testId !== undefined) {
      if (this.testIdAttribute !== PLAYWRIGHT_TEST_ID_ATTRIBUTE) this.needs.testIdAttribute = true;
      base = `${scope}.getByTestId(${literal(target.testId)})`;
    } else if (target.role !== undefined && ARIA_ROLES.has(target.role) && target.name !== undefined) {
      base = `${scope}.getByRole(${literal(target.role)}, { name: ${literal(target.name)}, exact: true })`;
    } else if (target.placeholder !== undefined) {
      base = `${scope}.getByPlaceholder(${literal(target.placeholder)}, { exact: true })`;
    } else if (target.selector !== undefined) {
      base = `${scope}.locator(${literal(target.selector)})`;
    } else if (target.name !== undefined || target.text !== undefined) {
      base = `${scope}.getByText(${literal((target.name ?? target.text)!)}, { exact: true })`;
    } else if (target.role !== undefined && ARIA_ROLES.has(target.role)) {
      base = `${scope}.getByRole(${literal(target.role)})`;
    } else {
      base = `${scope}.locator(":focus") /* TODO: the recording kept nothing to find this node by */`;
    }
    return target.position !== undefined && target.position.of > 1 ? `${base}.nth(${String(target.position.index)})` : base;
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
