/**
 * 验收契约来源：docs/execution-plan.md
 *   - §五 5.2 `apps/server/src/diagnostics/diagnostics.service.ts`（新增）：
 *     每频道环形缓冲 50 条；同 `channelId + id` 且距 `lastAt` < 60 秒 → 合并（`occurrences+1`、更新 `lastAt`），
 *     否则新增；超出淘汰最旧
 *   - §六 服务端契约：`GET /api/channels/:id/diagnostics?limit=50` → `items` 按 `lastAt` 倒序、`limit` 缺省 50 上限 50
 *   - CONTEXT.md D23：诊断留痕只在服务端内存（重启清空），不引数据库
 *   - §Done when 第 4 条第 4 项：环形缓冲上限 50、60 秒内同 id 合并 `occurrences`、超 60 秒另起一条、按 `lastAt` 倒序
 *
 * 刻意不锁的两处（计划没写死，见汇报「计划缺口」）：
 *   1. `record()` 的调用形态：计划/时序图只写了 `DS.record(report)`，而 POST 契约里 `channelId` 在路径上。
 *      所以本文件用「两种形态都试，哪种真写进去了就用哪种」的探测方式，不指定实现必须选哪种。
 *   2. 「正好 60 秒」这一毫秒的归属：计划写「< 60 秒 → 合并」，本文件只在 59_999ms / 60_001ms 两侧断言，
 *      不对 `== 60_000ms` 选边。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsService } from './diagnostics.service';

/** 2026-10-23T10:00:00Z：所有时刻都从这里推，避免依赖真实时间 */
const T0 = Date.parse('2026-10-23T10:00:00.000Z');

interface ReportInput {
  id: string;
  code: string;
  level: string;
  reason: string;
  measured: string;
  expected: string;
  at: string;
  /** D30：带这个字段的上报表示「已恢复」，只标记恢复，不计次数 */
  recoveredAt?: string;
  /** §十一 B（D35）：恢复上报携带的本次断流时长（毫秒） */
  outageMs?: number;
  /** §十一 C（D36）：会话设备快照（随诊断上报一起上来，存在则挂到频道上） */
  device?: DeviceSnapshotInput;
}

interface RecordItem {
  id?: string;
  code?: string;
  level?: string;
  reason?: string;
  measured?: string;
  expected?: string;
  firstAt?: string;
  lastAt?: string;
  occurrences?: number;
  recoveredAt?: string | null;
}

type AnyFn = (...args: unknown[]) => unknown;

const RECORD_NAMES = ['record', 'add', 'append', 'store', 'create'];
const LIST_NAMES = ['list', 'find', 'findByChannel', 'history', 'items'];

function pickMethod(target: object, names: string[]): AnyFn {
  const record = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const candidate = record[name];
    if (typeof candidate === 'function') return candidate as AnyFn;
  }
  throw new Error(`DiagnosticsService 需提供以下方法之一：${names.join(' / ')}`);
}

function reportAt(offsetMs: number, overrides: Partial<ReportInput> = {}): ReportInput {
  const at = new Date(T0 + offsetMs).toISOString();
  return {
    id: 'D7',
    code: `DIAG-D7-${at.slice(0, 19).replace(/[-:T]/g, '')}`,
    level: 'danger',
    reason: '没有检测到麦克风声音',
    measured: '-72 dBFS 持续 8 秒',
    expected: '> -50 dBFS',
    at,
    ...overrides,
  };
}

/** 探测 record 的调用形态：`record(channelId, report)` 还是 `record({ channelId, ...report })` */
function detectRecordMode(): 'pair' | 'merged' {
  for (const mode of ['pair', 'merged'] as const) {
    const service = new DiagnosticsService();
    const record = pickMethod(service, RECORD_NAMES);
    const list = pickMethod(service, LIST_NAMES);

    if (mode === 'pair') {
      record.call(service, '1000001', reportAt(0));
    } else {
      record.call(service, { channelId: '1000001', ...reportAt(0) });
    }

    const items = list.call(service, '1000001', 50) as RecordItem[];
    if (Array.isArray(items) && items.length > 0) return mode;
  }
  throw new Error(
    'DiagnosticsService.record 两种调用形态都没写入记录：期望 record(channelId, report) 或 record({ channelId, ...report })',
  );
}

let recordMode: 'pair' | 'merged';

