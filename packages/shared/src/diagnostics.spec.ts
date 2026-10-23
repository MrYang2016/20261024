/**
 * 验收契约来源：docs/execution-plan.md
 *   - §三「诊断项规则表」：优先级 `D2 > D1 > D3 > D9 > D6 > D7 > D5`、7 条规则的阈值（D24 均衡档）
 *   - §五 5.1：`src/diagnostics.ts` 必须导出 `DiagnosticId` / `DiagnosticRule`（阈值表）/
 *     `DIAGNOSTIC_THRESHOLDS` / `DIAGNOSTIC_PRIORITY` / `DIAGNOSTIC_META` / `diagnosticCode(id, at)`
 *   - §Done when 第 4 条第 1 项：优先级顺序、`diagnosticCode('D7', …)` 形如 `DIAG-D7-<14 位时间>`、
 *     阈值常量与计划第三节**逐项相等**
 *   - CONTEXT.md D24：麦克风 8s / fps 5s / 码率 5s / 黑屏 3s / 首帧 8s / 地址剩余 3 分钟
 *
 * 两条自我约束：
 *   1. **不重复写死两份**：断言读的是 `DIAGNOSTIC_THRESHOLDS` 常量本身，期望数字来自本文件顶部这张表
 *      （计划第三节的逐字数字）。两边不一致只有一种结果：红。
 *   2. **只锁数字，不锁键名**：计划只规定「阈值是共享常量」，没规定字段命名（`audioHoldMs` / `holdMs` /
 *      `silenceMs` 都算实现自由）。所以下面按「该诊断项的阈值桶里必须出现这个数」断言，
 *      失败信息会把桶里实际出现的数字全列出来——数字错了必红，键名不同不算违约。
 */
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_META,
  DIAGNOSTIC_PRIORITY,
  DIAGNOSTIC_THRESHOLDS,
  diagnosticCode,
  type DiagnosticId,
} from './diagnostics';
import * as sharedModule from './index';

/** 计划 §三 + D24 逐字给出的阈值（毫秒 / dBFS / luma / kbps / 比例） */
const PLAN_THRESHOLDS: ReadonlyArray<{
  id: DiagnosticId;
  label: string;
  /** 必须在该诊断项的阈值桶里出现的数字（任一表示法命中即可，见 expectOneOf） */
  expected: ReadonlyArray<ReadonlyArray<number>>;
}> = [
  // D1 推流地址过期：剩余 < 3 分钟告警（180_000ms；写成「3 分钟」也接受）
  { id: 'D1', label: '地址剩余时间告警', expected: [[180_000], [3]] },
  // D3 首帧 8 秒未到即判连不上
  { id: 'D3', label: '首帧超时', expected: [[8_000]] },
  // D9 黑屏连续 3 秒，亮度阈值 < 8/255
  { id: 'D9', label: '黑屏保持 / 亮度阈值', expected: [[3_000], [8]] },
  // D6 fps=0 连续 5 秒；恢复 fps>0 持续 2 秒
  { id: 'D6', label: 'fps 保持 / 恢复', expected: [[5_000], [2_000]] },
  // D7 麦克风连续 8 秒 < -60 dBFS；恢复 > -50 dBFS 持续 2 秒
  { id: 'D7', label: '静音保持 / 恢复 / 静音阈值 / 恢复阈值', expected: [[8_000], [2_000], [-60], [-50]] },
  // D5 码率连续 5 秒 < max(150kbps, 峰值 40%)；恢复持续 3 秒
  {
    id: 'D5',
    label: '码率保持 / 恢复 / 码率下限 / 峰值占比',
    expected: [[5_000], [3_000], [150], [0.4]],
  },
];

/** 计划 §三「一句话原因」逐字文案（诊断卡上给讲师看的那句话） */
const PLAN_REASONS: Record<DiagnosticId, string> = {
  D1: '推流地址已过期',
  D2: '当前频道不是纯视频模板',
  D3: '连不上推流服务器',
  D9: '摄像头没有画面',
  D6: '编码器没有输出画面',
  D7: '没有检测到麦克风声音',
  D5: '上行带宽不足',
};

/** 计划 §三「下一步」按钮标签（D22：能一键执行的都是真按钮） */
const PLAN_ACTION_LABELS: Record<DiagnosticId, string> = {
  D1: '重新连接',
  D2: '怎么改模板',
  D3: '重试连接',
  D9: '重新授权',
  D6: '重载推流器',
  D7: '换麦克风',
  D5: '自动重连',
};

/** 把阈值对象压平成数字数组（不关心键名，只关心「这个数在不在」） */
function collectNumbers(value: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectNumbers(item, out, depth + 1);
    }
  }
  return out;
}

function thresholdBucket(id: DiagnosticId): unknown {
  const table = DIAGNOSTIC_THRESHOLDS as unknown as Record<string, unknown>;
  return table?.[id];
}

/** 阈值桶里至少命中 `alternatives` 里的一组表示法（180_000ms 或 3 分钟这类等价写法） */
function expectOneOf(id: DiagnosticId, label: string, alternatives: ReadonlyArray<number>) {
  const found = collectNumbers(thresholdBucket(id));
  const hit = alternatives.some((candidate) => found.includes(candidate));
  expect(
    hit,
    `${id}「${label}」阈值必须是 ${alternatives.join(' 或 ')} 之一；` +
      `${id} 阈值桶里实际出现的数字：${found.length ? found.join(', ') : '（空）'}`,
  ).toBe(true);
}

