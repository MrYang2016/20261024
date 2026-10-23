/**
 * 验收契约来源：CONTEXT.md **D38**（评审人 2026-10-23 实测缺陷）
 *
 * 真实缺陷：断网后诊断卡能报错；点【自动重连】失败后，自检条回落到「预检通过，可以开播」，
 * 与真实网络状态相反。根因不是某条规则算错，而是**预检没有任何网络证据**：
 *   1. 预检只读内存里的频道对象（`channel`），从不探测 `GET /api/health`；
 *   2. 修复先 `stop()` → `session.state === 'idle'`，`useDiagnostics` 在 idle 时无条件清空结论；
 *   3. 进入 `preparing` 又把 `failures` 清零，「再试一次 → 降低分辨率重推」的升级逻辑丢失。
 *
 * 本文件逐条锁 D38 的 5 项要求：
 *   ① 预检结论必须由一次真实网络探测支撑（探测失败即判「连不上服务器」）；
 *   ② 探测时机：载入频道后 / 修复结束后 / idle 态每 15 秒；
 *   ③ 探测**未知**时不得显示「预检通过」，显示「正在检查网络…」；
 *   ④ `session` 进入 `idle` 不得无条件清空当前结论（探测成功 + 会话不再失败才撤销）；
 *   ⑤ 进入 `preparing` 不得清空修复失败计数（D5 两次失败 → 降低分辨率重推）。
 *
 * ## 探测桩契约（计划没有冻结签名 → 本文件按下面方式注入；实现对齐其一即可）
 *
 * `useDiagnostics(options)` 新增一个「网络探测」option，名字取以下任一
 * （本文件**同时全部注入**，所以实现选哪个都能被驱动）：
 *
 *   `probeHealth` / `healthProbe` / `probe` / `checkHealth` / `probeNetwork`
 *
 * 签名 `() => Promise<boolean>`：
 *   - `resolve(true)` = 网络可达（= `GET /api/health` 200）；
 *   - `reject(...)`  = 网络不可达（= fetch 抛 TypeError）；
 *   - **promise 一直 pending** = 探测还没有结论（unknown，UI 必须说「正在检查网络…」）。
 *
 * 如果实现选择自己 `fetch('/api/health')` 而不是注入探测函数，本文件也把 `globalThis.fetch`
 * 换成了同一只桩（成功 = 200、失败 = reject、未知 = 永不 settle），两种接法都能被驱动。
 *
 * 时间：`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`，不依赖真实计时器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, ref, type ComputedRef, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { ChannelInfo } from '@live1024/shared';
import type { PushState } from '../composables/usePushSession';
import type { PushConnectionStatus, PushEncoding, PushStatsSnapshot } from '../transports/types';
import type { PushErrorInfo } from '../lib/errors';
import { useDiagnostics, type UseDiagnosticsResult } from './useDiagnostics';

/** 固定基准时刻：2026-10-23T10:00:00Z，所有时间都从这里推 */
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const CHANNEL_ID = '1000001';
const SIX_HOURS = 6 * 60 * 60 * 1000;

/** D38 ②：idle 态每 15 秒探测一次 */
const IDLE_PROBE_INTERVAL_MS = 15_000;

type ProbeMode = 'ok' | 'fail' | 'unknown';

interface ProbeControl {
  /** 探测结果开关：e2e / 单测随时改它，模拟断网与恢复 */
  mode: ProbeMode;
  /** 探测被真正调用了几次（断言「载入后探测」「idle 定时探测」用） */
  calls: number;
}

const wrappers: VueWrapper[] = [];

/** 建一只可控探测桩：成功 / 失败 / 一直没结论（pending） */
function createProbe(): { control: ProbeControl; probe: () => Promise<boolean> } {
  const control: ProbeControl = { mode: 'ok', calls: 0 };
  const probe = (): Promise<boolean> => {
    control.calls += 1;
    if (control.mode === 'fail') return Promise.reject(new Error('D38 桩：网络不可达'));
    if (control.mode === 'unknown') {
      return new Promise<boolean>(() => {
        /* 永不 settle：探测还没有结论 */
      });
    }
    return Promise.resolve(true);
  };
  return { control, probe };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/**
 * 若实现改成自己 fetch `/api/health`（而不是用注入的探测函数），这里保证它走同一只可控桩。
 * 计数也记在 `control.calls` 上：`waitForProbeCount` 不关心实现用的是哪种接法。
 */
function installHealthFetch(control: ProbeControl): void {
  vi.stubGlobal('fetch', (input: unknown) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string } | null)?.url ?? input);
    if (!url.includes('/api/health')) {
      return Promise.resolve(jsonResponse(200, {}));
    }
    control.calls += 1;
    if (control.mode === 'fail') {
      // 浏览器断网时 fetch 抛 TypeError，而不是拿到一个 5xx
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    if (control.mode === 'unknown') return new Promise(() => {});
    return Promise.resolve(jsonResponse(200, { ok: true, polyv: 'reachable' }));
  });
}

