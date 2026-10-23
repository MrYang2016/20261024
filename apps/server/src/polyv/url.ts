const RTMP_PREFIX = 'rtmp://';
const WEBRTC_PREFIX = 'webrtc://';

/** rtmp 地址转 webrtc 地址：只换协议前缀，其余字符（含 txSecret / txTime）原样保留 */
export function toWebrtcUrl(rtmpUrl: string): string {
  if (!rtmpUrl.startsWith(RTMP_PREFIX)) return rtmpUrl;
  return WEBRTC_PREFIX + rtmpUrl.slice(RTMP_PREFIX.length);
}

/** 是否为可推送的 rtmp 地址 */
export function isRtmpUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith(RTMP_PREFIX) && url.length > RTMP_PREFIX.length;
}

/**
 * 从推流地址解析流名：rtmp://push-t2.videocc.net/recordf/<stream>?txSecret=..
 * 解析失败返回空串（不抛异常，避免把链路细节暴露成 500）。
 */
export function extractStreamName(pushUrl: string): string {
  const path = pushUrl.split('?')[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] ?? '') : '';
}

/** 是否腾讯云线路（腾讯云边缘推流域名以 push-t2 开头，网宿是 push.videocc.net） */
export function isTencentPushDomain(pushUrl: string): boolean {
  try {
    return new URL(pushUrl).hostname.startsWith('push-t2');
  } catch {
    return false;
  }
}
