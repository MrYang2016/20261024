/**
 * 验收契约来源：docs/execution-plan.md §五「实现要点」：
 *   - Polyv 返回非 200 或 code != 200 时，转成 502 + { code, message: 客户向一句话 }，不把上游原始报文透给前端
 *   - 建频道失败（如模板不符合）时明确返回「频道模板不是纯视频，无法用于第三方推流」这类可执行信息
 *
 * 约定的实现位置：
 *   apps/server/src/polyv/upstream-error.ts → export function toUpstreamError(error): HttpException-like
 *   导出名容忍 toUpstreamError / mapUpstreamError / toPolyvError / toGatewayError。
 *
 * 返回对象形状未在计划里固定（Nest HttpException / { status, body } / { code, message } 都可能），
 * 因此本文件通过「状态码提取 + 文本序列化」两条通道做断言，不锁死实现形状。
 *
 * 本轮缺陷修复（docs/test-results.md §4.2 第 4 条）：
 *   原来「频道不存在」被当成上游故障转 502（「上游服务暂时不可用」），前端又拼上「按提示处理后重试」，
 *   与同一不存在频道的 live-status（200 unStart）口径不一致。
 *   → 验收：三条实测上游签名必须映射成 404 + 「频道不存在」；其它上游失败仍 502（不能把所有错误都变 404）。
 */
import { describe, expect, it } from 'vitest';
import * as upstreamErrorModule from './upstream-error';

function resolveToUpstreamError(): (error: unknown) => unknown {
  const mod = upstreamErrorModule as unknown as Record<string, unknown>;
  const fn =
    (mod.toUpstreamError as Function | undefined) ??
    (mod.mapUpstreamError as Function | undefined) ??
    (mod.toPolyvError as Function | undefined) ??
    (mod.toGatewayError as Function | undefined);
  expect(
    typeof fn,
    'apps/server/src/polyv/upstream-error.ts 需导出上游错误转换函数（约定名 toUpstreamError(error)）',
  ).toBe('function');
  return fn as (error: unknown) => unknown;
}

/** 状态码通道：兼容 HttpException.getStatus() / { status } / { statusCode }。 */
function statusOf(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, any>;
  if (typeof candidate.getStatus === 'function') return candidate.getStatus();
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  const response = candidate.getResponse?.();
  if (response && typeof response.statusCode === 'number') return response.statusCode;
  return undefined;
}

/** 文本通道：把任意返回形状压成一段可断言文本（含 JSON 内的 message）。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const parts: string[] = [];
  const candidate = value as Record<string, any>;
  if (candidate && typeof candidate === 'object') {
    parts.push(JSON.stringify(candidate));
    if (typeof candidate.getResponse === 'function') {
      try {
        parts.push(JSON.stringify(candidate.getResponse()));
      } catch {
        // ignore
      }
    }
    if (typeof candidate.message === 'string') parts.push(candidate.message);
  }
  return parts.join('\n');
}

/** 响应体通道：HttpException.getResponse() → 实际写入 HTTP body 的对象。 */
function bodyOf(value: unknown): Record<string, any> {
  const candidate = value as Record<string, any>;
  if (candidate && typeof candidate.getResponse === 'function') {
    const body = candidate.getResponse();
    if (body && typeof body === 'object') return body as Record<string, any>;
  }
  if (candidate && typeof candidate === 'object') return candidate;
  return {};
}

