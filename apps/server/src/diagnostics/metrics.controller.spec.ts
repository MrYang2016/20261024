/**
 * 验收契约来源：docs/execution-plan.md §十一 A 段 + CONTEXT.md D34
 *   - `apps/server/src/diagnostics/metrics.controller.ts`（新增）：
 *       POST /api/channels/:channelId/metrics  → 201 `{ channelId, stored: true, total }`
 *       GET  /api/channels/:channelId/metrics?limit=300 → `{ channelId, items }`（按 `at` 升序）
 *   - 频道号复用现有 `assertChannelId` 口径（`/^\d{4,20}$/` → 否则 400「频道号格式不正确」）
 *   - 计划正文只给了「缺 at / kbps 非数字 / 频道号非法 → 400」，没给错误文案 →
 *     本文件断言状态码 + `{code: 400}` + 非空中文 message，不锁定具体措辞（避免凭空发明契约）。
 *
 * 不起 HTTP 服务器（仓库没有 supertest）：直接调 controller 方法拿 HttpException / 返回体，
 * 与 `diagnostics.controller.spec.ts` 的既有做法一致。
 * 「201」由 Nest 的 @Post 默认状态码保证，所以这里用路由元数据断言：
 * 路由是 POST、路径是 `channels/:channelId/metrics`、且没有用 @HttpCode 改成别的状态码。
 */
import { BadRequestException, HttpException, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import * as metricsControllerModule from './metrics.controller';
import * as metricsServiceModule from './metrics.service';

const CHANNEL_ID = '1000001';
const REPORT_NAMES = ['report', 'create', 'record', 'append', 'store', 'post'];
const LIST_NAMES = ['list', 'series', 'history', 'findAll', 'query'];

type AnyFn = (...args: unknown[]) => unknown;

interface MetricSample {
  kbps: number;
  fps: number;
  dropFps?: number;
  connection: string;
  at: string;
}

function pickMethod(target: object, names: string[], label: string): AnyFn {
  const bag = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const candidate = bag[name];
    // 必须 bind：引用出来的方法丢掉 this 会读不到注入的 service
    if (typeof candidate === 'function') return (candidate as AnyFn).bind(target);
  }
  throw new Error(`${label} 需提供以下方法之一：${names.join(' / ')}`);
}

function resolveCtor(moduleBag: unknown, names: string[], label: string): new (...args: never[]) => object {
  const bag = moduleBag as unknown as Record<string, unknown>;
  for (const name of names) {
    const candidate = bag[name];
    if (typeof candidate === 'function') return candidate as new (...args: never[]) => object;
  }
  throw new Error(`${label} 需导出以下类之一：${names.join(' / ')}`);
}

function createController() {
  const ServiceCtor = resolveCtor(
    metricsServiceModule,
    ['MetricsService', 'MetricsStore', 'MetricsHistoryService'],
    'apps/server/src/diagnostics/metrics.service.ts',
  );
  const ControllerCtor = resolveCtor(
    metricsControllerModule,
    ['MetricsController'],
    'apps/server/src/diagnostics/metrics.controller.ts',
  );

  // Nest 控制器是 @Injectable，单测直接 new 并把 service 传进去
  const service = new ServiceCtor();
  const controller = new (ControllerCtor as unknown as new (service: object) => object)(service);

  return {
    controller,
    service,
    report: pickMethod(controller, REPORT_NAMES, 'MetricsController.report'),
    list: pickMethod(controller, LIST_NAMES, 'MetricsController.list'),
  };
}

function sampleAt(offsetMs: number, overrides: Partial<MetricSample> = {}): MetricSample {
  const at = new Date(Date.parse('2026-10-23T08:12:35.000Z') + offsetMs).toISOString();
  return { kbps: 412, fps: 20, dropFps: 0, connection: 'connected', at, ...overrides };
}

interface StoreResultBody {
  channelId?: string;
  stored?: boolean;
  total?: number;
}

