/**
 * 验收契约来源（本轮缺陷修复第 3 项 / docs/test-results.md §4.2 第 4 条）：
 *   对**同一不存在的频道**，`GET /api/channels/:id` 与 `GET /api/channels/:id/live-status`
 *   必须返回**相同状态码与文案**。
 *   修复前：detail → 502「上游服务暂时不可用，请稍后重试」，live-status → 200 unStart，
 *   前端再把两处措辞拼起来，出现「上游服务暂时不可用，请稍后重试，按提示处理后重试」。
 *
 * 不启动真网络、不打真 API：这里用一个「按 2026-10-23 实测上游报文抛 PolyvUpstreamError」的
 * PolyvClient 桩，走真实的 ChannelService → ChannelController 代码路径（含上游错误 → HttpException 翻译），
 * 断言最终对外的 HTTP 状态码与响应体。这样既覆盖了两层（service 的「频道不存在要 rethrow」+ 统一错误翻译），
 * 也不依赖任何凭证或外网。
 */
import { HttpException, Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';
import { PolyvUpstreamError } from '../polyv/polyv-errors';
import type { PolyvClient } from '../polyv/polyv.client';
import { PushSessionRegistry } from '../realtime/push-session.registry';

const MISSING_CHANNEL_ID = '999999999';
const EXISTING_CHANNEL_ID = '1000001';

/** 服务端对「频道不存在」的对外文案（apps/server/src/polyv/upstream-error.ts 的 CHANNEL_NOT_FOUND） */
const EXPECTED_NOT_FOUND_BODY = { code: 404, message: '频道不存在，请确认频道号后重试' };

type UpstreamHandler = () => unknown;

/**
 * 上游桩：按 path 返回/抛错，并记录调用到的 path。
 * 用 Promise.resolve().then() 包一层，让同步 throw 变成 rejection，贴近真 fetch 的异步语义。
 */
function createFakePolyv(handlers: Record<string, UpstreamHandler> = {}) {
  const calls: string[] = [];
  const run = (path: string): unknown => {
    calls.push(path);
    const handler =
      handlers[path] ??
      (() => {
        throw new Error(`spec 未 mock 的上游路径: ${path}`);
      });
    return handler();
  };
  const fake = {
    get: (path: string) => Promise.resolve().then(() => run(path)),
    post: (path: string) => Promise.resolve().then(() => run(path)),
  };
  return { polyv: fake as unknown as PolyvClient, calls };
}

/** 2026-10-23 实测：同一个不存在频道在三个上游接口上的真实返回（只保留分类需要的部分） */
function missingChannelUpstream(): Record<string, UpstreamHandler> {
  return {
    '/live/v4/channel/basic/get': () => {
      throw new PolyvUpstreamError(400, '找不到频道', 400);
    },
    '/live/v4/channel/live-status/list': () => {
      throw new PolyvUpstreamError(400, `存在非法频道ID: ${MISSING_CHANNEL_ID}`, 400);
    },
    '/live/v3/channel/stream/get-push-url': () => {
      throw new PolyvUpstreamError(403, `illegal channel id: ${MISSING_CHANNEL_ID}`, 403);
    },
  };
}

function createController(handlers: Record<string, UpstreamHandler> = {}) {
  const { polyv, calls } = createFakePolyv(handlers);
  const service = new ChannelService(polyv, new PushSessionRegistry());
  return { controller: new ChannelController(service), calls };
}

/** 断言接口抛了 HttpException，并把它取出来（没抛就是测试写错/产品悄悄成功了） */
async function catchHttp(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('期望接口抛出 HttpException，但它成功返回了');
}

beforeAll(() => {
  // 失败分支会写服务端日志（Nest Logger → stdout），测试里静音，避免污染 npm test 输出
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('频道不存在：detail 与 live-status 同口径（状态码 + 文案）', () => {
  it('两个接口都返回 404 与同一句「频道不存在」文案', async () => {
    const detailSide = createController(missingChannelUpstream());
    const statusSide = createController(missingChannelUpstream());

    const detailError = await catchHttp(() => detailSide.controller.detail(MISSING_CHANNEL_ID));
    const statusError = await catchHttp(() => statusSide.controller.liveStatus(MISSING_CHANNEL_ID));

    // 真的打到了上游（不是被频道号格式校验提前挡掉）
    expect(detailSide.calls).toContain('/live/v4/channel/basic/get');
    expect(statusSide.calls).toContain('/live/v4/channel/live-status/list');

    expect(detailError.getStatus(), 'GET /channels/:id 对不存在的频道必须是 404').toBe(404);
    expect(statusError.getStatus(), 'GET /channels/:id/live-status 口径必须一致').toBe(404);

    expect(detailError.getResponse()).toEqual(statusError.getResponse());
    expect(detailError.getResponse()).toEqual(EXPECTED_NOT_FOUND_BODY);
  });

  it('live-status：平台状态接口正常、但 basic/get 报「找不到频道」时依然 404（不被「观看数按 0 处理」吞掉）', async () => {
    const { controller, calls } = createController({
      '/live/v4/channel/live-status/list': () => [
        { channelId: Number(MISSING_CHANNEL_ID), liveStatus: 'unStart' },
      ],
      '/live/v4/channel/basic/get': () => {
        throw new PolyvUpstreamError(400, '找不到频道', 400);
      },
    });

    const error = await catchHttp(() => controller.liveStatus(MISSING_CHANNEL_ID));

    expect(calls).toContain('/live/v4/channel/basic/get');
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual(EXPECTED_NOT_FOUND_BODY);
  });

  it('对照：存在的频道两个接口都正常返回（证明上面的 404 是错误分类的结果，不是桩一律失败）', async () => {
    const { controller } = createController({
      '/live/v4/channel/basic/get': () => ({
        channelId: Number(EXISTING_CHANNEL_ID),
        name: '对照频道',
        template: 'alone',
        pageView: 5,
      }),
      '/live/v4/channel/live-status/list': () => [
        { channelId: Number(EXISTING_CHANNEL_ID), liveStatus: 'live' },
      ],
      '/live/v3/channel/stream/get-push-url': () =>
        `rtmp://push-t2.videocc.net/recordf/${EXISTING_CHANNEL_ID}_stream?txSecret=a&txTime=b`,
    });

    const detail = await controller.detail(EXISTING_CHANNEL_ID);
    expect(detail.name).toBe('对照频道');
    expect(detail.push.webrtcUrl).toMatch(/^webrtc:\/\/push-t2\.videocc\.net\/recordf\//);

    const snapshot = await controller.liveStatus(EXISTING_CHANNEL_ID);
    expect(snapshot).toEqual({ liveStatus: 'live', viewerCount: 5 });
  });

  it('上游故障（不是频道不存在）仍是 502，不会把所有错误都报成「频道不存在」', async () => {
    const { controller } = createController({
      // basic/get 网络不可达：PolyvClient 的真实形态
      '/live/v4/channel/basic/get': () => {
        throw new PolyvUpstreamError(-1, 'network unreachable');
      },
    });

    const error = await catchHttp(() => controller.detail(MISSING_CHANNEL_ID));

    expect(error.getStatus()).toBe(502);
    const body = error.getResponse() as { code: number; message: string };
    expect(body.code).toBe(502);
    expect(body.message).not.toContain('频道不存在');
    expect(body.message).toMatch(/[\u4e00-\u9fa5]/);
  });
});

/**
 * 验收契约来源：HACK-1024 docs/execution-plan.md §五 5.2 + §Done when 第 4 条第 5 项。
 *   - `ChannelInfo` 新增 `template: string` 与 `push.expiresAt: string | null`
 *   - `push.expiresAt` 从 `rtmpUrl` 查询串里的 `txTime`（**hex 秒**）解出 ISO 时间；解不出返回 `null`（不编造）
 *   - `template` 原样透出（D2 预检读它判断是否纯视频模板）
 * 行为不变的部分（频道不存在 → 404、上游故障 → 502）见上面的既有用例。
 */
describe('ChannelInfo 新增 template / push.expiresAt（24060）', () => {
  /** 2026-10-23 腾讯云线路真实地址形状：txTime 是 hex 秒 */
  const TX_TIME_HEX = '68F1A2B3';
  const TX_TIME_MS = Number.parseInt(TX_TIME_HEX, 16) * 1000;

  function channelUpstream(options: { template?: string; txTime?: string | null; txSecret?: string } = {}) {
    const template = options.template ?? 'alone';
    const query = [
      options.txSecret === undefined ? 'txSecret=abc123' : `txSecret=${options.txSecret}`,
      options.txTime === null ? null : `txTime=${options.txTime ?? TX_TIME_HEX}`,
    ]
      .filter((piece): piece is string => Boolean(piece))
      .join('&');

    return {
      '/live/v4/channel/basic/get': () => ({
        channelId: Number(EXISTING_CHANNEL_ID),
        name: '纯视频频道',
        template,
        pageView: 2,
      }),
      '/live/v3/channel/stream/get-push-url': () =>
        `rtmp://push-t2.videocc.net/recordf/${EXISTING_CHANNEL_ID}_stream?${query}`,
    };
  }

  it('template 原样透出为 alone（D2 预检的判定字段）', async () => {
    const { controller } = createController(channelUpstream());

    const detail = await controller.detail(EXISTING_CHANNEL_ID);

    expect(detail.template, 'ChannelInfo.template 必须是频道真实模板').toBe('alone');
  });

  it('push.expiresAt 与 rtmpUrl 里的 txTime（hex 秒）换算一致', async () => {
    const { controller } = createController(channelUpstream());

    const detail = await controller.detail(EXISTING_CHANNEL_ID);

    expect(detail.push.rtmpUrl).toContain(`txTime=${TX_TIME_HEX}`);
    expect(detail.push.expiresAt, 'expiresAt 必须是 txTime(hex 秒) × 1000 的 ISO 时间').toBe(
      new Date(TX_TIME_MS).toISOString(),
    );
    // 换算不是「把 hex 当十进制」这种经典错误：ISO 里的秒数必须等于 parseInt(hex, 16)
    expect(Math.floor(Date.parse(detail.push.expiresAt as string) / 1000)).toBe(
      Number.parseInt(TX_TIME_HEX, 16),
    );
  });

  it('txTime 是小写 hex 也能解析（上游大小写不保证）', async () => {
    const lowercaseHex = TX_TIME_HEX.toLowerCase();
    const { controller } = createController(channelUpstream({ txTime: lowercaseHex }));

    const detail = await controller.detail(EXISTING_CHANNEL_ID);

    expect(detail.push.expiresAt).toBe(new Date(TX_TIME_MS).toISOString());
  });

  it('txTime 缺失 → expiresAt 为 null（不编造过期时间）', async () => {
    const { controller } = createController(channelUpstream({ txTime: null }));

    const detail = await controller.detail(EXISTING_CHANNEL_ID);

    expect(detail.push.expiresAt, '解不出有效期必须是 null，不能填一个假时间').toBeNull();
  });

  it('txTime 是非法值 → expiresAt 为 null', async () => {
    const { controller } = createController(channelUpstream({ txTime: 'not-hex' }));

    const detail = await controller.detail(EXISTING_CHANNEL_ID);

    expect(detail.push.expiresAt).toBeNull();
  });
});
