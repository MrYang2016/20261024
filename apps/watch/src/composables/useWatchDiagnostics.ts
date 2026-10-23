/**
 * 观众侧自检（W1–W4）：观众遇到「画面卡住 / 黑屏 / 连不上服务器 / 播放器出错」时，
 * 同样给**一句话原因 + 一个下一步**，与推流端自检条同一形态。
 *
 * 规则（优先级 W1 > W4 > W3 > W2，同一时刻只显示一条）：
 * | ID | 情况 | 判定 | 下一步 |
 * |----|------|------|--------|
 * | W1 | 连不上服务器 | `GET /api/health` 3s 超时连续 2 次失败（`polyv !== 'reachable'` 也算失败） | 重试连接（重新探测 + 重新拉状态 + 重连播放器） |
 * | W4 | 播放器出错 | 初始化失败 / SDK 上报播放错误，且画面没有在正常跑 | 重新连接（重建播放器） |
 * | W3 | 画面黑屏 | 平均亮度 < 8/255 连续 3 秒（有画面尺寸才判） | 重新加载画面 |
 * | W2 | 画面卡住 | `currentTime` 8 秒没推进，且直播中、未暂停、`readyState >= 2` | 重新加载画面 |
 *
 * 直播未开始 / 已结束时不跑 W2 / W3（没有画面是正常状态，不能报成「画面卡住」）。
 * 判定与计时都是纯函数（`evaluateWatchDiagnosis`），`now` 可注入 → 假时钟可测；本 composable 只负责驱动节拍与修复动作。
 */
import { onBeforeUnmount, ref, type Ref } from 'vue';
import type { LiveStatus } from '@live1024/shared';
import { probeHealth } from '../lib/api';
import { sampleAverageLuma } from '../lib/black-frame';
import type { WatchErrorInfo } from '../lib/errors';
import type { WatchPhase } from './useWatchCore';

export type WatchDiagnosisId = 'W1' | 'W2' | 'W3' | 'W4';
export type WatchDiagnosisLevel = 'danger' | 'warning';
/** 修复动作：重试连接（含重新探测）/ 重建播放器 */
export type WatchDiagnosisAction = 'retry-connect' | 'reload-player';

/** 同一时刻只显示一条：按优先级取最高命中（W1 > W4 > W3 > W2） */
export const WATCH_DIAGNOSIS_PRIORITY = ['W1', 'W4', 'W3', 'W2'] as const;

export const WATCH_DIAGNOSIS_THRESHOLDS = {
  /** health 探测超时：3 秒 */
  probeTimeoutMs: 3_000,
  /** 连续失败多少次才判「连不上服务器」（单次抖动不报） */
  probeFailureLimit: 2,
  /** 探测间隔：5 秒（连续 2 次失败约 5 秒内出结论） */
  probeIntervalMs: 5_000,
  /** `currentTime` 多久没推进判「画面卡住」 */
  stalledMs: 8_000,
  /** 平均亮度低于阈值持续多久判「黑屏」 */
  blackFrameMs: 3_000,
  /** 黑屏阈值：平均亮度 < 8/255 */
  blackLuma: 8,
  /** 判定节拍 */
  tickMs: 1_000,
} as const;

export interface WatchDiagnosisMeta {
  /** 诊断项中文名（详情 / 无障碍用） */
  name: string;
  level: WatchDiagnosisLevel;
  /** 一句话原因 */
  reason: string;
  /** 一个下一步的按钮文案 */
  actionLabel: string;
  action: WatchDiagnosisAction;
  /** 期望（与「实测」配对，排障时看） */
  expected: string;
}

