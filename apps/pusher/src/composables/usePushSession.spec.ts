/**
 * 验收契约来源：docs/execution-plan.md
 *   - §六「状态机（硬约束）」：`idle → preparing → connecting → live → stopping → idle`，另有 `error`。
 *     `start` 只允许在 `idle`；`stop` 必须 await 完成后才回到 `idle`。
 *   - §Done when 第 5 条：idle 下 start 合法；live 下再 start 被拒；stopping 期间 start 被拒；stop 完成后才回 idle。
 *   - CONTEXT.md 实测：`-12 streamurl authentication failed` 真实成因是上一次 stopPush 未释放就 startPush 的会话竞态
 *     → 所以「stopping 期间禁止 start」这条断言是本需求的核心回归点。
 *   - docs/test-results.md §4.2 第 3 条（本轮缺陷修复）：停止后指标条残留上一次会话的码率/帧率/画面。
 *     期望行为 = stop await 完成后 `stats` 清空，指标条回到占位符「—」（不能显示假数字/旧数字）。
 *
 * 约定的实现位置与用法：
 *   apps/pusher/src/composables/usePushSession.ts → export function usePushSession(...)
 *   transport 来自 apps/pusher/src/transports/（PushTransport: start(url, stream) / stop() / getStats()）
 *   本文件对构造参数形态与状态字段名做了容错（见 createSession / readStatus），断言的是行为，不是实现形状。
 */
import { describe, expect, it, vi } from 'vitest';
import { usePushSession } from './usePushSession';
import { usePushStats } from './usePushStats';
import type { PushStatsSnapshot, PushTransportObserver } from '../transports/types';

const PUSH_URL = 'webrtc://push-t2.videocc.net/recordf/e2e-stream?txSecret=a&txTime=b';
const FORWARD_STATES = ['preparing', 'connecting', 'live'];

interface Gate<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function gate<T = void>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 每次 start/stop 都给一个新的可控 Promise，让测试能精确停在 stopping / connecting 上。 */
function createTransport() {
  const startGates: Gate[] = [];
  const stopGates: Gate[] = [];
  let observer: PushTransportObserver = {};

  const transport = {
    start: vi.fn((_url?: string, _stream?: unknown) => {
      const g = gate();
      startGates.push(g);
      return g.promise;
    }),
    stop: vi.fn(() => {
      const g = gate();
      stopGates.push(g);
      return g.promise;
    }),
    getStats: vi.fn(() => ({})),
    // 真实现（WebRtcTxTransport）通过 setObserver 上报 SDK 统计；测试用它模拟「统计已回报」
    setObserver: vi.fn((next: PushTransportObserver) => {
      observer = next;
    }),
  };

  return {
    transport,
    startGates,
    stopGates,
    emitStats(snapshot: PushStatsSnapshot) {
      observer.onStats?.(snapshot);
    },
    resolveStart(index = startGates.length - 1) {
      startGates[index]?.resolve(undefined as never);
    },
    rejectStart(index = startGates.length - 1, reason: unknown = new Error('push failed')) {
      startGates[index]?.reject(reason);
    },
    resolveStop(index = stopGates.length - 1) {
      stopGates[index]?.resolve(undefined as never);
    },
  };
}

type Transport = ReturnType<typeof createTransport>['transport'];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** settle：不关心 resolve/reject 与否，只等它落地（「被拒」可以是 reject，也可以是 resolve(false) 的空操作）。 */
async function settle(run: () => unknown): Promise<'resolved' | 'rejected'> {
  try {
    await run();
    return 'resolved';
  } catch {
    return 'rejected';
  }
}

/**
 * 同时满足两种可能的构造形态：
 *   usePushSession(transport)          → 参数本身就是 transport（对象上有 start/stop/getStats）
 *   usePushSession({ transport, ... }) → 参数上有 transport 字段
 */
function createSession(transport: Transport, extra: Record<string, unknown> = {}): Record<string, any> {
  const arg = Object.assign({}, transport, {
    transport,
    pushUrl: PUSH_URL,
    url: PUSH_URL,
    ...extra,
  });
  const session = (usePushSession as unknown as (options: unknown) => Record<string, any>)(arg);
  expect(session, 'usePushSession 必须返回会话对象（含 start / stop 与状态）').toBeTruthy();
  return session;
}

