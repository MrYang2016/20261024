/**
 * e2e — 直播诊断卡（HACK-1024）
 *
 * 验收契约来源：
 *   - docs/execution-plan.md §一（8 秒内给出「一句话原因 + 一个下一步」）、§三 规则表、
 *     §四 状态机（修复中不重复触发 / 修复失败回到同一结论）、§六 服务端契约
 *   - §Done when 第 5 条（本文件逐条对应）：
 *       低码率 → 8 秒内 D5 结论 +【自动重连】，点按钮触发一次重连（push 次数 +1）
 *       fps=0 持续 5 秒 → D6 结论 +【重载推流器】，点击后推流器 stop+start 各一次
 *       麦克风静默 8 秒 → D7 结论 +【换麦克风】，点击后音频设备切换（重新 getUserMedia）
 *       频道不是纯视频模板（D29 真实口径：`GET /api/channels/:id` → 502 + 模板文案，由 error-to-signal 映射 D2）
 *         → 预检即 D2 结论 + 帮助中心链接（新窗口），**不发起推流**
 *       另保留一条 200 + `template='ppt'` 的防御性用例（真实服务端不会走到）
 *       诊断历史抽屉：命中后打开能看到该条记录；空态有文案
 *       修复失败：回到同一 D5 结论且出现「再试一次」
 *   - §Done when 第 11 条：同一故障的文案在页面上只出现 1 次（body.innerText 计数）
 *
 * 全部依赖已 mock：getUserMedia / enumerateDevices（support/media-mock.ts，本轮加了「静音麦克风」
 * 与「全黑画面」两个可控项）、TXLivePusher SDK（support/txlivepusher-mock.ts，本轮加了
 * 可控码率/fps、连接状态、start/stop 计数、失败注入）、服务端 /api/**（support/mock-server-api.ts，
 * 本轮加了诊断端点和 template / push.expiresAt）。e2e 不出网、不推真实流。
 *
 * 时序控制：`page.clock` 快进，不用 waitForTimeout 赌时序。但假摄像头是靠 canvas 每 100ms 重绘出帧的，
 * 媒体管道（canvas → captureStream → <video>）走的是**真实时间**，所以 `advance()` 每步 1s 之后
 * 会留 80ms 真实时间让帧真的流到 video，否则黑帧检测器可能采到「还没来得及出帧」的空画布。
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  installMediaMocks,
  revokeBrowserPermissions,
  setMediaPermission,
  readMediaCalls,
  type MediaPermissionState,
} from './support/media-mock';
import {
  blockExternalNetwork,
  createHealthControl,
  E2E_CHANNEL_ID,
  E2E_EXPIRED_TX_TIME_HEX,
  E2E_TEMPLATE_MISMATCH_BODY,
  mockServerApis,
  type DiagnosticRecordPayload,
  type DiagnosticReportPayload,
  type HealthControl,
  type MetricReportPayload,
  type MetricSamplePayload,
} from './support/mock-server-api';
import {
  E2E_TX_STATS,
  failNextTxStart,
  installTxLivePusherMock,
  readTxCounts,
  setTxStats,
} from './support/txlivepusher-mock';

const PUSHER_URL = process.env.PUSHER_BASE_URL ?? 'http://127.0.0.1:5173';

/** 计划 §三「一句话原因」逐字文案 */
const REASON = {
  D1: '推流地址已过期',
  D2: '当前频道不是纯视频模板',
  D5: '上行带宽不足，推流已中断或降质',
  D6: '编码器没有输出画面',
  D7: '没有检测到麦克风声音',
  D9: '摄像头没有画面',
} as const;

/** 计划 §三「下一步」按钮标签（D22：能一键执行的都是真按钮） */
const ACTION = {
  D1: /重新连接/,
  D2: /怎么改模板/,
  D5: /自动重连/,
  D6: /重载推流器/,
  D7: /换麦克风/,
  D9: /重新授权|换设备|重新检测摄像头|恢复画面/,
} as const;

interface SetupOptions {
  template?: string;
  txTimeHex?: string;
  silentAudio?: boolean;
  videoPixel?: 'dynamic' | 'black';
  /**
   * D41：摄像头/麦克风权限状态（缺省 `'granted'`，既有用例行为不变）。
   * `'denied'` = 用户在浏览器里点过「阻止」：`permissions.query` 回 denied，`getUserMedia` 立即 reject。
   */
  permission?: MediaPermissionState;
  diagnosticsSeed?: DiagnosticRecordPayload[];
  /** §十一 A：预置指标采样（导出 CSV 用例不必真等 10 秒攒采样） */
  metricsSeed?: MetricSamplePayload[];
  /** 只让 GET /api/channels/:id 失败（D29 真实口径：非纯视频模板 → 502） */
  channelGetFailure?: { status: number; body: unknown } | null;
  /** D38：`GET /api/health` 的可控开关（断网用例中途把它切到 `fail`，恢复时切回 `ok`） */
  healthControl?: HealthControl;
}

/** 每条用例的固定装配：先装桩、再装 API mock、最后装假时钟（时钟必须在 goto 前） */
async function setup(page: Page, options: SetupOptions = {}) {
  const diagnosticsLog: DiagnosticReportPayload[] = [];
  const metricsLog: MetricReportPayload[] = [];

  await installTxLivePusherMock(page);
  await installMediaMocks(page, {
    silentAudio: options.silentAudio,
    videoPixel: options.videoPixel,
    permission: options.permission,
  });
  await mockServerApis(page, {
    liveStatus: 'live',
    viewerCount: 3,
    template: options.template,
    txTimeHex: options.txTimeHex,
    diagnosticsLog,
    diagnosticsSeed: options.diagnosticsSeed,
    metricsLog,
    metricsSeed: options.metricsSeed,
    channelGetFailure: options.channelGetFailure,
    healthControl: options.healthControl,
  });
  await blockExternalNetwork(page);
  await page.clock.install();

  return { diagnosticsLog, metricsLog };
}

/**
 * 推进假时钟：每步 1s（让 1s 的诊断 tick 与 100ms 的假摄像头重绘都跑起来），
 * 步间留 80ms 真实时间让 canvas 帧真的流进 <video>（媒体管道不受 page.clock 控制）。
 */
async function advance(page: Page, totalMs: number, stepMs = 1_000) {
  let elapsed = 0;
  while (elapsed < totalMs) {
    const step = Math.min(stepMs, totalMs - elapsed);
    await page.clock.runFor(step);
    await page.waitForTimeout(80);
    elapsed += step;
  }
}

/**
 * 打开推流端并新建一个频道（走 mock 的 POST /api/channels）。
 * `query` 用于演示故障注入面板（§十一 D / D37：`?demo=1` 才挂载）。
 */
