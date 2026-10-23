/**
 * e2e — 推流端必须修项 C1/C2（D17 / D18）+ 评审 W5 的会话上报锁
 *
 * 覆盖 docs/execution-plan.md §Done when：
 *   - 第 10 条（D17）：`state ∈ {preparing, connecting, live, stopping}` 时「换频道」按钮 disabled 且带禁用原因；
 *     e2e 断言该状态下按钮 disabled、点击无效、且推流不中断。
 *   - 第 11 条（D18）：指标条「画面」在无实测统计时显示 `—`，不得出现固定的 `1280×720`；
 *     有统计时显示的值等于实测 width×height。
 *   - CONTEXT.md D17 后半：本次会话的 channelId 在 start() 时固化，`onLive` / `onIdle` / 心跳一律用固化的会话 channelId
 *     → 这里抓 `POST /api/channels/:id/push-session` 的请求体，断言本次会话所有上报的 channelId 恒为开播频道。
 *   - 评审 W5：`/push-session` 以前在 e2e 里落到兜底 404（上报被 catch 吞掉，静默失败），
 *     这里让 mock 成功并断言 started / 60s 心跳 / stopped 都真的发出来了。
 *
 * 全部依赖已 mock：getUserMedia / enumerateDevices、TXLivePusher SDK、服务端 /api/**；不出网、不推真实流。
 * 端口约定：pusher 5173（可用 PUSHER_BASE_URL 覆盖）/ API 由 playwright.config 的 E2E_API_PORT 决定。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMediaMocks } from './support/media-mock';
import {
  blockExternalNetwork,
  E2E_CHANNEL_ID,
  mockServerApis,
  type PushSessionReport,
} from './support/mock-server-api';
import {
  E2E_TX_STATS,
  emitTxStats,
  installTxLivePusherMock,
  readTxPushRecord,
} from './support/txlivepusher-mock';

const PUSHER_URL = process.env.PUSHER_BASE_URL ?? 'http://127.0.0.1:5173';

interface SetupOptions {
  /** false = 桩不自动回报实测统计，由测试手动触发（D18 需要观察「首帧统计回报前」的窗口） */
  autoStats?: boolean;
  /** >0 = startPush 慢多少毫秒才 resolve（D17 需要观察「连接中」这个中间态） */
  startDelayMs?: number;
  /** true = 安装 Playwright 假时钟（心跳用例要把 60s 快进过去，不真等 1 分钟） */
  fakeClock?: boolean;
}

async function setupPusherPage(page: Page, options: SetupOptions = {}) {
  const pushSessionLog: PushSessionReport[] = [];
  await installTxLivePusherMock(page, {
    autoStats: options.autoStats,
    startDelayMs: options.startDelayMs,
  });
  await installMediaMocks(page);
  await mockServerApis(page, { liveStatus: 'live', viewerCount: 3, pushSessionLog });
  await blockExternalNetwork(page);
  if (options.fakeClock) await page.clock.install();
  return { pushSessionLog };
}

/** 打开推流端并新建一个频道（走 mock 的 POST /api/channels） */
async function openPusherWithChannel(page: Page) {
  await page.goto(PUSHER_URL);
  const createButton = page.getByRole('button', { name: /新建频道|创建频道/ }).first();
  await expect(createButton).toBeVisible({ timeout: 20_000 });
  await createButton.click();
  await expect(page.locator('.channel-bar'), '新建频道后必须出现频道条').toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage__chip--tl'), '预览区要显示当前频道号').toContainText(E2E_CHANNEL_ID);
}

