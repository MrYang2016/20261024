/**
 * 验收契约来源：docs/execution-plan.md
 *   - §六 服务端契约：
 *       POST /api/channels/:channelId/diagnostics → 201 `{ channelId, stored: true, total }`
 *       `id` 不在枚举内 → 400 `{ code: 400, message: "诊断项不合法" }`
 *       频道号格式非法 → 400（复用现有频道接口文案「频道号格式不正确」）
 *       GET  /api/channels/:channelId/diagnostics?limit=50 → `{ channelId, items: [...] }`
 *   - §五 5.2：controller 新增 `POST` / `GET` 两个端点，频道号复用现有 `assertChannelId`，错误体走 `ApiErrorBody`
 *   - CONTEXT.md D23：内存态留痕（重启清空），所以这里全部走真实 DiagnosticsService 实例，不 mock 存储
 *
 * 不起 HTTP 服务器、不引 supertest：直接调 controller 方法拿 HttpException / 返回体，
 * 与 `channel.controller.spec.ts` 的既有做法一致（断言最终对外状态码与响应体）。
 */
import { BadRequestException, HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';

const CHANNEL_ID = '1000001';

type AnyFn = (...args: unknown[]) => unknown;

const REPORT_NAMES = ['report', 'create', 'store', 'record', 'post', 'reportDiagnostic'];
const LIST_NAMES = ['list', 'history', 'findAll', 'get', 'query', 'findByChannel'];

function pickMethod(target: object, names: string[]): AnyFn {
  const record = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const candidate = record[name];
    // 必须 bind：解构/引用出来的方法丢掉 this 会读不到注入的 service
    if (typeof candidate === 'function') return (candidate as AnyFn).bind(target);
  }
  throw new Error(`DiagnosticsController 需提供以下方法之一：${names.join(' / ')}`);
}

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'D7',
    code: 'DIAG-D7-20261023153012',
    level: 'danger',
    reason: '没有检测到麦克风声音',
    measured: '-72 dBFS 持续 8 秒',
    expected: '> -50 dBFS',
    at: '2026-10-23T07:30:12.000Z',
    ...overrides,
  };
}