async function openPusherWithChannel(page: Page, query = '') {
  await page.goto(`${PUSHER_URL}${query}`);

  // 先把假摄像头的画面画出来（否则黑帧检测器可能采到还没出帧的空画布）
  await advance(page, 1_000);

  const createButton = page.getByRole('button', { name: /新建频道|创建频道/ }).first();
  await expect(createButton).toBeVisible({ timeout: 20_000 });
  await createButton.click();
  await expect(page.locator('.channel-bar'), '新建频道后必须出现频道条').toBeVisible({
    timeout: 20_000,
  });
  // 再让画面稳定一下（此时频道已载入，预检可能已经跑过一轮）
  await advance(page, 1_000);
  // 媒体管道（canvas → captureStream → <video>）走真实时间，多留 400ms 给首帧落位，
  // 否则黑帧检测器第一次采样可能采到「还没出帧」的空画布 → 误命中 D9（优先级压过 D5/D6/D7）
  await page.waitForTimeout(400);
}

/** 打开推流端并填入一个已有频道号（走 mock 的 GET /api/channels/:id） */
async function openPusherWithExistingChannel(page: Page, channelId = E2E_CHANNEL_ID) {
  await page.goto(PUSHER_URL);
  await advance(page, 1_000);

  const channelIdInput = page.getByLabel('频道号').first();
  await expect(channelIdInput, '没载入频道时应该有「使用已有频道」面板').toBeVisible({
    timeout: 20_000,
  });
  await channelIdInput.fill(channelId);
  await page.getByRole('button', { name: /使用该频道/ }).first().click();
  await advance(page, 1_500);
}

async function startPush(page: Page) {
  await page.getByRole('button', { name: /开始直播/ }).first().click();
  await expect(page.getByText('推流中', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

/** 诊断卡上的一句话原因（页面上唯一一个提示位，D27） */
function reasonOf(page: Page, id: keyof typeof REASON) {
  return page.getByText(REASON[id], { exact: false }).first();
}

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function openHistoryDrawer(page: Page) {
  const button = page.getByRole('button', { name: /诊断历史/ }).first();
  await expect(button, '顶部信息条必须有「诊断历史」入口（D26）').toBeVisible({ timeout: 20_000 });
  await button.click();
}

test.describe('D2 预检：频道不是纯视频模板', () => {
  /** 自检条（D21）：D27 要求故障提示只走这里，所以 D2 必须落在这个区域内 */
  function selfCheckBar(page: Page) {
    return page.getByRole('region', { name: '推流自检' });
  }

  /**
   * 主路径 = D29 的真实服务端口径：非纯视频模板不是「200 + template 乱」，
   * 而是 `TemplateMismatchError` → **HTTP 502 + 「频道模板不是纯视频…」**（见 apps/server/src/polyv/upstream-error.ts）。
   * 讲师载入一个非纯视频模板的已有频道，就会在 `GET /api/channels/:id` 上碰到这个 502，
   * 推流端 `error-to-signal.ts` 的 `/模板|template|纯视频/` 必须把它映射成 D2。
   *
   * ⚠ 这条用例目前是**产品侧缺口**（TestSpec 只写测试，不改产品源码）：
   *   打了 502 模板错误后，页面上只出现 `ChannelSetupPanel` 的内联 alert，自检条根本不渲染。
   * 待补的路径（CodingAgent）：
   *   1. `App.vue`：`channelError` 不只给 `ChannelSetupPanel`，还要交给 `useDiagnostics`（新增 option）；
   *   2. `diagnostics/signals.ts`：把该错误经 `errorToDiagnosticSignal()` 摊成信号（如 `templateMismatch`）；
   *   3. `diagnostics/rules.ts`：D2 的 `condition` 除了 `signals.template !== 'alone'`，还要认这个信号
   *      —— 否则 `error-to-signal.ts` 的 D2 映射没有任何消费者（现有 `rules.spec.ts` 也证明 D2 只读 template）。
   *   `DiagnosisBar` 的 `v-if="channel || verdict"` 不用改：verdict 非空时自检条会渲染。
   * 同一道理，“开播前重取地址（`resolvePushUrl`）撞上 502”这条路径也要归 D2（目前会被 D3 首帧超时抢走）。
   *
   * 下面这份最小补丁已在本地实测过：打完这 4 处，这条用例就绿（unit 177 / typecheck 仍然绿），验证后已按字节还原，未提交：
   *   1) rules.ts `DiagnosticSignals` 加 `templateMismatch?: boolean`，
   *      D2.condition 改成 `signals.templateMismatch === true || (typeof signals.template === 'string' && signals.template !== 'alone')`
   *   2) signals.ts `SignalSource` 加 `channelError?: PushErrorInfo | null`，
   *      buildSignals 里 `const channelFailure = errorToDiagnosticSignal(source.channelError, now)`，
   *      返回体加 `templateMismatch: channelFailure?.id === 'D2' || pushError?.id === 'D2'`
   *   3) useDiagnostics.ts options 加 `channelError?: Ref<PushErrorInfo | null>`，两处 buildSignals 都传 `channelError: options.channelError?.value ?? null`
   *   4) App.vue 的 `useDiagnostics({ ... })` 里把已有的 `channelError` 也传进去
   */
  test('服务端 502「频道模板不是纯视频」→ 自检条给 D2 + 帮助中心（新窗口），不发起推流', async ({
    page,
  }) => {
    await setup(page, {
      channelGetFailure: { status: 502, body: E2E_TEMPLATE_MISMATCH_BODY },
    });
    await openPusherWithExistingChannel(page);

    // 一句话原因：服务端那句「频道模板不是纯视频…」必须出现在**自检条**里（不是只在频道面板内联一句）
    const bar = selfCheckBar(page);
    await expect(
      bar.getByText(/不是纯视频/).first(),
      'GET 频道返回 502 模板错误时，自检条必须给出 D2 结论（D27：故障提示只走诊断条）',
    ).toBeVisible({ timeout: 20_000 });

    // 一个下一步：怎么改模板（D22：D2 只给帮助中心链接，不做一键修复）
    const templateAction = bar
      .getByRole('link', { name: ACTION.D2 })
      .or(bar.getByRole('button', { name: ACTION.D2 }))
      .first();
    await expect(templateAction, 'D2 必须给出【怎么改模板】').toBeVisible();

    // 点开是帮助中心：要求新窗口（target=_blank 或 window.open）
    const tagName = await templateAction.evaluate((element) => element.tagName);
    if (tagName === 'A') {
      const meta = await templateAction.evaluate((element) => ({
        href: element.getAttribute('href') ?? '',
        target: element.getAttribute('target') ?? '',
      }));
      expect(meta.href, 'D2 的下一步必须指向帮助中心（http/https 链接）').toMatch(/^https?:\/\//);
      expect(meta.target, 'D2 的帮助中心必须新窗口打开，不能把讲师带走').toBe('_blank');
    } else {
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 8_000 }),
        templateAction.click(),
      ]);
      expect(popup.url()).toMatch(/^https?:\/\//);
      await popup.close();
    }

    // 不发起推流（D25：按开播键之前就拦住）：频道没载入成功，开播键必须是禁用的，而且推流器一次都没 start
    const startButton = page.getByRole('button', { name: /开始直播/ }).first();
    expect(
      await startButton.isDisabled(),
      '模板不符导致频道载入失败时，「开始直播」必须禁用（不能先推上去再报错）',
    ).toBe(true);
    expect((await readTxCounts(page)).start, 'D2 是预检拦截，不允许发起推流').toBe(0);
  });

  /**
   * 防御性用例（真实服务端不会走到）：前端预检读取 `ChannelInfo.template` 的那条路径。
   * 服务端只在纯视频模板下才返回 200，所以 `template: 'ppt'` 的 200 响应实际不会出现；
   * 这条留在这里锁住「前端本地也会用 template 兜底判定」，防止有人把预检改成只认错误码。
   */
  test('防御性（真实服务端不会走到）：200 + template≠alone 时前端预检也要拦住开播', async ({
    page,
  }) => {
    await setup(page, { template: 'ppt' });
    await openPusherWithChannel(page);

    // 预检结论：一句话原因（D25：按开播键之前就拦住）
    await expect(reasonOf(page, 'D2'), '载入频道后预检就要给出 D2 结论').toBeVisible({
      timeout: 20_000,
    });

    // 一个下一步：怎么改模板（D22：D2 只给帮助中心链接，不做一键修复）
    const templateAction = page
      .getByRole('link', { name: ACTION.D2 })
      .or(page.getByRole('button', { name: ACTION.D2 }))
      .first();
    await expect(templateAction, 'D2 必须给出【怎么改模板】').toBeVisible();

    // 点开是帮助中心：要求新窗口（target=_blank 或 window.open）
    const tagName = await templateAction.evaluate((element) => element.tagName);
    if (tagName === 'A') {
      const meta = await templateAction.evaluate((element) => ({
        href: element.getAttribute('href') ?? '',
        target: element.getAttribute('target') ?? '',
      }));
      expect(meta.href, 'D2 的下一步必须指向帮助中心（http/https 链接）').toMatch(/^https?:\/\//);
      expect(meta.target, 'D2 的帮助中心必须新窗口打开，不能把讲师带走').toBe('_blank');
    } else {
      const [popup] = await Promise.all([
        page.waitForEvent('popup', { timeout: 8_000 }),
        templateAction.click(),
      ]);
      expect(popup.url()).toMatch(/^https?:\/\//);
      await popup.close();
    }

    // 不发起推流：按钮就算是可点的，点了也不能推
    const before = await readTxCounts(page);
    const startButton = page.getByRole('button', { name: /开始直播/ }).first();
    if (await startButton.isEnabled().catch(() => false)) {
      await startButton.click().catch(() => undefined);
      await advance(page, 2_000);
    }

    const after = await readTxCounts(page);
    expect(after.start, '非纯视频模板不允许发起推流（D2 是预检拦截）').toBe(before.start);
    expect(after.start).toBe(0);
  });
});

test.describe('D1 预检：推流地址已过期', () => {
  test('push.expiresAt 已过期 → 预检即 D1 结论 +【重新连接】', async ({ page }) => {
    await setup(page, { txTimeHex: E2E_EXPIRED_TX_TIME_HEX });
    await openPusherWithChannel(page);

    await expect(reasonOf(page, 'D1'), '地址已过期时预检就要给出 D1 结论').toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: ACTION.D1 }).first()).toBeVisible();
  });
});

