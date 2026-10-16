import type { CodegenAction, CodegenCheck, CodegenFile, CodegenRecording, CodegenStep, CodegenTest } from 'e2e/engine';
import { describe, expect, it } from 'vitest';
import { playwrightCodegen } from '../../src/codegen.ts';

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
  return playwrightCodegen(testIdAttribute).render(file);
}

describe('playwright codegen statements', () => {
  it('writes .spec.ts files', () => {
    expect(playwrightCodegen(undefined).extension).toBe('.spec.ts');
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
    expect(asserted).toContain('await expect(page.getByRole("status", { name: "Order", exact: true })).toBeVisible();');
    expect(asserted).toContain('.toContainText("Order #12 confirmed");');
    expect(asserted).toContain('.toHaveValue("ada@example.test");');
    expect(asserted).toContain('await expect(page.getByRole("checkbox", { name: "Gift", exact: true })).not.toBeChecked();');
    expect(asserted).toContain('await expect(page.getByRole("button", { name: "Pay", exact: true })).toBeDisabled();');
    expect(asserted).toContain('await expect(page.getByText("Payment failed")).toHaveCount(0);');
    expect(asserted).toContain('await expect(page).toHaveURL("/orders/12");');
    const waited = render(judgedFile('agent.waitFor', checks));
    expect(waited).toContain('.toBeVisible({ timeout: 30_000 });');
    expect(waited).toContain('.toContainText("Order #12 confirmed", { timeout: 30_000 });');
    expect(waited).toContain('.toHaveCount(0, { timeout: 30_000 });');
    expect(render(judgedFile('agent.extract', [checks[1]!], { order: 12 }))).toContain('// Returned {"order":12}.');
    expect(render(judgedFile('agent.assert', []))).toContain('// TODO: no deterministic check could be derived');
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
    expect(code).toContain('    // agent.assert: the cart holds one hat\n    await expect(page.getByRole("status", { name: "Cart", exact: true })).toContainText("1 item");');
    expect(code).toContain(
      [
        '    // agent.extract: the order',
        '    await expect(page.getByRole("heading", { name: "Order 12", exact: true })).toContainText("Order 12");',
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

  it('falls back to the recorded steps when the source does not parse', () => {
    const code = convert('test(\'broken\', async ({ agent }) => {', [CONVERTED_TEST]);
    expect(code).toContain('// The test source could not be read');
    expect(code).toContain('test.describe("checkout", () => {');
  });
});