/** 状态字段名容错：status / state / phase / pushStatus，且支持 Ref 或普通值。 */
function readStatus(session: Record<string, any>): string {
  const raw =
    session.status ?? session.state ?? session.phase ?? session.pushStatus ?? session.statusRef;
  const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  return String(value);
}

function startCallCount(transport: Transport): number {
  return transport.start.mock.calls.length;
}

describe('usePushSession — 推流状态机', () => {
  it('初始状态为 idle', () => {
    const { transport } = createTransport();
    const session = createSession(transport);

    expect(readStatus(session)).toBe('idle');
  });

  it('idle 下 start 合法：先进入连接前置态，transport 成功后才是 live', async () => {
    const { transport, resolveStart } = createTransport();
    const session = createSession(transport);

    const starting = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();

    // 传输层还没成功 → 不能已经宣称 live（计划：connecting → live 由推流成功驱动）
    const pendingStatus = readStatus(session);
    expect(FORWARD_STATES).toContain(pendingStatus);
    expect(pendingStatus).not.toBe('live');
    expect(startCallCount(transport)).toBe(1);

    resolveStart();
    await starting;
    await flush();

    expect(readStatus(session)).toBe('live');
  });

  it('live 下再 start 被拒：状态保持 live，传输层不会被二次启动', async () => {
    const { transport, resolveStart } = createTransport();
    const session = createSession(transport);

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    resolveStart();
    await first;
    await flush();
    expect(readStatus(session)).toBe('live');

    const callsBefore = startCallCount(transport);
    await settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();

    expect(startCallCount(transport), 'live 下 start 不能再次调用 transport.start').toBe(callsBefore);
    expect(readStatus(session)).toBe('live');
  });

  it('stop：立刻进入 stopping，await 完成之后才回 idle', async () => {
    const { transport, resolveStart, resolveStop } = createTransport();
    const session = createSession(transport);

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    resolveStart();
    await first;
    await flush();

    const stopping = settle(() => session.stop());
    await flush();

    expect(readStatus(session), 'stop 调用后必须先停在 stopping').toBe('stopping');
    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(readStatus(session), 'transport.stop 未完成时不能回 idle').not.toBe('idle');

    resolveStop();
    await stopping;
    await flush();

    expect(readStatus(session)).toBe('idle');
  });

  it('stopping 期间 start 被拒（-12 竞态回归点）：传输层不重启，状态仍是 stopping', async () => {
    const { transport, resolveStart, resolveStop } = createTransport();
    const session = createSession(transport);

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    resolveStart();
    await first;
    await flush();

    const stopping = settle(() => session.stop());
    await flush();
    expect(readStatus(session)).toBe('stopping');

    const callsBefore = startCallCount(transport);
    await settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();

    expect(startCallCount(transport), 'stopping 期间 start 不能调用 transport.start').toBe(
      callsBefore,
    );
    expect(readStatus(session)).toBe('stopping');

    resolveStop();
    await stopping;
    await flush();
  });

  it('stop 完成后可以再次 start（防竞态守卫不能把状态机锁死）', async () => {
    const { transport, resolveStart, resolveStop } = createTransport();
    const session = createSession(transport);

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    resolveStart(0);
    await first;
    await flush();

    const stopping = settle(() => session.stop());
    await flush();
    resolveStop(0);
    await stopping;
    await flush();
    expect(readStatus(session)).toBe('idle');

    const second = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    expect(startCallCount(transport), '回到 idle 后 start 必须能真的打到传输层').toBe(2);

    resolveStart(1);
    await second;
    await flush();
    expect(readStatus(session)).toBe('live');
  });

  it('传输层 start 失败 → 进入 error 态，不谎报 live', async () => {
    const { transport, rejectStart } = createTransport();
    const session = createSession(transport);

    const starting = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    rejectStart();
    await starting;
    await flush();

    const status = readStatus(session);
    expect(status).toBe('error');
  });
});

