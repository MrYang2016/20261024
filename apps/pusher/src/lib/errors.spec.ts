/**
 * 验收契约来源：docs/execution-plan.md §六「错误映射（一句话原因 + 一个下一步）」。
 * 四条映射是计划逐字给出的客户向文案，属于验收内容：
 *   -12 streamurl authentication failed → 「上一次推流还没完全结束，请稍候几秒再试」
 *   NotAllowedError   → 「浏览器没有摄像头/麦克风权限，请在地址栏允许后重试」
 *   NotReadableError  → 「摄像头或麦克风被其他程序占用，关掉会议软件后重试」
 *   NotFoundError     → 「没有检测到摄像头，请接入设备后重试」
 *
 * 约定的实现位置与导出：
 *   apps/pusher/src/lib/errors.ts → export function mapPushError(error: unknown): string | { title/message/hint }
 *   返回形状未在计划里规定（一句话原因 + 一个下一步可能是单串，也可能是两字段），
 *   因此本文件把结果序列化成文本再断言文案出现，避免锁死实现形状。
 */
import { describe, expect, it } from 'vitest';
import * as errorsModule from './errors';

function resolveMapPushError(): (error: unknown) => unknown {
  const mod = errorsModule as unknown as Record<string, unknown>;
  const fn =
    (mod.mapPushError as Function | undefined) ??
    (mod.toPushError as Function | undefined) ??
    (mod.mapError as Function | undefined) ??
    (mod.describePushError as Function | undefined);
  expect(
    typeof fn,
    'apps/pusher/src/lib/errors.ts 需导出错误映射函数（约定名 mapPushError(error)）',
  ).toBe('function');
  return fn as (error: unknown) => unknown;
}

/** 把任意返回形状（string / Error / 对象）压成可断言的文本。 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

describe('mapPushError — 推流错误一句话映射', () => {
  it('-12 streamurl authentication failed → 竞态提示，而不是「鉴权失败」', () => {
    const mapPushError = resolveMapPushError();

    const mapped = textOf(
      mapPushError({ errCode: -12, code: -12, message: 'streamurl authentication failed' }),
    );

    expect(mapped).toContain('上一次推流还没完全结束，请稍候几秒再试');
    // 关键语义：不能把 -12 说成鉴权/密码问题，会把用户引向错误方向
    expect(mapped).not.toContain('鉴权失败');
    expect(mapped).not.toContain('appSecret');
  });

  it('NotAllowedError → 权限提示 + 下一步（地址栏允许）', () => {
    const mapPushError = resolveMapPushError();

    const mapped = textOf(
      mapPushError({ name: 'NotAllowedError', message: 'Permission denied' }),
    );

    expect(mapped).toContain('浏览器没有摄像头/麦克风权限，请在地址栏允许后重试');
  });

  it('NotReadableError → 设备被占用提示', () => {
    const mapPushError = resolveMapPushError();

    const mapped = textOf(
      mapPushError({ name: 'NotReadableError', message: 'Could not start video source' }),
    );

    expect(mapped).toContain('摄像头或麦克风被其他程序占用，关掉会议软件后重试');
  });

  it('NotFoundError → 没有检测到摄像头', () => {
    const mapPushError = resolveMapPushError();

    const mapped = textOf(
      mapPushError({ name: 'NotFoundError', message: 'Requested device not found' }),
    );

    expect(mapped).toContain('没有检测到摄像头，请接入设备后重试');
  });

  it('未知错误也有中文兜底文案，不透出原始报文 / [object Object] / undefined', () => {
    const mapPushError = resolveMapPushError();

    for (const unknownError of [new Error('some upstream failure'), { weird: true }, null, undefined]) {
      const mapped = textOf(mapPushError(unknownError));

      expect(mapped.trim().length, `未知错误 ${String(unknownError)} 必须有兜底文案`).toBeGreaterThan(0);
      expect(mapped).not.toContain('[object Object]');
      expect(mapped).not.toContain('undefined');
      expect(mapped).not.toContain('some upstream failure');
      // 兜底文案必须是中文，给讲师看得懂的一句话
      expect(mapped).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