test.describe('D5 低码率 → 自动重连', () => {
  test('码率掉到 100kbps，8 秒内出现 D5 结论与【自动重连】；点按钮真的重连一次', async ({ page }) => {
    const { diagnosticsLog } = await setup(page);
    await openPusherWithChannel(page);
    await startPush(page);

    // 峰值仍按开播时的 800kbps 算，阈值 = max(150, 800×40%) = 320kbps，100kbps 必然低于阈值
    await setTxStats(page, { bitrateBps: 100_000, fps: E2E_TX_STATS.fps });

    // Done when 第 5 条：8 秒内必须给出结论（阈值 5 秒，这里正好快进 8 秒）
    await advance(page, 8_000);

    await expect(reasonOf(page, 'D5'), '低码率 8 秒内必须给出 D5 结论').toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('button', { name: ACTION.D5 }).first(),
      'D5 的下一步必须是可一键执行的【自动重连】',
    ).toBeVisible();

    // Done when 第 11 条：同一故障只出现一个提示位
    const text = await bodyText(page);
    expect(
      text.match(/上行带宽不足/g) ?? [],
      `「上行带宽不足」只允许出现 1 次（诊断卡唯一提示位，D27）：\n${text}`,
    ).toHaveLength(1);

    // D23：命中必须留痕到服务端（POST 体按 §六 契约）
    await expect
      .poll(() => diagnosticsLog.filter((item) => item.id === 'D5').length, {
        timeout: 10_000,
        message: '命中 D5 必须 POST /api/channels/:id/diagnostics 留痕',
      })
      .toBeGreaterThan(0);

    const report = diagnosticsLog.filter((item) => item.id === 'D5')[0];
    expect(report.channelId).toBe(E2E_CHANNEL_ID);
    expect(report.code, '诊断码格式 DIAG-D5-<14 位时间>').toMatch(/^DIAG-D5-\d{14}$/);
    expect(report.level).toBe('danger');
    expect(report.reason).toContain('上行带宽不足');
    expect(report.measured.length, '实测值不能为空（展开区要显示实测 vs 期望）').toBeGreaterThan(0);
    expect(report.expected.length, '期望值不能为空').toBeGreaterThan(0);

    // 一键修复：点【自动重连】必须真的再 startPush 一次（mock 记次数）
    const before = await readTxCounts(page);
    await page.getByRole('button', { name: ACTION.D5 }).first().click();

    await expect
      .poll(async () => (await readTxCounts(page)).start, {
        timeout: 20_000,
        message: '点【自动重连】必须真的重新发起推流（startPush 次数 +1）',
      })
      .toBeGreaterThan(before.start);

    // 命中后打开「诊断历史」抽屉：能看到刚命中的那条记录（D26）
    // 断言口径：抽屉展开后「上行带宽不足」的出现次数必须**变多**（卡上 1 处 + 抽屉 1 处 → 2 处）。
    // 不按 DOM 结构断言，因为计划只规定了抽屉骨架，没规定 class 名。
    const reasonCountBefore = await page.getByText(/上行带宽不足/).count();
    await openHistoryDrawer(page);
    await expect
      .poll(() => page.getByText(/上行带宽不足/).count(), {
        timeout: 20_000,
        message: '诊断历史抽屉里必须能看到刚命中的那条记录',
      })
      .toBeGreaterThan(reasonCountBefore);
  });
});

test.describe('D6 编码器无输出 → 重载推流器', () => {
  test('fps=0 持续 5 秒 → D6 结论与【重载推流器】；点击后推流器 stop + start 各一次', async ({
    page,
  }) => {
    await setup(page);
    await openPusherWithChannel(page);
    await startPush(page);

    // 码率正常、只有 fps 掉到 0（D6 的判定前提：采集轨道仍在出帧）
    await setTxStats(page, { fps: 0, bitrateBps: E2E_TX_STATS.bitrateBps });
    await advance(page, 6_000);

    await expect(reasonOf(page, 'D6'), 'fps=0 持续 5 秒必须给出 D6 结论').toBeVisible({
      timeout: 15_000,
    });
    const reloadButton = page.getByRole('button', { name: ACTION.D6 }).first();
    await expect(reloadButton, 'D6 的下一步是【重载推流器】').toBeVisible();

    const before = await readTxCounts(page);
    await reloadButton.click();

    await expect
      .poll(async () => (await readTxCounts(page)).stop, {
        timeout: 20_000,
        message: '【重载推流器】必须先 stopPush（会话竞态：不 stop 就 start 会 -12）',
      })
      .toBeGreaterThan(before.stop);
    await expect
      .poll(async () => (await readTxCounts(page)).start, {
        timeout: 20_000,
        message: '【重载推流器】必须再 startPush 一次',
      })
      .toBeGreaterThan(before.start);
  });
});

