/**
 * e2e — 推流端（apps/pusher）
 *
 * 覆盖 docs/execution-plan.md §Done when 第 6 条：
 *   - 推流端加载后显示设备列表
 *   - 点「开始直播」后状态胶囊文案变「推流中」，再点「停止直播」后回「未开始」
 *
 * 本轮缺陷回归（第二轮验收报告 §4C 上半 / 表 #13）：
 *   - 无效频道号：`频道不存在` 只允许出现在一个提示位（面板内联 `.setup__error`），
 *     不得再被页面底部 `NoticeBar(.notice)` 重复一次
 *   - 键盘可达：Enter 开播后焦点必须停在「停止直播」，再按 Enter 能直接停播
 *     （preparing/connecting 期间按钮 disabled 会把焦点丢回 body）
 *
 * 全部依赖已 mock：getUserMedia / enumerateDevices（support/media-mock.ts）、
 * TXLivePusher SDK（support/txlivepusher-mock.ts）、服务端 /api/**（support/mock-server-api.ts）。
 * e2e 不出网、不推真实流；真实推流由 页面验收表里用频道 1000001 验。
 *
 * 端口约定（计划 §四）：pusher 5173。可用 PUSHER_BASE_URL 覆盖；
 * webServer 拉起由 CodingAgent 的 playwright.config 负责（见汇报里的待补清单）。
 */
import { expect, test } from '@playwright/test';
import { E2E_CAMERA_LABEL, installMediaMocks } from './support/media-mock';
import { blockExternalNetwork, mockServerApis } from './support/mock-server-api';
import {
  E2E_TX_STATS,
  installTxLivePusherMock,
  readTxPushRecord,
} from './support/txlivepusher-mock';

const PUSHER_URL = process.env.PUSHER_BASE_URL ?? 'http://127.0.0.1:5173';

/** 不存在的频道号（2026-10-23 实测非真实频道；服务端两个频道接口同口径 404） */
const MISSING_CHANNEL_ID = '999999999';

test.beforeEach(async ({ page }) => {
  await installTxLivePusherMock(page);
  await installMediaMocks(page);
  await mockServerApis(page, { liveStatus: 'live', viewerCount: 3 });
  await blockExternalNetwork(page);
});

/** 推流端可能先要求「新建频道 / 填入已有频道」，存在就点新建。 */
async function enterChannelIfNeeded(page: import('@playwright/test').Page) {
  const createButton = page.getByRole('button', { name: /新建频道|创建频道|新建直播/ }).first();
  if (await createButton.isVisible().catch(() => false)) {
    await createButton.click();
    await page.waitForTimeout(300);
  }
}

test('推流端加载后显示设备列表', async ({ page }) => {
  await page.goto(PUSHER_URL);

  // 设备名来自 mock 的 enumerateDevices：列表渲染出来才看得到
  await expect(page.getByText(E2E_CAMERA_LABEL, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });

  // 页面自身没有抛错白屏：至少有一个可交互控件
  await expect(page.locator('button').first()).toBeVisible();
});