function makeService(): {
  service: DiagnosticsService;
  record: (channelId: string, report: ReportInput) => unknown;
  list: (channelId: string, limit?: number) => RecordItem[];
} {
  const service = new DiagnosticsService();
  const recordFn = pickMethod(service, RECORD_NAMES);
  const listFn = pickMethod(service, LIST_NAMES);

  return {
    service,
    record(channelId: string, report: ReportInput) {
      // 每次上报都把系统时间对齐到报告时刻：实现用 report.at 还是 Date.now() 算 60 秒窗口都一致
      vi.setSystemTime(new Date(report.at));
      return recordMode === 'pair'
        ? recordFn.call(service, channelId, report)
        : recordFn.call(service, { channelId, ...report });
    },
    list(channelId: string, limit?: number) {
      const items = listFn.call(service, channelId, limit) as RecordItem[];
      expect(Array.isArray(items), 'list() 必须返回数组').toBe(true);
      return items;
    },
  };
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0));
  recordMode = detectRecordMode();
});

beforeEach(() => {
  vi.setSystemTime(new Date(T0));
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('DiagnosticsService — 写入与读取', () => {
  it('写一条就能按频道读回来，且首次记录 occurrences=1、firstAt=lastAt=上报时刻', () => {
    const { record, list } = makeService();
    const report = reportAt(0);

    record('1000001', report);
    const items = list('1000001');

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('D7');
    expect(items[0].code).toBe(report.code);
    expect(items[0].level).toBe('danger');
    expect(items[0].reason).toBe('没有检测到麦克风声音');
    expect(items[0].measured).toBe('-72 dBFS 持续 8 秒');
    expect(items[0].expected).toBe('> -50 dBFS');
    expect(items[0].occurrences, '首次出现必须是 1 次').toBe(1);
    expect(items[0].firstAt).toBe(report.at);
    expect(items[0].lastAt).toBe(report.at);
    expect(items[0].recoveredAt ?? null, '还没恢复时 recoveredAt 必须是空（不能编一个时间）').toBeNull();
  });

  it('频道之间互相隔离（A 频道的诊断不能出现在 B 频道里）', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0));
    record('1000020', reportAt(1_000, { id: 'D5', reason: '上行带宽不足，推流已中断或降质' }));

    expect(list('1000001')).toHaveLength(1);
    expect(list('1000001')[0].id).toBe('D7');
    expect(list('1000020')).toHaveLength(1);
    expect(list('1000020')[0].id).toBe('D5');
    expect(list('999999999'), '没上报过的频道必须是空列表').toEqual([]);
  });
});

describe('DiagnosticsService — 环形缓冲上限 50（D23）', () => {
  it('写 55 条只保留最近 50 条，最旧的 5 条被淘汰', () => {
    const { record, list } = makeService();

    // 同 id 但间隔 61 秒 → 每次都是新记录（不会合并）
    for (let index = 0; index < 55; index += 1) {
      record('1000001', reportAt(index * 61_000, { measured: `第 ${index + 1} 次` }));
    }

    const items = list('1000001');

    expect(items, '每频道最多保留 50 条').toHaveLength(50);
    expect(
      items.some((item) => item.measured === '第 1 次'),
      '最旧的记录必须被淘汰',
    ).toBe(false);
    expect(items.some((item) => item.measured === '第 5 次'), '第 5 条是首批被淘汰的最后一条').toBe(false);
    expect(items.some((item) => item.measured === '第 6 次'), '第 6 条应该还在缓冲里').toBe(true);
    expect(items.some((item) => item.measured === '第 55 次'), '最新一条必须保留').toBe(true);
    expect(items[0].measured, '第一条（最新）应是第 55 次').toBe('第 55 次');
  });

  it('50 条以内不淘汰（3 条就返回 3 条）', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0, { id: 'D7' }));
    record('1000001', reportAt(1_000, { id: 'D5' }));
    record('1000001', reportAt(2_000, { id: 'D6' }));

    expect(list('1000001')).toHaveLength(3);
  });
});

