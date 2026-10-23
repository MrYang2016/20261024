/** Polyv 上游返回体的公共形状（v4 通道接口） */
export interface PolyvEnvelope<T> {
  code: number;
  status?: string;
  message?: string;
  success?: boolean;
  error?: { code: number; desc: string } | null;
  data: T | null;
}

/** /live/v4/channel/create-init 的 data */
export interface PolyvChannelCreateResult {
  channelId: number;
  name: string;
  channelPasswd: string;
  newScene: string;
  template: string;
}

/** /live/v4/channel/basic/get 的 data（只列本服务用到的字段） */
export interface PolyvChannelBasic {
  channelId: number;
  name: string;
  template: string;
  newScene: string;
  watchStatus?: string;
  watchUrl?: string;
  pageView?: number;
  channelPasswd?: string;
}

/** /live/v4/channel/live-status/list 的 data 项 */
export interface PolyvLiveStatusItem {
  channelId: number;
  liveStatus: string;
}