export const WATCH_DIAGNOSIS_META: Record<WatchDiagnosisId, WatchDiagnosisMeta> = {
  W1: {
    name: '连不上服务器',
    level: 'danger',
    reason: '连不上服务器，请检查网络',
    actionLabel: '重试连接',
    action: 'retry-connect',
    expected: '3 秒内探测成功（服务端与上游都可达）',
  },
  W4: {
    name: '播放器出错',
    level: 'danger',
    reason: '播放器加载失败',
    actionLabel: '重新连接',
    action: 'reload-player',
    expected: '播放器正常初始化并有画面',
  },
  W3: {
    name: '画面黑屏',
    level: 'warning',
    reason: '画面是黑的',
    actionLabel: '重新加载画面',
    action: 'reload-player',
    expected: '画面平均亮度 ≥ 8/255',
  },
  W2: {
    name: '画面卡住',
    level: 'warning',
    reason: '画面卡住了',
    actionLabel: '重新加载画面',
    action: 'reload-player',
    expected: '播放进度持续推进',
  },
};

/** 当前结论：一句话原因 + 一个下一步 */
export interface WatchVerdict {
  id: WatchDiagnosisId;
  name: string;
  level: WatchDiagnosisLevel;
  reason: string;
  action: WatchDiagnosisAction;
  actionLabel: string;
  /** 实测（为什么判这条） */
  measured: string;
  /** 期望 */
  expected: string;
  /** 判定的时刻（ISO） */
  at: string;
}

/** 只取判定需要的视频属性（`HTMLVideoElement` 天然满足） */
export interface WatchDiagnosisVideo {
  currentTime: number;
  paused: boolean;
  readyState: number;
}

export type WatchProbeStatus = 'unknown' | 'ok' | 'failed';

export interface WatchDiagnosisInput {
  liveStatus: LiveStatus;
  videoEl: WatchDiagnosisVideo | null;
  playerState: { phase: WatchPhase; error: WatchErrorInfo | null };
  probe: { status: WatchProbeStatus };
  /** 最近一次黑屏采样的平均亮度（0-255）；null = 没有可用样本，不判黑屏 */
  luma: number | null;
}

/** 跨节拍的画面计时（不放进 ref：它只在规则里用，界面不直接读） */
export interface WatchDiagnosisMemory {
  lastCurrentTime: number | null;
  /** 上一次 `currentTime` 有变化的时刻 */
  lastProgressAt: number;
  /** 画面开始持续黑的时刻（未黑为 null） */
  blackSince: number | null;
}

export function createWatchDiagnosisMemory(now: number): WatchDiagnosisMemory {
  return { lastCurrentTime: null, lastProgressAt: now, blackSince: null };
}

export interface WatchDiagnosisEvaluation {
  memory: WatchDiagnosisMemory;
  verdict: WatchVerdict | null;
}

function verdictOf(id: WatchDiagnosisId, measured: string, now: number): WatchVerdict {
  const meta = WATCH_DIAGNOSIS_META[id];
  return {
    id,
    name: meta.name,
    level: meta.level,
    reason: meta.reason,
    action: meta.action,
    actionLabel: meta.actionLabel,
    measured,
    expected: meta.expected,
    at: new Date(now).toISOString(),
  };
}

/** 播放器是否「现在坏了」：初始化失败，或 SDK 报过错且画面没有在正常跑 */
function isPlayerBroken(
  playerState: WatchDiagnosisInput['playerState'],
  video: WatchDiagnosisVideo | null,
): boolean {
  if (playerState.phase === 'error') return true;
  if (playerState.error === null) return false;
  // 历史上报过的错误不该一直挂在条上：画面已经在跑（未暂停 + 有后续帧）就不再算当前故障
  const healthy = video !== null && !video.paused && video.readyState >= 3;
  return !healthy;
}

/**
 * 纯判定：给定信号 + 上一拍记忆 + 当前时刻 → 下一个结论。
 * 不读时钟、不碰 DOM，`now` 由调用方给（假时钟可测）。
 */
