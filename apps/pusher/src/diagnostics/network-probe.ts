import { probeHealth } from '../lib/api';

/**
 * 预检网络探测（CONTEXT D38）。
 *
 * 为什么单独一层：「预检通过」以前是 `useDiagnostics` 的兜底文案，没有任何探测支撑——
 * 断网时自检条照样说「预检通过，可以开播」，讲师以为能开播。这里把「到底连不连得上服务端」
 * 变成一个显式状态：`conclusion` 只在探测成功时才允许说「预检通过」，探测未知只说「正在检查网络…」。
 *
 * 探测本身是轻量的：一次 `GET /api/health`，3 秒超时（`lib/api.ts` 的 `probeHealth`）。
 */

/** 探测结果：还没探测完 / 连得上 / 连不上 */
export type NetworkProbeStatus = 'unknown' | 'ok' | 'failed';

/** 探测超时：3 秒（D38） */
export const NETWORK_PROBE_TIMEOUT_MS = 3_000;

/** 还没开播时的探测间隔：15 秒（D38） */
export const NETWORK_PROBE_INTERVAL_MS = 15_000;

/** 连续失败多少次才判「连不上」（D38 防抖；刚载入频道的首次探测不适用） */
export const NETWORK_PROBE_FAILURE_LIMIT = 2;

/** 缺省探测实现：`GET /api/health`，3 秒超时；任何异常都按「连不上」处理，不向上抛 */
export async function probeServerHealth(): Promise<boolean> {
  return probeHealth(NETWORK_PROBE_TIMEOUT_MS);
}

export interface NetworkProbeResult {
  status: NetworkProbeStatus;
  /** 更新后的连续失败次数（成功清零） */
  consecutiveFailures: number;
}

/**
 * 探测结果 → 展示态（D38 的防抖口径）。
 *
 * - 首次探测（刚载入频道）一次失败就判 `failed`：这时候没有别的证据，不该先让讲师等两个探测周期；
 * - 之后的探测要**连续 2 次失败**才判 `failed`：单次网络抖动不该把「预检通过」打成红色。
 * - 判不了 `failed` 的失败一律停在 `unknown`（界面上是「正在检查网络…」），不冒充成功。
 */
export function resolveProbeStatus(params: {
  /** 这一次探测是否连通 */
  reachable: boolean;
  /** 本次探测之前的连续失败次数 */
  consecutiveFailures: number;
  /** 是否「刚载入频道」的首次探测 */
  firstProbe: boolean;
}): NetworkProbeResult {
  if (params.reachable) return { status: 'ok', consecutiveFailures: 0 };

  const consecutiveFailures = params.consecutiveFailures + 1;
  const failed = params.firstProbe || consecutiveFailures >= NETWORK_PROBE_FAILURE_LIMIT;
  return { status: failed ? 'failed' : 'unknown', consecutiveFailures };
}