function readString(source: unknown, aliases: readonly string[]): string {
  if (!source || typeof source !== 'object') return '';
  const record = source as Record<string, unknown>;
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

const IDS: DiagnosticId[] = ['D1', 'D2', 'D3', 'D5', 'D6', 'D7', 'D9'];

describe('DIAGNOSTIC_PRIORITY — 同一时刻只显示最高优先级一条', () => {
  it('顺序必须逐字为 D2,D1,D3,D9,D6,D7,D5（计划 §三 + D28）', () => {
    expect(DIAGNOSTIC_PRIORITY).toEqual(['D2', 'D1', 'D3', 'D9', 'D6', 'D7', 'D5']);
  });

  it('优先级表覆盖全部 7 条、且与阈值表 / META 表口径一致（没有漏登记也没有多余项）', () => {
    expect(new Set(DIAGNOSTIC_PRIORITY).size, '优先级表不能有重复项').toBe(
      DIAGNOSTIC_PRIORITY.length,
    );
    expect([...DIAGNOSTIC_PRIORITY].sort()).toEqual([...IDS].sort());

    const table = DIAGNOSTIC_THRESHOLDS as unknown as Record<string, unknown>;
    expect(Object.keys(table).sort(), '阈值表必须正好是这 7 条').toEqual([...IDS].sort());

    const meta = DIAGNOSTIC_META as unknown as Record<string, unknown>;
    expect(Object.keys(meta).sort(), 'META 表必须正好是这 7 条').toEqual([...IDS].sort());
  });

  it('一期不做 D4 / D8 / D10 / D11（D28 明确不做，不能被顺手加进来）', () => {
    for (const excluded of ['D4', 'D8', 'D10', 'D11']) {
      expect(DIAGNOSTIC_PRIORITY as readonly string[]).not.toContain(excluded);
    }
  });
});

describe('DIAGNOSTIC_THRESHOLDS — 与计划第三节逐项相等（D24 均衡档）', () => {
  for (const { id, label, expected } of PLAN_THRESHOLDS) {
    it(`${id} ${label}`, () => {
      for (const alternatives of expected) {
        expectOneOf(id, label, alternatives);
      }
    });
  }
});

describe('DIAGNOSTIC_META — 一句话原因 + 一个下一步（D21/D22）', () => {
  for (const id of IDS) {
    it(`${id} 的原因文案包含计划原文「${PLAN_REASONS[id]}」`, () => {
      const meta = (DIAGNOSTIC_META as unknown as Record<string, unknown>)[id];
      expect(meta, `DIAGNOSTIC_META.${id} 必须存在`).toBeTruthy();

      const reason = readString(meta, ['reason', 'reasonText', 'title', 'message', 'text']);
      expect(reason, `DIAGNOSTIC_META.${id} 必须有一句话原因（reason）`).toContain(PLAN_REASONS[id]);
    });

    it(`${id} 的下一步标签包含「${PLAN_ACTION_LABELS[id]}」`, () => {
      const meta = (DIAGNOSTIC_META as unknown as Record<string, unknown>)[id];
      const label = readString(meta, [
        'actionLabel',
        'action',
        'nextStep',
        'nextStepLabel',
        'buttonLabel',
        'cta',
      ]);
      expect(label, `DIAGNOSTIC_META.${id} 必须有下一步标签`).toContain(
        PLAN_ACTION_LABELS[id],
      );
    });
  }
});

describe('diagnosticCode — DIAG-<ID>-<14 位时间>', () => {
  it('D7 的诊断码形如 DIAG-D7-20261023153012（本地时间 yyyyMMddHHmmss）', () => {
    // 用本地时间构造，避免把测试绑死在某个时区上（计划示例是 UTC+8 的本地时刻）
    const at = new Date(2026, 9, 23, 15, 30, 12);
    const code = diagnosticCode('D7', at);

    expect(code).toMatch(/^DIAG-D7-\d{14}$/);
    expect(code).toBe('DIAG-D7-20261023153012');
  });

  it('7 个 id 都走同一格式，且时间精确到秒（不同秒 → 不同码）', () => {
    const first = new Date(2026, 9, 23, 15, 30, 12);
    const second = new Date(2026, 9, 23, 15, 30, 13);

    for (const id of IDS) {
      expect(diagnosticCode(id, first)).toMatch(new RegExp(`^DIAG-${id}-\\d{14}$`));
    }
    expect(diagnosticCode('D7', first)).not.toBe(diagnosticCode('D7', second));
  });

  it('诊断码里的时间与传入时刻一致（不做时区漂移、不补毫秒）', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    const digits = diagnosticCode('D5', at).split('-')[2];

    expect(digits).toBe('20260102030405');
  });
});

describe('packages/shared 的运行时导出（计划 §五 5.1 注意点）', () => {
  it('index.ts 追加 `export * from ./diagnostics`，运行时能拿到同一份常量对象', () => {
    const runtimeExports = sharedModule as unknown as Record<string, unknown>;

    expect(
      runtimeExports.DIAGNOSTIC_PRIORITY,
      'packages/shared/src/index.ts 需要追加 `export * from \'./diagnostics\'`（本单是 shared 第一次出现运行时导出）',
    ).toBe(DIAGNOSTIC_PRIORITY);
    expect(runtimeExports.DIAGNOSTIC_THRESHOLDS).toBe(DIAGNOSTIC_THRESHOLDS);
    expect(runtimeExports.DIAGNOSTIC_META).toBe(DIAGNOSTIC_META);
    expect(typeof runtimeExports.diagnosticCode).toBe('function');
  });
});