export function evaluateWatchDiagnosis(
  input: WatchDiagnosisInput,
  memory: WatchDiagnosisMemory,
  now: number,
): WatchDiagnosisEvaluation {
  const thresholds = WATCH_DIAGNOSIS_THRESHOLDS;
  /** 直播中才有「画面」可言；未开始 / 已结束不跑画面类判定 */
  const watchingLive = input.liveStatus === 'live';
  const video = watchingLive ? input.videoEl : null;

  let lastCurrentTime = memory.lastCurrentTime;
  let lastProgressAt = memory.lastProgressAt;
  let blackSince = memory.blackSince;

  if (!video) {
    // 没有视频元素 = 没有画面证据：清空画面类计时，避免旧读数被当成本次故障
    lastCurrentTime = null;
    lastProgressAt = now;
    blackSince = null;
  } else {
    if (video.currentTime !== lastCurrentTime) {
      lastCurrentTime = video.currentTime;
      lastProgressAt = now;
    }
    const isBlack = input.luma !== null && input.luma < thresholds.blackLuma && !video.paused;
    blackSince = isBlack ? (blackSince ?? now) : null;
  }

  const nextMemory: WatchDiagnosisMemory = { lastCurrentTime, lastProgressAt, blackSince };

  // W1 连不上服务器
  if (input.probe.status === 'failed') {
    return {
      memory: nextMemory,
      verdict: verdictOf(
        'W1',
        `探测连续 ${thresholds.probeFailureLimit} 次失败（每次 ${thresholds.probeTimeoutMs / 1000} 秒超时）`,
        now,
      ),
    };
  }

  // W4 播放器出错
  if (isPlayerBroken(input.playerState, video)) {
    const detail = input.playerState.error?.message ?? '播放器初始化失败';
    return { memory: nextMemory, verdict: verdictOf('W4', detail, now) };
  }

  // W3 画面黑屏
  if (video && blackSince !== null && now - blackSince >= thresholds.blackFrameMs) {
    const luma = input.luma ?? 0;
    const seconds = Math.round((now - blackSince) / 1000);
    return {
      memory: nextMemory,
      verdict: verdictOf('W3', `画面平均亮度 ${Math.round(luma)}/255，持续 ${seconds} 秒`, now),
    };
  }

  // W2 画面卡住：直播中、没暂停、已有画面数据，进度却 8 秒没走
  if (
    video &&
    !video.paused &&
    video.readyState >= 2 &&
    now - lastProgressAt >= thresholds.stalledMs
  ) {
    const seconds = Math.round((now - lastProgressAt) / 1000);
    return {
      memory: nextMemory,
      verdict: verdictOf('W2', `画面停在 ${video.currentTime.toFixed(1)} 秒，${seconds} 秒没有推进`, now),
    };
  }

  return { memory: nextMemory, verdict: null };
}

export interface UseWatchDiagnosticsOptions {
  liveStatus: Ref<LiveStatus>;
  /** 播放器视频元素：由 SDK 渲染在容器里，用 getter 每次取当前那个（重连后会换元素） */
  videoEl: () => HTMLVideoElement | null;
  playerState: { phase: Ref<WatchPhase>; error: Ref<WatchErrorInfo | null> };
  /** 没有频道时不必探测 / 判定 */
  enabled?: () => boolean;
  /** health 探测实现（测试注入）；默认 `GET /api/health`，3 秒超时 */
  probeHealth?: () => Promise<boolean>;
  /** 时钟（测试注入假时钟） */
  now?: () => number;
  tickMs?: number;
  probeIntervalMs?: number;
  /** W1 的下一步：重新拉状态 + 重连播放器（重新探测在内部先做） */
  onRetryConnect?: () => Promise<void> | void;
  /** W2 / W3 / W4 的下一步：重建播放器（接到现有重连逻辑） */
  onReloadPicture?: () => Promise<void> | void;
}

export interface UseWatchDiagnosticsResult {
  verdict: Ref<WatchVerdict | null>;
  /** 修复动作进行中：按钮置忙，防重复触发 */
  fixing: Ref<boolean>;
  probeStatus: Ref<WatchProbeStatus>;
  /** 立即探测一次（runFix 与测试用） */
  probe: () => Promise<boolean>;
  /** 立即重算一次（假时钟驱动测试用） */
  evaluate: () => void;
  /** 执行当前结论的下一步 */
  runFix: () => Promise<void>;
  stop: () => void;
}

