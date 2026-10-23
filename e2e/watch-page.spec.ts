/**
 * e2e — 观看页（apps/watch）
 *
 * 覆盖 docs/execution-plan.md §Done when 第 6 条：
 *   - 观看页加载后显示频道名与状态条
 * 以及 §七 的其余可测验收点：
 *   - 状态条三态文案：直播中 / 未开始 / 已结束
 *   - 未开播态给出可执行的下一步（讲师开播后自动播放），不是干瞪眼空态
 *   - AI 面板默认收起，展开显示「AI 实时大纲 · 即将上线」占位
 *   - （本轮缺陷回归）同一个 AI 开关连点两次要能收起：抽屉不得盖住自己的开关
 *   - （本轮缺陷回归）频道不存在时只出现一次提示，且不重复拼「按提示处理后重试」
 *   - （本轮缺陷回归 #2）频道不存在时不得冒充「未开始」空态：不出现「直播还没开始」、
 *     状态芯片不显示「未开始」、必须给出「重新连接」动作
 *
 * 观看 SDK 不能真拉流（e2e 不出网）：本文件把 polyv 域全部 abort，
 * 因此断言的都是「壳层 + 状态条」必须与 SDK 是否拉到流无关地渲染出来。
 *
 * 端口约定（计划 §四）：watch 5174。可用 WATCH_BASE_URL 覆盖。
 * 频道参数约定：?channelId=<id>（与服务端 watchUrl 字段一致）。
 */
import { expect, test } from '@playwright/test';
import {
  blockExternalNetwork,
  E2E_CHANNEL_ID,
  E2E_CHANNEL_NAME,
  mockServerApis,
  type E2eLiveStatus,
} from './support/mock-server-api';

const WATCH_URL = process.env.WATCH_BASE_URL ?? 'http://127.0.0.1:5174';

/** 不存在的频道号（2026-10-23 实测非真实频道） */
const MISSING_CHANNEL_ID = '999999999';

const watchUrl = (channelId = E2E_CHANNEL_ID) => `${WATCH_URL}/?channelId=${channelId}`;

async function openWatchPage(
  page: import('@playwright/test').Page,
  liveStatus: E2eLiveStatus,
) {
  await blockExternalNetwork(page);
  await mockServerApis(page, { liveStatus, viewerCount: 3 });
  await page.goto(watchUrl());
}