interface ListBody {
  channelId?: string;
  items?: MetricSample[];
}

/** 取原型上的原始方法（不 bind）：Nest 的路由元数据挂在它上面 */
function rawMethod(target: object, names: string[], label: string): object {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor && typeof descriptor.value === 'function') return descriptor.value as object;
  }
  throw new Error(`${label} 需提供以下方法之一：${names.join(' / ')}`);
}

/** 断言抛了 HttpException 并取出来（没抛 = 该拒绝的请求被放过了） */
async function catchHttp(run: () => unknown): Promise<HttpException> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('期望抛出 HttpException，但接口成功返回了');
}

/** 400 的统一断言：状态码 + 统一错误体 {code:400,message:<非空中文>}，不锁具体文案 */
function expectBadRequest(error: HttpException): void {
  expect(error).toBeInstanceOf(BadRequestException);
  expect(error.getStatus()).toBe(400);
  const body = error.getResponse() as { code?: number; message?: string };
  expect(body.code, '错误体必须走统一 ApiErrorBody（code=400）').toBe(400);
  expect(typeof body.message).toBe('string');
  expect((body.message ?? '').length, '错误体必须给客户向一句话').toBeGreaterThan(0);
}

describe('路由契约（D34）：POST/GET /api/channels/:channelId/metrics', () => {
  it('控制器挂在 channels/:channelId/metrics 下，POST 默认 201、GET 默认 200', () => {
    const ControllerCtor = resolveCtor(
      metricsControllerModule,
      ['MetricsController'],
      'apps/server/src/diagnostics/metrics.controller.ts',
    ) as unknown as new (...args: never[]) => object;

    const controllerPath = String(Reflect.getMetadata(PATH_METADATA, ControllerCtor) ?? '');
    expect(controllerPath, '路由前缀必须是 channels/:channelId/metrics').toMatch(
      /^\/?channels\/:channelId\/metrics$/,
    );

    const proto = ControllerCtor.prototype;
    // 路由元数据挂在**原始方法**上：不能取 bind 过的引用（bind 出来的函数没有 Nest 元数据）
    const reportHandler = rawMethod(proto, REPORT_NAMES, 'MetricsController.report');
    const listHandler = rawMethod(proto, LIST_NAMES, 'MetricsController.list');

    expect(
      Reflect.getMetadata(METHOD_METADATA, reportHandler),
      '上报纸样必须是 POST',
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(METHOD_METADATA, listHandler),
      '读取采样必须是 GET',
    ).toBe(RequestMethod.GET);

    // Nest 对 @Post 的默认状态码就是 201；出现 @HttpCode(...) 元数据说明被改过（契约要求 201）
    const httpCode = Reflect.getMetadata('__httpCode__', reportHandler);
    expect(httpCode, '上报必须保持 201（不得用 @HttpCode 改成 200）').toBeUndefined();
  });
});

describe('POST /channels/:channelId/metrics — 正常上报', () => {
  it('合法上报返回 `{ channelId, stored: true, total }`，并且 GET 能按升序读到', async () => {
    const { report, list } = createController();

    const created = (await report(CHANNEL_ID, sampleAt(0))) as StoreResultBody;
    expect(created.channelId, '返回体必须回显频道号').toBe(CHANNEL_ID);
    expect(created.stored, '内存态写入必须显式回报 stored').toBe(true);
    expect(created.total, 'total 是该频道当前采样条数').toBe(1);

    await report(CHANNEL_ID, sampleAt(5_000, { kbps: 500 }));
    const response = (await list(CHANNEL_ID, 300)) as ListBody;

    expect(response.channelId).toBe(CHANNEL_ID);
    expect(response.items).toHaveLength(2);
    expect(response.items?.map((item) => item.kbps), 'GET 必须按 at 升序').toEqual([412, 500]);
    expect(response.items?.[0].at).toBe(sampleAt(0).at);
    expect(response.items?.[0].connection).toBe('connected');
  });

  it('total 随采样条数增长（每 5 秒一条，不做合并）', async () => {
    const { report } = createController();

    const first = (await report(CHANNEL_ID, sampleAt(0))) as StoreResultBody;
    const second = (await report(CHANNEL_ID, sampleAt(5_000))) as StoreResultBody;
    const third = (await report(CHANNEL_ID, sampleAt(10_000))) as StoreResultBody;

    expect([first.total, second.total, third.total]).toEqual([1, 2, 3]);
  });
});