describe('DiagnosticsService — 同 id 60 秒内合并、超 60 秒另起（D23）', () => {
  it('间隔 59_999ms 的同 id 上报合并为一条，occurrences=2、firstAt 不变、lastAt 更新', () => {
    const { record, list } = makeService();
    const first = reportAt(0);
    const second = reportAt(59_999, { measured: '-70 dBFS 持续 68 秒' });

    record('1000001', first);
    record('1000001', second);

    const items = list('1000001');
    expect(items, '60 秒内同 id 必须合并（否则历史抽屉会被重复条目刷屏）').toHaveLength(1);
    expect(items[0].occurrences).toBe(2);
    expect(items[0].firstAt).toBe(first.at);
    expect(items[0].lastAt).toBe(second.at);
    expect(items[0].measured, '合并时实测值应更新为最近一次').toBe('-70 dBFS 持续 68 秒');
  });

  it('间隔 60_001ms 的同 id 上报另起一条', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0));
    record('1000001', reportAt(60_001));

    const items = list('1000001');
    expect(items, '超过 60 秒必须另起一条').toHaveLength(2);
    expect(items.map((item) => item.occurrences)).toEqual([1, 1]);
  });

  it('连续合并 3 次 occurrences=3；中间换成别的 id 不影响同 id 的合并', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0, { id: 'D7' }));
    record('1000001', reportAt(10_000, { id: 'D5', reason: '上行带宽不足，推流已中断或降质' }));
    record('1000001', reportAt(20_000, { id: 'D7' }));
    record('1000001', reportAt(30_000, { id: 'D7' }));

    const items = list('1000001');
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === 'D7')?.occurrences).toBe(3);
    expect(items.find((item) => item.id === 'D5')?.occurrences).toBe(1);
  });

  it('不同频道即使同 id、同一时刻也不合并', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0));
    record('1000020', reportAt(0));

    expect(list('1000001')).toHaveLength(1);
    expect(list('1000020')).toHaveLength(1);
  });
});

describe('DiagnosticsService — 恢复上报只标记恢复（D30）', () => {
  /** `record()` 的返回体（可能是 void，也可能是 storeResult）：只按字段名读，不猜形态 */
  function storedFlag(result: unknown): unknown {
    return (result as { stored?: unknown } | null)?.stored;
  }

  it('带 recoveredAt 的上报：occurrences 不变、lastAt 不变、recoveredAt 写入、stored=true', () => {
    const { record, list } = makeService();
    const firstAt = reportAt(0).at;
    const lastAt = reportAt(10_000).at;
    const recoveredAt = new Date(T0 + 30_000).toISOString();

    record('1000001', reportAt(0));
    // 60s 内同 id 再报一次 → 合并，occurrences=2、lastAt 推到 10s
    record('1000001', reportAt(10_000));

    const result = record('1000001', { ...reportAt(30_000), recoveredAt });

    const items = list('1000001');
    expect(items, '恢复上报不能新增一条记录（它是标记，不是一次新故障）').toHaveLength(1);
    expect(items[0].recoveredAt, '恢复时间必须写进同一条记录').toBe(recoveredAt);
    expect(items[0].occurrences, '恢复不计次数：仍然是 2 次').toBe(2);
    expect(
      items[0].lastAt,
      '恢复不改 lastAt：历史里那一行的时间是「最后一次出问题」，不是恢复时间',
    ).toBe(lastAt);
    expect(items[0].firstAt, '恢复不改首次发生时间').toBe(firstAt);
    expect(storedFlag(result), '命中并标记成功时 stored 必须为 true').toBe(true);
  });

  it('按 code 精确命中：同 id 两条不同 code 时，不会把「最新那条」错标成恢复', () => {
    const { record, list } = makeService();
    const older = reportAt(0);
    const newer = reportAt(61_000);
    const recoveredAt = new Date(T0 + 70_000).toISOString();

    record('1000001', older);
    record('1000001', newer);

    // 恢复上报带的是**旧那条**的 code（诊断码一次故障一个，讲师报的就是它）
    record('1000001', { ...older, recoveredAt });

    const items = list('1000001');
    expect(items).toHaveLength(2);
    const olderItem = items.find((item) => item.code === older.code);
    const newerItem = items.find((item) => item.code === newer.code);
    expect(olderItem?.recoveredAt, 'code 精确命中：旧那条必须被标成已恢复').toBe(recoveredAt);
    expect(newerItem?.recoveredAt ?? null, '另一条同 id 记录不能被当成同一次故障一起标掉').toBeNull();
    expect(olderItem?.occurrences, '恢复不动 occurrences').toBe(1);
    expect(olderItem?.lastAt, '恢复不动 lastAt').toBe(older.at);
  });

  it('旧的一条已恢复时，恢复上报不会把旧记录再标一次（标最近一条未恢复的）', () => {
    const { record, list } = makeService();
    const older = reportAt(0);
    const newer = reportAt(61_000);
    const recoveredOlder = new Date(T0 + 70_000).toISOString();
    const recoveredNewer = new Date(T0 + 80_000).toISOString();

    record('1000001', older);
    record('1000001', newer);
    record('1000001', { ...older, recoveredAt: recoveredOlder });

    // 第二次恢复：不带能精确命中的 code（模拟 code 被重新生成的老客户端），只能靠「最近一条未恢复」定位
    record('1000001', {
      ...reportAt(80_000, { code: 'DIAG-D7-19700101000000' }),
      recoveredAt: recoveredNewer,
    });

    const items = list('1000001');
    const olderItem = items.find((item) => item.code === older.code);
    const newerItem = items.find((item) => item.code === newer.code);
    expect(
      olderItem?.recoveredAt,
      '旧记录已经恢复过，不能被第二次恢复上报改写（否则历史里两行时间会串）',
    ).toBe(recoveredOlder);
    expect(newerItem?.recoveredAt, '当前这条（未恢复的）必须被标成已恢复').toBe(recoveredNewer);
    expect(items.filter((item) => item.recoveredAt != null), '两条记录各恢复一次（不能多出第三条）').toHaveLength(2);
  });

  it('恢复之后再出问题：合并时撤掉 recoveredAt（不能显示「已恢复」却还在发生）', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0));
    record('1000001', { ...reportAt(10_000), recoveredAt: new Date(T0 + 10_000).toISOString() });
    expect(list('1000001')[0].recoveredAt ?? null).not.toBeNull();

    record('1000001', reportAt(20_000));

    const items = list('1000001');
    expect(items).toHaveLength(1);
    expect(items[0].recoveredAt ?? null, '又出问题了就不能再挂着「已恢复」').toBeNull();
    expect(items[0].occurrences).toBe(2);
  });
});

