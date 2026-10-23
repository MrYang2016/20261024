/**
 * 验收契约来源：docs/execution-plan.md §十一 A 段 + CONTEXT.md D34
 *   - `apps/pusher/src/diagnostics/useMetricsRecorder.ts`（新增）：
 *     推流中每 **5 秒**采样一次 `{kbps, fps, dropFps, connection, at}`；**仅 `state === 'live'` 时采样**；
 *     停止推流后**停表并 flush**
 *   - §「十一补 Done when」第 14 条：`useMetricsRecorder.spec.ts`（5 秒一次、非 live 不采、停止 flush）
 *   - 用途（客户函第①条）：断了几秒、码率从多少掉到多少，要能变成可交付客户的客观证据
 *
 * ## 本文件固化的输入契约（计划只给了文件名与行为，没给签名 →
 * ## 按 `useDiagnostics` 的既有风格定形，已记进汇报「契约缺口」，实现请对齐这里）
 *
 * ```ts
 * useMetricsRecorder({
 *   session: Pick<PushSession, 'state' | 'stats' | 'connectionStatus'>,  // 只读这三个 ref
 *   getChannelId: () => string | null,   // 会话固化的频道号（null = 还没开播，不采）
 *   report?: (channelId: string, sample: MetricSample) => Promise<unknown> | unknown,
 *   now?: () => number,                  // 缺省 Date.now（假时钟能驱动）
 *   intervalMs?: number,                 // 缺省 5000
 * }) → { samples: Ref<MetricSample[]>, flush?: () => void | Promise<void> }
 * ```
 *
 * `MetricSample` 的 `at` 用 **ISO 字符串**（与服务端 /metrics 契约、CSV 第一列同口径），
 * 其余字段与 POST 契约同名同单位：`kbps`（kbps）、`fps`、`dropFps`、`connection`。
 *
 * 时间控制：`vi.useFakeTimers()` + `advanceTimersByTimeAsync`，不依赖真实计时器。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { PushState } from '../composables/usePushSession';
import type { PushConnectionStatus, PushStatsSnapshot } from '../transports/types';
import * as recorderModule from './useMetricsRecorder';

const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const CHANNEL_ID = '1000001';
/** D34：每 5 秒采样一次 */
const SAMPLE_INTERVAL_MS = 5_000;

interface MetricSample {
  kbps: number;
  fps: number;
  dropFps?: number;
  connection: string;
  at: string;
}

interface FakeSession {
  state: Ref<PushState>;
  stats: Ref<PushStatsSnapshot | null>;
  connectionStatus: Ref<PushConnectionStatus>;
}

type ReportLog = Array<{ channelId: string; sample: MetricSample }>;
type AnyFn = (...args: unknown[]) => unknown;

function resolveFactory(): AnyFn {
  const bag = recorderModule as unknown as Record<string, unknown>;
  for (const name of ['useMetricsRecorder', 'createMetricsRecorder', 'useMetricsSampler']) {
    const candidate = bag[name];
    if (typeof candidate === 'function') return candidate as AnyFn;
  }
  throw new Error(
    'apps/pusher/src/diagnostics/useMetricsRecorder.ts 需导出 useMetricsRecorder(options)',
  );
}

function fakeSession(
  state: PushState = 'live',
  stats: PushStatsSnapshot | null = {
    bitrateKbps: 800,
    fps: 15,
    width: 320,
    height: 180,
    at: T0,
  },
): FakeSession {
  return {
    state: ref<PushState>(state),
    stats: ref<PushStatsSnapshot | null>(stats),
    connectionStatus: ref<PushConnectionStatus>('connected'),
  };
}

interface RecorderOptions {
  session: FakeSession;
  getChannelId?: () => string | null;
  report?: (channelId: string, sample: MetricSample) => unknown;
}

interface RecorderHandle {
  samples?: Ref<MetricSample[]>;
  flush?: () => unknown;
}