export function useWatchDiagnostics(options: UseWatchDiagnosticsOptions): UseWatchDiagnosticsResult {
  const now = options.now ?? (() => Date.now());
  const probeTimeoutMs = WATCH_DIAGNOSIS_THRESHOLDS.probeTimeoutMs;
  const probeImpl = options.probeHealth ?? (() => probeHealth(probeTimeoutMs));
  const tickMs = options.tickMs ?? WATCH_DIAGNOSIS_THRESHOLDS.tickMs;
  const probeIntervalMs = options.probeIntervalMs ?? WATCH_DIAGNOSIS_THRESHOLDS.probeIntervalMs;
  const enabled = options.enabled ?? (() => true);

  const verdict = ref<WatchVerdict | null>(null);
  const fixing = ref(false);
  const probeStatus = ref<WatchProbeStatus>('unknown');

  let memory = createWatchDiagnosisMemory(now());
  let consecutiveFailures = 0;
  let lumaCanvas: HTMLCanvasElement | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;

  function readLuma(): number | null {
    // 未开始 / 已结束没有画面，不采样（省一次 drawImage + getImageData）
    if (options.liveStatus.value !== 'live') return null;
    const video = options.videoEl();
    if (!video) return null;
    if (!lumaCanvas && typeof document !== 'undefined') {
      lumaCanvas = document.createElement('canvas');
    }
    return sampleAverageLuma(video, lumaCanvas);
  }

  function evaluate(): void {
    if (!enabled()) {
      verdict.value = null;
      return;
    }
    const video = options.videoEl();
    const result = evaluateWatchDiagnosis(
      {
        liveStatus: options.liveStatus.value,
        videoEl: video
          ? { currentTime: video.currentTime, paused: video.paused, readyState: video.readyState }
          : null,
        playerState: { phase: options.playerState.phase.value, error: options.playerState.error.value },
        probe: { status: probeStatus.value },
        luma: readLuma(),
      },
      memory,
      now(),
    );
    memory = result.memory;
    verdict.value = result.verdict;
  }

  async function probe(): Promise<boolean> {
    // 没有频道（填频道号的入口页）：不做无意义的探测
    if (!enabled()) return true;
    const reachable = await probeImpl().catch(() => false);
    if (reachable) {
      consecutiveFailures = 0;
      probeStatus.value = 'ok';
    } else {
      consecutiveFailures += 1;
      // 单次失败只停「未知」，连续 2 次才判「连不上服务器」
      probeStatus.value =
        consecutiveFailures >= WATCH_DIAGNOSIS_THRESHOLDS.probeFailureLimit ? 'failed' : 'unknown';
    }
    evaluate();
    return reachable;
  }

  async function runFix(): Promise<void> {
    const current = verdict.value;
    if (!current || fixing.value) return;

    fixing.value = true;
    try {
      if (current.action === 'retry-connect') {
        // 先重新探测：通了就清掉 W1；同时重新拉状态 + 重连播放器
        await probe();
        await options.onRetryConnect?.();
      } else {
        await options.onReloadPicture?.();
      }
    } catch {
      // 修复失败：保留原结论，观众可以再点一次
    } finally {
      // 修完重置画面计时：新播放器的 currentTime 与旧读数不可比
      memory = createWatchDiagnosisMemory(now());
      fixing.value = false;
      evaluate();
    }
  }

  function stop(): void {
    if (tickTimer !== null) clearInterval(tickTimer);
    if (probeTimer !== null) clearInterval(probeTimer);
    tickTimer = null;
    probeTimer = null;
  }

  evaluate();
  void probe();
  tickTimer = setInterval(evaluate, tickMs);
  probeTimer = setInterval(() => void probe(), probeIntervalMs);

  onBeforeUnmount(stop);

  return { verdict, fixing, probeStatus, probe, evaluate, runFix, stop };
}
