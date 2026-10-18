import type { CodegenAction, CodegenCheck, CodegenFile, CodegenRecording, CodegenStep, CodegenTargetDescriptor, CodegenTest } from 'e2e/engine';
import { describe, expect, it } from 'vitest';
import { playwrightCodegen } from '../../src/codegen.ts';
import type { CodegenScreenNode } from 'e2e/engine';

const APP_URL = 'http://127.0.0.1:4271/';

/** One file with no source, so the recorded steps are written alone, and one test whose only step is an act. */
function actFile(actions: readonly CodegenAction[], extra: Partial<CodegenRecording> = {}): CodegenFile {
  return {
    file: 'tests/checkout.e2e.ts',
    target: 'web',
    appUrl: APP_URL,
    tests: [
      {
        title: 'buys a hat',
        titlePath: ['buys a hat'],
        steps: [{ api: 'agent.act', label: 'buy a hat', line: 7, recording: { actions, incomplete: false, ...extra } }],
      },
    ],
  };
}

/** One file with no source and one test whose only step is a judgment that passed with `checks`. */
function judgedFile(api: string, checks: readonly CodegenCheck[], value?: unknown): CodegenFile {
  return {
    file: 'tests/checkout.e2e.ts',
    target: 'web',
    appUrl: APP_URL,
    tests: [
      {
        title: 'buys a hat',
        titlePath: ['buys a hat'],
        steps: [{ api, label: 'the order is confirmed', judgment: { checks, ...(value === undefined ? {} : { value }) } }],
      },
    ],
  };
}

function render(file: CodegenFile, testIdAttribute?: string): string {
  return playwrightCodegen(testIdAttribute).render(file).code;
}