/** 起一个 recorder（假时钟下） */
function startRecorder(options: RecorderOptions): {
  handle: RecorderHandle;
  session: FakeSession;
  reports: ReportLog;
  attempts: string[];
} {
  const reports: ReportLog = [];
  const attempts: string[] = [];
  const factory = resolveFactory();

  const session = options.session;
  const handle = factory({
    session,
    getChannelId: options.getChannelId ?? (() => CHANNEL_ID),
    report: (channelId: string, sample: MetricSample) => {
      attempts.push(channelId);
      const result = options.report ? options.report(channelId, sample) : undefined;
      if (options.report) return result;
      reports.push({ channelId, sample });
      return Promise.resolve({ channelId, stored: true, total: reports.length });
    },
    now: () => Date.now(),
  }) as RecorderHandle;

  return { handle, session, reports, attempts };
}

/** 推进假时钟并让 microtask 队列跑干净（上报是异步的） */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function millis(sample: MetricSample): number {
  return Date.parse(sample.at);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useMetricsRecorder — 仅 live 采样（D34）', () => {
  it('connecting / preparing / stopping / idle 都不采样', async () => {
    const { session, reports } = startRecorder({ session: fakeSession('connecting') });

    await advance(20_000);
    expect(reports, '连接中还没有上行数据，不能采样').toHaveLength(0);

    session.state.value = 'preparing';
    await advance(20_000);
    expect(reports, '准备中不能采样').toHaveLength(0);

    session.state.value = 'stopping';
    await advance(20_000);
    expect(reports, '停止中不能采样').toHaveLength(0);

    session.state.value = 'idle';
    await advance(20_000);
    expect(reports, '没开播不能采样').toHaveLength(0);
  });

  it('进入 live 后才开始采样，且采样只发生在 live 区间', async () => {
    const { session, reports } = startRecorder({ session: fakeSession('idle') });

    await advance(10_000);
    expect(reports).toHaveLength(0);

    session.state.value = 'live';
    await advance(10_000);
    expect(reports.length, 'live 10 秒至少要有 1~3 条采样').toBeGreaterThanOrEqual(1);
    expect(reports.length).toBeLessThanOrEqual(3);

    const liveCount = reports.length;
    session.state.value = 'idle';
    await advance(20_000);
    expect(reports.length, '停播之后不能再有采样').toBeLessThanOrEqual(liveCount + 1);
  });
});

describe('useMetricsRecorder — 5 秒一次（D34）', () => {
  it('5 秒未到不采、到 5 秒采一条、每满 5 秒再采一条（不按秒刷）', async () => {
    const { reports } = startRecorder({ session: fakeSession('live') });
    // 若实现在启动时立刻采一条，先把它算进基线（契约没禁止首采，但禁止高频率采）
    await advance(0);
    const base = reports.length;
    expect(base, '启动瞬间最多允许 1 条首采').toBeLessThanOrEqual(1);

    await advance(SAMPLE_INTERVAL_MS - 1);
    expect(reports.length - base, '差 1ms 到 5 秒不能采样').toBe(0);

    await advance(1);
    expect(reports.length - base, '刚好 5 秒必须采一条').toBe(1);

    await advance(SAMPLE_INTERVAL_MS);
    expect(reports.length - base, '第 10 秒再采一条').toBe(2);

    await advance(SAMPLE_INTERVAL_MS);
    expect(reports.length - base, '第 15 秒再采一条').toBe(3);
  });

  it('采样间隔不小于 5 秒（不会 1 秒一条地把缓冲刷爆）', async () => {
    const { reports } = startRecorder({ session: fakeSession('live') });

    await advance(30_000);

    expect(reports.length, '30 秒最多 7 条（6×5s + 可能的首采）').toBeLessThanOrEqual(7);
    const times = reports.map((entry) => millis(entry.sample));
    for (let index = 1; index < times.length; index += 1) {
      expect(
        times[index] - times[index - 1],
        `第 ${index} 条与上一条的间隔必须 ≥ 5 秒`,
      ).toBeGreaterThanOrEqual(SAMPLE_INTERVAL_MS - 1);
    }
  });

  it('采样内容来自当前实测统计（kbps / fps / connection / at）', async () => {
    const session = fakeSession('live');
    const { reports } = startRecorder({ session });

    session.stats.value = {
      bitrateKbps: 412,
      fps: 20,
      width: 1280,
      height: 720,
      at: T0,
    };
    session.connectionStatus.value = 'connected';

    await advance(SAMPLE_INTERVAL_MS);

    expect(reports.length).toBeGreaterThanOrEqual(1);
    const sample = reports[reports.length - 1].sample;

    expect(reports[0].channelId, '采样必须报到会话固化的频道号').toBe(CHANNEL_ID);
    expect(sample.kbps, 'kbps 用实测码率（不是编码目标码率）').toBe(412);
    expect(sample.fps).toBe(20);
    expect(sample.connection, 'connection 用实测连接态').toBe('connected');
    expect(sample.at, 'at 必须是 ISO 时间字符串（CSV 第一列）').toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(millis(sample), 'at 必须是本次采样时刻，不是 T0 克隆').toBeGreaterThan(T0);
  });

  it('没有实测统计（stats 为 null）时不编造数字', async () => {
    const { reports } = startRecorder({ session: fakeSession('live', null) });

    await advance(20_000);

    for (const { sample } of reports) {
      expect(
        sample.kbps,
        '拿不到实测统计就不该上报一条「0 kbps」的假采样（会被当成断流证据）',
      ).not.toBe(0);
    }
  });
});

