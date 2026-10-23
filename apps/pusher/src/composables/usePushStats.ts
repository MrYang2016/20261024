import { computed, type ComputedRef, type Ref } from 'vue';
import { formatBitrate, formatDuration, formatFps, formatResolution } from '../lib/format';
import { DEFAULT_ENCODING, toEncoding, type CaptureSettings } from '../transports/encoding';
import type { PushConnectionStatus, PushEncoding } from '../transports/types';
import type { PushSession } from './usePushSession';

export interface PushStatsView {
  /** 目标编码参数：采集设置 → 会话固化的值 → 兜底档（只用于页脚，不当实测值） */
  encoding: ComputedRef<PushEncoding>;
  encodingText: ComputedRef<string>;
  durationText: ComputedRef<string>;
  bitrateText: ComputedRef<string>;
  fpsText: ComputedRef<string>;
  resolutionText: ComputedRef<string>;
  /** 上行连接状态文案（已本地化） */
  connectionText: ComputedRef<string>;
  /** 链路是否健康：只有 connected 才给正向色，其余用中性/警示色 */
  connectionTone: ComputedRef<'healthy' | 'pending' | 'neutral'>;
  /** 是否已经拿到实时统计（拿不到就显示占位符，不显示假数字） */
  hasLiveStats: ComputedRef<boolean>;
}

const CONNECTION_TEXT: Record<PushConnectionStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '未连接',
};

/**
 * 指标条视图模型。
 * 数据来源优先级：SDK 实时统计（码率/帧率/画面）→ 时长 + 连接状态。
 * 实时值拿不到时保持「—」，绝不用编码参数冒充实测值（D18）。
 */
export function usePushStats(
  session: PushSession,
  captureSettings?: Ref<CaptureSettings | null>,
): PushStatsView {
  /**
   * 编码参数 = 实际采集分辨率/帧率（D18）。
   * 采集设置是「当前摄像头」的事实；会话里固化的那份是开播那一刻的值（中途切设备时保持不变）。
   */
  const encoding = computed<PushEncoding>(() => {
    const settings = captureSettings?.value;
    if (settings) return toEncoding(settings);
    return session.encoding?.value ?? DEFAULT_ENCODING;
  });

  const hasLiveStats = computed(() => session.stats.value !== null);

  return {
    encoding,
    encodingText: computed(
      () =>
        `${encoding.value.width}×${encoding.value.height} · ${encoding.value.fps} fps · ${encoding.value.bitrateKbps} kbps`,
    ),
    durationText: computed(() => (session.startedAt.value === null ? '—' : formatDuration(session.elapsedMs.value))),
    bitrateText: computed(() => formatBitrate(session.stats.value?.bitrateKbps ?? null)),
    fpsText: computed(() => formatFps(session.stats.value?.fps ?? null)),
    resolutionText: computed(() => {
      const stats = session.stats.value;
      if (stats?.width && stats.height) return formatResolution(stats.width, stats.height);
      // 统计还没回报（或已清空）就是占位符：编码参数放在页脚，不能拿来冒充「画面」实测值
      return '—';
    }),
    connectionText: computed(() => CONNECTION_TEXT[session.connectionStatus.value]),
    connectionTone: computed(() => {
      switch (session.connectionStatus.value) {
        case 'connected':
          return 'healthy' as const;
        case 'connecting':
        case 'reconnecting':
          return 'pending' as const;
        default:
          return 'neutral' as const;
      }
    }),
    hasLiveStats,
  };
}
