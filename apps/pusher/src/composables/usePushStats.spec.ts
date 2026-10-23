/**
 * 验收契约来源：docs/execution-plan.md
 *   - Done when 第 11 条（D18）：指标条「画面」在**无实测统计**时必须显示 `—`，
 *     不得出现固定的 `1280×720`（编码参数）；有统计时显示统计里的 width×height。
 *   - §六「指标条」：SDK 未暴露码率/帧率时降级为「编码参数 + 推流时长 + 上行连接状态」，
 *     并在 UI 上**不显示假数据**。
 *   - CONTEXT.md D18：拿到实测统计前一律显示 `—`，禁止用编码参数冒充实测值。
 *   - 评审 C2：`usePushStats.resolutionText` 曾在 live 且 stats 为空时回落到
 *     `formatResolution(encoding.width, encoding.height)`（即 1280×720），正是计划禁止的假数字。
 *
 * 断言只看「视图层输出」，不依赖统计对象怎么来的：用一个最小 session 桩喂 usePushStats。
 */
import { describe, expect, it } from 'vitest';
import { computed, ref, shallowRef } from 'vue';
import { usePushStats } from './usePushStats';
import type { PushSession, PushState } from './usePushSession';
import type { PushConnectionStatus, PushStatsSnapshot } from '../transports/types';

const PLACEHOLDER = '—';
/** DEFAULT_ENCODING 的固定编码参数：它只能出现在「目标编码参数」脚注里，不能冒充实测「画面」 */
const ENCODING_RESOLUTION = '1280×720';

function createSession(initialState: PushState = 'idle') {
  const state = ref<PushState>(initialState);
  const stats = shallowRef<PushStatsSnapshot | null>(null);
  const connectionStatus = ref<PushConnectionStatus>('disconnected');

  const session = {
    state,
    status: state,
    error: ref(null),
    errorMessage: computed(() => null),
    connectionStatus,
    stats,
    startedAt: ref<number | null>(null),
    elapsedMs: ref(0),
    isBusy: computed(() => false),
    canStart: computed(() => true),
    canStop: computed(() => state.value === 'live'),
    start: async () => undefined,
    stop: async () => undefined,
    clearError: () => undefined,
  } as unknown as PushSession;

  return { session, state, stats, connectionStatus };
}

describe('usePushStats.resolutionText — 画面必须是实测值，未拿到前是占位符（D18）', () => {
  it('live 且还没有统计回报：显示占位符 —，不得返回编码参数 1280×720', () => {
    const { session, state, stats } = createSession('live');
    const view = usePushStats(session);

    expect(stats.value).toBeNull();
    expect(state.value).toBe('live');

    expect(
      view.resolutionText.value,
      '开播后首帧统计回报前，指标条「画面」必须是占位符（评审 C2：曾显示 1280×720）',
    ).toBe(PLACEHOLDER);
    expect(view.resolutionText.value).not.toBe(ENCODING_RESOLUTION);
    expect(view.resolutionText.value, '「画面」不能出现任何形如 宽×高 的假值').not.toContain('×');
    expect(view.hasLiveStats.value, '没有统计时 hasLiveStats 必须是 false').toBe(false);
  });

  it('live 且统计回报 640×480：显示统计里的 width×height（不是编码参数）', () => {
    const { session, stats } = createSession('live');
    const view = usePushStats(session);

    stats.value = { bitrateKbps: 372, fps: 20, width: 640, height: 480, at: Date.now() };

    expect(view.resolutionText.value).toBe('640×480');
    expect(view.hasLiveStats.value).toBe(true);
  });

  it('统计回报但缺尺寸（width/height 为 null）：仍然显示占位符，不拿编码参数顶替', () => {
    const { session, stats } = createSession('live');
    const view = usePushStats(session);

    stats.value = { bitrateKbps: 800, fps: 15, width: null, height: null, at: Date.now() };

    expect(view.resolutionText.value, '实测尺寸缺失时也必须显示 —，不能回落编码参数').toBe(PLACEHOLDER);
  });

  it('未开播（idle）：显示占位符；编码参数只出现在「目标编码参数」脚注里', () => {
    const { session } = createSession('idle');
    const view = usePushStats(session);

    expect(view.resolutionText.value).toBe(PLACEHOLDER);
    expect(view.encodingText.value, '编码参数仍要有自己的展示位（脚注）').toMatch(
      /^\d+×\d+ · \d+ fps · \d+ kbps$/,
    );
  });

  it('编码参数跟随实际采集设置（D18 前半：不再固定 720p）', () => {
    const { session } = createSession('idle');
    const captureSettings = ref({ width: 640, height: 480, frameRate: 24 });
    const view = usePushStats(session, captureSettings);

    expect(view.encodingText.value, '编码参数的分辨率/帧率必须来自 track.getSettings()').toContain('640×480');
    expect(view.encodingText.value).toContain('24 fps');
  });

  it('统计里的尺寸随 SDK 每次回报更新（讲师看到的就是最新实测值）', () => {
    const { session, stats } = createSession('live');
    const view = usePushStats(session);

    stats.value = { bitrateKbps: 800, fps: 15, width: 320, height: 180, at: Date.now() };
    expect(view.resolutionText.value).toBe('320×180');

    stats.value = { bitrateKbps: 900, fps: 16, width: 1280, height: 720, at: Date.now() };
    expect(view.resolutionText.value).toBe('1280×720');
  });

  it('停止后统计清空即回到占位符（不残留上一场的实测画面尺寸）', () => {
    const { session, state, stats } = createSession('live');
    const view = usePushStats(session);

    stats.value = { bitrateKbps: 372, fps: 20, width: 640, height: 480, at: Date.now() };
    expect(view.resolutionText.value).toBe('640×480');

    state.value = 'idle';
    stats.value = null;
    expect(view.resolutionText.value).toBe(PLACEHOLDER);
  });
});