function createController() {
  const service = new DiagnosticsService();
  const controller = new DiagnosticsController(service);
  return {
    controller,
    service,
    report: pickMethod(controller, REPORT_NAMES),
    list: pickMethod(controller, LIST_NAMES),
  };
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

describe('POST /channels/:channelId/diagnostics — 正常上报', () => {
  it('合法上报返回 201 体 `{ channelId, stored: true, total }`，并且 GET 能读到', async () => {
    const { report, list } = createController();

    const created = (await report(CHANNEL_ID, validReport())) as {
      channelId?: string;
      stored?: boolean;
      total?: number;
    };

    expect(created.channelId, '返回体必须回显频道号').toBe(CHANNEL_ID);
    expect(created.stored, '内存态写入必须显式回报 stored').toBe(true);
    expect(created.total, 'total 是该频道当前条数').toBe(1);

    const response = (await list(CHANNEL_ID, 50)) as {
      channelId?: string;
      items?: Array<Record<string, unknown>>;
    };

    expect(response.channelId).toBe(CHANNEL_ID);
    expect(response.items).toHaveLength(1);
    expect(response.items?.[0].id).toBe('D7');
    expect(response.items?.[0].code).toBe('DIAG-D7-20261023153012');
    expect(response.items?.[0].reason).toBe('没有检测到麦克风声音');
    expect(response.items?.[0].occurrences).toBe(1);
  });

  it('total 随条数增长（同 id 60 秒内合并时 total 不增加）', async () => {
    const { report } = createController();

    const first = (await report(CHANNEL_ID, validReport())) as { total?: number };
    const merged = (await report(
      CHANNEL_ID,
      validReport({ at: '2026-10-23T07:30:52.000Z', measured: '-70 dBFS 持续 8 秒' }),
    )) as { total?: number };
    const second = (await report(
      CHANNEL_ID,
      validReport({ id: 'D5', reason: '上行带宽不足，推流已中断或降质', at: '2026-10-23T07:31:00.000Z' }),
    )) as { total?: number };

    expect(first.total).toBe(1);
    expect(merged.total, '合并进已有条目时 total 不变').toBe(1);
    expect(second.total).toBe(2);
  });
});

describe('POST /channels/:channelId/diagnostics — 入参校验', () => {
  it('诊断 id 不在枚举内（D4）→ 400 `{code:400, message:"诊断项不合法"}`', async () => {
    const { report } = createController();

    const error = await catchHttp(() => report(CHANNEL_ID, validReport({ id: 'D4' })));

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({ code: 400, message: '诊断项不合法' });
  });

  it('诊断 id 缺失 / 非字符串 → 400（不能让脏数据进内存缓冲）', async () => {
    const { report } = createController();

    for (const badId of [undefined, null, '', 'd7', 7]) {
      const error = await catchHttp(() => report(CHANNEL_ID, validReport({ id: badId })));
      expect(error.getStatus(), `id=${String(badId)} 必须被拒绝`).toBe(400);
      expect(error.getResponse()).toEqual({ code: 400, message: '诊断项不合法' });
    }
  });

  it('频道号格式非法 → 400「频道号格式不正确」（复用现有频道接口口径）', async () => {
    const { report } = createController();

    for (const badChannelId of ['abc', '12', '123456789012345678901', '']) {
      const error = await catchHttp(() => report(badChannelId, validReport()));
      expect(error.getStatus(), `频道号 ${badChannelId} 必须被拒绝`).toBe(400);
      expect(error.getResponse()).toEqual({ code: 400, message: '频道号格式不正确' });
    }
  });
});

describe('POST /channels/:channelId/diagnostics — 恢复上报（D30）', () => {
  it('带 recoveredAt 的 POST 走通 201，GET 能看到该字段且 occurrences 不变', async () => {
    const { report, list } = createController();

    const first = (await report(CHANNEL_ID, validReport())) as { total?: number };
    expect(first.total).toBe(1);

    // 恢复上报：同一个 code，只多了 recoveredAt
    const recovered = (await report(
      CHANNEL_ID,
      validReport({ recoveredAt: '2026-10-23T07:31:00.000Z' }),
    )) as { channelId?: string; stored?: boolean; total?: number };

    expect(recovered.channelId, '恢复上报也要回显频道号').toBe(CHANNEL_ID);
    expect(recovered.stored, '标记恢复成功必须回报 stored: true').toBe(true);
    expect(recovered.total, '恢复不新增记录：total 不变').toBe(1);

    const response = (await list(CHANNEL_ID, 50)) as {
      items?: Array<Record<string, unknown>>;
    };
    expect(response.items, '恢复上报不能多出一条记录').toHaveLength(1);
    expect(response.items?.[0].recoveredAt, 'GET 必须能看到 recoveredAt').toBe(
      '2026-10-23T07:31:00.000Z',
    );
    expect(response.items?.[0].occurrences, '恢复不计次数').toBe(1);
    expect(response.items?.[0].lastAt, '恢复不改 lastAt').toBe('2026-10-23T07:30:12.000Z');
  });

  it('recoveredAt 非法（不是时间）→ 当作普通上报，不会把记录错标成已恢复', async () => {
    const { report, list } = createController();

    await report(CHANNEL_ID, validReport());
    await report(CHANNEL_ID, validReport({ recoveredAt: 'not-a-date' }));

    const response = (await list(CHANNEL_ID, 50)) as {
      items?: Array<Record<string, unknown>>;
    };
    expect(response.items?.[0].recoveredAt ?? null).toBeNull();
  });

  it('恢复上报照样校验 id / 频道号（脏数据不能借此绕过枚举）', async () => {
    const { report } = createController();

    const badId = await catchHttp(() =>
      report(CHANNEL_ID, validReport({ id: 'D4', recoveredAt: '2026-10-23T07:31:00.000Z' })),
    );
    expect(badId.getStatus()).toBe(400);
    expect(badId.getResponse()).toEqual({ code: 400, message: '诊断项不合法' });

    const badChannel = await catchHttp(() => report('abc', validReport({ recoveredAt: '2026-10-23T07:31:00.000Z' })));
    expect(badChannel.getStatus()).toBe(400);
    expect(badChannel.getResponse()).toEqual({ code: 400, message: '频道号格式不正确' });
  });
});

describe('GET /channels/:channelId/diagnostics — 读取与 limit', () => {
  it('频道号格式非法 → 400', async () => {
    const { list } = createController();

    const error = await catchHttp(() => list('abc', 50));

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({ code: 400, message: '频道号格式不正确' });
  });

  it('没上报过的频道返回空 items（不是 404，也不是编造数据）', async () => {
    const { list } = createController();

    const response = (await list('1000020', undefined)) as { channelId?: string; items?: unknown[] };

    expect(response.channelId).toBe('1000020');
    expect(response.items).toEqual([]);
  });

  it('limit 走 HTTP 查询串时是字符串（?limit=3）：必须能正确解析并夹到上限 50', async () => {
    const { report, list } = createController();
    for (let index = 0; index < 5; index += 1) {
      await report(
        CHANNEL_ID,
        validReport({
          at: new Date(Date.parse('2026-10-23T07:30:00.000Z') + index * 61_000).toISOString(),
        }),
      );
    }

    const three = (await list(CHANNEL_ID, '3')) as { items?: unknown[] };
    expect(three.items, '?limit=3 必须只返回 3 条').toHaveLength(3);

    const huge = (await list(CHANNEL_ID, '999')) as { items?: unknown[] };
    expect(huge.items?.length ?? 0, 'limit 上限 50').toBeLessThanOrEqual(50);
  });
});

/* ============================================================================================
 * 增补 B / C（§十一 B、C 段 / CONTEXT D35、D36）—— 控制器侧的透传责任
 *   - POST 体新增可选 `device`（会话设备快照）与恢复上报的 `outageMs`（断流时长）
 *   - GET 响应体顶层追加 `"device": { … } | null`
 * 控制器只做「收进来 → 交给 service → 原样吐出去」，校验口径与主链路一致（id 枚举 / 频道号）。
 * 存储层的环形缓冲、最近一次 device 的保留策略在 diagnostics.service.spec.ts 里锁。
 * ========================================================================================== */

const DEVICE_SNAPSHOT = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  os: 'macOS 10.15.7',
  cpuCores: 8,
  deviceMemoryGb: 16,
  gpuRenderer: 'Apple M2',
  screen: '1728×1117@2',
};

