/**
 * 验收契约来源：docs/execution-plan.md
 *   - §五 接口契约：`GET /channels/:channelId/live-status` 返回 `{ liveStatus: 'unStart'|'live'|'end'|'playback', viewerCount }`
 *   - §五「实现要点」：Polyv 返回非 200 / code != 200 转 502，不把上游原始报文透给前端
 *   - §Done when 第 9 条（其可测的一半）：返回的 liveStatus 必须是合法枚举值
 *     （另一端「真实调用返回含 txSecret 的 webrtcUrl」属真实冒烟，交 TestRunner）
 *
 * 约定的实现位置：
 *   apps/server/src/channel/live-status.ts  →  export function toLiveStatus(raw: unknown): LiveStatus
 *   导出名容忍 toLiveStatus / normalizeLiveStatus / mapLiveStatus。
 *
 * 为什么单测这个纯函数：CONTEXT.md 记录「平台状态接口对 API 新建频道不可靠」，
 * 上游可能给 "waiting"、true/false、undefined 之类值；服务端必须收敛到 4 个枚举值，
 * 否则前端状态条会出现未定义分支。
 */
import { describe, expect, it } from 'vitest';
import * as liveStatusModule from './live-status';

const VALID = ['unStart', 'live', 'end', 'playback'] as const;

function resolveToLiveStatus(): (raw: unknown) => string {
  const mod = liveStatusModule as unknown as Record<string, unknown>;
  const fn =
    (mod.toLiveStatus as Function | undefined) ??
    (mod.normalizeLiveStatus as Function | undefined) ??
    (mod.mapLiveStatus as Function | undefined) ??
    (mod.toLiveStatusEnum as Function | undefined);
  expect(
    typeof fn,
    'apps/server/src/channel/live-status.ts 需导出状态归一函数（约定名 toLiveStatus(raw)）',
  ).toBe('function');
  return fn as (raw: unknown) => string;
}

describe('toLiveStatus — 上游直播状态归一', () => {
  it('四个合法枚举值原样透传', () => {
    const toLiveStatus = resolveToLiveStatus();

    for (const value of VALID) {
      expect(toLiveStatus(value), `${value} 应原样透传`).toBe(value);
    }
  });

  it('上游不可靠值（waiting / true / undefined / 空串）不得穿透成非法枚举，也不抛异常', () => {
    const toLiveStatus = resolveToLiveStatus();

    const unreliable = [undefined, null, '', 'waiting', true, false, 0, 'unknown', {}, []];

    // 不断言兜底值必须是 unStart：计划只说返回合法枚举值，兜底语义由 CodingAgent 定；
    // 这里锁的是「前端永远不会收到 4 个枚举之外的值」。
    for (const raw of unreliable) {
      const result = toLiveStatus(raw);
      expect(VALID as readonly string[], `原始值 ${JSON.stringify(raw)} 归一结果非法`).toContain(
        result,
      );
    }
  });

  it('任何奇怪输入都只能产出 4 个合法枚举值之一（前端不留未定义分支）', () => {
    const toLiveStatus = resolveToLiveStatus();

    // 不断言「LIVE 必须归一成 live」——计划未规定大小写容错，只要求不产出非法枚举。
    for (const raw of ['LIVE', ' live ', 'Live', 'UNSTART', 'END', 'playBack', '开始', 1, NaN]) {
      expect(VALID as readonly string[], `原始值 ${String(raw)} 归一结果非法`).toContain(
        toLiveStatus(raw),
      );
    }
  });
});
