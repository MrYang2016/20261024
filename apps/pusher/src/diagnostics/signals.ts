import { DIAGNOSTIC_STATS_STALE_MS, type ChannelInfo } from '@live1024/shared';
import type { PushState } from '../composables/usePushSession';
import type { PushErrorInfo } from '../lib/errors';
import type { PushConnectionStatus, PushStatsSnapshot } from '../transports/types';
import { injectDemoFault, type DemoFaultKind } from './demo-faults';
import { errorToDiagnosticSignal, isAuthRejection } from './error-to-signal';
import type { NetworkProbeStatus } from './network-probe';
import type { DiagnosticSignals } from './rules';

/**
 * 会话 / 采集 / 频道信息的实时快照（App 与 composable 攒出来的原料）。
 * 这里只做**纯组装**：不改传入的对象、不读时钟、不碰 DOM。
 */
export interface SignalSource {
  now: number;
  /** 推流状态机状态 */
  pushState: PushState;
  /** 上行连接状态 */
  connection: PushConnectionStatus;
  /** 最近一次实测统计 */
  stats: PushStatsSnapshot | null;
  /** 本次会话的统计历史（算码率峰值用） */
  statsHistory: readonly PushStatsSnapshot[];
  /** 本次会话开始推流的时刻 */
  pushStartedAt: number | null;
  /** 拿到首帧的时刻（连接成功） */
  firstFrameAt: number | null;
  /** 当前频道（预检读 template / push.expiresAt） */
  channel: ChannelInfo | null;
  /**
   * 频道类错误（取频道 / 取推流地址阶段）：D2 的错误路径靠它（D29）。
   * 非纯视频模板时服务端直接 502，`channel` 根本不存在，只有这条错误能说明原因。
   */
  channelError?: PushErrorInfo | null;
  /** 采集层错误（getUserMedia 失败） */
  mediaError: PushErrorInfo | null;
  /** 推流层错误（start / 传输层报错） */
  pushError: PushErrorInfo | null;
  /** 麦克风实测电平（dBFS）；拿不到为 null */
  audioDbfs: number | null;
  /** 当前麦克风设备名（详情用） */
  audioDeviceLabel: string | null;
  /** 当前是否有音频轨 */
  hasAudioTrack: boolean;
  /** 预览画面平均亮度（0-255）；拿不到为 null */
  averageLuma: number | null;
  /** 当前是否有视频轨 */
  hasVideoTrack: boolean;
  /** 目标码率（kbps，详情用） */
  targetBitrateKbps: number | null;
  /**
   * 预检网络探测结果（D38）：只在**还没开播**时喂进规则层。
   * 断网时预检必须能说出「连不上服务器」，而不是靠 `channel` 对象在内存里就宣布「预检通过」。
   */
  networkProbe?: NetworkProbeStatus;
  /**
   * 演示故障注入（D37，仅 `?demo=1`）：注入的是**规则引擎的输入**，后续仍由 `evaluateDiagnostics`
   * 走真实判定链路——不绕过规则层，录像里展示的就是真实结论。
   */
  demo?: DemoFaultKind | null;
}

/** 推流中会话才有的信号（idle / stopping 时不参与判定，避免停止后误报） */
const SESSION_STATES: readonly PushState[] = ['preparing', 'connecting', 'live'];

/**
 * 把运行时状态拼成规则引擎的输入。
 *
 * 三条口径（都为了让「诊断卡只说真话」）：
 * - **统计过期就当没有**：SDK 正常 1-2 秒回报一次，10 秒没更新还拿旧 fps/码率判 D5/D6 会误报；
 * - **connected 只在推流中给值**：连接过程中给 `undefined`（未知）而不是 false，
 *   否则「连接中」会被 D5 的断流路径判成码率不足，抢在 D3 的首帧超时之前误报；
 * - **没有对应轨道就不给电平/亮度**：没麦克风是 D7 的场景，但没有音轨时读到的 -100 不是证据。
 */
export function buildSignals(source: SignalSource): DiagnosticSignals {
  const now = source.now;
  const inSession = SESSION_STATES.includes(source.pushState);
  const live = source.pushState === 'live';
  const freshStats =
    source.stats && now - source.stats.at <= DIAGNOSTIC_STATS_STALE_MS ? source.stats : null;
  const pushError = errorToDiagnosticSignal(source.pushError, now);
  const mediaError = errorToDiagnosticSignal(source.mediaError, now);
  const channelError = errorToDiagnosticSignal(source.channelError, now);
  /**
   * 模板不符只认错误分类（D29）：真实链路里请求本身就是 502，拿不到 template 值，
   * 所以这里不伪造模板，只把「服务端判定模板不对」这件事带进规则层。
   */
  const templateFailure =
    channelError?.id === 'D2' ? channelError : pushError?.id === 'D2' ? pushError : null;
  const peakBitrateKbps = peakOf(source.statsHistory);
  /** 预检阶段 = 还没开播（idle / 上一次开播失败）：只有这时探测结果才算诊断证据 */
  const precheckPhase = source.pushState === 'idle' || source.pushState === 'error';

  const signals: DiagnosticSignals = {
    now,
    template: source.channel?.template ?? null,
    templateMismatch: templateFailure !== null,
    pushExpiresAt: source.channel?.push.expiresAt ?? null,
    // D1 的两条路都走错误分类：推流被拒是鉴权类，取地址 / 取频道被拒也是（同一份 isAuthRejection）
    pushRejectedAuth: isAuthRejection(source.pushError) || isAuthRejection(source.channelError),
    pushStartedAt: inSession ? source.pushStartedAt : null,
    firstFrameAt: source.firstFrameAt,
    connected: live ? source.connection === 'connected' : undefined,
    connectFailed: pushError?.id === 'D3',
    fps: live ? (freshStats?.fps ?? null) : null,
    bitrateKbps: live ? (freshStats?.bitrateKbps ?? null) : null,
    peakBitrateKbps,
    audioRmsDb: source.hasAudioTrack ? source.audioDbfs : null,
    averageLuma: source.hasVideoTrack ? source.averageLuma : null,
    captureError: mediaError?.id === 'D9' ? (source.mediaError?.code ?? 'capture_failed') : null,
    captureTrackActive: source.hasVideoTrack,
    templateHint: source.channel?.template ?? null,
    templateMismatchDetail: templateFailure?.detail ?? null,
    pushErrorDetail: pushError?.detail ?? null,
    pushErrorMessage: pushError?.reason ?? null,
    captureErrorMessage: mediaError?.reason ?? null,
    audioDeviceLabel: source.audioDeviceLabel,
    pushHost: hostOf(source.channel?.push.rtmpUrl),
    bitrateTargetKbps: source.targetBitrateKbps,
    // D38：探测只在预检阶段有意义；推流中不能拿几分钟前的探测结果判「连不上」
    networkUnreachable: precheckPhase && source.networkProbe === 'failed',
  };

  // 演示注入只在推流中生效（与真实故障的采样前提一致），注完仍由规则层判定
  if (source.demo && live) return injectDemoFault(signals, source.demo, now);
  return signals;
}

/** 本次会话观测到的码率峰值（kbps）：D5 的「峰值 40%」用 */
export function peakOf(history: readonly PushStatsSnapshot[]): number | null {
  let peak: number | null = null;
  for (const snapshot of history) {
    const value = snapshot.bitrateKbps;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    peak = peak === null ? value : Math.max(peak, value);
  }
  return peak;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