describe('DiagnosticsService — 排序与 limit（§六 服务端契约）', () => {
  it('items 按 lastAt 倒序返回', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0, { id: 'D7' }));
    record('1000001', reportAt(1_000, { id: 'D5' }));
    record('1000001', reportAt(2_000, { id: 'D6' }));

    expect(list('1000001').map((item) => item.id)).toEqual(['D6', 'D5', 'D7']);
  });

  it('合并会更新 lastAt → 该条顶到最前面（倒序按最近一次发生排序）', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0, { id: 'D7' }));
    record('1000001', reportAt(1_000, { id: 'D5' }));
    // D7 在 50s 时又出现一次（60s 内 → 合并，lastAt 变成 50s）
    record('1000001', reportAt(50_000, { id: 'D7' }));

    expect(list('1000001').map((item) => item.id), '刚发生过的 D7 必须排在最前').toEqual([
      'D7',
      'D5',
    ]);
  });

  it('limit 生效：limit=3 只返回最近 3 条', () => {
    const { record, list } = makeService();
    for (let index = 0; index < 6; index += 1) {
      record('1000001', reportAt(index * 61_000, { measured: `第 ${index + 1} 次` }));
    }

    const items = list('1000001', 3);
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.measured)).toEqual(['第 6 次', '第 5 次', '第 4 次']);
  });

  it('limit 上限 50：limit=100 也不会返回超过 50 条', () => {
    const { record, list } = makeService();
    for (let index = 0; index < 60; index += 1) {
      record('1000001', reportAt(index * 61_000, { measured: `第 ${index + 1} 次` }));
    }

    expect(list('1000001', 100), 'limit 上限必须夹到 50').toHaveLength(50);
  });

  it('不传 limit 时缺省 50', () => {
    const { record, list } = makeService();
    for (let index = 0; index < 52; index += 1) {
      record('1000001', reportAt(index * 61_000, { measured: `第 ${index + 1} 次` }));
    }

    expect(list('1000001')).toHaveLength(50);
  });

  it('limit 传 0 / 负数时不会崩溃（缺省按 50 处理即可，不能抛错）', () => {
    const { record, list } = makeService();
    record('1000001', reportAt(0));

    expect(() => list('1000001', 0)).not.toThrow();
    expect(() => list('1000001', -1)).not.toThrow();
  });
});

