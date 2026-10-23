import { loadTxLivePusher, TxPushStatusCode, type TxPusher, type TxStatistics } from './tx-live-pusher';
import { DEFAULT_ENCODING } from './encoding';
import {
  PushTransportError,
  type PushConnectionStatus,
  type PushEncoding,
  type PushStatsSnapshot,
  type PushTransport,
  type PushTransportObserver,
} from './types';

/** 默认编码参数（分辨率/帧率由 usePushSession 按实际采集覆盖，见 D18） */
export { DEFAULT_ENCODING };

/** 等待 SDK 报 disconnected 的上限；超时也继续释放，避免状态机卡在 stopping */
const DISCONNECT_TIMEOUT_MS = 1500;
/** 停流后再等一小段，让信令/ICE 释放干净——这一步是 -12 竞态的防线 */
const POST_STOP_SETTLE_MS = 400;

/**
 * 腾讯云 WebRTC 直推实现：
 * rtmp 地址换协议得到 webrtc:// 后由 TXLivePusher 直接推到腾讯云边缘。
 * 统计来自 SDK 的 onStatisticsUpdate（bps / fps 实测值），没有数据时保持 null。
 */
export class WebRtcTxTransport implements PushTransport {
  readonly encoding: PushEncoding;

  private pusher: TxPusher | null = null;
  private observer: PushTransportObserver = {};
  private stats: PushStatsSnapshot | null = null;
  private disconnectWaiter: (() => void) | null = null;

  constructor(encoding: Partial<PushEncoding> = {}) {
    this.encoding = { ...DEFAULT_ENCODING, ...encoding };
  }

  setObserver(observer: PushTransportObserver): void {
    this.observer = observer;
  }

  getStats(): PushStatsSnapshot | null {
    return this.stats;
  }

  async start(pushUrl: string, stream: MediaStream): Promise<void> {
    if (!pushUrl.startsWith('webrtc://')) {
      throw new PushTransportError('invalid_push_url', 'push url is not a webrtc url');
    }

    const Ctor = await loadTxLivePusher();
    const pusher = new Ctor();
    this.pusher = pusher;
    this.stats = null;

    pusher.setProperty('setVideoResolution', { width: this.encoding.width, height: this.encoding.height });
    pusher.setProperty('setVideoFPS', this.encoding.fps);
    pusher.setProperty('setVideoBitrate', this.encoding.bitrateKbps);
    pusher.setProperty('setAudioSampleRate', 48000);
    pusher.setProperty('setAudioBitrate', 64);

    pusher.setObserver?.({
      onPushStatusUpdate: (status) => {
        this.observer.onStatus?.(toConnectionStatus(status));
        if (status === TxPushStatusCode.Disconnected) this.resolveDisconnect();
      },
      onStatisticsUpdate: (stats) => this.handleStatistics(stats),
      onError: (code, message) => {
        // 推流会话未释放时 SDK 会报 -12（spike 实测：不是鉴权问题）
        const error = new PushTransportError('sdk_error', message || `SDK error ${code}`, code);
        this.observer.onError?.(error);
      },
    });

    try {
      await pusher.startCustomCapture(stream);
      this.observer.onStatus?.('connecting');
      await pusher.startPush(pushUrl);
      this.observer.onStatus?.('connected');
    } catch (error) {
      await this.release(false);
      if (error instanceof PushTransportError) throw error;
      throw new PushTransportError('start_failed', describeError(error), extractSdkCode(error));
    }
  }

  async stop(): Promise<void> {
    await this.release(true);
  }

  private async release(waitForDisconnect: boolean): Promise<void> {
    const pusher = this.pusher;
    if (!pusher) return;
    this.pusher = null;

    if (waitForDisconnect && safeIsPushing(pusher)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.disconnectWaiter = null;
          resolve();
        }, DISCONNECT_TIMEOUT_MS);
        this.disconnectWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
        safeCall(() => pusher.stopPush());
      });
    } else {
      safeCall(() => pusher.stopPush());
    }

    // 释放后留出静默窗口，避免下一次 start 撞上上一场的会话
    await delay(POST_STOP_SETTLE_MS);

    try {
      await pusher.stopCustomCapture?.();
    } catch {
      // 已经停过就不用管
    }
    safeCall(() => pusher.destroy());
  }

  private resolveDisconnect(): void {
    this.disconnectWaiter?.();
    this.disconnectWaiter = null;
  }

  private handleStatistics(stats: TxStatistics): void {
    const video = stats.video;
    const bitrateBps = typeof video?.bitrate === 'number' ? video.bitrate : null;
    this.stats = {
      bitrateKbps: bitrateBps === null ? null : bitrateBps / 1000,
      fps: numberOrNull(video?.framesPerSecond),
      width: numberOrNull(video?.frameWidth),
      height: numberOrNull(video?.frameHeight),
      at: Date.now(),
    };
    this.observer.onStats?.(this.stats);
  }
}

function toConnectionStatus(status: number): PushConnectionStatus {
  switch (status) {
    case TxPushStatusCode.Connected:
      return 'connected';
    case TxPushStatusCode.Connecting:
      return 'connecting';
    case TxPushStatusCode.Reconnecting:
      return 'reconnecting';
    default:
      return 'disconnected';
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeIsPushing(pusher: TxPusher): boolean {
  try {
    if (typeof pusher.isPushing === 'function') return Boolean(pusher.isPushing());
    if (typeof pusher.isPushing === 'boolean') return pusher.isPushing;
    return false;
  } catch {
    return false;
  }
}

function safeCall(action: () => void): void {
  try {
    action();
  } catch {
    // SDK 在非预期状态下会抛错，这里吞掉，避免阻塞状态机复位
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function extractSdkCode(error: unknown): number | undefined {
  const message = describeError(error);
  const match = /err(?:or)?Code\s*:?\s*(-?\d+)/i.exec(message) ?? /^\s*(-\d+)\b/.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
