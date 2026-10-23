/**
 * 验收契约来源：docs/execution-plan.md §十一「增补（评审通过）」A 段 + CONTEXT.md D34
 *   - `apps/server/src/diagnostics/metrics.service.ts`（新增）：每频道环形 **300 条**；
 *     `record(channelId, sample)` / `list(channelId, limit)`（**按 `at` 升序**返回，便于画曲线 / 导 CSV）
 *   - §六 GET 契约：`GET /api/channels/:id/metrics?limit=` → `{ channelId, items }`（limit 缺省 300、上限 300）
 *   - §「十一补 Done when」第 14 条：`metrics.service.spec.ts`（环形 300 / 升序 / limit 夹取）
 *
 * 本文件固化的两处计划没写死的形态（已记进汇报「契约缺口」）：
 *   1. 方法名 `record` / `list`（计划正文写了这两个词），但保留同义名探测，
 *      与 `diagnostics.service.spec.ts` 的既有做法一致（不因实现挑同义词就红）。
 *   2. `list(channelId, limit)` 的 limit 到底是「最近 N 条」还是「最早 N 条」计划没定义 →
 *      只断言「长度 = limit、仍是升序、元素都来自写入集合」，不对切片方向选边。
 */
import { describe, expect, it } from 'vitest';
import * as metricsModule from './metrics.service';

/** 2026-10-23T10:00:00Z：所有时刻都从这里推，避免依赖真实时间 */
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const CHANNEL_ID = '1000001';
/** D34：每频道环形 300 条（≈25 分钟 @5s） */
const RING_LIMIT = 300;

interface MetricSample {
  kbps: number;
  fps: number;
  dropFps?: number;
  connection: string;
  at: string;
}

interface ServiceLike {
  [key: string]: unknown;
}

type AnyFn = (...args: unknown[]) => unknown;

const RECORD_NAMES = ['record', 'add', 'append', 'push', 'store'];
const LIST_NAMES = ['list', 'series', 'history', 'findByChannel', 'items'];

function pickMethod(target: object, names: string[], label: string): AnyFn {
  const bag = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const candidate = bag[name];
    if (typeof candidate === 'function') return (candidate as AnyFn).bind(target);
  }
  throw new Error(`${label} 需提供以下方法之一：${names.join(' / ')}`);
}

/** 计划只给了文件名与方法名，类名按 Nest 约定取 MetricsService；同义类名一并接受 */
function resolveServiceCtor(): new () => ServiceLike {
  const bag = metricsModule as unknown as Record<string, unknown>;
  for (const name of ['MetricsService', 'MetricsStore', 'MetricsHistoryService']) {
    const candidate = bag[name];
    if (typeof candidate === 'function') return candidate as new () => ServiceLike;
  }
  throw new Error('apps/server/src/diagnostics/metrics.service.ts 需导出 MetricsService 类');
}

function makeService() {
  const ServiceCtor = resolveServiceCtor();
  const service = new ServiceCtor();
  const recordFn = pickMethod(service, RECORD_NAMES, 'MetricsService.record');
  const listFn = pickMethod(service, LIST_NAMES, 'MetricsService.list');

  return {
    service,
    record(channelId: string, sample: MetricSample): unknown {
      return recordFn(channelId, sample);
    },
    list(channelId: string, limit?: number | string): MetricSample[] {
      const items = listFn(channelId, limit) as MetricSample[];
      expect(Array.isArray(items), 'list() 必须返回数组').toBe(true);
      return items;
    },
  };
}

/** 造一条采样；`offsetMs` 是相对 T0 的时刻（`at` 用 ISO，契约里就是字符串） */
function sampleAt(offsetMs: number, overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    kbps: 412,
    fps: 20,
    dropFps: 0,
    connection: 'connected',
    at: new Date(T0 + offsetMs).toISOString(),
    ...overrides,
  };
}

function millis(item: MetricSample): number {
  return Date.parse(item.at);
}

describe('MetricsService — 写入与升序读取（D34）', () => {
  it('写一条就能按频道读回来，字段与上报体一致（不加工、不丢字段）', () => {
    const { record, list } = makeService();
    const sample = sampleAt(0, { kbps: 412, fps: 20, dropFps: 3, connection: 'connected' });

    record(CHANNEL_ID, sample);
    const items = list(CHANNEL_ID);

    expect(items).toHaveLength(1);
    expect(items[0].kbps).toBe(412);
    expect(items[0].fps).toBe(20);
    expect(items[0].dropFps, 'dropFps（丢帧）必须原样保留，导出 CSV 要这一列').toBe(3);
    expect(items[0].connection).toBe('connected');
    expect(items[0].at, 'at 必须是 ISO 时间字符串（CSV 第一列直接用它）').toBe(sample.at);
  });

  it('乱序写入时按 at 升序返回（画曲线 / 导 CSV 都按时间正序）', () => {
    const { record, list } = makeService();

    record(CHANNEL_ID, sampleAt(2_000, { kbps: 300 }));
    record(CHANNEL_ID, sampleAt(0, { kbps: 100 }));
    record(CHANNEL_ID, sampleAt(1_000, { kbps: 200 }));

    const items = list(CHANNEL_ID);
    expect(items.map((item) => item.kbps), '必须按 at 升序（不是写入顺序、也不是倒序）').toEqual([
      100, 200, 300,
    ]);
    expect(items.map(millis)).toEqual([T0, T0 + 1_000, T0 + 2_000]);
  });

  it('频道之间互相隔离（A 频道的采样不能出现在 B 频道里）', () => {
    const { record, list } = makeService();

    record(CHANNEL_ID, sampleAt(0, { kbps: 111 }));
    record('1000020', sampleAt(0, { kbps: 222 }));

    expect(list(CHANNEL_ID).map((item) => item.kbps)).toEqual([111]);
    expect(list('1000020').map((item) => item.kbps)).toEqual([222]);
    expect(list('999999999'), '没上报过的频道必须是空列表（不是 404、不编数据）').toEqual([]);
  });
});