test.describe('D7 麦克风没声音 → 换麦克风', () => {
  test('麦克风静默 8 秒 → D7 结论与【换麦克风】；点击后重新请求音频设备', async ({ page }) => {
    await setup(page, { silentAudio: true });
    await openPusherWithChannel(page);
    await startPush(page);

    await advance(page, 9_000);

    await expect(reasonOf(page, 'D7'), '静默 8 秒必须给出 D7 结论').toBeVisible({
      timeout: 20_000,
    });
    const switchMic = page.getByRole('button', { name: ACTION.D7 }).first();
    await expect(switchMic, 'D7 的下一步是【换麦克风】').toBeVisible();

    const callsBefore = (await readMediaCalls(page)).length;
    await switchMic.click();

    await expect
      .poll(async () => (await readMediaCalls(page)).length, {
        timeout: 20_000,
        message: '【换麦克风】必须真的重新请求音频设备（getUserMedia）',
      })
      .toBeGreaterThan(callsBefore);
  });
});

test.describe('D9 摄像头黑屏', () => {
  test('黑屏连续 3 秒 → D9 结论与修复按钮（推流中文案必须是「恢复画面」，D41 ③）', async ({ page }) => {
    await setup(page, { videoPixel: 'black' });
    await openPusherWithChannel(page);
    await startPush(page);

    await advance(page, 4_000);

    await expect(reasonOf(page, 'D9'), '黑屏连续 3 秒必须给出 D9 结论').toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: ACTION.D9 }).first()).toBeVisible();
    // D41 ③：按钮文案随状态区分——推流中 =「恢复画面」（未开播 =「重新检测摄像头」）
    await expect(
      page.getByRole('button', { name: /恢复画面/ }).first(),
      'D41 ③：推流中点开 D9 的按钮文案必须是「恢复画面」',
    ).toBeVisible();
  });
});

