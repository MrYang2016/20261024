/**
 * 验收契约来源：docs/execution-plan.md
 *   - §三 D2 的判定口径（D29）：服务端对非纯视频模板仍返回 **502 + 「频道模板不是纯视频…」**，
 *     推流端 `error-to-signal.ts` 用 `/模板|template|纯视频/` 把它映射成 D2；
 *     `ChannelInfo.template` 只用于正常态展示，不作为唯一判定源。
 *   - §三 D1：推流被拒且错误分类为鉴权类 → D1 的第二条触发路径。
 *   - D27：推流 / 设备错误只走诊断条，所以分类必须先落到一个诊断项（或明确不归任何诊断项）。
 *
 * 这一层只锁「错误 → 诊断信号」的映射本身；错误 → 一句话文案的映射在 `lib/errors.spec.ts` 里锁。
 * 端到端（自检条上真的出现 D2 + 帮助链接）在 `e2e/diagnostics.spec.ts` 的「D2 预检」主路径里锁。
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import { mapPushError } from '../lib/errors';
import { PushTransportError } from '../transports/types';
import { errorToDiagnosticSignal, isAuthRejection } from './error-to-signal';

/** 与 `apps/server/src/polyv/upstream-error.ts` 的 TEMPLATE_MISMATCH 逐字一致 */
const TEMPLATE_MESSAGE =
  '频道模板不是纯视频，无法用于第三方推流，请在直播后台改为纯视频模板后重试';
/** 与同一个文件的 UPSTREAM_FAILED 逐字一致（不含模板字样的 502） */
const UPSTREAM_FAILED_MESSAGE = '上游服务暂时不可用，请稍后重试';

const AT = Date.parse('2026-10-23T07:30:12.000Z');

describe('errorToDiagnosticSignal — 服务端 502 模板错误 → D2（D29）', () => {
  it('ApiRequestError(502, 「频道模板不是纯视频…」) → D2，原因原样保留、详情带 api_502', () => {
    const error = mapPushError(new ApiRequestError(502, 502, TEMPLATE_MESSAGE));

    const signal = errorToDiagnosticSignal(error, AT);

    expect(signal, '模板类 502 必须映射成 D2，不能落到兜底分类').not.toBeNull();
    expect(signal?.id).toBe('D2');
    expect(signal?.reason, '一句话原因用服务端那句可执行文案，不另写一套').toBe(TEMPLATE_MESSAGE);
    expect(signal?.detail, '详情里要能对上服务端状态码（讲师报障时能核对）').toContain('api_502');
    expect(signal?.detail).toContain(TEMPLATE_MESSAGE);
    expect(signal?.at, '诊断时刻用调用方给的时刻（同一 tick 内一致）').toBe(AT);
  });

  it('不含模板字样的 502（上游不可用）不硬塞诊断项（留给频道面板，D27 不重复一遍）', () => {
    const error = mapPushError(new ApiRequestError(502, 502, UPSTREAM_FAILED_MESSAGE));

    expect(errorToDiagnosticSignal(error, AT)).toBeNull();
  });

  it('没有错误 → null（不能凭空生成一条诊断）', () => {
    expect(errorToDiagnosticSignal(null, AT)).toBeNull();
    expect(errorToDiagnosticSignal(undefined, AT)).toBeNull();
  });
});

describe('isAuthRejection — D1 的第二条触发路径', () => {
  it('传输层 invalid_push_url → 鉴权类（D1）', () => {
    const error = mapPushError(new PushTransportError('invalid_push_url', '推流地址不可用'));

    expect(isAuthRejection(error)).toBe(true);
  });

  it('模板不符的 502 不是鉴权问题（不能误判成 D1 把 D2 顶掉）', () => {
    const error = mapPushError(new ApiRequestError(502, 502, TEMPLATE_MESSAGE));

    expect(isAuthRejection(error)).toBe(false);
  });
});
