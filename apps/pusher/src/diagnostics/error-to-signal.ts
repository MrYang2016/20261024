import type { DiagnosticId } from '@live1024/shared';
import type { PushErrorInfo } from '../lib/errors';

/**
 * 错误分类 → 诊断信号（D27：推流 / 设备错误只走诊断条）。
 *
 * 判定顺序：
 *   1. `lib/errors.ts` 已经给出 `diagnosticId` 就照抄（那份映射是全站唯一的错误分类来源）；
 *   2. 频道类错误（上游 502 里带模板字样）归 D2 / D1，其余频道错误**不归任何诊断项**，
 *      留在频道面板里内联展示（否则同一句话会在页面上出现两次）；
 *   3. 都没命中 → null（不硬塞一个诊断项）。
 */
export interface DiagnosticErrorSignal {
  /** 映射到的诊断项 */
  id: DiagnosticId;
  /** 一句话原因（沿用既有的客户向文案，不另写一句） */
  reason: string;
  /** 失败码 / 上游原文：只进详情，不上大屏 */
  detail: string;
  /** 错误发生时刻（ms） */
  at: number;
}

export function errorToDiagnosticSignal(
  error: PushErrorInfo | null | undefined,
  at: number,
): DiagnosticErrorSignal | null {
  if (!error) return null;

  const detail = [error.code, error.message].filter(Boolean).join(' · ');

  if (error.diagnosticId) {
    return { id: error.diagnosticId, reason: error.message, detail, at };
  }

  // 频道模板不符：上游文案或服务端 message 里带模板字样（服务端 502「频道模板不是纯视频…」）
  if (/模板|template|纯视频/i.test(error.message)) {
    return { id: 'D2', reason: error.message, detail, at };
  }

  // 服务端错误（非模板类）没有对应诊断项：留给频道面板，不重复一遍
  if (error.code.startsWith('api_')) return null;

  return null;
}

/**
 * 推流被拒且分类为「鉴权类」→ D1 的第二条触发路径（计划 §三）。
 * 上游说鉴权失败 / 地址无效时，不是网络问题，是这条地址不能用。
 */
export function isAuthRejection(error: PushErrorInfo | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'invalid_push_url') return true;
  return /auth|鉴权|签名|txsecret|expire|过期/i.test(`${error.message} ${error.nextStep}`);
}