describe('playwright codegen statements', () => {
  it('writes .gen.spec.ts files, which Playwright Test picks up by default', () => {
    expect(playwrightCodegen(undefined).extension).toBe('.gen.spec.ts');
  });

  it('maps every node verb onto the Playwright call that does the same', () => {
    const button = { role: 'button', name: 'Buy' };
    const code = render(
      actFile([
        { name: 'tap', summary: 'tap', target: button },
        { name: 'doubleTap', summary: 'double', target: button },
        { name: 'longPress', summary: 'long', target: button },
        { name: 'secondaryTap', summary: 'right', target: button },
        { name: 'hover', summary: 'hover', target: button },
        { name: 'scrollTo', summary: 'scroll to', target: button },
        { name: 'type', summary: 'type', target: { role: 'textbox', name: 'Size' }, value: 'L "large"' },
        { name: 'press', summary: 'press', target: { role: 'textbox', name: 'Size' }, key: 'Enter' },
        { name: 'select', summary: 'select', target: { role: 'combobox', name: 'Color' }, value: 'Red' },
        { name: 'check', summary: 'check', target: { role: 'checkbox', name: 'Gift' }, checked: false },
        { name: 'upload', summary: 'upload', target: { role: 'button', name: 'Photo' }, paths: ['fixtures/hat.png'] },
        { name: 'drag', summary: 'drag', target: { testId: 'hat' }, destination: { testId: 'cart' } },
      ]),
    );
    expect(code).toContain('await page.getByRole("button", { name: "Buy", exact: true }).click();');
    expect(code).toContain('.dblclick();');
    expect(code).toContain('.click({ delay: 1000 });');
    expect(code).toContain('.click({ button: "right" });');
    expect(code).toContain('.hover();');
    expect(code).toContain('.scrollIntoViewIfNeeded();');
    expect(code).toContain('await page.getByRole("textbox", { name: "Size", exact: true }).fill("L \\"large\\"");');
    expect(code).toContain('.press("Enter");');
    expect(code).toContain('await page.getByRole("combobox", { name: "Color", exact: true }).selectOption({ label: "Red" });');
    expect(code).toContain('.setChecked(false);');
    expect(code).toContain('.setInputFiles(["fixtures/hat.png"]);');
    expect(code).toContain('await page.getByTestId("hat").dragTo(page.getByTestId("cart"));');
  });

  it('addresses a node by test id, then role and name, placeholder, selector, and text', () => {
    const code = render(
      actFile([
        { name: 'tap', summary: '1', target: { testId: 'buy', role: 'button', name: 'Buy' } },
        { name: 'tap', summary: '2', target: { role: 'textbox', placeholder: 'Search hats' } },
        { name: 'tap', summary: '3', target: { role: 'box', selector: '[name="size"]' } },
        { name: 'tap', summary: '4', target: { role: 'box', text: 'Free shipping' } },
        { name: 'tap', summary: '5', target: { role: 'button', name: 'Add', within: 'Blue hat', position: { index: 1, of: 2 } } },
      ]),
    );
    expect(code).toContain('await page.getByTestId("buy").click();');
    expect(code).toContain('await page.getByPlaceholder("Search hats", { exact: true }).click();');
    expect(code).toContain('await page.locator("[name=\\"size\\"]").click();');
    expect(code).toContain('await page.getByText("Free shipping", { exact: true }).click();');
    expect(code).toContain('await within(page, "Blue hat").getByRole("button", { name: "Add", exact: true }).nth(1).click();');
    expect(code).toContain('import type { Locator, Page } from "@playwright/test";');
    expect(code).toContain('function within(page: Page, key: string): Locator {');
    expect(code).not.toContain('setTestIdAttribute');
  });

  it('finds a node e2e named from its content by what it shows, one the author named by its name, and a frame by its title', () => {
    const code = render(
      actFile([
        { name: 'tap', summary: '1', target: { role: 'listitem', name: '資料を作る', shownText: '資料を作る', standard: { name: '' } } as CodegenTargetDescriptor },
        {
          name: 'tap',
          summary: '2',
          target: { role: 'listitem', name: 'NDA Review 8 rules More actions for NDA Review', shownText: 'NDA Review 8 rules ⋯' } as CodegenTargetDescriptor,
        },
        { name: 'tap', summary: '3', target: { role: 'status', name: 'Counter', text: '1' } },
        { name: 'tap', summary: '4', target: { role: 'image', name: 'Logo' } },
        { name: 'tap', summary: '5', target: { role: 'iframe', name: 'checkout-frame' } },
        { name: 'tap', summary: '6', target: { role: 'alert', name: `${'x'.repeat(10)}…`, shownText: `${'x'.repeat(10)}…` } as CodegenTargetDescriptor },
      ]),
    );
    expect(code).toContain('await page.getByRole("listitem").filter({ hasText: /^\\s*資料を作る\\s*$/u }).click();');
    expect(code).toContain('await page.getByRole("listitem").filter({ hasText: /^\\s*NDA\\s*Review\\s*8\\s*rules\\s*⋯\\s*$/u }).click();');
    expect(code).toContain('await page.getByRole("status", { name: "Counter", exact: true }).click();');
    expect(code).toContain('await page.getByRole("img", { name: "Logo", exact: true }).click();');
    expect(code).toContain('await page.locator("iframe[title=\\"checkout-frame\\"], iframe[aria-label=\\"checkout-frame\\"]").click();');
    expect(code).toContain('await page.getByRole("alert").filter({ hasText: /^\\s*xxxxxxxxxx/u }).click();');
    expect(code).not.toContain('.or(');
  });

  it("writes the standard's reading where e2e reads a node its own way", () => {
    const code = render(
      actFile([
        { name: 'type', summary: '1', target: { role: 'textbox', name: 'Editor', standard: { role: null } } as CodegenTargetDescriptor, value: 'Hi' },
        {
          name: 'type',
          summary: '2',
          target: { role: 'textbox', name: 'Write something…', standard: { role: null, name: '' } } as CodegenTargetDescriptor,
          value: 'Hi',
        },
        { name: 'type', summary: '3', target: { role: 'textbox', standard: { role: null } } as CodegenTargetDescriptor, value: 'Hi' },
        { name: 'tap', summary: '4', target: { role: 'button', name: 'Sign in', standard: { name: '\uf090 Sign in' } } as CodegenTargetDescriptor },
        { name: 'tap', summary: '5', target: { role: 'link', name: 'Sign out', standard: { name: '\uf08b' } } as CodegenTargetDescriptor },
      ]),
    );
    expect(code).toContain('await page.getByLabel("Editor", { exact: true }).fill("Hi");');
    expect(code).toContain('await page.locator("[data-placeholder=\\"Write something…\\"]").fill("Hi");');
    expect(code).toContain('await page.locator(":is([contenteditable=\\"\\"], [contenteditable=\\"true\\"], [contenteditable=\\"plaintext-only\\"])").fill("Hi");');
    expect(code).toContain('await page.getByRole("button", { name: "\\uf090 Sign in", exact: true }).click();');
    expect(code).toContain('await page.getByTitle("Sign out", { exact: true }).click();');
  });

  it("sets the engine's test id attribute when it is not Playwright's default", () => {
    const code = render(actFile([{ name: 'tap', summary: 'tap', target: { testId: 'buy' } }]), 'data-test');
    expect(code).toContain('import { expect, selectors, test } from "@playwright/test";');
    expect(code).toContain('selectors.setTestIdAttribute("data-test");');
    expect(render(actFile([{ name: 'tap', summary: 'tap', target: { role: 'button', name: 'Buy' } }]), 'data-test')).not.toContain(
      'setTestIdAttribute',
    );
  });

  it('fills a secret from the variable that overrides it in the e2e config, never the value', () => {
    const code = render(
      actFile([
        { name: 'typeSecret', summary: 'password', target: { role: 'textbox', name: 'Password' }, secret: 'admin.password' },
        { name: 'typeSecret', summary: 'key', target: { role: 'textbox', name: 'API key' }, secret: 'stripe-key' },
      ]),
    );
    expect(code).toContain('.fill(secret("E2E_USER_ADMIN_PASSWORD"));');
    expect(code).toContain('.fill(secret("E2E_SECRET_STRIPE_KEY"));');
    expect(code).toContain('function secret(variable: string): string {');
  });

  it('writes keyboard, pointer, scroll, navigation, and history actions, and a TODO where the recording has a gap', () => {
    const code = render(
      actFile(
        [
          { name: 'typeText', summary: 'type', value: 'hello', replace: true },
          { name: 'pressKey', summary: 'key', key: 'Tab' },
          { name: 'scroll', summary: 'scroll', direction: 'down', times: 2 },
          { name: 'scroll', summary: 'scroll', direction: 'left', target: { role: 'list', name: 'Hats' } },
          { name: 'scrollUntil', summary: 'until', text: 'Red hat', direction: 'down' },
          { name: 'tapAt', summary: 'point', point: { x: 10, y: 20 }, viewport: { width: 1280, height: 720 } },
          {
            name: 'hoverAt',
            summary: 'point in',
            point: { x: 10, y: 20 },
            viewport: { width: 1280, height: 720 },
            within: { target: { role: 'img', name: 'Map' }, fx: 0.25, fy: 0.5 },
          },
          { name: 'navigate', summary: 'go', url: 'http://127.0.0.1:4271/cart?step=2' },
          { name: 'navigate', summary: 'pay', url: 'https://pay.example.test/checkout' },
          { name: 'back', summary: 'back' },
          { name: 'dismissKeyboard', summary: 'dismiss' },
          { name: 'tool', summary: 'tool seed_cart' },
          { name: 'tool', summary: 'tool type (run-time value)', derived: 'whole-node' },
        ],
        { incomplete: true },
      ),
    );
    expect(code).toContain('await page.keyboard.press("ControlOrMeta+A");\n  await page.keyboard.type("hello");');
    expect(code).toContain('await page.keyboard.press("Tab");');
    expect(code).toContain('await page.mouse.wheel(0, 1200);');
    expect(code).toContain('await page.getByRole("list", { name: "Hats", exact: true }).hover();\n  await page.mouse.wheel(-600, 0);');
    expect(code).toContain('await page.getByText("Red hat").first().scrollIntoViewIfNeeded();');
    expect(code).toContain('// A bare point on the 1280x720 viewport the run used.\n  await page.mouse.click(10, 20);');
    expect(code).toContain('await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);');
    expect(code).toContain('await page.goto("/cart?step=2");');
    expect(code).toContain('await page.goto("https://pay.example.test/checkout");');
    expect(code).toContain('await page.goBack();');
    expect(code).toContain('// TODO: tool seed_cart: a project tool the agent called; repeat it here by hand.');
    expect(code).toContain('// TODO: the agent typed a value this run read off the screen (whole-node); type it here by hand.');
    expect(code).toContain('// NOTE: this step was not recorded whole');
  });

  it("writes a judgment's checks as the expects that prove it, a waitFor's retrying until its deadline", () => {
    const status = { role: 'status', name: 'Order' };
    const checks: CodegenCheck[] = [
      { kind: 'visible', target: status },
      { kind: 'text', target: status, text: 'Order #12 confirmed' },
      { kind: 'value', target: { role: 'textbox', name: 'Email' }, value: 'ada@example.test' },
      { kind: 'checked', target: { role: 'checkbox', name: 'Gift' }, checked: false },
      { kind: 'enabled', target: { role: 'button', name: 'Pay' }, enabled: false },
      { kind: 'absent', text: 'Payment failed' },
      { kind: 'url', location: 'http://127.0.0.1:4271/orders/12' },
    ];
    const asserted = render(judgedFile('agent.assert', checks));
    const order = 'page.getByRole("status", { name: "Order", exact: true })';
    expect(asserted).toContain(`await expect(${order}).toBeVisible();`);
    expect(asserted).toContain('.toContainText(/Order\\s*#12\\s*confirmed/u);');
    expect(asserted).toContain('.toHaveValue("ada@example.test");');
    expect(asserted).toContain('await expect(page.getByRole("checkbox", { name: "Gift", exact: true })).not.toBeChecked();');
    expect(asserted).toContain('await expect(page.getByRole("button", { name: "Pay", exact: true })).toBeDisabled();');
    expect(asserted).toContain('await expect(page.getByText(/Payment\\s*failed/u)).toHaveCount(0);');
    expect(asserted).toContain('await expect(page).toHaveURL("/orders/12");');
    const waited = render(judgedFile('agent.waitFor', checks));
    expect(waited).toContain('.toBeVisible({ timeout: 30_000 });');
    expect(waited).toContain('.toContainText(/Order\\s*#12\\s*confirmed/u, { timeout: 30_000 });');
    expect(waited).toContain('.toHaveCount(0, { timeout: 30_000 });');
    expect(render(judgedFile('agent.assert', [{ kind: 'count', role: 'listitem', count: 3 }]))).toContain(
      'await expect(page.getByRole("listitem")).toHaveCount(3);',
    );
    expect(render(judgedFile('agent.assert', [{ kind: 'order', role: 'listitem', texts: ['Milk', 'Hot tea'] }]))).toContain(
      'await expect(page.getByRole("listitem")).toContainText(["Milk", /Hot\\s*tea/u]);',
    );
    expect(render(judgedFile('agent.assert', [{ kind: 'value', target: { role: 'textbox', name: 'Note' }, value: '' }]))).toContain('.toHaveValue("");');
    expect(render(judgedFile('agent.extract', [checks[1]!], { order: 12 }))).toContain('// Returned {"order":12}.');
    expect(render(judgedFile('agent.assert', []))).toContain('// TODO: no deterministic check could be derived');
  });

  it('writes a gone check as the earlier element counting zero, found anywhere on the page', () => {
    const row = { role: 'listitem', name: '資料を作る', shownText: '資料を作る', standard: { name: '' } };
    expect(render(judgedFile('agent.assert', [{ kind: 'gone', target: row }]))).toContain(
      'await expect(page.getByRole("listitem").filter({ hasText: /^\\s*資料を作る\\s*$/u })).toHaveCount(0);',
    );
    expect(render(judgedFile('agent.waitFor', [{ kind: 'gone', target: { role: 'button', name: 'Logout' } }]))).toContain(
      'await expect(page.getByRole("button", { name: "Logout", exact: true })).toHaveCount(0, { timeout: 30_000 });',
    );
  });

  it('says above the checks what they leave unproven, and returns the line of every judgment with a gap', () => {
    const gap = {
      explanation: 'The login form shows and no list is on screen.\nNo task is listed.',
      uncovered: ['タスクの一覧は表示されていない'],
      dropped: [{ check: 'absent "Logout"', reason: 'the instruction does not say this text is missing' }, { reason: 'its text carries a secret' }],
      screenshot: '.e2e/artifacts/web/tests_checkout.e2e.ts___buys_a_hat/default/attempt-0/screenshots/001-assert.png',
    };
    const file: CodegenFile = {
      ...judgedFile('agent.assert', [{ kind: 'visible', target: { role: 'button', name: 'Login' } }]),
    };
    const withGap: CodegenFile = { ...file, tests: [{ ...file.tests[0]!, steps: [{ ...file.tests[0]!.steps[0]!, judgment: { ...file.tests[0]!.steps[0]!.judgment!, gap } }] }] };
    const rendered = playwrightCodegen(undefined).render(withGap);
    expect(rendered.code).toContain(
      [
        '  // agent.assert: the order is confirmed',
        '  // NOTE: the checks below prove only part of this judgment.',
        "  //   The judge's explanation of its verdict (its reasoning, not a checked fact): The login form shows and no list is on screen. No task is listed.",
        '  //   Not checked: タスクの一覧は表示されていない',
        '  //   Dropped absent "Logout": the instruction does not say this text is missing',
        '  //   Dropped a check whose content is withheld: its text carries a secret',
        '  //   Screenshot of the screen it passed on: .e2e/artifacts/web/tests_checkout.e2e.ts___buys_a_hat/default/attempt-0/screenshots/001-assert.png',
        '  await expect(page.getByRole("button", { name: "Login", exact: true })).toBeVisible();',
      ].join('\n'),
    );
    expect(rendered.code).not.toContain('\u0000');
    const lines = rendered.code.split('\n');
    expect(rendered.gaps).toEqual([{ test: 0, step: 0, line: lines.indexOf('  // agent.assert: the order is confirmed') + 1 }]);
    expect(playwrightCodegen(undefined).render(file).gaps).toEqual([]);

    const { screenshot: _screenshot, ...noScreenshot } = gap;
    const withheld = { ...noScreenshot, screenshotWithheld: 'a secret was filled earlier in this attempt, so no screenshot leaves it' };
    const unconverted: CodegenFile = { ...file, tests: [{ ...file.tests[0]!, steps: [{ ...file.tests[0]!.steps[0]!, judgment: { checks: [], gap: withheld } }] }] };
    const thrown = playwrightCodegen(undefined).render(unconverted);
    expect(thrown.code).toContain('// TODO: no deterministic check could be derived from the screen this judgment passed on.\n  //   The judge');
    expect(thrown.code).toContain('  //   No screenshot: a secret was filled earlier in this attempt, so no screenshot leaves it');
    expect(thrown.gaps).toHaveLength(1);
  });

  it('nests describes from the title path and keeps the steps the run did not record as comments in their place', () => {
    const file: CodegenFile = {
      file: 'tests/shop.e2e.ts',
      target: 'web',
      tests: [
        {
          title: 'opens the shop',
          titlePath: ['shop', 'browsing', 'opens the shop'],
          steps: [
            { api: 'app.open', label: '/shop', line: 3 },
            { api: 'agent.act', label: 'look around', line: 4 },
            { api: 'expect.toHaveURL', label: '/shop', line: 6 },
          ],
        },
        { title: 'checks out', titlePath: ['shop', 'checks out'], steps: [] },
      ],
    };
    expect(render(file)).toBe(`// Generated by \`e2e run --codegen\` from tests/shop.e2e.ts (target "web").
// The test source could not be read, so this file holds the recorded steps alone; the steps the
// test code ran itself are comments where they ran.
import { expect, test } from "@playwright/test";

test.describe("shop", () => {
  test.describe("browsing", () => {
    test("opens the shop", async ({ page }) => {
      // app.open (tests/shop.e2e.ts:3)
      await page.goto("/shop");

      // agent.act: look around (tests/shop.e2e.ts:4)
      // The agent found nothing to do here in the recorded run.

      // expect.toHaveURL: /shop (tests/shop.e2e.ts:6)
      // TODO: expect.toHaveURL ran as test code; the test source could not be read to carry it over.
    });
  });

  test("checks out", async ({ page }) => {
  });
});
`);
  });
});