function channelFixture(): ChannelInfo {
  const stream = `${CHANNEL_ID}_d38`;
  return {
    channelId: CHANNEL_ID,
    name: 'D38 断网回归频道',
    watchUrl: `http://127.0.0.1:5174/?channelId=${CHANNEL_ID}`,
    template: 'alone',
    stream,
    push: {
      rtmpUrl: `rtmp://push-t2.videocc.net/recordf/${stream}?txSecret=d38&txTime=68F1A2B3`,
      webrtcUrl: `webrtc://push-t2.videocc.net/recordf/${stream}?txSecret=d38&txTime=68F1A2B3`,
      expiresAt: new Date(T0 + SIX_HOURS).toISOString(),
    },
  };
}

interface FakeSession {
  state: Ref<PushState>;
  status: Ref<PushState>;
  error: Ref<PushErrorInfo | null>;
  errorMessage: ComputedRef<string | null>;
  connectionStatus: Ref<PushConnectionStatus>;
  stats: Ref<PushStatsSnapshot | null>;
  startedAt: Ref<number | null>;
  elapsedMs: Ref<number>;
  encoding: Ref<PushEncoding | null>;
  isBusy: ComputedRef<boolean>;
  canStart: ComputedRef<boolean>;
  canStop: ComputedRef<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  clearError: () => void;
}

interface HarnessOptions {
  probeMode?: ProbeMode;
  state?: PushState;
  /** 一键修复的执行侧：抛错 = 修复失败（D22 / ④ / ⑤） */
  runFix?: () => Promise<void>;
  channel?: ChannelInfo | null;
}

interface Harness {
  diag: UseDiagnosticsResult;
  control: ProbeControl;
  session: FakeSession;
  wrapper: VueWrapper;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const { control, probe } = createProbe();
  control.mode = options.probeMode ?? 'ok';
  installHealthFetch(control);

  const initialState = options.state ?? 'idle';
  const state = ref<PushState>(initialState);
  const connectionStatus = ref<PushConnectionStatus>(
    initialState === 'live' ? 'connected' : 'disconnected',
  );
  const stats = ref<PushStatsSnapshot | null>(null);
  const error = ref<PushErrorInfo | null>(null);

  const session: FakeSession = {
    state,
    status: state,
    error,
    errorMessage: computed(() => (error.value ? error.value.text : null)),
    connectionStatus,
    stats,
    startedAt: ref<number | null>(null),
    elapsedMs: ref(0),
    encoding: ref<PushEncoding | null>(null),
    isBusy: computed(() => state.value === 'preparing' || state.value === 'connecting'),
    canStart: computed(() => state.value === 'idle' || state.value === 'error'),
    canStop: computed(() => state.value === 'live'),
    start: async () => undefined,
    stop: async () => undefined,
    clearError: () => undefined,
  };

  const channel = ref<ChannelInfo | null>(
    options.channel === undefined ? channelFixture() : options.channel,
  );
  const mediaError = ref<PushErrorInfo | null>(null);
  const stream = ref<MediaStream | null>(null);
  const runFix = options.runFix ?? vi.fn(async () => undefined);

  let result: UseDiagnosticsResult | null = null;
  const wrapper = mount(
    defineComponent({
      setup() {
        result = useDiagnostics({
          session: session as unknown as Parameters<typeof useDiagnostics>[0]['session'],
          channel,
          channelError: ref<PushErrorInfo | null>(null),
          mediaError,
          stream,
          getVideoElement: () => null,
          getAudioDeviceLabel: () => null,
          getChannelId: () => CHANNEL_ID,
          runFix,
          report: async () => ({ channelId: CHANNEL_ID, stored: true, total: 1 }),
          demoFault: () => null,
          now: () => Date.now(),
          // D38：探测函数可能被实现取以下任一 option 名（见文件头契约）
          probeHealth: probe,
          healthProbe: probe,
          probe,
          checkHealth: probe,
          probeNetwork: probe,
        } as Parameters<typeof useDiagnostics>[0]);
        return () => null;
      },
    }),
  );
  wrappers.push(wrapper);

  expect(result, 'useDiagnostics 必须在 setup 期返回结果').not.toBeNull();
  return { diag: result as unknown as UseDiagnosticsResult, control, session, wrapper };
}