test.describe('诊断历史抽屉（D26）', () => {
  test('服务端已有记录时抽屉能列出来（时间 / 诊断项 / 原因 / 实测值）', async ({ page }) => {
    await setup(page, {
      diagnosticsSeed: [
        {
          id: 'D5',
          code: 'DIAG-D5-20261023153012',
          level: 'danger',
          reason: '上行带宽不足，推流已中断或降质',
          measured: '实测 88 kbps（历史记录）',
          expected: '上行码率 > 150 kbps 且不低于峰值的 40%',
          firstAt: '2026-10-23T07:30:12.000Z',
          lastAt: '2026-10-23T07:31:02.000Z',
          occurrences: 3,
          recoveredAt: null,
        },
      ],
    });
    // 抽屉按 historyChannelId 取数，必须先载入频道（否则它拿到 null，只会显示空态）
    await openPusherWithChannel(page);

    await openHistoryDrawer(page);

    // 实测值字符串是这条 seed 独有的，出现即说明抽屉真的渲染了服务端数据（不是本地兜底）
    await expect(
      page.getByText('实测 88 kbps（历史记录）').first(),
      '抽屉必须渲染服务端返回的历史记录',
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('上行带宽不足，推流已中断或降质').first()).toBeVisible();
  });

  test('没有诊断记录时抽屉给空态文案（不是空白面板）', async ({ page }) => {
    await setup(page);
    await page.goto(PUSHER_URL);
    await advance(page, 500);

    await openHistoryDrawer(page);

    await expect(
      page.getByText(/暂无诊断|还没有.*记录|暂无记录|没有诊断/).first(),
      '空态必须有一句中文说明，不能是空白抽屉',
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('修复失败 → 回到同一结论 + 再试一次', () => {
  test('D5 点【自动重连】但重连失败：仍是同一条 D5 结论，并出现「再试一次」', async ({ page }) => {
    await setup(page);
    await openPusherWithChannel(page);
    await startPush(page);

    await setTxStats(page, { bitrateBps: 100_000, fps: E2E_TX_STATS.fps });
    await advance(page, 6_000);
    await expect(reasonOf(page, 'D5')).toBeVisible({ timeout: 15_000 });

    // 让下一次 startPush 直接失败 → 重连不可能成功
    await failNextTxStart(page);
    await page.getByRole('button', { name: ACTION.D5 }).first().click();

    // 修复失败必须回到同一条 verdict（不能被低优先级规则顶掉、也不能变成「一切正常」）
    await expect(
      page.getByRole('button', { name: /再试一次/ }).first(),
      '修复失败必须给出「再试一次」这个下一步',
    ).toBeVisible({ timeout: 20_000 });

    await expect(reasonOf(page, 'D5'), '修复失败后必须回到同一条 D5 结论').toBeVisible();

    const text = await bodyText(page);
    expect(
      text.match(/上行带宽不足/g) ?? [],
      `修复失败后同一故障仍然只能出现 1 次：\n${text}`,
    ).toHaveLength(1);
    expect(text, '不能因为修复失败就宣称「一切正常」').not.toContain('推流一切正常');
  });
});

/* ============================================================================================
 * 增补 A / B / C / D（HACK-1024 §十一，评审通过）
 * 客户来函（国开在线 2026-10-23 15:31）点名要的三样证据，全部在这里落成可执行断言：
 *   ① 推流帧率 / 码率等客观数据 → 指标时间序列（D34）+ 抽屉导出 CSV
 *   ② 弹窗提示的时间点与次数       → 断流时长 outageMs（D35）+ 网络波动分级
 *   ③ 设备配置                    → 设备快照 device（D36）
 * 外加演示注入面板（D37）：`?demo=1` 注入低码率后**必须仍走真实规则链路**（自检条出现 D5、且真的上报了诊断）。
 * ========================================================================================== */

/** 页面内直接读 mock 接口（page.route 拦截页面请求，相对路径会打到 5173 上再被 mock 拦下） */
async function fetchJson(page: Page, path: string): Promise<any> {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { headers: { Accept: 'application/json' } });
    return response.json();
  }, path);
}

function isAscendingByAt(items: Array<{ at: string }>): boolean {
  for (let index = 1; index < items.length; index += 1) {
    if (Date.parse(items[index].at) < Date.parse(items[index - 1].at)) return false;
  }
  return true;
}

test.describe('增补 A：指标时间序列（D34）', () => {
  /**
   * 一次完整断流 → 恢复：
   *   - `GET /metrics` 至少有 2 条采样（推流中每 5 秒一条），且按 at 升序（画曲线 / 导 CSV 的口径）
   *   - `GET /diagnostics` 里那条 D5 带**数字型** `outageMs`（客户函「断了几秒」）
   */
  test('断流→恢复后：metrics 有 ≥2 条升序采样，diagnostics 里 D5 带数字 outageMs', async ({
    page,
  }) => {
    const { metricsLog } = await setup(page);
    await openPusherWithChannel(page);
    await startPush(page);

    // 正常推流：边推进假时钟边等采样凑够 2 条。
    // 不能只 advance 一次再 poll —— 假时钟停下来之后 5 秒采样器就不会再触发了（首跑曾因此偶发红）。
    let waited = 0;
    while (metricsLog.length < 2 && waited < 24_000) {
      await advance(page, 2_000);
      waited += 2_000;
    }
    expect(
      metricsLog.length,
      `推流中必须每 5 秒上报一条采样（POST /api/channels/:id/metrics），实际 ${metricsLog.length} 条`,
    ).toBeGreaterThanOrEqual(2);

    // 断流：码率掉到 100kbps（< max(150, 800×40%)），持续 5 秒触发 D5
    await setTxStats(page, { bitrateBps: 100_000, fps: E2E_TX_STATS.fps });
    await advance(page, 6_000);
    await expect(reasonOf(page, 'D5'), '前置条件：先命中 D5').toBeVisible({ timeout: 15_000 });

    // 恢复：码率回到 800kbps，D5 的恢复窗口 3 秒
    await setTxStats(page, { bitrateBps: E2E_TX_STATS.bitrateBps, fps: E2E_TX_STATS.fps });
    await advance(page, 6_000);

    // ① 客观数据：GET /metrics 按 at 升序
    const metrics = await fetchJson(page, `/api/channels/${E2E_CHANNEL_ID}/metrics?limit=300`);
    expect(metrics.channelId).toBe(E2E_CHANNEL_ID);
    expect(
      metrics.items.length,
      `断流一次也要有 ≥2 条采样（客户要「码率从多少掉到多少」）：${JSON.stringify(metrics.items)}`,
    ).toBeGreaterThanOrEqual(2);
    expect(isAscendingByAt(metrics.items), 'GET /metrics 必须按 at 升序返回').toBe(true);
    for (const item of metrics.items) {
      expect(typeof item.kbps, '每条采样都要有数字型码率').toBe('number');
      expect(typeof item.fps).toBe('number');
      expect(typeof item.connection).toBe('string');
    }
    expect(
      metrics.items.some((item: { kbps: number }) => item.kbps <= 100),
      '断流那一段的低码率必须被采到（否则曲线证明不了掉底）',
    ).toBe(true);

    // ② 时间点与次数：GET /diagnostics 里该条带数字型 outageMs
    const history = await fetchJson(page, `/api/channels/${E2E_CHANNEL_ID}/diagnostics?limit=50`);
    const d5 = history.items.find((item: { id: string }) => item.id === 'D5');
    expect(d5, '诊断历史里必须有这条 D5').toBeTruthy();
    expect(
      typeof d5.outageMs,
      `断流恢复后必须写数字型 outageMs（客户函：弹窗时间点与次数）：${JSON.stringify(d5)}`,
    ).toBe('number');
    expect(d5.outageMs, '断流时长必须 > 0 毫秒').toBeGreaterThan(0);
    expect(d5.recoveredAt, '恢复后该条要标记 recoveredAt').toBeTruthy();
  });
});

test.describe('增补 A：抽屉导出 CSV（D34）', () => {
  test('「导出 CSV」触发下载，内容表头是 at,kbps,fps…（含采样行）', async ({ page }) => {
    await setup(page, {
      metricsSeed: [
        {
          kbps: 780,
          fps: 20,
          dropFps: 0,
          connection: 'connected',
          at: '2026-10-23T08:12:30.000Z',
        },
        {
          kbps: 120,
          fps: 12,
          dropFps: 4,
          connection: 'connected',
          at: '2026-10-23T08:12:35.000Z',
        },
        {
          kbps: 90,
          fps: 0,
          dropFps: 15,
          connection: 'disconnected',
          at: '2026-10-23T08:12:40.000Z',
        },
      ],
    });
    // 抽屉按 historyChannelId 取数，必须先载入频道
    await openPusherWithChannel(page);
    await openHistoryDrawer(page);

    const csvButton = page.getByRole('button', { name: /导出\s*CSV/i }).first();
    await expect(csvButton, '抽屉里必须有「导出 CSV」（§十一 A）').toBeVisible({ timeout: 20_000 });

    const [download] = await Promise.all([page.waitForEvent('download'), csvButton.click()]);
    expect(download.suggestedFilename(), '导出的文件名应能看出是 CSV').toMatch(/\.csv$/i);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const content = Buffer.concat(chunks).toString('utf8');
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    expect(lines[0], 'CSV 表头第一列必须是 at（时间正序）').toContain('at,kbps,fps');
    expect(lines[0], 'CSV 还要有丢帧与连接态两列（计划 §十一 A 逐字列名）').toContain('dropFps');
    expect(lines[0]).toContain('connection');
    expect(lines.length - 1, '预置 3 条采样 → 至少 3 行数据').toBeGreaterThanOrEqual(3);
    expect(content, '采样内容要真的写进文件（不是空表）').toContain('780');
  });
});

test.describe('增补 B：网络波动（D35，advisory）', () => {
  /**
   * ⚠ 契约文本矛盾（已报主代理，需 评审人 裁定）：
   *   - 计划 §十一 B 表格：「基线 60%–100% 之间」→ 70% 算波动；
   *   - CONTEXT D35：「跌破基线 60%」+ 「不到 D5 下限」→ 70% 不算，45% 才算。
   * 本用例按**计划表格**（= 主代理派单口径）写：800kbps 峰值 → 560kbps（70%）。
   * 若裁定按 D35，把这里改成 `bitrateBps: 360_000`（45%，仍高于 D5 下限 320kbps）即可。
   */
  test('码率掉到基线 70% 持续 5 秒 → 自检条出现「网络波动」提醒，但不占据硬诊断结论', async ({
    page,
  }) => {
    await setup(page);
    await openPusherWithChannel(page);
    await startPush(page);

    // 800kbps 峰值 → 560kbps（70%）：还没到 D5 的下限（max(150, 320)=320kbps）
    await setTxStats(page, { bitrateBps: 560_000, fps: E2E_TX_STATS.fps });
    await advance(page, 7_000);

    const text = await bodyText(page);
    expect(
      text,
      `网络波动要在自检条上给一句提醒（D35：warning「网络波动，可能会断流」）：\n${text}`,
    ).toContain('网络波动');
    expect(
      text,
      '没到断流门槛时不能出现 D5 的硬结论（advisory 不抢占硬诊断）',
    ).not.toContain('上行带宽不足');
  });
});

test.describe('增补 C：设备快照（D36）', () => {
  test('开播即上报设备快照：GET /diagnostics 返回 device（cpuCores 是数字、ua 含 Chrome）', async ({
    page,
  }) => {
    await setup(page);
    await openPusherWithChannel(page);
    await startPush(page);

    // D36：会话开始（进入 live）上报一次，不需要先出故障
    await advance(page, 1_500);

    const history = await fetchJson(page, `/api/channels/${E2E_CHANNEL_ID}/diagnostics?limit=50`);
    const device = history.device;
    expect(device, 'GET /diagnostics 必须返回 device（客户函第③条「设备配置接口」）').toBeTruthy();
    expect(typeof device.cpuCores, 'device.cpuCores 必须是数字').toBe('number');
    expect(device.cpuCores).toBeGreaterThan(0);
    expect(String(device.ua), 'device.ua 必须含浏览器标识').toContain('Chrome');
    expect(
      Object.prototype.hasOwnProperty.call(device, 'gpuRenderer'),
      '取不到的字段也要在（值为 null），不能整个字段消失',
    ).toBe(true);
    expect(device.screen === null || /^\d+×\d+@[\d.]+$/.test(String(device.screen))).toBe(true);
  });
});

test.describe('增补 D：演示故障注入面板（D37）', () => {
  test('?demo=1 注入低码率 → 自检条出现 D5，证明注入走的是真实规则链路', async ({ page }) => {
    const { diagnosticsLog } = await setup(page);
    await openPusherWithChannel(page, '?demo=1');
    await startPush(page);

    // 面板必须在（URL 带 demo=1）
    const lowBitrate = page.getByRole('button', { name: /^低码率$/ }).first();
    await expect(lowBitrate, '?demo=1 时必须挂载「演示故障注入」面板（D37）').toBeVisible({
      timeout: 20_000,
    });

    await lowBitrate.click();
    await advance(page, 8_000);

    // 走的是真规则：自检条给出 D5 结论 + 下一步按钮（不是直接改 UI 文案）
    await expect(
      reasonOf(page, 'D5'),
      '演示注入低码率也必须经过规则层判出 D5（D37：不绕过规则）',
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: ACTION.D5 }).first()).toBeVisible();

    // 更强的证据：命中的诊断真的被上报到服务端（走完整链路）
    await expect
      .poll(() => diagnosticsLog.filter((item) => item.id === 'D5').length, {
        timeout: 15_000,
        message: '演示注入命中后也要留痕（说明走的是 useDiagnostics → rules → report）',
      })
      .toBeGreaterThan(0);
    const report = diagnosticsLog.find((item) => item.id === 'D5');
    expect(report?.code, '诊断码仍按 DIAG-D5-<14 位时间> 生成').toMatch(/^DIAG-D5-\d{14}$/);
    expect(report?.channelId).toBe(E2E_CHANNEL_ID);
  });

  test('不带 ?demo=1 时演示面板不加载（D37：默认不加载、不进生产路径）', async ({ page }) => {
    await setup(page);
    await openPusherWithChannel(page);

    await expect(
      page.getByRole('button', { name: /^低码率$/ }),
      '演示注入面板只允许在 ?demo=1 出现',
    ).toHaveCount(0);
  });
});