/** A recorded step for the source conversion, at a line of the source. */
function step(api: string, label: string, line: number, data: Partial<CodegenStep> = {}): CodegenStep {
  return { api, label, line, column: 3, ...data };
}

const SOURCE = `import { test } from '@e2e-dev/web';
import { credentials, expect, secrets, unique } from 'e2e';
import { z } from 'zod';

test.describe('checkout', { tags: ['shop'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('buys a hat', async ({ agent, screen, browser }) => {
    const buyer = credentials.user('buyer');
    await agent.act('sign in', { params: { password: buyer.password } });
    await agent.act(\`add \${'a hat'} to the cart\`);
    await agent.assert('the cart holds one hat');
    const order = await agent.extract('the order', { schema: z.object({ id: z.number() }) });
    expect(order.id).toBe(12);
    await agent.waitFor('the receipt is shown', { timeout: 5_000 });
    await screen.getByRole('button', 'Done').tap();
    await screen.getByText('Thanks').secondaryTap();
    await screen.getByLabel('Note').fill(unique('note'));
    await screen.getByRole('combobox', { name: 'Size' }).selectOption('Large');
    await expect(screen.getByRole('tab', 'Receipt')).toBeSelected();
    await expect(browser).toHaveURL('/done');
    const key = secrets.get('stripe-key');
    await screen.getByLabel('Key').fill(key);
    if (order.id > 100) {
      await agent.act('never reached');
    }
  });
});

test.setup('signs in', { sessions: ['buyer'] }, async ({ app, session }) => {
  await app.open('/login');
  await session.save('buyer');
});
`;