describe('MetricsService — 环形缓冲 300 条（D34）', () => {
  it('写 305 条只保留最近 300 条，最旧的 5 条被淘汰', () => {
    const { record, list } = makeService();

    for (let index = 0; index < 305; index += 1) {
      record(CHANNEL_ID, sampleAt(index * 5_000, { kbps: index + 1 }));
    }

    const items = list(CHANNEL_ID);
    expect(items, '每频道最多保留 300 条').toHaveLength(RING_LIMIT);
    expect(
      items.some((item) => item.kbps === 1),
      '第 1 条（最旧）必须被淘汰',
    ).toBe(false);
    expect(
      items.some((item) => item.kbps === 5),
      '第 5 条是首批被淘汰的最后一条',
    ).toBe(false);
    expect(items.some((item) => item.kbps === 6), '第 6 条应该还在缓冲里').toBe(true);
    expect(items.some((item) => item.kbps === 305), '最新一条必须保留').toBe(true);
    expect(items[items.length - 1].kbps, '升序返回 → 最后一条是最新采样').toBe(305);
    expect(items[0].kbps, '升序返回 → 第一条是缓冲里最旧的一条（第 6 条）').toBe(6);
  });

  it('300 条以内不淘汰（3 条就返回 3 条）', () => {
    const { record, list } = makeService();

    record(CHANNEL_ID, sampleAt(0));
    record(CHANNEL_ID, sampleAt(5_000));
    record(CHANNEL_ID, sampleAt(10_000));

    expect(list(CHANNEL_ID)).toHaveLength(3);
  });
});

describe('MetricsService — limit（缺省 / 夹取 / 非法值）', () => {
  /** 写 `count` 条（间隔 5s，避免同 at） */
  function seed(record: (channelId: string, sample: MetricSample) => unknown, count: number): void {
    for (let index = 0; index < count; index += 1) {
      record(CHANNEL_ID, sampleAt(index * 5_000, { kbps: index + 1 }));
    }
  }

  it('不传 limit 时缺省 300（即整个环形缓冲）', () => {
    const { record, list } = makeService();
    seed(record, 305);

    expect(list(CHANNEL_ID), '缺省 limit = 300').toHaveLength(RING_LIMIT);
  });

  it('limit 生效：limit=3 只返回 3 条，且仍然按 at 升序', () => {
    const { record, list } = makeService();
    seed(record, 6);

    const items = list(CHANNEL_ID, 3);
    expect(items).toHaveLength(3);
    const times = items.map(millis);
    expect(
      times,
      'limit 之后仍必须是升序（limit 的切片方向计划没定义，这里只锁升序）',
    ).toEqual([...times].sort((left, right) => left - right));
    for (const item of items) {
      expect(item.kbps, 'limit 返回的元素必须来自写入集合').toBeGreaterThanOrEqual(1);
      expect(item.kbps).toBeLessThanOrEqual(6);
    }
  });

  it('limit 上限 300：limit=1000 也不会返回超过 300 条', () => {
    const { record, list } = makeService();
    seed(record, 305);

    expect(list(CHANNEL_ID, 1000), 'limit 上限必须夹到 300').toHaveLength(RING_LIMIT);
  });

  it('limit 走 HTTP 查询串时是字符串（?limit=2）：必须能正确解析', () => {
    const { record, list } = makeService();
    seed(record, 5);

    expect(list(CHANNEL_ID, '2'), '?limit=2 必须解析成数字 2').toHaveLength(2);
    expect(list(CHANNEL_ID, '1000'), '?limit=1000 仍要夹到 300').toHaveLength(5);
  });

  it('limit 非法（0 / 负数 / 非数字）不抛错，按缺省 300 处理', () => {
    const { record, list } = makeService();
    seed(record, 3);

    for (const badLimit of [0, -1, 'abc', '']) {
      expect(
        () => list(CHANNEL_ID, badLimit),
        `limit=${String(badLimit)} 不能让接口 500`,
      ).not.toThrow();
      expect(
        list(CHANNEL_ID, badLimit),
        `limit=${String(badLimit)} 应回落到缺省 300（这里只有 3 条）`,
      ).toHaveLength(3);
    }
  });
});
