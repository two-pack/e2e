import type { CodegenAction, CodegenFile, CodegenRecording } from 'e2e/engine';
import { describe, expect, it } from 'vitest';
import { playwrightCodegen } from '../../src/codegen.ts';

const APP_URL = 'http://127.0.0.1:4271/';

/** One file with one test whose only step is an act that recorded `actions`. */
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

function render(file: CodegenFile, testIdAttribute?: string): string {
  return playwrightCodegen(testIdAttribute).render(file);
}

describe('playwright codegen', () => {
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
    expect(code).toContain('await page.getByRole("combobox", { name: "Color", exact: true }).selectOption("Red");');
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
    expect(code).toContain('import { selectors, test } from "@playwright/test";');
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

  it('opens the location the first act started on as a path on the base URL, unless the act navigates first', () => {
    const tap = { name: 'tap', summary: 'tap', target: { role: 'button', name: 'Buy' } } as const;
    expect(render(actFile([tap], { startLocation: 'http://127.0.0.1:4271/shop?q=hat' }))).toContain('await page.goto("/shop?q=hat");');
    expect(render(actFile([tap], { startLocation: 'https://pay.example.test/checkout' }))).toContain(
      'await page.goto("https://pay.example.test/checkout");',
    );
    const navigating = render(
      actFile([{ name: 'navigate', summary: 'go', url: 'http://127.0.0.1:4271/cart' }, tap], { startLocation: 'http://127.0.0.1:4271/' }),
    );
    expect(navigating).toContain('await page.goto("/cart");');
    expect(navigating).not.toContain('await page.goto("/");');
    expect(render(actFile([tap], { startLocation: 'http://127.0.0.1:4271/' }))).toContain(
      `test.use({ baseURL: process.env["BASE_URL"] ?? "${APP_URL}" });`,
    );
  });

  it('writes keyboard, pointer, scroll, and history actions, and a TODO where the recording has a gap', () => {
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
    expect(code).toContain('await page.goBack();');
    expect(code).toContain('// TODO: tool seed_cart: a project tool the agent called; repeat it here by hand.');
    expect(code).toContain('// TODO: the agent typed a value this run read off the screen (whole-node); type it here by hand.');
    expect(code).toContain('// NOTE: this step was not recorded whole');
  });

  it('nests describes from the title path and keeps unrecorded steps as TODOs in their place', () => {
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
            { api: 'agent.assert', label: 'hats\nare listed', line: 5 },
            { api: 'expect.toHaveURL', label: '/shop', line: 6 },
          ],
        },
        { title: 'checks out', titlePath: ['shop', 'checks out'], steps: [] },
      ],
    };
    expect(render(file)).toBe(`// Generated by \`e2e run --codegen\` from tests/shop.e2e.ts (target "web").
// Each block is what an agent step did in that run, frozen: review it, then replace the
// TODO comments with the assertions the e2e test made through the agent.
import { test } from "@playwright/test";

test.describe("shop", () => {
  test.describe("browsing", () => {
    test("opens the shop", async ({ page }) => {
      // app.open (tests/shop.e2e.ts:3)
      await page.goto("/shop");

      // agent.act: look around (tests/shop.e2e.ts:4)
      // TODO: agent.act committed no action this code can repeat

      // agent.assert: hats are listed (tests/shop.e2e.ts:5)
      // TODO: agent.assert was a model judgment; write it as an expect() on what it checked

      // expect.toHaveURL: /shop (tests/shop.e2e.ts:6)
      // TODO: expect.toHaveURL ran as test code; port it by hand
    });
  });

  test("checks out", async ({ page }) => {
  });
});
`);
  });
});