const CONVERTED_TEST: CodegenTest = {
  title: 'buys a hat',
  titlePath: ['checkout', 'buys a hat'],
  steps: [
    step('app.open', '', 7),
    step('agent.act', 'sign in', 12, {
      recording: {
        actions: [
          { name: 'type', summary: 'type', target: { role: 'textbox', name: 'Email' }, value: 'buyer@example.test' },
          { name: 'typeSecret', summary: 'password', target: { role: 'textbox', name: 'Password' }, secret: 'buyer.password' },
        ],
        incomplete: false,
      },
    }),
    // Reported off its line, as a loader without source maps does; found by its order instead.
    step('agent.act', 'add a hat to the cart', 40, {
      recording: { actions: [{ name: 'tap', summary: 'tap', target: { role: 'button', name: 'Add hat' } }], incomplete: false },
    }),
    step('agent.assert', 'the cart holds one hat', 99, {
      judgment: { checks: [{ kind: 'text', target: { role: 'status', name: 'Cart' }, text: '1 item' }] },
    }),
    step('agent.extract', 'the order', 15, {
      judgment: { checks: [{ kind: 'text', target: { role: 'heading', name: 'Order 12' }, text: 'Order 12' }], value: { id: 12 } },
    }),
    step('agent.waitFor', 'the receipt is shown', 17, {
      judgment: { checks: [{ kind: 'visible', target: { role: 'region', name: 'Receipt' } }] },
    }),
  ],
};