describe('usePushSession — 会话回调（评审 W5：push-session 上报的触发点）', () => {
  it('进入 live 时调 onLive；stop 完成回 idle 后调 onIdle（各自只调一次）', async () => {
    const { transport, resolveStart, resolveStop } = createTransport();
    const onLive = vi.fn();
    const onIdle = vi.fn();
    const session = createSession(transport, { onLive, onIdle });

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    expect(onLive, '传输层还没成功前不能上报 started').not.toHaveBeenCalled();

    resolveStart();
    await first;
    await flush();
    expect(onLive, '进入 live 必须上报一次 started').toHaveBeenCalledTimes(1);

    const stopping = settle(() => session.stop());
    await flush();
    expect(onIdle, 'stop 还没完成（传输层未释放）时不能提前报 stopped').not.toHaveBeenCalled();

    resolveStop();
    await stopping;
    await flush();
    expect(onIdle, '回到 idle 必须上报一次 stopped').toHaveBeenCalledTimes(1);
  });

  it('start 失败进 error 时不调 onLive（不能把失败会话报成推流中）', async () => {
    const { transport, rejectStart } = createTransport();
    const onLive = vi.fn();
    const onIdle = vi.fn();
    const session = createSession(transport, { onLive, onIdle });

    const starting = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    rejectStart();
    await starting;
    await flush();

    expect(readStatus(session)).toBe('error');
    expect(onLive, '开播失败不能让服务端认为在推流').not.toHaveBeenCalled();
    expect(onIdle, '开播失败没进入过 live，不需要补报 stopped').not.toHaveBeenCalled();
  });
});

describe('usePushSession — 停止后指标清理（指标条不残留上次统计）', () => {
  it('stop await 完成 → stats 清空，码率/帧率/画面回到占位符', async () => {
    const { transport, resolveStart, resolveStop, emitStats } = createTransport();
    const session = createSession(transport);
    const view = usePushStats(session as unknown as Parameters<typeof usePushStats>[0]);

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    resolveStart();
    await first;
    await flush();
    expect(readStatus(session)).toBe('live');

    // SDK 通过 onStatisticsUpdate 回报一次实测统计（对应真实链路的 372kbps / 20fps / 640×480）
    emitStats({ bitrateKbps: 372, fps: 20, width: 640, height: 480, at: Date.now() });
    await flush();

    expect(session.stats.value, '开播中 SDK 回报的统计必须落到 session.stats').not.toBeNull();
    expect(view.bitrateText.value).toBe('372 kbps');
    expect(view.fpsText.value).toBe('20 fps');
    expect(view.resolutionText.value).toBe('640×480');
    expect(view.hasLiveStats.value).toBe(true);

    const stopping = settle(() => session.stop());
    await flush();
    resolveStop();
    await stopping;
    await flush();

    expect(readStatus(session)).toBe('idle');
    expect(
      session.stats.value,
      'stop 完成后必须清空上一次会话的统计（缺陷：停止后仍显示 372kbps / 20fps / 640×480）',
    ).toBeNull();
    expect(view.bitrateText.value, '停止后码率不能再显示上次的数字').toBe('—');
    expect(view.fpsText.value).toBe('—');
    expect(view.resolutionText.value).toBe('—');
    expect(view.hasLiveStats.value).toBe(false);
  });

  it('再次 start 时旧的统计不会重现（第二次会话从空统计开始）', async () => {
    const { transport, resolveStart, resolveStop, emitStats } = createTransport();
    const session = createSession(transport);

    const first = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    resolveStart(0);
    await first;
    await flush();
    emitStats({ bitrateKbps: 372, fps: 20, width: 640, height: 480, at: Date.now() });
    await flush();

    const stopping = settle(() => session.stop());
    await flush();
    resolveStop(0);
    await stopping;
    await flush();
    expect(session.stats.value).toBeNull();

    const second = settle(() => session.start(PUSH_URL, {} as MediaStream));
    await flush();
    expect(session.stats.value, '第二次会话在拿到新统计前必须是空值').toBeNull();
    resolveStart(1);
    await second;
    await flush();
    expect(readStatus(session)).toBe('live');
    expect(session.stats.value, '没有新统计回报时不能沿用上一场的数字').toBeNull();
  });
});