describe('POST /channels/:channelId/metrics — 入参校验（400）', () => {
  it('缺 at → 400，且不写入（GET 仍是空）', async () => {
    const { report, list } = createController();

    const withoutAt: Record<string, unknown> = { ...sampleAt(0) };
    delete withoutAt.at;

    const error = await catchHttp(() => report(CHANNEL_ID, withoutAt));
    expectBadRequest(error);

    const response = (await list(CHANNEL_ID)) as ListBody;
    expect(response.items, '非法 payload 不能进缓冲（否则曲线里会出现没有时间的点）').toEqual([]);
  });

  it('at 不是时间 → 400', async () => {
    const { report } = createController();

    const error = await catchHttp(() => report(CHANNEL_ID, sampleAt(0, { at: 'not-a-date' })));
    expectBadRequest(error);
  });

  it('kbps 非数字（"abc" / null / 缺失）→ 400', async () => {
    const { report } = createController();

    for (const badKbps of ['abc', null, undefined]) {
      const body = { ...sampleAt(0), kbps: badKbps };
      const error = await catchHttp(() => report(CHANNEL_ID, body));
      expectBadRequest(error);
    }
  });

  it('fps 非数字 → 400（曲线要画 fps，脏值同样不能进）', async () => {
    const { report } = createController();

    const error = await catchHttp(() => report(CHANNEL_ID, { ...sampleAt(0), fps: 'ten' }));
    expectBadRequest(error);
  });

  it('频道号格式非法 → 400「频道号格式不正确」（复用现有频道接口口径）', async () => {
    const { report } = createController();

    for (const badChannelId of ['abc', '12', '123456789012345678901', '']) {
      const error = await catchHttp(() => report(badChannelId, sampleAt(0)));
      expectBadRequest(error);
      expect(
        (error.getResponse() as { message?: string }).message,
        '频道号文案要与既有频道接口一致（客户看到的是同一句话）',
      ).toBe('频道号格式不正确');
    }
  });

  it('上报体缺失（undefined）→ 400，不崩', async () => {
    const { report } = createController();

    const error = await catchHttp(() => report(CHANNEL_ID, undefined));
    expectBadRequest(error);
  });
});

describe('GET /channels/:channelId/metrics — 读取与 limit', () => {
  it('频道号非法 → 400', async () => {
    const { list } = createController();

    const error = await catchHttp(() => list('abc', 300));
    expectBadRequest(error);
    expect((error.getResponse() as { message?: string }).message).toBe('频道号格式不正确');
  });

  it('没上报过的频道返回空 items（不是 404、不编造数据）', async () => {
    const { list } = createController();

    const response = (await list('1000020', undefined)) as ListBody;
    expect(response.channelId).toBe('1000020');
    expect(response.items).toEqual([]);
  });

  it('limit 走 HTTP 查询串时是字符串（?limit=2）：能解析，超过上限夹到 300', async () => {
    const { report, list } = createController();
    for (let index = 0; index < 5; index += 1) {
      await report(CHANNEL_ID, sampleAt(index * 5_000, { kbps: 100 + index }));
    }

    const two = (await list(CHANNEL_ID, '2')) as ListBody;
    expect(two.items, '?limit=2 必须只返回 2 条').toHaveLength(2);

    const huge = (await list(CHANNEL_ID, '9999')) as ListBody;
    expect(huge.items?.length ?? 0, 'limit 上限 300').toBeLessThanOrEqual(300);
  });
});
