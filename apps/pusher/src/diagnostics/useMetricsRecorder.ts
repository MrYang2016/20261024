import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
  DIAGNOSTIC_STATS_STALE_MS,
  METRICS_HISTORY_LIMIT,
  METRICS_SAMPLE_INTERVAL_MS,
  type MetricSample,
} from '@live1024/shared';
import type { PushSession } from '../composables/usePushSession';

export interface UseMetricsRecorderOptions {
  /** 推流会话：只读 state / stats / connectionStatus 三个 ref（不依赖整个 PushSession 契约） */
  session: Pick<PushSession, 'state' | 'stats' | 'connectionStatus'>;
  /** 上报用的频道号（会话固化的那个） */
  getChannelId?: () => string | null;
  /** 同上，Ref 形态（二选一） */
  channelId?: Ref<string | null> | (() => string | null);
  /** 上报一条采样（App 提供）；失败不打扰讲师，只影响证据留痕 */
  report?: (channelId: string, sample: MetricSample) => Promise<unknown>;
  /** 采样间隔（单测可调小；缺省 5 秒，D34） */
  intervalMs?: number;
  /** 时钟（单测可注入假时钟） */
  now?: () => number;
}

export interface MetricsRecorder {
  /** 本场本地镜像（服务端读不到时抽屉仍能导出） */
  samples: Ref<MetricSample[]>;
  /** 立即采一条（正常由 5 秒定时器驱动，这里给自检 / 演示用） */
  sample: () => MetricSample | null;
  /** 停表并把最后一条采样冲出去（停止推流时调用） */
  flush: () => void;
}

/**
 * 指标时间序列采集（D34）：推流中每 **5 秒**一条 `{kbps, fps, dropFps, connection, at}`。
 *
 * 三条口径：
 * - **只在 `live` 采样**：连接中 / 停止后采到的都是没有意义的值；
 * - **统计过期就当没有**：10 秒没更新还拿旧码率当实测值会误导客户（与诊断卡同一份
 *   `DIAGNOSTIC_STATS_STALE_MS`）；
 * - **上报失败只 warn**：证据链断了不能影响推流主链路（与 D23 诊断留痕同一原则）。
 */
export function useMetricsRecorder(options: UseMetricsRecorderOptions): MetricsRecorder {
  const clock = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? METRICS_SAMPLE_INTERVAL_MS;
  const samples = ref<MetricSample[]>([]);

  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const resolveChannelId = (): string | null => {
    if (options.getChannelId) return options.getChannelId();
    const source = options.channelId;
    if (typeof source === 'function') return source();
    return source?.value ?? null;
  };

  /** 采一条：拿不到实测值就写 null（不拿编码参数冒充，D18） */
  function sample(): MetricSample | null {
    if (disposed) return null;
    const now = clock();
    const stats = options.session.stats.value;
    const fresh = stats && now - stats.at <= DIAGNOSTIC_STATS_STALE_MS ? stats : null;
    const item: MetricSample = {
      kbps: fresh?.bitrateKbps ?? null,
      fps: fresh?.fps ?? null,
      dropFps: fresh?.dropFps ?? null,
      connection: options.session.connectionStatus.value,
      at: new Date(now).toISOString(),
    };
    samples.value = [...samples.value, item].slice(-METRICS_HISTORY_LIMIT);
    void report(item);
    return item;
  }

  async function report(item: MetricSample): Promise<void> {
    const channelId = resolveChannelId();
    if (!channelId || !options.report) return;
    try {
      await options.report(channelId, item);
    } catch (error) {
      // 留痕失败不影响推流：只 warn，不抛、不打搅讲师
      console.warn('[metrics] 指标上报失败，本次采样只留在本地', error);
    }
  }

  function start(): void {
    if (timer !== null || disposed) return;
    timer = setInterval(tick, intervalMs);
  }

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  /** 定时器回调：非 live 不采样（防止停止过程中的最后几拍写出假数据） */
  function tick(): void {
    if (options.session.state.value !== 'live') return;
    sample();
  }

  /** 停表 + 冲最后一条：停止推流那一刻的码率/连接态也是证据链的一部分 */
  function flush(): void {
    stop();
    if (options.session.state.value === 'live') sample();
  }

  watch(
    () => options.session.state.value,
    (next, previous) => {
      if (next === 'live') {
        start();
        // 会话起点先留一条：客户问「什么时候开始掉的」时，这条就是基线
        sample();
        return;
      }
      // 从 live 掉出来（stopping / error / idle）：停表并 flush
      if (previous === 'live') flush();
      else stop();
    },
  );

  if (options.session.state.value === 'live') {
    start();
    sample();
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      disposed = true;
      stop();
    });
  }

  return { samples, sample, flush };
}