test('点「开始直播」→ 状态变「推流中」，点「停止直播」→ 回「未开始」', async ({ page }) => {
  await page.goto(PUSHER_URL);
  await enterChannelIfNeeded(page);

  const startButton = page.getByRole('button', { name: /开始直播/ }).first();
  await expect(startButton).toBeVisible({ timeout: 20_000 });

  // 未开播时不应出现「推流中」
  await expect(page.getByText('推流中', { exact: false })).toHaveCount(0);

  await startButton.click();

  // 状态胶囊文案变「推流中」
  await expect(page.getByText('推流中', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });

  // 计划 D5 + D7：客户端推的必须是腾讯云线路的 webrtc:// 地址，且带服务端下发的 txSecret（D6：客户端不自己签名）
  const pushRecord = await readTxPushRecord(page);
  expect(pushRecord?.customCapture, '推流必须走 startCustomCapture(MediaStream)').toBe(true);
  expect(pushRecord?.hasVideoTrack, '喂给 SDK 的流必须带视频轨').toBe(true);
  expect(pushRecord?.url, '推流地址必须是 webrtc://push-t2.videocc.net/recordf/...').toMatch(
    /^webrtc:\/\/push-t2\.videocc\.net\/recordf\//,
  );
  expect(pushRecord?.url).toContain('txSecret=');

  const stopButton = page.getByRole('button', { name: /停止直播/ }).first();
  await expect(stopButton).toBeVisible();
  await stopButton.click();

  // 停止完成 → 状态胶囊回「未开始」
  await expect(page.getByText('未开始', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('推流中', { exact: false })).toHaveCount(0);

  const afterStop = await readTxPushRecord(page);
  expect(afterStop?.stoppedAt, '必须真的调用过 stopPush（不是只改 UI 文案）').toBeTruthy();
});

/** 指标条上某一项的数值节点（按可见标题定位，不依赖 DOM 顺序） */
function metricValue(page: import('@playwright/test').Page, label: string) {
  return page
    .getByRole('region', { name: '推流指标' })
    .locator('.metrics__item')
    .filter({ hasText: label })
    .locator('.metrics__value')
    .first();
}

test('停止直播后指标条不残留上次统计（码率/帧率/画面回到占位符）', async ({ page }) => {
  await page.goto(PUSHER_URL);
  await enterChannelIfNeeded(page);

  await page.getByRole('button', { name: /开始直播/ }).first().click();
  await expect(page.getByText('推流中', { exact: false }).first()).toBeVisible({ timeout: 20_000 });

  // 统计来自 SDK 的 onStatisticsUpdate 桩（E2E_TX_STATS：800kbps / 15fps / 320×180，
  // 数值渲染为「数字 + 单位」两个节点，所以用正则在整段文本上断言）
  await expect(metricValue(page, '上行码率')).toHaveText(
    new RegExp(`${E2E_TX_STATS.bitrateKbps}\\s*kbps`),
    { timeout: 10_000 },
  );
  await expect(metricValue(page, '帧率')).toHaveText(new RegExp(`${E2E_TX_STATS.fps}\\s*fps`));
  await expect(metricValue(page, '画面')).toHaveText(
    `${E2E_TX_STATS.width}×${E2E_TX_STATS.height}`,
  );

  await page.getByRole('button', { name: /停止直播/ }).first().click();
  await expect(page.getByText('未开始', { exact: false }).first()).toBeVisible({ timeout: 20_000 });

  // 缺陷回归点：停止后胶囊已回「未开始」，但指标条还显示上一场的 372kbps / 20fps / 640×480
  for (const label of ['上行码率', '帧率', '画面']) {
    const value = metricValue(page, label);
    await expect(value, `${label}停止后必须回到占位符`).toHaveAttribute('data-empty', 'true');
    await expect(value).toHaveText('—');
  }
  await expect(metricValue(page, '上行连接')).toHaveText(/未连接/);
});

test('填入不存在的频道号：整页只出现一次「频道不存在」，第二个提示位不再重复', async ({ page }) => {
  // 频道不存在：GET /api/channels/:id 与 /live-status 同口径 404（本轮补的契约）
  await mockServerApis(page, { channelNotFound: true });
  await page.goto(PUSHER_URL);

  const channelIdInput = page.locator('#existing-channel-id');
  await expect(channelIdInput).toBeVisible({ timeout: 20_000 });
  await channelIdInput.fill(MISSING_CHANNEL_ID);
  await page.getByRole('button', { name: '使用该频道' }).click();

  // 唯一允许的提示位：频道面板内联错误（原因 + 下一步一句话）
  const inlineError = page.locator('.setup__error');
  await expect(inlineError).toBeVisible({ timeout: 20_000 });
  await expect(inlineError).toContainText('频道不存在');
  await expect(inlineError).toContainText('请确认频道号后重试');

  // 缺陷回归点：同一句原因曾被渲染两处 —— 面板内联 + 页面底部 NoticeBar(.notice)，
  // 底部那条要滚动才看得到，讲师会以为「又报了一次错」。
  await expect(
    page.locator('.notice').filter({ hasText: '频道不存在' }),
    '.notice 不得承载频道不存在文案（频道类错误只在面板内联展示）',
  ).toHaveCount(0);

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(
    bodyText.match(/频道不存在/g) ?? [],
    `整页只应出现一次「频道不存在」，实际全文：\n${bodyText}`,
  ).toHaveLength(1);
  // 服务端 message 已自带「请…重试」，前端不得再拼下一步后缀
  expect(bodyText, '不允许出现「按提示处理」这类重复后缀').not.toContain('按提示处理');
  expect(
    bodyText.match(/重试/g) ?? [],
    `「重试」只能出现一次（不得「…请稍后重试，按提示处理后重试」）：${bodyText}`,
  ).toHaveLength(1);
  expect(
    bodyText.match(/频道不存在，请确认频道号后重试/g) ?? [],
    '服务端整句文案不得被渲染两遍',
  ).toHaveLength(1);

  // 报错后仍停在频道准备面板，可以直接重填（不白屏、不锁死输入）
  await expect(channelIdInput).toBeEnabled();
  await expect(page.locator('#existing-channel-id')).toHaveValue(MISSING_CHANNEL_ID);
});

test('键盘开播：Enter 后焦点落在「停止直播」，不重新聚焦也能再按 Enter 停播', async ({ page }) => {
  await page.goto(PUSHER_URL);
  await enterChannelIfNeeded(page);

  const controlButton = page.locator('.push-control button').first();
  await expect(controlButton).toHaveText(/开始直播/, { timeout: 20_000 });

  // 纯键盘路径：Tab 到按钮 → Enter
  await controlButton.focus();
  expect(await controlButton.evaluate((el) => document.activeElement === el)).toBe(true);
  await page.keyboard.press('Enter');

  await expect(page.getByText('推流中', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(controlButton).toHaveText(/停止直播/);

  // 缺陷回归点：preparing / connecting 期间按钮是 disabled，浏览器会把焦点丢回 body，
  // 于是讲师用键盘开播后再也「按」不到停止。回到可点状态后焦点必须还在这同一个按钮上。
  await expect
    .poll(
      async () => controlButton.evaluate((el) => document.activeElement === el),
      { timeout: 5_000, message: '开播完成后焦点必须回到「停止直播」按钮' },
    )
    .toBe(true);

  const active = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? '',
    text: (document.activeElement?.textContent ?? '').trim(),
  }));
  expect(active.tag, '焦点不能落在 body 上').toBe('BUTTON');
  expect(active.text).toContain('停止直播');

  // 不重新聚焦，直接再按一次 Enter：必须能停播并回到「未开始」
  await page.keyboard.press('Enter');
  await expect(page.getByText('未开始', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('推流中', { exact: false })).toHaveCount(0);

  const afterStop = await readTxPushRecord(page);
  expect(afterStop?.stoppedAt, '键盘停播必须真的调用过 stopPush（不是只改 UI 文案）').toBeTruthy();

  // 停止后焦点仍然回到按钮，键盘用户可以接着再开一场
  await expect(controlButton).toHaveText(/开始直播/);
  await expect
    .poll(async () => controlButton.evaluate((el) => document.activeElement === el), {
      timeout: 5_000,
    })
    .toBe(true);
});