test('观看页加载后显示频道名与状态条（直播中 + 在线人数）', async ({ page }) => {
  await openWatchPage(page, 'live');

  await expect(page.getByText(E2E_CHANNEL_NAME, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('直播中', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('3', { exact: false }).first()).toBeVisible();
});

test('未开播：状态条显示「未开始」并给出下一步（讲师开播后自动播放）', async ({ page }) => {
  await openWatchPage(page, 'unStart');

  await expect(page.getByText(E2E_CHANNEL_NAME, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('未开始', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('直播中', { exact: false })).toHaveCount(0);

  // 计划 §七：未开播态要给可执行的下一步，不能是空态
  await expect(page.getByText(/讲师开播|自动播放/).first()).toBeVisible();
});

test('已结束：状态条显示「已结束」', async ({ page }) => {
  await openWatchPage(page, 'end');

  await expect(page.getByText(E2E_CHANNEL_NAME, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('已结束', { exact: false }).first()).toBeVisible();
});

test('AI 面板：默认收起，展开显示「AI 实时大纲 · 即将上线」占位（24061 接内容不改布局）', async ({
  page,
}) => {
  await openWatchPage(page, 'live');
  await expect(page.getByText(E2E_CHANNEL_NAME, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });

  // 默认收起：占位文案不可见（v-show 隐藏也算收起，故不断言 DOM 里没有这个节点）
  await expect(page.getByText(/AI 实时大纲/).first()).toBeHidden();

  const aiToggle = page.getByRole('button', { name: /AI/i }).first();
  await expect(aiToggle, '观看页需要一个 AI 面板抽屉开关').toBeVisible();
  await aiToggle.click();

  await expect(page.getByText(/AI 实时大纲/).first()).toBeVisible();
  await expect(page.getByText(/即将上线/).first()).toBeVisible();
});

test('AI 面板：连点同一个开关两次 → 第二次点击后抽屉收起（z-index 遮挡回归）', async ({
  page,
}) => {
  await openWatchPage(page, 'live');
  await expect(page.getByText(E2E_CHANNEL_NAME, { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  });

  // 顶部开关：可访问名就是「AI 面板」（抽屉里的收起按钮叫「收起 AI 面板」，用 exact 区分开）
  const aiToggle = page.getByRole('button', { name: 'AI 面板', exact: true });
  await expect(aiToggle).toBeVisible();
  await expect(aiToggle).toHaveAttribute('aria-expanded', 'false');

  await aiToggle.click();
  await expect(aiToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/AI 实时大纲/).first()).toBeVisible();

  // 等抽屉滑到位（transition 结束）再做命中测试，避免在动画中途拿到「还没盖上来」的假通过
  const drawer = page.locator('#ai-drawer');
  await expect(drawer).toHaveAttribute('data-open', 'true');
  await expect
    .poll(
      async () => {
        const box = await drawer.boundingBox();
        const viewport = page.viewportSize();
        if (!box || !viewport) return null;
        return Math.round(viewport.width - (box.x + box.width));
      },
      { timeout: 5_000 },
    )
    .toBe(0);

  // 缺陷回归点：抽屉展开后曾用 z-index 20 盖住自己的开关，
  // 点击落到了抽屉头部（elementFromPoint 命中 HEADER.ai-panel__head），开关再也点不到。
  const toggleOnTop = await aiToggle.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === element || element.contains(hit);
  });
  expect(toggleOnTop, '抽屉完全展开后仍必须让出开关，否则同一个开关点不到').toBe(true);

  // 第二次点同一个开关 → 抽屉收起（不是靠抽屉内的关闭按钮 / Esc）
  await aiToggle.click();
  await expect(aiToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(/AI 实时大纲/).first()).toBeHidden();
});

test('频道不存在：只出现一次「频道不存在」提示，且不重复拼「按提示处理后重试」', async ({ page }) => {
  await blockExternalNetwork(page);
  // 两个频道接口同口径 404（服务端契约），前端若在各处再提示一次就会重复
  await mockServerApis(page, { channelNotFound: true });
  await page.goto(watchUrl(MISSING_CHANNEL_ID));

  const notice = page.getByRole('status').filter({ hasText: '频道不存在' });
  await expect(notice.first()).toBeVisible({ timeout: 20_000 });
  await expect(notice, '同一句原因只能有一个提示位（不能状态条 + 提示条各说一遍）').toHaveCount(1);

  const sentence = (await notice.first().innerText()).trim();
  expect(sentence).toContain('频道不存在');
  // 服务端文案本身已含「请…重试」，前端不得再拼一次下一步
  expect(sentence.match(/重试/g) ?? [], `重复「重试」：${sentence}`).toHaveLength(1);
  expect(sentence).not.toContain('按提示处理');
  expect(sentence, '不能把上游原始故障文案当作频道不存在的原因').not.toContain('上游服务暂时不可用');

  const pageText = await page.evaluate(() => document.body.innerText);
  expect(pageText.match(/频道不存在/g) ?? [], '整页只应出现一次「频道不存在」').toHaveLength(1);
  expect(pageText, '不允许出现「按提示处理后重试」这类重复后缀').not.toContain('按提示处理');

  // 不谎报直播中（状态接口 404 时不应残留默认的直播态）
  await expect(page.getByText('直播中', { exact: false })).toHaveCount(0);
});

test('频道不存在：不冒充「未开始」空态，状态芯片不显示「未开始」，并给出「重新连接」', async ({
  page,
}) => {
  await blockExternalNetwork(page);
  await mockServerApis(page, { channelNotFound: true });

  // 统计频道接口被真实打过几次（用来证「重新连接」不是装饰按钮）
  let channelRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/channels/${MISSING_CHANNEL_ID}`) {
      channelRequests += 1;
    }
  });

  await page.goto(watchUrl(MISSING_CHANNEL_ID));

  const reconnect = page.getByRole('button', { name: '重新连接' });
  await expect(reconnect, '频道不存在时必须给出可执行的下一步（计划 §七：拉流失败要给重连）').toBeVisible({
    timeout: 20_000,
  });

  // 缺陷回归点 1：404 曾被当成「未开播」，播放区盖上「直播还没开始 / 讲师开播后本页自动播放」，
  // 观众会以为「讲师还没开播，再等等」，实际是这个频道号根本不存在。
  await expect(page.getByText('直播还没开始'), '频道不存在时不得显示未开播空态').toHaveCount(0);
  await expect(page.getByText(/讲师开播后本页自动播放/)).toHaveCount(0);

  // 缺陷回归点 2：状态芯片曾按默认值渲染「未开始」。
  const statusChip = page.locator('.status-bar__pill');
  await expect(statusChip).toBeVisible();
  await expect(statusChip, '状态取不到时不能谎报「未开始」').toContainText('加载失败');
  await expect(statusChip).not.toContainText('未开始');

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText, `整页不得出现「未开始」，实际全文：\n${bodyText}`).not.toContain('未开始');
  expect(bodyText, '整页不得出现未开播空态文案').not.toContain('直播还没开始');

  // 「重新连接」必须真的重试：点一次后再打一次频道接口（同时覆盖频道信息 + 直播状态两条）
  const before = channelRequests;
  await reconnect.click();
  await expect
    .poll(() => channelRequests, { timeout: 10_000, message: '重新连接必须重新请求频道信息' })
    .toBeGreaterThan(before);

  // 重试后仍是 404：继续停在错误态，不退回「未开始」空态
  await expect(statusChip).toContainText('加载失败');
  await expect(reconnect).toBeVisible();
});