/* ============================================================================================
 * D38（评审人 2026-10-23 实测缺陷）：预检必须真探网络，「预检通过」不得无证据显示
 *
 * 真实缺陷：断网后诊断卡能报错；点【自动重连】失败后，自检条回落到「预检通过，可以开播」，
 * 与真实网络状态相反。根因是预检只读内存里的频道对象、从不探测 `GET /api/health`，
 * 而修复先 stop() → idle，idle 又无条件清空结论。
 *
 * 本用例把整条真实路径走一遍：
 *   联网载入 → 开播（预检确实通过）→ 断网（/api/health abort）+ 断流 → 点【自动重连】失败
 *   → 自检条不得出现「预检通过」→ 网络恢复 → 再次开播 / 停止 → 只有探测成功才回到「预检通过」。
 *
 * 支撑：`e2e/support/mock-server-api.ts` 的 `healthControl`（默认成功，既有 e2e 一条都不受影响）。
 * ========================================================================================== */
test.describe('D38 断网：不得误报「预检通过」', () => {
  const ANY_NEXT_STEP = /自动重连|重试连接|重新连接|再试一次/;

  test('断网后点【自动重连】失败：全文不得出现「预检通过」，网络恢复后才允许再次预检通过', async ({
    page,
  }) => {
    const health = createHealthControl('ok');
    await setup(page, { healthControl: health });
    await openPusherWithChannel(page);
    await startPush(page);
    await advance(page, 2_000);

    expect(
      await bodyText(page),
      '前置：网络正常时预检应当通过（不能一上来就红）',
    ).not.toMatch(/连不上|正在检查网络/);

    // —— 断网：`GET /api/health` 直接失败（等价浏览器网络不可达）——
    health.mode = 'fail';
    // 同时把码率打到 100kbps，复现「断网 → 断流 → 点自动重连」这条真实路径
    await setTxStats(page, { bitrateBps: 100_000, fps: E2E_TX_STATS.fps });
    await advance(page, 10_000);

    const reconnect = page.getByRole('button', { name: ANY_NEXT_STEP }).first();
    await expect(
      reconnect,
      '断网 + 断流后必须给出一个可一键执行的下一步（D22）',
    ).toBeVisible({ timeout: 20_000 });

    // 断网状态下重连必然失败（推流器 startPush 直接 reject）
    await failNextTxStart(page);
    await reconnect.click();
    await advance(page, 4_000);

    const failedText = await bodyText(page);
    expect(
      failedText,
      `断网 + 修复失败后绝不能宣称「预检通过」（D38 实测缺陷）：\n${failedText}`,
    ).not.toContain('预检通过');

    // 结论必须仍然在说「有问题」：探测失败给的「连不上 / 正在检查网络」，
    // 或按计划 §四「修复失败回到同一条 verdict」保留的原结论（D5 断流等）都算合格。
    // 不合格的只有一种：没有任何证据地静默变绿。
    expect(
      failedText,
      `必须保留一条如实的异常结论（不能静默变绿）：\n${failedText}`,
    ).toMatch(
      /连不上|连接没建立|无法连接|正在检查网络|正在检测网络|上行带宽不足|编码器没有输出|没有检测到麦克风声音|摄像头没有画面/,
    );

    // 自检条状态本身不能是 ok（结构断言，避免只靠文案）
    const selfCheck = page.getByRole('region', { name: '推流自检' });
    await expect(selfCheck, '断网时自检条必须还在').toBeVisible();
    expect(
      ['danger', 'warning', 'fixing'],
      `断网 + 修复失败时自检条不能是 ok，实际 data-status=${await selfCheck.getAttribute('data-status')}`,
    ).toContain(await selfCheck.getAttribute('data-status'));

    // 修复失败必须还能再试（D22：修复失败回到同一结论 + 再试一次）
    const retry = page.getByRole('button', { name: ANY_NEXT_STEP }).first();
    await expect(retry, '修复失败后必须保留「再试一次」这个下一步').toBeVisible();
    await expect(retry, '修复失败后按钮必须可再次点击，不能卡在修复中').toBeEnabled();

    // —— 网络恢复 ——
    health.mode = 'ok';
    await setTxStats(page, { bitrateBps: E2E_TX_STATS.bitrateBps, fps: E2E_TX_STATS.fps });
    // idle 态每 15 秒探测一次（D38 ②），等过一轮探测周期
    await advance(page, 16_000);

    // 真正拿到「预检通过」的路径：再次开播成功 → 停止 → 回到可以开播的 idle 态。
    // （修复失败会停在 error 态；只要探测没成功，这条路径同样不会显示「预检通过」。）
    await page.getByRole('button', { name: /开始直播/ }).first().click();
    await expect(
      page.getByRole('button', { name: /停止直播/ }).first(),
      '网络恢复后必须能重新开播成功',
    ).toBeVisible({ timeout: 20_000 });
    await advance(page, 1_000);
    await page.getByRole('button', { name: /停止直播/ }).first().click();
    await expect(
      page.getByRole('button', { name: /开始直播/ }).first(),
      '停止后回到 idle',
    ).toBeVisible({ timeout: 20_000 });
    await advance(page, 2_000);

    // D38 ④：只有探测成功 + 会话不再失败，才允许回「预检通过，可以开播」
    await expect(
      page.getByText('预检通过，可以开播'),
      '网络恢复且探测成功后才允许回「预检通过，可以开播」',
    ).toBeVisible({ timeout: 20_000 });
  });
});

