import { createHash } from 'node:crypto';

/** 参与签名的参数值（Polyv 只接受字符串化后的拼接） */
export type SignParams = Record<string, string | number | boolean>;

/**
 * Polyv 签名原文：appSecret + 按 key 升序的 `k + v` 拼接 + appSecret。
 * sign 字段本身不参与签名。导出成独立函数便于单测与排查。
 */
export function buildSignSource(params: SignParams, appSecret: string): string {
  const keys = Object.keys(params)
    .filter((key) => key !== 'sign')
    .sort();
  return appSecret + keys.map((key) => `${key}${String(params[key])}`).join('') + appSecret;
}

/** 32 位大写 MD5 签名 */
export function createSign(params: SignParams, appSecret: string): string {
  return createHash('md5').update(buildSignSource(params, appSecret), 'utf8').digest('hex').toUpperCase();
}

/**
 * 补齐公共参数（appId / timestamp）后签名。
 * timestamp 固定传入便于单测；默认取当前毫秒时间戳（3 分钟内有效）。
 */
export function signRequest(
  params: SignParams,
  appId: string,
  appSecret: string,
  timestamp: number = Date.now(),
): SignParams & { sign: string } {
  const merged: SignParams = { ...params, appId, timestamp: String(timestamp) };
  return { ...merged, sign: createSign(merged, appSecret) };
}
