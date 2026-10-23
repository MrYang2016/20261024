/** 连接状态（对齐 TXLivePusher 的 onPushStatusUpdate） */
export type PushConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/** 一次统计快照；未知字段保持 null，UI 不显示假数字 */
export interface PushStatsSnapshot {
  /** 视频码率，单位 kbps */
  bitrateKbps: number | null;
  /** 视频帧率 */
  fps: number | null;
  width: number | null;
  height: number | null;
  /** 丢帧率（D34）：SDK 没暴露时缺省 / null，不编造 */
  dropFps?: number | null;
  /** 统计时间戳（毫秒） */
  at: number;
}

/** 编码参数：发出前就确定的部分，与网络实测值分开呈现 */
export interface PushEncoding {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

export type PushTransportErrorCode =
  | 'script_load_failed'
  | 'invalid_push_url'
  | 'start_failed'
  | 'sdk_error';

export class PushTransportError extends Error {
  constructor(
    readonly code: PushTransportErrorCode,
    message: string,
    readonly sdkCode?: number,
  ) {
    super(message);
    this.name = 'PushTransportError';
  }
}

export interface PushTransportObserver {
  onStatus?: (status: PushConnectionStatus, message?: string) => void;
  onStats?: (stats: PushStatsSnapshot) => void;
  onError?: (error: PushTransportError) => void;
}

/**
 * 推送传输层接口。本期唯一实现是 WebRtcTxTransport（腾讯云 WebRTC 直推）。
 * 抽接口是为了让状态机与具体 SDK 解耦，24060 加诊断时可直接换实现。
 */
export interface PushTransport {
  readonly encoding: PushEncoding;
  /** 观测回调（实现不支持时可缺省，状态机不依赖它） */
  setObserver?(observer: PushTransportObserver): void;
  /** 开始推流；resolve 表示连接已建立 */
  start(pushUrl: string, stream: MediaStream): Promise<void>;
  /** 停止推流；resolve 表示会话已释放（之后才允许再次 start） */
  stop(): Promise<void>;
  getStats(): PushStatsSnapshot | null;
}