/* ============================================================================================
 * D39（评审人 2026-10-23 第二次实测）：探测必须反映「外网可达」，不能只看本进程活着
 *
 * 真实缺陷：关 Wi-Fi 后**刷新页面**仍显示「预检通过」。根因：浏览器到 `127.0.0.1:3100` 走回环，
 * 断网不影响；而 `GET /api/health` 在上游不可达时**旧实现回 HTTP 200 + `{ok:true, polyv:'unreachable'}`**，
 * 前端只判 `response.ok` → 当成网络正常。
 *
 * 本文件锁 D39 的两半：
 *   ① 服务端上游不可达 → 503 + `{ok:false, polyv:'unreachable'}`（mock 的 `offline`；新契约形状）
 *   ② 前端必须同时要求 `response.ok === true` 且 `ok !== false` 且 `polyv !== 'unreachable'`
 *      → 所以旧实现的形状（200 + polyv unreachable，mock 的 `upstream-down`）**也必须判失败**
 *   ③ 判「连不上服务器」时同步禁用【开始直播】并给出禁用原因
 *
 * mock 支撑：`e2e/support/mock-server-api.ts` 的 `HealthMode`（默认 `ok`，既有用例不受影响）。
 * 恢复路径：把 `health.mode` 改回 `'ok'`，idle 态每 15 秒探测一次（D38 ②），探测成功后自动可开播。
 * ========================================================================================== */
test.describe('D39 上游不可达：不得误判为「预检通过」', () => {
  /** 连不上服务器的一句话原因（rules.ts D3：预检阶段「连不上服务器，请检查网络」） */
  const UNREACHABLE_TEXT = /连不上服务器|连不上网络|无法连接服务器|网络不可达/;

  function selfCheckBar(page: Page) {
    return page.getByRole('region', { name: '推流自检' });
  }

  function startButton(page: Page) {
    return page.getByRole('button', { name: /开始直播/ }).first();
  }

  /**
   * 【开始直播】的禁用原因：按钮自身的 `title` / `aria-describedby` 指向的元素 / 按钮所在控件容器里的说明文案,
   * 三者任一命中即可（实现可能把原因放在 hint、title 或 aria-describedby 上）。
   * 只看**按钮所在容器**，避免拿自检条里的结论蒙混过关：禁用原因必须和按钮在一起。
   */
  async function startBlockedReason(page: Page): Promise<string> {
    return startButton(page).evaluate((el) => {
      const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      const described = ids
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      const container = el.parentElement?.textContent ?? '';
      return [el.getAttribute('title') ?? '', described, container].join(' \n ');
    });
  }

  /** 打开推流端 → 建频道（频道会持久化到 localStorage）→ 刷新页面（复现「关 Wi-Fi 后刷新」实测路径） */
  async function reloadWithChannel(page: Page) {
    await openPusherWithChannel(page);
    await expect
      .poll(async () => page.evaluate(() => window.localStorage.getItem('live1024.pusher.channel')))
      .not.toBeNull();
    await page.reload();
    await advance(page, 2_000);
    await page.waitForTimeout(400);
  }

  test('刷新后 health 回 503（polyv unreachable）：不显示「预检通过」、给「连不上服务器」、【开始直播】禁用并给原因，恢复后自动可开播', async ({
    page,
  }) => {
    const health = createHealthControl('offline');
    await setup(page, { healthControl: health });
    await reloadWithChannel(page);

    // 结论：必须说「连不上服务器」（D3 的预检口径），不能静默变绿
    await expect(
      page.getByText(UNREACHABLE_TEXT).first(),
      'D39：health 503（上游不可达）时预检必须判「连不上服务器」',
    ).toBeVisible({ timeout: 20_000 });

    const text = await bodyText(page);
    expect(text, `上游不可达时绝不能宣称「预检通过」：\n${text}`).not.toContain('预检通过');

    // 自检条状态本身不能是 ok（结构断言，避免只靠文案）
    const selfCheck = selfCheckBar(page);
    await expect(selfCheck, '预检阶段自检条必须还在').toBeVisible();
    expect(
      ['danger', 'warning'],
      `上游不可达时自检条不能是 ok / checking，实际 data-status=${await selfCheck.getAttribute('data-status')}`,
    ).toContain(await selfCheck.getAttribute('data-status'));

    // D39 ③：判「连不上服务器」时同步禁用开播，并在按钮旁给出原因
    const start = startButton(page);
    await expect(start, 'D39 ③：连不上服务器时必须禁用【开始直播】').toBeDisabled({ timeout: 20_000 });
    const blockedReason = await startBlockedReason(page);
    expect(
      blockedReason,
      `D39 ③：禁用【开始直播】必须给出原因（连不上/网络类文案），实际按钮附近文案：${blockedReason}`,
    ).toMatch(/连不上|网络/);

    // —— 网络恢复：mock 改回 200 + reachable ——
    health.mode = 'ok';
    // idle 态每 15 秒探测一次（D38 ②），等过一轮探测周期
    await advance(page, 16_000);

    await expect(
      page.getByText('预检通过，可以开播'),
      '探测成功后必须自动恢复「预检通过，可以开播」',
    ).toBeVisible({ timeout: 20_000 });
    await expect(start, '网络恢复且探测成功后必须自动恢复可开播').toBeEnabled({ timeout: 20_000 });
  });

  test('旧实现的形状（200 + { ok: true, polyv: "unreachable" }）同样不得判通过：不显示「预检通过」且【开始直播】禁用', async ({
    page,
  }) => {
    const health = createHealthControl('upstream-down');
    await setup(page, { healthControl: health });
    await reloadWithChannel(page);

    await expect(
      page.getByText(UNREACHABLE_TEXT).first(),
      'D39 ②：HTTP 200 但 polyv:"unreachable" 必须判「连不上服务器」（旧实现只看 response.ok 会误判通过）',
    ).toBeVisible({ timeout: 20_000 });

    const text = await bodyText(page);
    expect(
      text,
      `D39 核心回归：200 + polyv:"unreachable" 时绝不能显示「预检通过」：\n${text}`,
    ).not.toContain('预检通过');

    const start = startButton(page);
    await expect(start, '200 + polyv unreachable 时也必须禁用【开始直播】').toBeDisabled({
      timeout: 20_000,
    });
    expect(
      await startBlockedReason(page),
      '禁用【开始直播】必须给出原因（连不上/网络类文案）',
    ).toMatch(/连不上|网络/);

    // 恢复后同样要能自动开播（与 503 用例同一恢复口径）
    health.mode = 'ok';
    await advance(page, 16_000);
    await expect(
      page.getByText('预检通过，可以开播'),
      '上游恢复后（200 + reachable）必须自动恢复「预检通过」',
    ).toBeVisible({ timeout: 20_000 });
    await expect(start).toBeEnabled({ timeout: 20_000 });
  });
});

