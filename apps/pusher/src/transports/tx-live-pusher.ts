import { PushTransportError } from './types';

/** 腾讯云公开 Web 推流 SDK（与生产网页开播同一条上行链路） */
export const TX_PUSHER_SRC = 'https://video.sdk.qcloudecdn.com/web/TXLivePusher-2.1.1.min.js';

/** onPushStatusUpdate 的状态码（SDK 内部枚举） */
export const TxPushStatusCode = {
  Disconnected: 0,
  Connecting: 1,
  Connected: 2,
  Reconnecting: 3,
} as const;

export interface TxStatistics {
  timestamp?: number;
  video?: {
    /** 8 * bytesSent 增量 / 秒，单位 bps */
    bitrate?: number | null;
    framesPerSecond?: number | null;
    frameWidth?: number | null;
    frameHeight?: number | null;
    framesEncoded?: number | null;
    framesSent?: number | null;
    packetsSent?: number | null;
    nackCount?: number | null;
    firCount?: number | null;
    pliCount?: number | null;
    frameEncodeAvgTime?: number | null;
    packetSendDelay?: number | null;
  };
  audio?: {
    bitrate?: number | null;
    packetsSent?: number | null;
  };
}

export interface TxObserver {
  onError?: (code: number, message: string, extra?: unknown) => void;
  onWarning?: (code: number, message: string, extra?: unknown) => void;
  onCaptureFirstVideoFrame?: () => void;
  onCaptureFirstAudioFrame?: () => void;
  onPushStatusUpdate?: (status: number, message: string, extra?: unknown) => void;
  onStatisticsUpdate?: (stats: TxStatistics) => void;
}

export interface TxPusher {
  setProperty(name: string, value: unknown): void;
  setObserver?(observer: TxObserver): void;
  startCustomCapture(stream: MediaStream): Promise<void>;
  stopCustomCapture(): Promise<void> | void;
  startPush(pushUrl: string): Promise<void>;
  stopPush(): void;
  /** 官方实装是方法；部分精简实现/桩里是布尔属性，两种都容错 */
  isPushing?: boolean | (() => boolean);
  destroy(): void;
}

export type TxPusherCtor = new () => TxPusher;

interface TxGlobal {
  TXLivePusher?: TxPusherCtor;
}

let loader: Promise<TxPusherCtor> | null = null;

/**
 * 动态加载 SDK 脚本（只加载一次，失败后允许重试）。
 * 项目不走 npm 包，官方只提供这份 CDN 脚本。
 */
export function loadTxLivePusher(): Promise<TxPusherCtor> {
  const existing = (globalThis as TxGlobal).TXLivePusher;
  if (existing) return Promise.resolve(existing);
  if (loader) return loader;

  const pending = new Promise<TxPusherCtor>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new PushTransportError('script_load_failed', 'TXLivePusher 只能在浏览器中加载'));
      return;
    }
    const script = document.createElement('script');
    script.src = TX_PUSHER_SRC;
    script.async = true;
    script.onload = () => {
      const ctor = (globalThis as TxGlobal).TXLivePusher;
      if (ctor) resolve(ctor);
      else reject(new PushTransportError('script_load_failed', 'TXLivePusher 脚本已加载但未挂载全局对象'));
    };
    script.onerror = () => reject(new PushTransportError('script_load_failed', '无法加载 TXLivePusher 脚本'));
    document.head.appendChild(script);
  });

  loader = pending.catch((error: unknown) => {
    loader = null;
    throw error;
  });
  return loader;
}
