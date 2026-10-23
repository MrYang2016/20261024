/**
 * e2e — 主按钮对比度回归（评审 C3 / CONTEXT.md D19 / 计划 Done when 第 12 条）
 *
 * 契约：
 *   - 主按钮品牌蓝**实底** `#2F63E0` = `rgb(47, 99, 224)`，白字（白字对比度 ≥4.5:1，
 *     对比度本身由 packages/shared/styles/contrast.spec.ts 用 token 值手算锁定）。
 *   - hover **压深**到 `#2A57C7` = `rgb(42, 87, 199)`（提亮会掉对比度，v2 §4 明令禁止）。
 *   - 焦点环仍是 `#7CA0FF` = `rgb(124, 160, 255)`，2px（D19「焦点环、链接色不变」）。
 *
 * 为什么用 getComputedStyle：色值可能来自 CSS 变量 / color-mix，只有浏览器算完的结果才是用户看到的。
 * 焦点环走纯键盘（Tab）路径，确认 :focus-visible 真的自绘了。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { blockExternalNetwork, mockServerApis } from './support/mock-server-api';

const PUSHER_URL = process.env.PUSHER_BASE_URL ?? 'http://127.0.0.1:5173';
const WATCH_URL = process.env.WATCH_BASE_URL ?? 'http://127.0.0.1:5174';

/** D19 规定的主按钮色值 */
const PRIMARY_BG = 'rgb(47, 99, 224)'; // #2F63E0
const PRIMARY_BG_HOVER = 'rgb(42, 87, 199)'; // #2A57C7
const FOCUS_RING = 'rgb(124, 160, 255)'; // #7CA0FF
const WHITE_TEXT = 'rgb(255, 255, 255)';

/** 用键盘 Tab 把焦点走到目标控件上（同时验证「全键盘可达」） */
async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error('Tab 30 次仍未聚焦到目标按钮（键盘可达性 regress？）');
}

async function expectPrimaryButtonTokens(page: Page, button: Locator): Promise<void> {
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button, `主按钮底色必须是 #2F63E0 → ${PRIMARY_BG}（D19）`).toHaveCSS(
    'background-color',
    PRIMARY_BG,
  );
  await expect(button, '主按钮文字必须是白字').toHaveCSS('color', WHITE_TEXT);

  await button.hover();
  await expect(
    button,
    `hover 必须压深到 #2A57C7 → ${PRIMARY_BG_HOVER}（提亮会掉对比度，v2 §4）`,
  ).toHaveCSS('background-color', PRIMARY_BG_HOVER);

  await focusByKeyboard(page, button);
  await expect(button, '焦点环必须是 2px #7CA0FF（D19：焦点环不变）').toHaveCSS('outline-color', FOCUS_RING);
  await expect(button).toHaveCSS('outline-style', 'solid');
  await expect(button).toHaveCSS('outline-width', '2px');
}

test('推流端主按钮：实底 #2F63E0 / hover #2A57C7 / 焦点环 #7CA0FF', async ({ page }) => {
  await mockServerApis(page);
  await blockExternalNetwork(page);
  await page.goto(PUSHER_URL);

  // 「新建频道」是推流端主操作（主按钮）
  await expectPrimaryButtonTokens(page, page.getByRole('button', { name: '新建频道' }).first());
});

test('观看页主按钮（进入观看）：实底 #2F63E0 / hover #2A57C7 / 焦点环 #7CA0FF', async ({ page }) => {
  await mockServerApis(page);
  await blockExternalNetwork(page);
  await page.goto(WATCH_URL);

  await expectPrimaryButtonTokens(page, page.getByRole('button', { name: '进入观看' }).first());
});