/**
 * D41（CONTEXT.md，评审人 2026-10-23 第三次实测）——两条实测缺陷的回归：
 *
 * ① 「重新授权 / 换设备」在**未开播**状态下只允许「重新获取采集流 + 重跑判定」，
 *    **不得调用 `start()` 自动开播**；只有修复前处于 `live` 才恢复推流（记录 `wasLive`）。
 *    真机现场：诊断卡显示已恢复，但画面直接开始推流了，讲师没有按过「开始直播」。
 *
 * ② 摄像头/麦克风权限被浏览器拒绝后，`getUserMedia` 会立即 reject，**浏览器不会再弹授权框**
 *    （规范行为，不是 bug）。此时不得盲目重试/切设备，必须在诊断卡给出「地址栏 → 允许」的指引，
 *    并且详情里列出步骤。
 *
 * ③ 按钮文案随状态区分：未开播 =「重新检测摄像头」，推流中 =「恢复画面」。
 *    （推流中那半条在「D9 摄像头黑屏」用例里断言）
 *
 * 前提说明（为什么 ① 用「黑屏」而不是「权限失败」制造 D9）：
 *   权限被撤**不会**让已经拿到的 MediaStream 立刻报错，页面也就不会冒出 D9 结论；
 *   真机上「撤掉权限 / 摄像头被系统占用」的表现就是**没有画面**（黑屏），
 *   所以这里用 `videoPixel: 'black'` 造 D9，再在点修复前把权限桩切成 denied（= 撤权后的现场）。
 */
test.describe('D41 ① 修复动作不得擅自开播（未开播）', () => {
  /** 自检条（D21 / D27：故障提示只走这里） */
  const selfCheckBar = (page: Page) => page.getByRole('region', { name: '推流自检' });

  test('未开播时权限被撤 + D9 → 点【重新检测摄像头】后仍停在「未开始」，推流器 start 计数不变', async ({
    page,
    context,
  }) => {
    // 起步：有权限、有画面（但画面是黑的 → D9），此时推流器一次都没 start 过
    await setup(page, { videoPixel: 'black' });
    await openPusherWithChannel(page);
    await advance(page, 4_000);

    const bar = selfCheckBar(page);
    await expect(
      bar.getByText(REASON.D9, { exact: false }).first(),
      '未开播时黑屏连续 3 秒必须给 D9 结论（否则这条用例的前提不成立）',
    ).toBeVisible({ timeout: 20_000 });

    // D41 ③：未开播时按钮文案 =「重新检测摄像头」
    const fixButton = page.getByRole('button', { name: /重新检测摄像头/ }).first();
    await expect(
      fixButton,
      'D41 ③：未开播时 D9 的按钮文案必须是「重新检测摄像头」',
    ).toBeVisible();

    // 权限被撤（用户点了「阻止」/ 系统收回）：浏览器之后不会再弹授权框
    await revokeBrowserPermissions(context);
    await setMediaPermission(page, 'denied');

    const before = await readTxCounts(page);
    expect(before.start, '用例前提：修复前推流器一次都没 start（页面处于未开播）').toBe(0);

    await fixButton.click();
    await advance(page, 3_000);

    const after = await readTxCounts(page);
    expect(
      after.start,
      'D41 ①：未开播时点修复只允许「重取采集流 + 重跑判定」，不得调用 start() 自动开播',
    ).toBe(before.start);
    expect(after.start, '未开播修复后推流器 start 次数仍应为 0').toBe(0);

    // 页面仍停在未开播：状态胶囊仍是「未开始」，开播键仍是「开始直播」
    await expect(
      page.getByText('未开始', { exact: true }).first(),
      'D41 ①：修复动作结束后页面必须仍停在「未开始」，不能自己进入推流中',
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /开始直播/ }).first()).toBeVisible();
  });
});

test.describe('D41 ② 权限 denied 必须给浏览器授权指引', () => {
  /** 自检条（D21 / D27：故障提示只走这里） */
  const selfCheckBar = (page: Page) => page.getByRole('region', { name: '推流自检' });

  test('摄像头权限 denied → D9 + 详情里的「地址栏 → 允许」步骤；点修复不得再静默重试 getUserMedia', async ({
    page,
    context,
  }) => {
    await setup(page, { permission: 'denied' });
    // 浏览器侧也把授权记录清掉（Chromium 只会回到 prompt，真正的 denied 由 permissions 桩表达）
    await revokeBrowserPermissions(context);
    await openPusherWithChannel(page);

    const bar = selfCheckBar(page);
    await expect(
      bar.getByText(/权限|阻止/).first(),
      'D41 ②：权限被拒时 D9 必须点名「权限 / 浏览器已阻止」，不能只说「摄像头没有画面」',
    ).toBeVisible({ timeout: 20_000 });

    // 详情展开必须给「地址栏 → 允许 → 再点重新检测」这类可执行步骤
    const detailsButton = bar.getByRole('button', { name: /详情/ }).first();
    await expect(detailsButton, 'D9 必须有可展开的详情（D21）').toBeVisible();
    await detailsButton.click();

    const details = bar.locator('#diagnosis-details');
    await expect(details).toBeVisible();
    const guidance = await details.innerText();
    expect(
      guidance,
      `D41 ②：denied 时详情里必须出现「地址栏」授权指引，实际：\n${guidance}`,
    ).toMatch(/地址栏/);
    expect(
      guidance,
      `D41 ②：指引里必须出现「允许」（或引导到浏览器设置），实际：\n${guidance}`,
    ).toMatch(/允许|浏览器设置/);

    // 规范行为：denied 之后 getUserMedia 立即 reject、浏览器不再弹框 → 修复动作不得盲目重试
    const callsBefore = (await readMediaCalls(page)).length;
    const startBefore = await readTxCounts(page);
    await bar
      .getByRole('button', { name: /重新检测摄像头|重新授权|恢复画面/ })
      .first()
      .click();
    await advance(page, 2_000);

    expect(
      (await readMediaCalls(page)).length,
      'D41 ②：权限 denied 时点修复不得再次调用 getUserMedia（浏览器不会再弹授权框，重试只会立刻失败）',
    ).toBe(callsBefore);
    expect(
      (await readTxCounts(page)).start,
      'D41 ②：权限没恢复时点修复也不得擅自开播',
    ).toBe(startBefore.start);
  });
});