describe('toUpstreamError — Polyv 上游错误转客户向错误', () => {
  it('上游 code != 200 → 502，且不透出上游原始报文与凭证', () => {
    const toUpstreamError = resolveToUpstreamError();

    const mapped = toUpstreamError({
      status: 500,
      data: {
        code: 400,
        status: 'error',
        message: 'streamurl authentication failed: appSecret=leaked-secret',
        appSecret: 'leaked-secret',
      },
    });

    expect(statusOf(mapped), '上游失败必须转 502').toBe(502);

    const text = textOf(mapped);
    expect(text).toMatch(/[\u4e00-\u9fa5]/); // 客户向中文一句话
    expect(text).not.toContain('leaked-secret'); // 凭证绝不外泄
    expect(text).not.toContain('appSecret');
    expect(text).not.toContain('streamurl authentication failed'); // 原始报文不透给前端
  });

  it('上游 HTTP 非 200（无 body）→ 502 + 中文兜底文案', () => {
    const toUpstreamError = resolveToUpstreamError();

    const mapped = toUpstreamError({ status: 503, data: undefined });

    expect(statusOf(mapped)).toBe(502);
    expect(textOf(mapped)).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('模板不符合场景 → 可执行信息（指出「模板 / 纯视频」），而不是笼统失败', () => {
    const toUpstreamError = resolveToUpstreamError();

    const mapped = toUpstreamError({
      status: 200,
      data: {
        code: 400,
        message: 'channel template is not alone, third-party push is not supported',
        template: 'ppt',
      },
    });

    expect(textOf(mapped)).toMatch(/模板|纯视频/);
  });
});

const MISSING_CHANNEL_ID = '999999999';

/**
 * 2026-10-23 对不存在频道 `999999999` 的真实上游返回（三个上游接口各一条）：
 *   basic/get           → HTTP 400 `{"code":400,"error":{"code":400,"desc":"找不到频道"}}`
 *   stream/get-push-url → HTTP 403 `{"code":403,"message":"illegal channel id: 999999999"}`
 *   live-status/list    → HTTP 400 `{"code":400,"error":{"desc":"存在非法频道ID: 999999999"}}`
 * 三条都必须归为「频道不存在」→ 404，而不是 502。
 */
const REAL_CHANNEL_NOT_FOUND_RESPONSES: ReadonlyArray<{ name: string; payload: unknown }> = [
  {
    name: 'basic/get：error.desc「找不到频道」',
    payload: { status: 400, data: { code: 400, error: { code: 400, desc: '找不到频道' } } },
  },
  {
    name: 'stream/get-push-url：message「illegal channel id」',
    payload: { status: 403, data: { code: 403, message: `illegal channel id: ${MISSING_CHANNEL_ID}` } },
  },
  {
    name: 'live-status/list：error.desc「存在非法频道ID」',
    payload: { status: 400, data: { code: 400, error: { desc: `存在非法频道ID: ${MISSING_CHANNEL_ID}` } } },
  },
];

describe('toUpstreamError — 频道不存在的实测签名 → 404', () => {
  for (const { name, payload } of REAL_CHANNEL_NOT_FOUND_RESPONSES) {
    it(`${name} → 404 + 「频道不存在」客户向文案`, () => {
      const toUpstreamError = resolveToUpstreamError();

      const mapped = toUpstreamError(payload);

      expect(statusOf(mapped), '频道不存在必须是 404，不能笼统 502').toBe(404);

      const body = bodyOf(mapped);
      expect(body.code, '响应体 code 要与 HTTP 状态码一致').toBe(404);
      expect(String(body.message)).toContain('频道不存在');

      // 上游原始报文（英文/中文原文、频道号）绝不透给前端
      const text = textOf(mapped);
      expect(text).not.toContain('illegal channel id');
      expect(text).not.toContain('非法频道');
      expect(text).not.toContain('找不到频道');
      expect(text).not.toContain('上游服务暂时不可用');
    });
  }
});

describe('toUpstreamError — 不是所有上游失败都变成 404', () => {
  const GENERIC_UPSTREAM_FAILURES: ReadonlyArray<{ name: string; payload: unknown }> = [
    {
      name: '参数错误 400（描述里没有「频道不存在」特征）',
      payload: { status: 400, data: { code: 400, message: 'parameter name is required' } },
    },
    {
      name: '上游 500 内部错误',
      payload: { status: 500, data: { code: 500, message: 'internal error, please contact admin' } },
    },
    {
      name: '纯网络失败（无响应体）',
      payload: { status: 503, data: undefined },
    },
  ];

  for (const { name, payload } of GENERIC_UPSTREAM_FAILURES) {
    it(`${name} → 仍为 502，不当成频道不存在`, () => {
      const toUpstreamError = resolveToUpstreamError();

      const mapped = toUpstreamError(payload);

      expect(statusOf(mapped), '其它上游失败必须保留 502 语义').toBe(502);

      const body = bodyOf(mapped);
      expect(body.code).toBe(502);
      expect(String(body.message), '502 文案不能误报成「频道不存在」').not.toContain('频道不存在');
      expect(String(body.message)).toMatch(/[\u4e00-\u9fa5]/);
      expect(textOf(mapped)).not.toContain('parameter name is required');
    });
  }
});