describe('§十一 C：device 字段透传（D36）', () => {
  it('POST 带 device → GET 响应体顶层返回该 device（客户函第③条「设备配置接口」）', async () => {
    const { report, list } = createController();

    await report(CHANNEL_ID, validReport());
    await report(CHANNEL_ID, { ...validReport(), device: DEVICE_SNAPSHOT });

    const response = (await list(CHANNEL_ID, 50)) as {
      items?: unknown[];
      device?: Record<string, unknown> | null;
    };

    expect(response.device, 'GET 必须把设备快照吐出来').toBeTruthy();
    expect(response.device?.cpuCores).toBe(8);
    expect(response.device?.deviceMemoryGb).toBe(16);
    expect(String(response.device?.ua), 'ua 必须含浏览器标识（报障时用来对机器）').toContain('Chrome');
    expect(response.device?.gpuRenderer).toBe('Apple M2');
    expect(response.device?.screen, 'screen 格式 width×height@dpr').toBe('1728×1117@2');
  });

  it('没有上报过 device → GET 响应里 device 为 null（字段存在，不是缺失也不是编造）', async () => {
    const { report, list } = createController();

    await report(CHANNEL_ID, validReport());

    const response = (await list(CHANNEL_ID, 50)) as {
      device?: Record<string, unknown> | null;
    } & Record<string, unknown>;

    expect('device' in response, '契约要求响应里有 device 这个键').toBe(true);
    expect(response.device ?? null).toBeNull();
  });

  it('device 不替代诊断 id 校验：合法 device + 非法 id 仍然 400', async () => {
    const { report } = createController();

    const error = await catchHttp(() =>
      report(CHANNEL_ID, { ...validReport({ id: 'D4' }), device: DEVICE_SNAPSHOT }),
    );
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({ code: 400, message: '诊断项不合法' });
  });
});

describe('§十一 B：断流时长 outageMs 透传（D35）', () => {
  it('恢复上报带 outageMs → GET 里该条带数字型 outageMs', async () => {
    const { report, list } = createController();

    await report(CHANNEL_ID, validReport({ id: 'D5', at: '2026-10-23T07:30:00.000Z' }));
    await report(CHANNEL_ID, {
      ...validReport({ id: 'D5', at: '2026-10-23T07:30:20.000Z' }),
      recoveredAt: '2026-10-23T07:30:20.000Z',
      outageMs: 12_000,
    });

    const response = (await list(CHANNEL_ID, 50)) as {
      items?: Array<Record<string, unknown>>;
    };

    expect(response.items, '恢复上报不能新增一条').toHaveLength(1);
    const item = response.items?.[0];
    expect(typeof item?.outageMs, 'outageMs 必须是数字（客户要「断了几秒」的客观数字）').toBe(
      'number',
    );
    expect(item?.outageMs).toBe(12_000);
    expect(item?.recoveredAt).toBe('2026-10-23T07:30:20.000Z');
    expect(item?.occurrences, '恢复不计次数').toBe(1);
  });

  it('outageMs 非数字 → 当作没带（不能让脏值进历史抽屉）', async () => {
    const { report, list } = createController();

    await report(CHANNEL_ID, validReport({ id: 'D5' }));
    await report(CHANNEL_ID, {
      ...validReport({ id: 'D5' }),
      recoveredAt: '2026-10-23T07:31:00.000Z',
      outageMs: 'twelve-seconds',
    });

    const response = (await list(CHANNEL_ID, 50)) as {
      items?: Array<Record<string, unknown>>;
    };
    expect(response.items?.[0].recoveredAt, '恢复照样要标记').toBe('2026-10-23T07:31:00.000Z');
    expect(
      response.items?.[0].outageMs ?? null,
      '非数字的时长不能原样存进记录',
    ).toBeNull();
  });
});