/** 推进假时钟并让 microtask 队列跑干净（探测与上报都是异步的） */
async function tick(ms = 1_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

/**
 * 一直推进到探测至少发生 `expected` 次（探测周期由实现决定：载入后 / 修复后 / idle 每 15 秒）：
 * 断言不绑定具体节拍，只绑定「探测真的发生了」。
 */
async function waitForProbeCount(
  control: ProbeControl,
  expected: number,
  maxMs = IDLE_PROBE_INTERVAL_MS * 3,
): Promise<void> {
  let elapsed = 0;
  while (control.calls < expected && elapsed < maxMs) {
    await vi.advanceTimersByTimeAsync(250);
    elapsed += 250;
  }
  // 再给结论一次 1s tick 把探测结果落成 UI 结论
  await tick(1_000);
}

/** D3 类结论：id 是 D3，或文案明确在说「连不上 / 网络」（实现可能把探测失败挂在新信号上） */
function isD3Like(verdict: UseDiagnosticsResult['verdict']['value']): boolean {
  if (!verdict) return false;
  return verdict.id === 'D3' || /连不上|网络/.test(`${verdict.reason}${verdict.measured}`);
}

/** 每条结论都必须带一个能执行的下一步（D22） */
function expectHasNextStep(verdict: UseDiagnosticsResult['verdict']['value']): void {
  expect(verdict, '必须有结论').toBeTruthy();
  expect(verdict?.action, '结论必须带一个下一步（D22）').toBeTruthy();
  expect(String(verdict?.action.label ?? '').trim().length, '下一步必须有按钮文案').toBeGreaterThan(0);
}

function stats(bitrateKbps: number, at = Date.now()): PushStatsSnapshot {
  return { bitrateKbps, fps: 15, width: 320, height: 180, at };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('D38 ③ 探测未知：不得说「预检通过」', () => {
  it('探测一直没结论时，结论必须是「正在检查网络…」一类的检查中态，status 不能是 ok', async () => {
    const { diag } = createHarness({ probeMode: 'unknown' });
    await tick(200);

    expect(diag.conclusion.value).not.toBe('预检通过，可以开播');
    expect(
      diag.conclusion.value,
      `探测未知时只能说「正在检查网络…」，实际：${diag.conclusion.value}`,
    ).toMatch(/正在检查网络|正在检测网络|正在检查|检查中/);
    expect(diag.status.value, '探测未知时不能显示绿色 ok').not.toBe('ok');
    expect(diag.verdict.value, '未知不是异常：不应该急着给 verdict').toBeNull();
  });
});

describe('D38 ① 探测失败：必须给 D3 类结论 + 下一步', () => {
  it('首次载入就连不上：不得停在「预检通过」，要给「连不上服务器」类结论与一键下一步', async () => {
    const { diag, control } = createHarness({ probeMode: 'fail' });
    // 首次失败允许立即判定；这里等到探测确实发生过（>0）再断言，不裁定「必须第 1 次就红」
    await waitForProbeCount(control, 1);

    expect(diag.conclusion.value).not.toBe('预检通过，可以开播');
    expect(diag.status.value).not.toBe('ok');
    expect(isD3Like(diag.verdict.value), '探测失败必须给 D3 类「连不上服务器」结论').toBe(true);
    expectHasNextStep(diag.verdict.value);
    expect(diag.conclusion.value).toMatch(/连不上|网络/);
  });

  it('单次探测失败也不能说「预检通过」；连续两次失败必须升级为 danger', async () => {
    const { diag, control } = createHarness({ probeMode: 'ok' });
    await tick(1_200);
    expect(diag.conclusion.value, '有证据的成功态才允许说预检通过').toBe('预检通过，可以开播');
    expect(diag.status.value).toBe('ok');

    const baseline = control.calls;
    control.mode = 'fail';

    // 第 1 次失败：还没到「连续两次」的防抖门槛，但也绝不能是「预检通过」
    await waitForProbeCount(control, baseline + 1);
    expect(
      diag.conclusion.value,
      '只要有探测失败，就不能再宣称「预检通过」（D38 ①：结论必须有证据）',
    ).not.toBe('预检通过，可以开播');
    expect(diag.status.value).not.toBe('ok');

    // 第 2 次连续失败：必须判「连不上服务器」
    await waitForProbeCount(control, baseline + 2);
    expect(diag.status.value, '连续两次探测失败必须变红').toBe('danger');
    expect(isD3Like(diag.verdict.value)).toBe(true);
    expectHasNextStep(diag.verdict.value);
  });
});

describe('D38 ④ idle 不得无条件清空结论', () => {
  it('修复失败后进入 idle：结论保留（不回落「预检通过」）；探测恢复 ok 才撤销', async () => {
    let goIdle: (() => void) | null = null;
    const runFix = vi.fn(async () => {
      // 真实链路：一键修复先 stop()（→ idle）再 start()，start 失败 → 修复失败
      goIdle?.();
      throw new Error('重连失败：网络不可达');
    });

    const { diag, control, session } = createHarness({ probeMode: 'fail', runFix });
    goIdle = () => {
      session.state.value = 'idle';
    };

    await waitForProbeCount(control, 1);
    expect(diag.verdict.value, '前置：断网时必须先有结论').toBeTruthy();
    const retainedConclusion = diag.conclusion.value;

    await diag.runFix();
    await tick(1_000);
    expect(session.state.value).toBe('idle');
    expect(diag.attempts.value, '修复失败要把次数 +1（「再试一次」的依据）').toBeGreaterThanOrEqual(1);

    // idle 下继续跑 tick（旧实现会在这里清空结论 → 回落「预检通过」）
    await tick(2_000);
    expect(
      diag.conclusion.value,
      'idle 不得无条件清空当前结论：断网结论必须保留',
    ).toBe(retainedConclusion);
    expect(diag.conclusion.value).not.toBe('预检通过，可以开播');
    expect(diag.verdict.value, 'idle 后结论仍在').toBeTruthy();
    expect(diag.status.value).not.toBe('ok');

    // 只有探测成功之后，才允许撤销
    const baseline = control.calls;
    control.mode = 'ok';
    await waitForProbeCount(control, baseline + 1);
    await tick(2_000);
    expect(diag.conclusion.value, '网络恢复且探测成功后才允许回「预检通过，可以开播」').toBe(
      '预检通过，可以开播',
    );
    expect(diag.verdict.value).toBeNull();
    expect(diag.status.value).toBe('ok');
  });
});

describe('D38 ② 探测时机', () => {
  it('idle 态每 15 秒探测一次（31 秒内至少 3 次：载入 1 次 + 15s + 30s）', async () => {
    const { control } = createHarness({ probeMode: 'ok' });
    await tick(1_000);
    expect(control.calls, '载入频道后必须探测一次').toBeGreaterThanOrEqual(1);

    await tick(31_000);
    expect(
      control.calls,
      `idle 态必须每 15 秒补一次探测（D38 ②），实际 ${control.calls} 次`,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('D38 ⑤ 进入 preparing 不得清空修复失败计数', () => {
  it('D5 连续两次修复失败后进入 preparing：计数保留，下一步仍是「降低分辨率重推」', async () => {
    const runFix = vi.fn(async () => {
      throw new Error('自动重连失败');
    });
    const { diag, session } = createHarness({ probeMode: 'ok', state: 'live', runFix });

    // 先给一条正常统计（峰值 800kbps → D5 下限 max(150, 320) = 320kbps）
    session.stats.value = stats(800);
    await tick(1_000);

    // 掉底到 100kbps，持续 5 秒 → D5
    session.stats.value = stats(100);
    await tick(6_000);
    expect(diag.verdict.value?.id, '前置：要先命中 D5').toBe('D5');

    await diag.runFix();
    await tick(1_000);
    expect(diag.attempts.value, '第一次修复失败 → 1 次').toBe(1);
    expect(diag.verdict.value?.action.label, '第一次失败后是「再试一次」').toBe('再试一次');

    await diag.runFix();
    await tick(1_000);
    expect(diag.attempts.value, '第二次修复失败 → 2 次').toBe(2);
    expect(diag.verdict.value?.action.label, '两次失败后升级为「降低分辨率重推」').toBe(
      '降低分辨率重推',
    );

    // 修复动作的最后一拍是 start() → 会话进入 preparing（真实链路里 stop 先回 idle，再 preparing）。
    // 这里多推进 6 秒让 D5 重新攒满 hold：断言不绑定「实现是否在 preparing 冻结 verdict」，
    // 只绑定 D38 ⑤ 的契约——失败计数跨 preparing 不能被清掉。
    session.state.value = 'preparing';
    await tick(6_000);
    expect(diag.verdict.value?.id, '前置：D5 仍然命中').toBe('D5');

    // 在 preparing 态再来一次修复失败：
    //   计数保留 → 3 次（升级动作仍是「降低分辨率重推」）；
    //   计数被清 → 1 次（退回「再试一次」，升级逻辑丢失）。
    await diag.runFix();
    await tick(1_000);

    expect(
      diag.attempts.value,
      '进入 preparing 不得清空修复失败计数（D38 ⑤）：必须从 2 继续累加，不能回到 1',
    ).toBe(3);
    expect(diag.verdict.value?.id).toBe('D5');
    expect(diag.verdict.value?.action.label, '计数保留 → 仍是「降低分辨率重推」').toBe(
      '降低分辨率重推',
    );
  });
});