/* ============================================================================================
 * 增补 B/C（§十一 B、C 段 / CONTEXT D35、D36）
 *   - B：`DiagnosticRecord` 增加可选 `outageMs`；**恢复上报带 `outageMs` 时写入**
 *        （断流恢复时 useDiagnostics 的 reportRecovery 会带上「本次断流持续时长」）
 *   - C：`record()` 接受可选 `device`，存在时挂在服务端「最近一次会话设备」上；
 *        `GET /api/channels/:channelId/diagnostics` 返回 `device` 字段
 *
 * 计划没写「device 从 service 怎么读出来」（GET 响应体顶层带 device，而 `list()` 返回的是条目数组）。
 * 所以本文件用探针按优先顺序找：service 上的 device 访问器 → list 返回 `{items, device}` →
 * 条目上挂 device。三种实现都能过，但「device 必须能读到、且是最近一次上报的那个」必须成立。
 * ========================================================================================== */

interface DeviceSnapshotInput {
  ua: string;
  os: string | null;
  cpuCores: number | null;
  deviceMemoryGb: number | null;
  gpuRenderer: string | null;
  screen: string | null;
}

interface RecordItemWithExtras extends RecordItem {
  outageMs?: number | null;
  device?: DeviceSnapshotInput | null;
}

/** 设备快照读出来（容忍三种暴露形态） */
function deviceOf(
  service: DiagnosticsService,
  channelId: string,
): DeviceSnapshotInput | null | undefined {
  const bag = service as unknown as Record<string, unknown>;

  for (const name of [
    'getDevice',
    'deviceOf',
    'latestDevice',
    'getLatestDevice',
    'sessionDevice',
    'getSessionDevice',
    'device',
  ]) {
    const candidate = bag[name];
    if (typeof candidate === 'function') {
      return (candidate as (id: string) => DeviceSnapshotInput | null).call(service, channelId) ?? null;
    }
  }

  const listFn = pickMethod(service, LIST_NAMES);
  for (const name of ['listWithDevice', 'snapshot', 'historyWithDevice', 'read']) {
    const candidate = bag[name];
    if (typeof candidate === 'function') {
      const result = (candidate as AnyFn).call(service, channelId, 50) as
        | { device?: DeviceSnapshotInput | null; items?: RecordItemWithExtras[] }
        | undefined;
      if (result && typeof result === 'object' && 'device' in result) return result.device ?? null;
      const item = result?.items?.find((entry) => entry.device != null);
      if (item) return item.device ?? null;
    }
  }

  const listed = listFn.call(service, channelId, 50) as unknown;
  if (listed && !Array.isArray(listed) && typeof listed === 'object' && 'device' in listed) {
    return (listed as { device?: DeviceSnapshotInput | null }).device ?? null;
  }
  const items = listed as RecordItemWithExtras[];
  const withDevice = items.find((item) => item.device != null);
  if (withDevice) return withDevice.device ?? null;

  throw new Error(
    'DiagnosticsService 必须能把「最近一次会话设备」读出来（service 访问器 / list 返回 {items, device} / 条目上带 device 任一种）',
  );
}

const DEVICE_A: DeviceSnapshotInput = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  os: 'macOS 10.15.7',
  cpuCores: 8,
  deviceMemoryGb: 16,
  gpuRenderer: 'Apple M2',
  screen: '1728×1117@2',
};

const DEVICE_B: DeviceSnapshotInput = {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  os: 'Windows 10',
  cpuCores: 12,
  deviceMemoryGb: 8,
  gpuRenderer: 'ANGLE (NVIDIA GeForce RTX 3060)',
  screen: '1920×1080@1',
};

