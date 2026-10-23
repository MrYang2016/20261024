/**
 * 前后端共享 DTO 类型（纯类型，无运行时导出）。
 * 服务端与两个前端都用 `import type` 引入，构建产物里不留运行时依赖。
 */

/** 对外公开的直播状态（上游 waiting/banpush 等值由服务端归一到这里） */
export type LiveStatus = 'unStart' | 'live' | 'end' | 'playback';

/** 推流凭证：服务端下发，客户端不自行签名 */
export interface PushCredentials {
  /** RTMP 地址（含 txSecret / txTime） */
  rtmpUrl: string;
  /** WebRTC 地址（由 rtmpUrl 换协议得到） */
  webrtcUrl: string;
  /**
   * 推流地址有效期（ISO 时间）：从 rtmpUrl 的 txTime（hex 秒）解出。
   * 解不出就是 null —— 宁可没有这个字段，也不编一个时间出来（D1 预检据此告警）。
   */
  expiresAt: string | null;
}

/** 频道信息 + 新推流地址 */
export interface ChannelInfo {
  channelId: string;
  name: string;
  watchUrl: string;
  push: PushCredentials;
  stream: string;
  /** 频道模板（'alone' = 纯视频）：第三方推流只支持纯视频模板（D2 预检读它） */
  template: string;
}

/** 直播状态与观看数据 */
export interface LiveStatusSnapshot {
  liveStatus: LiveStatus;
  /** 给客户端展示的观看数（公开 API 只提供累计观看人次） */
  viewerCount: number;
}

/** 推流会话上报（内存态，服务端据此校正直播状态） */
export type PushSessionState = 'started' | 'stopped';

/** 统一错误体：客户向一句话，不透传上游原始报文 */
export interface ApiErrorBody {
  code: number;
  message: string;
}

export * from './diagnostics';
