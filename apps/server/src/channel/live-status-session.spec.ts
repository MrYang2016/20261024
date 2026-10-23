/**
 * 验收契约来源：docs/sequence-diagram.md §1
 *   `liveStatus = 平台状态 ∪ PushSessionRegistry 会话`
 *   `viewerCount = pageView`（累计观看人次，非实时在线）
 * 以及 CONTEXT.md 已实测事实：「平台状态接口对 API 新建频道不可靠（观众能看但接口报 unStart）」
 *   → 推流端本地会话优先级最高；报过 stopped 且平台还没跟上时判为已结束。
 *
 * 评审 W5：`PushSessionRegistry` + 60s 心跳 + resolveLiveStatus 合并是本单**唯一**能让平台
 * 接口不可靠时仍显示「直播中」的机制，但没有任何自动化锁 —— 本文件直接走真实的
 * ChannelService.getLiveStatus（上游用桩，不联网），断言四种合并结果与 TTL 时效。
 *
 * 明确不锁的一条：平台残留 `live` 且本地已 stopped 时的优先级（评审 W2 未修，属于建议项），
 * 这里不断言该组合，避免制造一条无人修的红色断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelService } from './channel.service';
import { PolyvUpstreamError } from '../polyv/polyv-errors';
import type { PolyvClient } from '../polyv/polyv.client';
import { PushSessionRegistry } from '../realtime/push-session.registry';
import type { LiveStatus } from '@live1024/shared';

const CHANNEL_ID = '1000001';
const PAGE_VIEW = 42;
const SESSION_TTL_MS = 150_000;
const STOPPED_HOLD_MS = 10 * 60_000;
const T0 = new Date('2026-10-23T10:00:00.000Z');

type Handler = () => unknown;

/** 与 channel.controller.spec.ts 同款上游桩：按 path 返回/抛错，同步 throw 转成 rejection */
function createService(platformStatus: LiveStatus | 'missing', handlers: Record<string, Handler> = {}) {
  const calls: string[] = [];
  const table: Record<string, Handler> = {
    '/live/v4/channel/live-status/list': () => [{ channelId: Number(CHANNEL_ID), liveStatus: platformStatus }],
    '/live/v4/channel/basic/get': () => ({
      channelId: Number(CHANNEL_ID),
      name: '会话合并测试频道',
      template: 'alone',
      pageView: PAGE_VIEW,
    }),
    ...handlers,
  };

  const polyv = {
    get: (path: string) => {
      calls.push(path);
      return Promise.resolve().then(() => {
        const handler = table[path];
        if (!handler) throw new Error(`spec 未 mock 的上游路径: ${path}`);
        return handler();
      });
    },
    post: (path: string) => {
      calls.push(path);
      return Promise.resolve().then(() => {
        const handler = table[path];
        if (!handler) throw new Error(`spec 未 mock 的上游路径: ${path}`);
        return handler();
      });
    },
  } as unknown as PolyvClient;

  const sessions = new PushSessionRegistry();
  return { service: new ChannelService(polyv, sessions), sessions, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getLiveStatus — 平台状态 ∪ 推流会话', () => {
  it('平台报 unStart（API 新建频道的常见实况）+ 推流端刚上报 started → live', async () => {
    const { service, sessions } = createService('unStart');
    sessions.mark(CHANNEL_ID, 'started');

    const snapshot = await service.getLiveStatus(CHANNEL_ID);

    expect(snapshot.liveStatus, '平台接口不可靠时，推流端会话必须能把状态校正成直播中').toBe('live');
    expect(snapshot.viewerCount, 'viewerCount 必须来自平台 pageView（累计观看人次）').toBe(PAGE_VIEW);
  });

  it('60s 心跳续期后仍在推流中：第一次上报 200s 后（距最近心跳 140s）→ live', async () => {
    const { service, sessions } = createService('unStart');
    sessions.mark(CHANNEL_ID, 'started');
    vi.advanceTimersByTime(60_000);
    sessions.mark(CHANNEL_ID, 'started');
    vi.advanceTimersByTime(140_000);

    const snapshot = await service.getLiveStatus(CHANNEL_ID);

    expect(snapshot.liveStatus).toBe('live');
  });

  it('心跳断了超过 150s（推流端进程被杀）→ 自动交还平台状态，不永久挂直播中', async () => {
    const { service, sessions } = createService('unStart');
    sessions.mark(CHANNEL_ID, 'started');

    vi.advanceTimersByTime(SESSION_TTL_MS + 1_000);
    const snapshot = await service.getLiveStatus(CHANNEL_ID);

    expect(snapshot.liveStatus, '会话超过 TTL 必须失效（自愈）').toBe('unStart');
  });

  it('推流端上报 stopped + 平台还没跟上（unStart）→ end（观看页必须回到已结束）', async () => {
    const { service, sessions } = createService('unStart');
    sessions.mark(CHANNEL_ID, 'stopped');

    const snapshot = await service.getLiveStatus(CHANNEL_ID);

    expect(snapshot.liveStatus, '点停止后观看页要回到「已结束」').toBe('end');
  });

  it('stopped 保持窗口 10 分钟内一直是 end，超过窗口交还平台状态', async () => {
    const { service, sessions } = createService('unStart');
    sessions.mark(CHANNEL_ID, 'stopped');

    vi.advanceTimersByTime(STOPPED_HOLD_MS - 1_000);
    expect((await service.getLiveStatus(CHANNEL_ID)).liveStatus).toBe('end');

    vi.advanceTimersByTime(2_000);
    expect(
      (await service.getLiveStatus(CHANNEL_ID)).liveStatus,
      '超过 10 分钟保持窗口后不能永远显示已结束',
    ).toBe('unStart');
  });

  it('没有会话上报时完全跟随平台状态（live / playback / unStart）', async () => {
    for (const platform of ['live', 'playback', 'unStart'] as const) {
      const { service } = createService(platform);
      const snapshot = await service.getLiveStatus(CHANNEL_ID);
      expect(snapshot.liveStatus, `平台 ${platform} 必须原样透传`).toBe(platform);
      expect(snapshot.viewerCount).toBe(PAGE_VIEW);
    }
  });

  it('推流中且平台也报 live：仍是 live，观看数不受合并逻辑影响', async () => {
    const { service, sessions } = createService('live');
    sessions.mark(CHANNEL_ID, 'started');

    const snapshot = await service.getLiveStatus(CHANNEL_ID);

    expect(snapshot.liveStatus).toBe('live');
    expect(snapshot.viewerCount).toBe(PAGE_VIEW);
  });

  it('频道不存在仍然 404（会话合并不吞掉上游错误分类）', async () => {
    const { service, sessions } = createService('unStart', {
      '/live/v4/channel/live-status/list': () => {
        throw new PolyvUpstreamError(400, `存在非法频道ID: ${CHANNEL_ID}`, 400);
      },
    });
    sessions.mark(CHANNEL_ID, 'started');

    await expect(service.getLiveStatus(CHANNEL_ID)).rejects.toBeInstanceOf(PolyvUpstreamError);
  });
});