describe('DiagnosticsService — 断流时长 outageMs（§十一 B / D35）', () => {
  it('恢复上报带 outageMs → 写进同一条记录，occurrences / lastAt 仍不变', () => {
    const { record, list } = makeService();
    const outageMs = 12_000;

    record('1000001', reportAt(0, { id: 'D5' }));
    record('1000001', reportAt(5_000, { id: 'D5' }));

    record('1000001', {
      ...reportAt(30_000, { id: 'D5' }),
      recoveredAt: new Date(T0 + 30_000).toISOString(),
      outageMs,
    });

    const items = list('1000001') as RecordItemWithExtras[];
    expect(items, '恢复上报不能新增一条记录').toHaveLength(1);
    expect(
      items[0].outageMs,
      '断流时长必须写进这条记录（客户函要「断了几秒」的客观数字）',
    ).toBe(outageMs);
    expect(items[0].recoveredAt).toBe(new Date(T0 + 30_000).toISOString());
    expect(items[0].occurrences, '恢复不计次数').toBe(2);
    expect(items[0].lastAt, '恢复不改 lastAt').toBe(reportAt(5_000, { id: 'D5' }).at);
  });

  it('普通上报（没有 outageMs）不会编一个时长出来', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0, { id: 'D5' }));

    const items = list('1000001') as RecordItemWithExtras[];
    expect(items[0].outageMs ?? null, '没断流就没有时长，不能填 0 冒充').toBeNull();
  });

  it('outageMs 只落在对应那条记录上（不同 id 的恢复不串）', () => {
    const { record, list } = makeService();

    record('1000001', reportAt(0, { id: 'D5' }));
    record('1000001', reportAt(1_000, { id: 'D7' }));

    record('1000001', {
      ...reportAt(20_000, { id: 'D5' }),
      recoveredAt: new Date(T0 + 20_000).toISOString(),
      outageMs: 8_000,
    });

    const items = list('1000001') as RecordItemWithExtras[];
    expect(items.find((item) => item.id === 'D5')?.outageMs).toBe(8_000);
    expect(
      items.find((item) => item.id === 'D7')?.outageMs ?? null,
      '别的诊断项不能被写上断流时长',
    ).toBeNull();
  });
});

describe('DiagnosticsService — 设备快照 device（§十一 C / D36）', () => {
  it('带 device 的上报保存下来，并能按频道读回（字段一个不少）', () => {
    const { service, record } = makeService();

    record('1000001', reportAt(0, { id: 'D5' }));
    // 会话开始时的设备快照是随诊断上报一起上来的（POST 体里的可选字段）
    record('1000001', {
      ...reportAt(0, { id: 'D5' }),
      device: DEVICE_A,
    });

    const device = deviceOf(service, '1000001');
    expect(device, '带 device 上报后必须能读回来').not.toBeNull();
    expect(device?.ua).toBe(DEVICE_A.ua);
    expect(device?.os).toBe(DEVICE_A.os);
    expect(device?.cpuCores).toBe(DEVICE_A.cpuCores);
    expect(device?.deviceMemoryGb, '缺失字段是 null 也要原样保留（不编造）').toBe(
      DEVICE_A.deviceMemoryGb,
    );
    expect(device?.gpuRenderer).toBe(DEVICE_A.gpuRenderer);
    expect(device?.screen, 'screen 格式 width×height@dpr').toBe(DEVICE_A.screen);
  });

  it('多次上报时保留最近一次 device（会话重建 / 换机器后不能还挂旧配置）', () => {
    const { service, record } = makeService();

    record('1000001', { ...reportAt(0, { id: 'D5' }), device: DEVICE_A });
    record('1000001', { ...reportAt(10_000, { id: 'D5' }), device: DEVICE_B });

    expect(deviceOf(service, '1000001')?.cpuCores).toBe(DEVICE_B.cpuCores);
    expect(deviceOf(service, '1000001')?.os).toBe(DEVICE_B.os);
  });

  it('不带 device 的后续上报不会把已有的设备快照清掉（快照是会话级，不是每条都带）', () => {
    const { service, record } = makeService();

    record('1000001', { ...reportAt(0, { id: 'D5' }), device: DEVICE_A });
    record('1000001', { ...reportAt(10_000, { id: 'D5' }) });

    expect(
      deviceOf(service, '1000001')?.cpuCores,
      '「存在时挂在最近一次会话设备上」→ 不带 device 的上报不覆盖它',
    ).toBe(DEVICE_A.cpuCores);
  });

  it('device 按频道隔离：A 频道的设备不能出现在 B 频道', () => {
    const { service, record } = makeService();

    record('1000001', { ...reportAt(0, { id: 'D5' }), device: DEVICE_A });

    expect(
      deviceOf(service, '1000020') ?? null,
      '没上报过设备的频道必须是 null（不能借用别的频道的设备）',
    ).toBeNull();
  });

  it('没上报过 device 时读到 null（不编造一台机器）', () => {
    const { service, record } = makeService();

    record('1000001', reportAt(0, { id: 'D5' }));

    expect(deviceOf(service, '1000001') ?? null).toBeNull();
  });
});