function convert(source = SOURCE, tests: readonly CodegenTest[] = [CONVERTED_TEST]): string {
  return render({
    file: 'tests/checkout.e2e.ts',
    target: 'web',
    appUrl: APP_URL,
    source,
    usernames: { buyer: 'buyer@example.test' },
    tests,
  });
}

describe('playwright codegen from the test source', () => {
  it('swaps the e2e imports for Playwright and helpers, keeping every other import', () => {
    const code = convert();
    expect(code.startsWith('// Generated by `e2e run --codegen` from tests/checkout.e2e.ts (target "web").')).toBe(true);
    expect(code).toContain('import { expect, test } from "@playwright/test";');
    expect(code).toContain("import { z } from 'zod';");
    expect(code).not.toContain("from 'e2e'");
    expect(code).not.toContain("from '@e2e-dev/web'");
    expect(code).toContain(`test.use({ baseURL: process.env["BASE_URL"] ?? "${APP_URL}" });`);
    expect(code).toContain('const usernames: Record<string, string> = {"buyer":"buyer@example.test"};');
    expect(code).toContain('return secret(`${prefix}_PASSWORD`);');
    expect(code).toContain('const secrets = { get: (name: string): string => secret(`E2E_SECRET_');
    expect(code).toContain('const unique = (value: string): string => value;');
  });

  it('turns the fixtures into page and the e2e API into its Playwright spelling', () => {
    const code = convert();
    expect(code).toContain("test.describe('checkout' /* e2e options: { tags: ['shop'] } */, () => {");
    expect(code).toContain('test.beforeEach(async ({ page }) => {\n    await page.goto("/");');
    expect(code).toContain("test('buys a hat', async ({ page }) => {");
    expect(code).toContain("await page.getByRole('button', { name: 'Done', exact: true }).click();");
    expect(code).toContain("await page.getByText('Thanks', { exact: true }).click({ button: \"right\" });");
    expect(code).toContain("await page.getByLabel('Note', { exact: true }).fill(unique('note'));");
    expect(code).toContain("await page.getByRole('combobox', { exact: true, name: 'Size' }).selectOption({ label: 'Large' });");
    expect(code).toContain("await expect(page.getByRole('tab', { name: 'Receipt', exact: true })).toHaveAttribute(\"aria-selected\", \"true\");");
    expect(code).toContain("await expect(page).toHaveURL('/done');");
    expect(code).toContain("test('signs in' /* e2e options: { sessions: ['buyer'] } */, async ({ page }) => {");
    expect(code).toContain("await page.goto('/login');");
    expect(code).toContain("// e2e session.save('buyer'): keep sign-in with Playwright's storageState instead.");
  });

  it('replaces each agent call with what the agent did or checked, matched by line, instruction, or order', () => {
    const code = convert();
    expect(code).toContain(
      [
        '    // agent.act: sign in',
        '    await page.getByRole("textbox", { name: "Email", exact: true }).fill("buyer@example.test");',
        '    await page.getByRole("textbox", { name: "Password", exact: true }).fill(secret("E2E_USER_BUYER_PASSWORD"));',
      ].join('\n'),
    );
    expect(code).toContain('    // agent.act: add a hat to the cart\n    await page.getByRole("button", { name: "Add hat", exact: true }).click();');
    expect(code).toContain(
      '    // agent.assert: the cart holds one hat\n    await expect(page.getByRole("status", { name: "Cart", exact: true })).toContainText(/1\\s*item/u);',
    );
    expect(code).toContain(
      [
        '    // agent.extract: the order',
        '    await expect(page.getByRole("heading", { name: "Order 12", exact: true })).toContainText(/Order\\s*12/u);',
        '    const order = ({"id":12});',
        '    expect(order.id).toBe(12);',
      ].join('\n'),
    );
    expect(code).toContain(
      '    // agent.waitFor: the receipt is shown\n    await expect(page.getByRole("region", { name: "Receipt", exact: true })).toBeVisible({ timeout: 5_000 });',
    );
    expect(code).not.toContain('await agent.');
  });

  it('throws where the run recorded nothing for a call, so the generated test never passes on nothing', () => {
    const code = convert();
    expect(code).toContain(
      '      // agent.act: never reached\n      // TODO: no passing run reached this call, so nothing was recorded for it.\n      throw new Error("agent.act(\\"never reached\\") was not recorded by e2e run --codegen");',
    );
    const unjudged = convert(SOURCE, [
      { ...CONVERTED_TEST, steps: CONVERTED_TEST.steps.map((recorded) => (recorded.api === 'agent.assert' ? { ...recorded, judgment: { checks: [] } } : recorded)) },
    ]);
    expect(unjudged).toContain('throw new Error("agent.assert(\\"the cart holds one hat\\") has no recorded check; write it as an expect()");');
  });

  it('names a call whose instruction is a variable by the value it has when the generated test runs', () => {
    const source = `import { test } from '@e2e-dev/web';\n\ntest('signs in', async ({ agent }) => {\n  const login = 'log in as admin';\n  await agent.act(login);\n});\n`;
    const code = convert(source, []);
    expect(code).toContain('  // agent.act(login)\n  // TODO: no passing run reached this call');
    expect(code).toContain('  throw new Error(`agent.act(${JSON.stringify(login)}) was not recorded by e2e run --codegen`);');
  });

  it('marks a judgment with a gap where the converted source has it, and reports its line', () => {
    const gap = { explanation: 'The cart shows one hat.', uncovered: ['nothing else is in the cart'], dropped: [] };
    const tests = [{ ...CONVERTED_TEST, steps: CONVERTED_TEST.steps.map((recorded) => (recorded.api === 'agent.assert' ? { ...recorded, judgment: { ...recorded.judgment!, gap } } : recorded)) }];
    const rendered = playwrightCodegen(undefined).render({ file: 'tests/checkout.e2e.ts', target: 'web', appUrl: APP_URL, source: SOURCE, tests });
    const lines = rendered.code.split('\n');
    const header = lines.findIndex((line) => line.trim() === '// agent.assert: the cart holds one hat');
    expect(lines[header + 1]?.trim()).toBe('// NOTE: the checks below prove only part of this judgment.');
    expect(lines[header + 3]?.trim()).toBe('//   Not checked: nothing else is in the cart');
    const assertIndex = tests[0]!.steps.findIndex((recorded) => recorded.api === 'agent.assert');
    expect(rendered.gaps).toEqual([{ test: 0, step: assertIndex, line: header + 1 }]);
  });

  it('keeps a call the code does not await on the spot a promise', () => {
    const source = `import { test } from '@e2e-dev/web';\n\ntest('buys a hat', async ({ agent }) => {\n  await agent.assert('the cart holds one hat').catch(() => undefined);\n});\n`;
    const code = convert(source, [
      { title: 'buys a hat', titlePath: ['buys a hat'], steps: [step('agent.assert', 'the cart holds one hat', 4, { judgment: { checks: [{ kind: 'visible', target: { role: 'status', name: 'Cart' } }] } })] },
    ]);
    expect(code).toContain('  await expect(page.getByRole("status", { name: "Cart", exact: true })).toBeVisible();\n  await Promise.resolve().catch(() => undefined);');
  });

  it('falls back to the recorded steps when the source does not parse', () => {
    const code = convert('test(\'broken\', async ({ agent }) => {', [CONVERTED_TEST]);
    expect(code).toContain('// The test source could not be read');
    expect(code).toContain('test.describe("checkout", () => {');
  });
});