async function startPush(page: Page) {
  await page.getByRole('button', { name: /开始直播/ }).first().click();
  await expect(page.getByText('推流中', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

async function stopPush(page: Page) {
  await page.getByRole('button', { name: /停止直播/ }).first().click();
  await expect(page.getByText('未开始', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

/** 指标条上某一项的数值节点（按可见标题定位，不依赖 DOM 顺序） */
function metricValue(page: Page, label: string) {
  return page
    .getByRole('region', { name: '推流指标' })
    .locator('.metrics__item')
    .filter({ hasText: label })
    .locator('.metrics__value')
    .first();
}

/**
 * 「换频道」按钮的禁用原因文案。
 * 计划/CONTEXT 只规定「禁用并给出禁用原因」，没规定逐字文案，所以这里接受三种承载方式：
 * title、aria-describedby 指向的元素、频道条内联提示；断言的是**语义**（停止 + 频道）。
 */
function readSwitchBlockReason(page: Page): Promise<string> {
  return page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => (item.textContent ?? '').trim() === '换频道',
    ) as HTMLButtonElement | undefined;
    if (!button) return '';
    const describedBy = (button.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const bar = button.closest('.channel-bar') ?? button.parentElement;
    return [
      button.getAttribute('title') ?? '',
      button.getAttribute('aria-label') ?? '',
      describedBy,
      bar?.textContent ?? '',
    ].join(' ');
  });
}

/** 绕过 Playwright 的可操作性检查，用真鼠标点在被禁用的按钮上（模拟「强行点击」） */
async function forceClick(page: Page, target: Locator) {
  const box = await target.boundingBox();
  expect(box, '「换频道」按钮必须可见（否则无法模拟强行点击）').not.toBeNull();
  const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };
  await page.mouse.click(x + width / 2, y + height / 2);
}

test.describe('D17 推流中禁止换频道', () => {
  test('推流中「换频道」disabled + 有禁用原因；强行点击不改变推流态、不中断推流', async ({ page }) => {
    await setupPusherPage(page);
    await openPusherWithChannel(page);

    const switchButton = page.getByRole('button', { name: '换频道' });
    // 未开播时可以正常换频道
    await expect(switchButton, '未开播时「换频道」必须可点').toBeEnabled();

    await startPush(page);

    // 计划 Done when 第 10 条：推流中按钮 disabled
    await expect(
      switchButton,
      '推流中「换频道」必须 disabled（否则会清空频道、心跳继续给旧频道续期，评审 C1）',
    ).toBeDisabled();

    // 并且给出禁用原因（语义必须包含「停止」+「频道」）
    const reason = await readSwitchBlockReason(page);
    expect(reason, `推流中禁用「换频道」必须给出原因，实际：${reason}`).toMatch(/停止/);
    expect(reason, `禁用原因必须说明是「频道」相关操作，实际：${reason}`).toMatch(/频道/);

    const before = await readTxPushRecord(page);
    expect(before?.startedAt, '推流必须真的开始过（startPush 已调用）').toBeTruthy();

    // 强行点击
    await forceClick(page, switchButton);
    await page.waitForTimeout(300);

    // 推流态不变：仍在推流中、没有被踢回「先准备一个频道」面板
    await expect(page.getByText('推流中', { exact: false }).first(), '强行点击后必须仍停在推流态').toBeVisible();
    await expect(page.locator('.channel-bar'), '频道条不能被清空').toBeVisible();
    await expect(page.locator('.setup'), '不能跳回「先准备一个频道」面板').toHaveCount(0);
    await expect(switchButton).toBeDisabled();

    // 推流没有被中断：SDK 实例仍在推、没有调用过 stopPush、地址没被改掉
    const pusherState = await page.evaluate(() => {
      const list = ((window as any).__E2E_TX_PUSHERS__ ?? []) as Array<{ isPushing?: boolean }>;
      return { count: list.length, pushing: list.some((item) => item.isPushing === true) };
    });
    expect(pusherState.pushing, '强行点击不能中断推流（SDK 实例必须仍在 push）').toBe(true);

    const after = await readTxPushRecord(page);
    expect(after?.stoppedAt, '强行点击不能触发 stopPush').toBeUndefined();
    expect(after?.url, '推流地址不能被换频道改掉').toBe(before?.url);

    // 停止后按钮恢复可点
    await stopPush(page);
    await expect(switchButton, '停止直播后「换频道」必须恢复可点').toBeEnabled();
    await expect(page.locator('.channel-bar')).toBeVisible();
  });

  test('连接中（connecting）也禁用「换频道」：真的推上去之前不允许换频道', async ({ page }) => {
    // 桩把 startPush 拖 1.5s，稳定观察「准备中/连接中」这个中间态
    await setupPusherPage(page, { startDelayMs: 1_500 });
    await openPusherWithChannel(page);

    await page.getByRole('button', { name: /开始直播/ }).first().click();
    await expect(page.getByText(/连接中|准备中/).first(), '开播后先进入中间态').toBeVisible({
      timeout: 10_000,
    });

    const switchButton = page.getByRole('button', { name: '换频道' });
    await expect(
      switchButton,
      '连接中也不能换频道（D17：preparing / connecting / live / stopping 全要禁用）',
    ).toBeDisabled();
    const reason = await readSwitchBlockReason(page);
    expect(reason, `连接中禁用「换频道」也要给出原因，实际：${reason}`).toMatch(/停止/);
    expect(reason).toMatch(/频道/);

    // 不放宽：推流真的连上后仍然禁用
    await expect(page.getByText('推流中', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(switchButton).toBeDisabled();
  });

  test('本次会话上报的 push-session 的 channelId 恒为开播时的那个频道', async ({ page }) => {
    const { pushSessionLog } = await setupPusherPage(page);
    await openPusherWithChannel(page);
    await startPush(page);

    // W5：开播必须真的上报 started（以前 e2e 把 /push-session mock 成 404，这条链路静默失败）
    await expect
      .poll(
        () => pushSessionLog.filter((report) => report.state === 'started').length,
        { timeout: 10_000, message: '开播后必须 POST /api/channels/:id/push-session { state: started }' },
      )
      .toBeGreaterThan(0);

    const switchButton = page.getByRole('button', { name: '换频道' });
    await expect(switchButton).toBeDisabled();
    await forceClick(page, switchButton);
    await page.waitForTimeout(300);

    await stopPush(page);

    await expect
      .poll(() => pushSessionLog.filter((report) => report.state === 'stopped').length, {
        timeout: 10_000,
        message: '停止后必须 POST { state: stopped }（服务端据此把观看页切「已结束」）',
      })
      .toBeGreaterThan(0);

    expect(pushSessionLog.length).toBeGreaterThanOrEqual(2);
    expect(
      Array.from(new Set(pushSessionLog.map((report) => report.channelId))),
      `本次会话所有上报必须用同一个 channelId，实际：${JSON.stringify(pushSessionLog)}`,
    ).toEqual([E2E_CHANNEL_ID]);

    const states = pushSessionLog.map((report) => report.state);
    expect(states[0], '第一次上报必须是 started').toBe('started');
    expect(states[states.length - 1], '最后一次上报必须是 stopped').toBe('stopped');
  });

  test('60s 心跳：推流期间继续上报 started，且 channelId 不变（服务端 150s TTL 靠它续期）', async ({ page }) => {
    const { pushSessionLog } = await setupPusherPage(page, { fakeClock: true });
    await openPusherWithChannel(page);
    await startPush(page);

    await expect
      .poll(() => pushSessionLog.filter((report) => report.state === 'started').length, {
        timeout: 10_000,
        message: '开播必须立刻上报一次 started',
      })
      .toBe(1);

    // 快进 61s：心跳定时器（60s）必须再发一次 started，否则服务端 150s 后会判为断流
    await page.clock.fastForward(61_000);

    await expect
      .poll(() => pushSessionLog.filter((report) => report.state === 'started').length, {
        timeout: 10_000,
        message: '60s 心跳必须继续上报 started（会话续期）',
      })
      .toBeGreaterThanOrEqual(2);

    expect(
      Array.from(new Set(pushSessionLog.map((report) => report.channelId))),
      '心跳必须用开播时固化的 channelId',
    ).toEqual([E2E_CHANNEL_ID]);
  });
});

test.describe('D18 指标条「画面」不显示假分辨率', () => {
  test('开播后首帧统计回报前「画面」是 —；回报后是实测 width×height', async ({ page }) => {
    await setupPusherPage(page, { autoStats: false });
    await openPusherWithChannel(page);
    await startPush(page);

    const resolution = metricValue(page, '画面');

    // 已进入推流态，但 SDK 还没回报第一帧统计
    await expect(
      resolution,
      '首帧统计回报前「画面」必须是占位符 —（评审 C2：曾把编码参数 1280×720 当实测值）',
    ).toHaveText('—');
    await expect(resolution).toHaveAttribute('data-empty', 'true');

    // 码率 / 帧率同理：没有实测就是占位符，不编数字
    await expect(metricValue(page, '上行码率')).toHaveText('—');
    await expect(metricValue(page, '帧率')).toHaveText('—');

    // 整条指标条的**数值位**里不允许出现编码参数（1280×720 只能出现在「目标编码参数」脚注）
    const valueTexts = await page.locator('.metrics__item .metrics__value').allInnerTexts();
    expect(valueTexts.join(' | '), '指标数值位不得出现 1280×720').not.toContain('1280×720');

    // 手动触发 SDK 回报一次实测统计（桩的 E2E_TX_STATS：320×180 / 800kbps / 15fps）
    const emitted = await emitTxStats(page);
    expect(emitted, '手动触发统计回报失败：桩没拿到正在推流的实例').toBe(true);

    const expected = `${E2E_TX_STATS.width}×${E2E_TX_STATS.height}`;
    await expect(resolution, '统计回报后必须显示实测 width×height').toHaveText(expected, { timeout: 10_000 });
    await expect(resolution).not.toHaveAttribute('data-empty', 'true');

    // 计划 Done when 第 11 条：显示值必须等于实际采集轨道的 getSettings() 尺寸
    const trackSettings = await page.evaluate(() => {
      const video = document.querySelector('.stage__video') as HTMLVideoElement | null;
      const stream = video?.srcObject;
      if (!(stream instanceof MediaStream)) return null;
      const track = stream.getVideoTracks()[0];
      if (!track) return null;
      const settings = track.getSettings();
      return { width: settings.width ?? null, height: settings.height ?? null };
    });
    expect(trackSettings?.width, 'e2e 的采集桩必须能读到实际分辨率').toBeTruthy();
    await expect(resolution, '「画面」必须等于 track.getSettings() 的实际采集尺寸').toHaveText(
      `${trackSettings?.width}×${trackSettings?.height}`,
    );

    // D18 前半：编码参数也来自实际采集（脚注不得再是固定的 1280×720）
    const footnote = await page.locator('.metrics__footnote').innerText();
    expect(footnote, `目标编码参数必须跟随实际采集尺寸，实际脚注：${footnote}`).toContain(
      `${trackSettings?.width}×${trackSettings?.height}`,
    );
    expect(footnote, '编码参数不能是固定的 1280×720').not.toContain('1280×720');
  });

  test('停止直播后「画面」回到占位符（不复用上一场的实测值）', async ({ page }) => {
    await setupPusherPage(page);
    await openPusherWithChannel(page);
    await startPush(page);

    const resolution = metricValue(page, '画面');
    await expect(resolution).toHaveText(`${E2E_TX_STATS.width}×${E2E_TX_STATS.height}`, { timeout: 10_000 });

    await stopPush(page);

    await expect(resolution).toHaveText('—');
    await expect(resolution).toHaveAttribute('data-empty', 'true');
  });
});