describe('useMetricsRecorder — 停止时 flush 且不再上报（D34）', () => {
  it('停播时把最后一条统计补报出来，然后彻底停表', async () => {
    const session = fakeSession('live');
    const { handle, reports } = startRecorder({ session });

    await advance(11_000);
    expect(reports.length, '前置条件：live 11 秒至少 2 条采样').toBeGreaterThanOrEqual(2);

    const beforeStop = reports.length;
    session.state.value = 'idle';
    await advance(0);

    const afterStop = reports.length;
    expect(afterStop, '停播不允许丢数据（flush 最多补一条）').toBeLessThanOrEqual(beforeStop + 1);

    // 停播后时间继续走：一条都不能再冒出来
    await advance(60_000);
    expect(reports.length, '停表之后不能再上报（否则历史曲线会拖出一条假尾巴）').toBe(afterStop);

    // flush 若暴露成方法，必须可重复调用且幂等（不重复上报、不抛错）
    if (typeof handle.flush === 'function') {
      const beforeFlush = reports.length;
      await handle.flush();
      const afterFirstFlush = reports.length;
      expect(afterFirstFlush - beforeFlush, 'flush 最多补一条未上报的采样').toBeLessThanOrEqual(1);
      await handle.flush();
      expect(reports.length, '第二次 flush 必须幂等（不能重复上报）').toBe(afterFirstFlush);
    }
  });

  it('从 live 直接掉到 error 也按停止处理（不再采样）', async () => {
    const session = fakeSession('live');
    const { reports } = startRecorder({ session });

    await advance(6_000);
    const liveCount = reports.length;

    session.state.value = 'error';
    await advance(0);
    const afterError = reports.length;

    await advance(30_000);
    expect(reports.length, 'error 之后不再采样').toBe(afterError);
    expect(reports.length).toBeLessThanOrEqual(liveCount + 1);
  });
});

describe('useMetricsRecorder — 上报失败不抛、不阻塞采样', () => {
  it('report 同步抛错：不冒出未捕获异常，后续采样照常继续', async () => {
    const { attempts } = startRecorder({
      session: fakeSession('live'),
      report: () => {
        throw new Error('e2e: report boom');
      },
    });

    await expect(advance(20_000), '留痕失败不能把采样器打挂').resolves.toBeUndefined();
    expect(
      attempts.length,
      '上报失败后仍然每 5 秒尝试一次（留痕失败只影响证据，不影响采样节奏）',
    ).toBeGreaterThanOrEqual(3);
  });

  it('report 返回 rejected Promise：不产生未处理拒绝，后续采样照常继续', async () => {
    const { attempts } = startRecorder({
      session: fakeSession('live'),
      report: () => Promise.reject(new Error('e2e: network down')),
    });

    await expect(advance(20_000), '网络断了也不能让采样器崩').resolves.toBeUndefined();
    expect(attempts.length).toBeGreaterThanOrEqual(3);
  });
});
