/**
 * 验收契约来源：CONTEXT.md **D39**（评审人 2026-10-23 第二次实测）
 *
 * 真实缺陷：关 Wi-Fi 后刷新推流端，自检条仍显示「预检通过，可以开播」。
 * 根因有两层，本文件锁服务端这一层：
 *   浏览器到 `127.0.0.1:3100` 走**回环**，断网不影响；而 `GET /api/health` 在上游
 *   （api.polyv.net）不可达时**仍然回 HTTP 200 + `{ok:true, polyv:'unreachable'}`**，
 *   前端只判 `response.ok` → 把「上游不可达」当成「网络正常」。
 *
 * D39 ① 的契约：
 *   - 上游可达                         → `200 { ok: true,  polyv: 'reachable' }`
 *   - 上游**网络层**失败（code `-1`）    → `503 { ok: false, polyv: 'unreachable' }`
 *     （本进程活着 ≠ 外部可达：进程存活用 503 表达「我活着，但我连不上外面」）
 *   - 上游业务错误（如 10019 频道不存在）→ `200 { ok: true,  polyv: 'reachable' }`
 *     （上游回了业务报文 = 上游可达，业务错误不该让预检判「断网」）
 *   - 未配置凭证                        → `200 { ok: true,  polyv: 'unreachable' }`（保持 24059 既有行为）
 *
 * 做法与 `channel.controller.spec.ts` / `diagnostics.controller.spec.ts` 一致：不启 HTTP 服务器、
 * 不引 supertest，直接调 controller 拿返回值 / `HttpException`，断言最终对外状态码与响应体。
 * 上游用 `PolyvClient` 桩：只实现 `get`，按用例返回或抛 `PolyvUpstreamError`。
 */
import { HttpException } from '@nestjs/common';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import { PolyvUpstreamError } from '../polyv/polyv-errors';
import type { PolyvClient } from '../polyv/polyv.client';
import { loadEnvFiles } from '../env';

/** 健康检查打的上游路径（polyv.client 的薄封装，这里只关心「有没有真的探上游」） */
const HEALTH_UPSTREAM_PATH = '/live/v4/channel/live-status/list';
const HEALTH_CHANNEL_ID = '892222333';

/** 上游业务错误码：「频道不存在」类（2026-10-23 实测口径，见 polyv-errors.ts） */
const BUSINESS_ERROR_CODE = 10019;

type UpstreamHandler = () => unknown;

interface HealthCall {
  status: number;
  body: Record<string, unknown>;
}

/** 上游桩：`get` 记录调用并按 handler 返回 / 抛错；`post` 不该被健康检查用到 */
function createFakePolyv(handler: UpstreamHandler) {
  const calls: Array<{ path: string; params: unknown }> = [];
  const client = {
    get(path: string, params: unknown): Promise<unknown> {
      calls.push({ path, params });
      // 用 Promise.resolve().then 包一层：同步 throw 也变成 rejection，贴近真 fetch 的异步语义
      return Promise.resolve().then(handler);
    },
    post(): never {
      throw new Error('健康检查不应该调用上游 POST');
    },
  } as unknown as PolyvClient;
  return { client, calls };
}

/**
 * 调一次健康检查并归一化成 `{ status, body }`。
 *
 * D39 要求上游不可达时是 **503**，NestJS 里只能用 `HttpException`（或子类）表达，
 * 所以这里把「返回值」和「抛 HttpException」两种实现都归一化：实现选哪种都能被断言。
 */
async function callHealth(controller: HealthController): Promise<HealthCall> {
  try {
    const body = await controller.check();
    return { status: 200, body: body as unknown as Record<string, unknown> };
  } catch (error) {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const body =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : { message: response };
      return { status: error.getStatus(), body };
    }
    throw error;
  }
}

const PREVIOUS_ENV = {
  POLYV_APP_ID: process.env.POLYV_APP_ID,
  POLYV_APP_SECRET: process.env.POLYV_APP_SECRET,
  POLYV_USER_ID: process.env.POLYV_USER_ID,
  POLYV_HEALTH_CHANNEL_ID: process.env.POLYV_HEALTH_CHANNEL_ID,
};

beforeEach(() => {
  // dotenv 的 override:false 不会覆盖已存在的键，所以这里先落一份确定值，避免跑真 .env 里的凭证
  loadEnvFiles();
  process.env.POLYV_APP_ID = 'spec-app-id';
  process.env.POLYV_APP_SECRET = 'spec-app-secret';
  process.env.POLYV_USER_ID = 'spec-user-id';
  process.env.POLYV_HEALTH_CHANNEL_ID = HEALTH_CHANNEL_ID;
});

afterAll(() => {
  for (const [key, value] of Object.entries(PREVIOUS_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /api/health — 上游可达性（D39）', () => {
  it('上游可达 → 200 { ok: true, polyv: reachable }', async () => {
    const { client, calls } = createFakePolyv(() => ({ liveStatus: 'live' }));
    const result = await callHealth(new HealthController(client));

    expect(result.status, '上游可达时必须是 200').toBe(200);
    expect(result.body).toMatchObject({ ok: true, polyv: 'reachable' });
    expect(calls, '健康检查必须真的打一次上游（不能只报本进程活着）').toHaveLength(1);
    expect(calls[0]?.path, '健康检查应打 live-status/list').toBe(HEALTH_UPSTREAM_PATH);
  });

  it('上游网络层失败（PolyvUpstreamError(-1)）→ 503 { ok: false, polyv: unreachable }', async () => {
    const { client } = createFakePolyv(() => {
      throw new PolyvUpstreamError(-1, 'network unreachable');
    });
    const result = await callHealth(new HealthController(client));

    expect(
      result.status,
      'D39 ①：上游不可达必须是 503（旧实现回 200，前端只看 response.ok 就会误判网络正常）',
    ).toBe(503);
    expect(result.body).toMatchObject({ ok: false, polyv: 'unreachable' });
  });

  it('上游业务错误（10019 频道不存在）→ 200 { ok: true, polyv: reachable }', async () => {
    const { client } = createFakePolyv(() => {
      throw new PolyvUpstreamError(BUSINESS_ERROR_CODE, '频道不存在', 400);
    });
    const result = await callHealth(new HealthController(client));

    expect(
      result.status,
      '上游回了业务报文 = 上游可达；业务错误不能判成「断网」，否则预检会拦死正常开播',
    ).toBe(200);
    expect(result.body).toMatchObject({ ok: true, polyv: 'reachable' });
  });

  it('未配置凭证 → 200 { ok: true, polyv: unreachable }（保持 24059 既有行为）', async () => {
    process.env.POLYV_APP_ID = '';
    process.env.POLYV_APP_SECRET = '';
    const { client, calls } = createFakePolyv(() => {
      throw new Error('没有凭证时不应该打上游');
    });
    const result = await callHealth(new HealthController(client));

    expect(result.status, '没凭证不是「服务端挂了」，保持 200').toBe(200);
    expect(result.body).toMatchObject({ ok: true, polyv: 'unreachable' });
    expect(calls, '没有凭证时不能打上游').toHaveLength(0);
  });
});