describe('playwright codegen locate', () => {
  const locate = (target: CodegenTargetDescriptor, screen: readonly CodegenScreenNode[]) => playwrightCodegen(undefined).locate?.(target, screen);
  // The sign-in card: a title that is a div reading "Login", a field, and the button reading "Login".
  const signIn: CodegenScreenNode[] = [
    { id: 'n1', role: 'main', shownText: 'Login Username Login' },
    { id: 'n2', parent: 'n1', shownText: 'Login' },
    { id: 'n3', parent: 'n1', role: 'textbox', name: 'Username', shownText: '' },
    { id: 'n4', parent: 'n1', role: 'button', name: 'Login', shownText: 'Login' },
  ];

  it('finds a bare text wherever an element shows it, the button that reads the same included', () => {
    expect(locate({ text: 'Login' }, signIn)).toEqual(['n2', 'n4']);
  });

  it('finds a node by role and name, a field by its label, and a test id alone', () => {
    expect(locate({ role: 'button', name: 'Login' }, signIn)).toEqual(['n4']);
    expect(locate({ role: 'textbox', name: 'Username' }, signIn)).toEqual(['n3']);
    expect(locate({ testId: 'go', role: 'button', name: 'Login' }, [...signIn, { id: 'n5', role: 'link', testId: 'go', shownText: 'Go' }])).toEqual(['n5']);
  });

  it('finds a row named from its content by the whole of what it shows, and leaves out hidden nodes for a role', () => {
    const rows: CodegenScreenNode[] = [
      { id: 'r1', role: 'listitem', name: 'Buy milk', shownText: 'Buy milk' },
      { id: 'r2', role: 'listitem', name: 'Buy milk now', shownText: 'Buy milk now' },
      { id: 'r3', role: 'listitem', name: 'Buy milk', shownText: 'Buy milk', hidden: true },
    ];
    expect(locate({ role: 'listitem', name: 'Buy milk', shownText: 'Buy milk', standard: { name: '' } }, rows)).toEqual(['r1']);
  });

  it('cannot tell for a structural selector', () => {
    expect(locate({ selector: 'main > div' }, signIn)).toBeUndefined();
  });
});
