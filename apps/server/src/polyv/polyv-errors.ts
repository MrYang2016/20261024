/** 上游调用失败（网络、HTTP 状态、业务 code 三种都归到这里） */
export class PolyvUpstreamError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PolyvUpstreamError';
  }
}

/**
 * 「频道不存在」的上游特征（2026-10-23 实测频道 999999999）：
 *   basic/get           → HTTP 400 `{"code":400,"error":{"desc":"找不到频道"}}`
 *   live-status/list    → HTTP 400 `{"code":400,"error":{"desc":"存在非法频道ID: 999999999"}}`
 *   stream/get-push-url → HTTP 403 `{"code":403,"message":"illegal channel id: 999999999"}`
 * 只有描述命中这些特征才判成「频道不存在」（404）；其它上游失败（含参数类 400）仍走 502 兜底。
 */
export const CHANNEL_NOT_FOUND_PATTERN =
  /找不到频道|频道不存在|不存在.*频道|非法频道\s*id|illegal channel id|invalid channel|channel\s*not\s*exist/i;

/** 上游描述里出现这些特征就认为频道不存在，转换成 404 而不是 502 */
export function isChannelNotFound(error: unknown): boolean {
  if (!(error instanceof PolyvUpstreamError)) return false;
  return CHANNEL_NOT_FOUND_PATTERN.test(error.message);
}
