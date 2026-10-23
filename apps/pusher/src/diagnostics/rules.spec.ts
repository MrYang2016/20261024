/**
 * 验收契约来源：docs/execution-plan.md
 *   - §三「诊断项规则表」：7 条诊断项的判定信号 / 触发阈值（D24）/ 恢复条件
 *   - §四 状态机：`fixing` 期间不被其它规则抢占；修复失败回到同一条 verdict
 *   - §五 5.3：`src/diagnostics/rules.ts` 必须是**纯函数**
 *     `evaluateDiagnostics(signals, state) → DiagnosticVerdict | null`，含 hold/recover 计时，
 *     输入 `now` 可被假时钟驱动
 *   - §Done when 第 4 条第 2/3 项：每条规则「刚好到阈值 → 命中」「差 1ms → 不命中」「恢复阈值 → 撤销」；
 *     多规则同时命中只返回最高优先级；`fixing` 期间不被抢占
 *
 * 不依赖真实计时器：所有时刻都由本文件显式给出（`now` 走 signals，不用 `vi.useFakeTimers`）。
 *
 * ## signals 契约（计划只给了函数签名，字段形状由本 spec 规定，见汇报里的「计划缺口 #1」）
 *
 * 扁平对象，全部可选，缺省 = 健康态：
 *   now                 当前时刻（ms）——规则的所有 hold/recover 判定都基于它
 *   template            频道模板（'alone' = 纯视频，D2）
 *   pushExpiresAt       推流地址过期时间（ISO 字符串，D1）
 *   pushRejectedAuth   推流被拒且错误分类为鉴权类（D1 的第二条触发路径）
 *   pushStartedAt       本次推流开始时刻（D3 的首帧超时从这里算）
 *   firstFrameAt        拿到首帧的时刻（D3 恢复条件）
 *   connected           是否处于 connected
 *   connectFailed       连接失败 / ICE 失败（D3 即时触发）
 *   fps / bitrateKbps / peakBitrateKbps      统计窗口（D6 / D5）
 *   audioRmsDb          音频实测电平 dBFS（D7）
 *   averageLuma         画面平均亮度 0..255（D9）
 *   captureError        getUserMedia 错误名（D9 即时触发）
 *   captureTrackActive  采集轨道是否仍在出帧（D6 的「但采集轨道仍在出帧」）
 *
 * `state` 由调用方持有并在多次调用间复用（累积计时）；`state.fixing` 语义见
 * docs/sequence-diagram.md §3：`state.fixing = verdict.id`，修复结束 `state.fixing = null`。
 */
import { describe, expect, it } from 'vitest';
import type { DiagnosticId } from '@live1024/shared';
import * as rulesModule from './rules';

/** 固定基准时刻：2026-10-23T10:00:00Z，所有用例的时间都从这里推 */
const T0 = new Date('2026-10-23T10:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

type Signals = Record<string, unknown>;
type Verdict = { id?: string; level?: string; reason?: string } | null | undefined;
type EvaluateFn = (signals: Signals, state: Record<string, unknown>) => Verdict;

function resolveEvaluate(): EvaluateFn {
  const mod = rulesModule as unknown as Record<string, unknown>;
  const fn =
    (mod.evaluateDiagnostics as unknown) ??
    (mod.evaluateDiagnosticRules as unknown) ??
    (mod.evaluate as unknown);
  expect(
    typeof fn,
    'apps/pusher/src/diagnostics/rules.ts 需导出纯函数 evaluateDiagnostics(signals, state)',
  ).toBe('function');
  return fn as unknown as EvaluateFn;
}

/** 规则状态：实现若提供工厂就优先用（避免漏初始化内部计时表） */
function createState(): Record<string, unknown> {
  const mod = rulesModule as unknown as Record<string, unknown>;
  for (const name of ['createDiagnosticsState', 'createRulesState', 'createDiagnosticState']) {
    const factory = mod[name];
    if (typeof factory === 'function') {
      return (factory as () => Record<string, unknown>)();
    }
  }
  return {};
}

/** 健康态信号：什么都不命中（任何一条规则命中都意味着本文件某处断言写错了） */
function healthy(now: number): Signals {
  return {
    now,
    template: 'alone',
    pushExpiresAt: new Date(now + HOUR).toISOString(),
    pushRejectedAuth: false,
    pushStartedAt: now - 60_000,
    firstFrameAt: now - 59_000,
    connected: true,
    connectFailed: false,
    fps: 15,
    bitrateKbps: 800,
    peakBitrateKbps: 800,
    audioRmsDb: -20,
    averageLuma: 120,
    captureError: null,
    captureTrackActive: true,
  };
}

/**
 * 用固定时钟驱动规则：同一个 `state` 连续调用，模拟 useDiagnostics 的 1s tick。
 * 返回该时刻的 verdict（null = 无命中）。
 */
function makeClock(state: Record<string, unknown>, start = T0) {
  const evaluate = resolveEvaluate();
  let now = start;
  return {
    evaluate,
    state,
    get now() {
      return now;
    },
    tick(advanceMs: number, overrides: Signals = {}): Verdict {
      now += advanceMs;
      return evaluate({ ...healthy(now), ...overrides, now }, state);
    },
  };
}

interface HoldScenario {
  id: DiagnosticId;
  name: string;
  /** 该诊断项的严重度（D7 麦克风静音是 warning，其余是 danger；见 shared DIAGNOSTIC_META） */
  level: 'danger' | 'warning';
  /** 命中态持续多少毫秒才判命中（D24） */
  holdMs: number;
  /** 恢复态持续多少毫秒才撤销（0 = 即时恢复） */
  recoverMs: number;
  /** 命中态信号（相对基准时刻 T0） */
  bad: (now: number) => Signals;
  /** 恢复态信号（D3 需要把 firstFrameAt 填上） */
  good: (now: number) => Signals;
}

const HOLD_SCENARIOS: HoldScenario[] = [
  {
    id: 'D3',
    name: '连不上推流服务器（首帧 8s 未到）',
    level: 'danger',
    holdMs: 8_000,
    recoverMs: 0,
    bad: (now) => ({ pushStartedAt: now, firstFrameAt: null, connected: false }),
    good: (now) => ({ pushStartedAt: now - 9_000, firstFrameAt: now, connected: true }),
  },
  {
    id: 'D5',
    name: '断流 / 码率掉底（连续 5s < max(150kbps, 峰值 40%)）',
    level: 'danger',
    holdMs: 5_000,
    recoverMs: 3_000,
    bad: () => ({ bitrateKbps: 100, peakBitrateKbps: 800, connected: true }),
    good: () => ({ bitrateKbps: 800, peakBitrateKbps: 800, connected: true }),
  },
  {
    id: 'D6',
    name: '编码器无输出（fps=0 连续 5s，采集轨道仍在出帧）',
    level: 'danger',
    holdMs: 5_000,
    recoverMs: 2_000,
    bad: () => ({ fps: 0, captureTrackActive: true }),
    good: () => ({ fps: 15, captureTrackActive: true }),
  },
  {
    id: 'D7',
    name: '麦克风没声音（连续 8s < -60 dBFS）',
    level: 'warning',
    holdMs: 8_000,
    recoverMs: 2_000,
    bad: () => ({ audioRmsDb: -72 }),
    good: () => ({ audioRmsDb: -18 }),
  },
  {
    id: 'D9',
    name: '摄像头黑屏（连续 3s 亮度 < 8/255）',
    level: 'danger',
    holdMs: 3_000,
    recoverMs: 0,
    bad: () => ({ averageLuma: 3 }),
    good: () => ({ averageLuma: 120 }),
  },
];

describe('evaluateDiagnostics — 健康态基线', () => {
  it('一切正常时任何一条都不命中（返回 null）', () => {
    const clock = makeClock(createState());

    expect(clock.tick(0)).toBeFalsy();
    expect(clock.tick(1_000)).toBeFalsy();
    expect(clock.tick(60_000)).toBeFalsy();
  });
});

describe('evaluateDiagnostics — 阈值边界（刚好命中 / 差 1ms 不命中 / 恢复撤销）', () => {
  for (const scenario of HOLD_SCENARIOS) {
    it(`${scenario.id} ${scenario.name}`, () => {
      const clock = makeClock(createState());

      // 命中态信号以基准时刻 T0 生成（D3 的 pushStartedAt 必须固定，否则计时起点跟着 tick 漂移）
      const badSignals = scenario.bad(T0);

      // 1) 命中态出现的那一刻：hold 未满 → 不命中
      expect(
        clock.tick(0, badSignals),
        `${scenario.id} 阈值是「连续 ${scenario.holdMs}ms」，刚出现不能立刻报`,
      ).toBeFalsy();

      // 2) 差 1ms → 不命中
      expect(
        clock.tick(scenario.holdMs - 1, badSignals),
        `${scenario.id} 差 1ms 不能命中（阈值 ${scenario.holdMs}ms）`,
      ).toBeFalsy();

      // 3) 刚好到阈值 → 命中
      const hit = clock.tick(1, badSignals);
      expect(hit?.id, `${scenario.id} 刚好到 ${scenario.holdMs}ms 必须命中`).toBe(scenario.id);
      expect(hit?.level, `${scenario.id} 命中态 level 必须是 ${scenario.level}`).toBe(
        scenario.level,
      );

      // 4) 恢复态刚开始：还没到恢复阈值，结论不能立刻撤销（避免抖动）
      const recoveryStart = clock.now + 1_000;
      if (scenario.recoverMs > 0) {
        expect(
          clock.tick(1_000, scenario.good(clock.now)),
          `${scenario.id} 恢复需要连续 ${scenario.recoverMs}ms，刚恢复不能立刻撤销`,
        ).toEqual(hit);

        expect(
          clock.tick(scenario.recoverMs - 1, scenario.good(clock.now)),
          `${scenario.id} 恢复差 1ms 不能撤销（阈值 ${scenario.recoverMs}ms）`,
        ).toEqual(hit);
      }

      // 5) 刚好到恢复阈值 → 撤销（回到 null）
      const remaining = recoveryStart + (scenario.recoverMs > 0 ? scenario.recoverMs - 1 : 0) - clock.now;
      expect(
        clock.tick(remaining + 1, scenario.good(clock.now)),
        `${scenario.id} 恢复达到阈值后必须撤销结论`,
      ).toBeFalsy();
    });
  }
});

describe('evaluateDiagnostics — 即时命中型（无 hold）', () => {
  it('D2 频道模板不是 alone → 立刻命中；改回 alone 立刻撤销', () => {
    const clock = makeClock(createState());

    expect(clock.tick(0), '健康态不该命中 D2').toBeFalsy();

    const hit = clock.tick(0, { template: 'ppt' });
    expect(hit?.id).toBe('D2');
    expect(hit?.level).toBe('danger');

    expect(clock.tick(1_000, { template: 'ppt' })).toEqual(hit);
    expect(clock.tick(1_000, { template: 'alone' }), '模板改回纯视频后必须撤销').toBeFalsy();
  });

  it('D1 地址剩余 179999ms → 命中；剩余正好 180000ms（差 1ms）→ 不命中', () => {
    const clock = makeClock(createState());

    // 差 1ms：剩余正好 3 分钟不算过期告警（计划原文「剩余 < 3 分钟」）
    expect(
      clock.tick(0, { pushExpiresAt: new Date(T0 + 180_000).toISOString() }),
      '剩余正好 180000ms 不满足「< 3 分钟」',
    ).toBeFalsy();

    const hit = clock.tick(0, { pushExpiresAt: new Date(T0 + 179_999).toISOString() });
    expect(hit?.id, '剩余 179999ms 必须命中 D1').toBe('D1');

    // 恢复：重新取地址成功且剩余 ≥ 3 分钟
    expect(
      clock.tick(1_000, { pushExpiresAt: new Date(clock.now + 180_000).toISOString() }),
      '重新取地址后剩余 ≥ 3 分钟必须撤销',
    ).toBeFalsy();
  });

  it('D1 推流被拒且分类为鉴权类 → 即时命中（第二条触发路径）', () => {
    const clock = makeClock(createState());

    const hit = clock.tick(0, { pushRejectedAuth: true });
    expect(hit?.id).toBe('D1');
  });

  it('D9 getUserMedia 失败 → 即时命中（不必等黑屏 3s）', () => {
    const clock = makeClock(createState());

    const hit = clock.tick(0, { captureError: 'NotAllowedError', averageLuma: null });
    expect(hit?.id).toBe('D9');

    // 重新授权成功、画面正常 → 撤销
    expect(
      clock.tick(1_000, { captureError: null, averageLuma: 128 }),
      '权限恢复且出现非黑帧后必须撤销',
    ).toBeFalsy();
  });

  it('D5 连接态掉出 connected → 也要能命中（不只码率一条路径）', () => {
    const clock = makeClock(createState());

    clock.tick(0, { connected: false });
    expect(clock.tick(4_999, { connected: false })).toBeFalsy();
    const hit = clock.tick(1, { connected: false });
    expect(hit?.id).toBe('D5');
  });

  it('D6 fps=0 但采集轨道没出帧（captureTrackActive=false）→ 不算编码器问题', () => {
    const clock = makeClock(createState());

    clock.tick(0, { fps: 0, captureTrackActive: false });
    expect(
      clock.tick(6_000, { fps: 0, captureTrackActive: false }),
      '「但采集轨道仍在出帧」是 D6 的判定前提，采集本身停了不该报 D6',
    ).toBeFalsy();
  });
});

describe('evaluateDiagnostics — 优先级（同一时刻只返回一条）', () => {
  /** 7 条全部处于命中态的叠加信号 */
  function allBad(now: number): Signals {
    return {
      template: 'ppt',
      pushExpiresAt: new Date(now - 1_000).toISOString(),
      pushStartedAt: now - 60_000,
      firstFrameAt: null,
      connected: false,
      fps: 0,
      captureTrackActive: true,
      bitrateKbps: 0,
      peakBitrateKbps: 800,
      audioRmsDb: -80,
      averageLuma: 0,
    };
  }

  it('全部同时命中只返回 D2（最高优先级）', () => {
    const clock = makeClock(createState());

    expect(clock.tick(0, allBad(clock.now))?.id, 'D2 是即时命中且优先级最高').toBe('D2');
    // 攒够最长 hold（8s）后仍然是 D2，不会被低优先级规则顶掉
    let verdict = clock.tick(10_000, allBad(clock.now));
    for (let index = 0; index < 10; index += 1) {
      verdict = clock.tick(1_000, allBad(clock.now));
    }
    expect(verdict?.id, '多规则同时命中必须始终只返回最高优先级 D2').toBe('D2');
  });

  it('逐条修掉后按 D1 → D3 → D9 → D6 → D7 → D5 的顺序降级', () => {
    const clock = makeClock(createState());
    const bad = allBad(clock.now);

    // 先把所有规则的 hold 都攒满（最长 8s）
    clock.tick(0, bad);
    for (let index = 0; index < 10; index += 1) clock.tick(1_000, bad);

    const stillBad: Signals = { ...bad };

    // 修 D2（模板改回纯视频）→ 下一顺位 D1
    stillBad.template = 'alone';
    expect(clock.tick(0, stillBad)?.id, '修掉 D2 后应该是 D1').toBe('D1');

    // 修 D1（地址重新取，剩余充足）→ D3
    stillBad.pushExpiresAt = new Date(clock.now + HOUR).toISOString();
    expect(clock.tick(0, stillBad)?.id, '修掉 D1 后应该是 D3').toBe('D3');

    // 修 D3（连上并拿到首帧）→ D9
    stillBad.firstFrameAt = clock.now;
    stillBad.connected = true;
    expect(clock.tick(0, stillBad)?.id, '修掉 D3 后应该是 D9（黑屏 hold 已攒满）').toBe('D9');

    // 修 D9（出现非黑帧）→ D6
    stillBad.averageLuma = 130;
    expect(clock.tick(0, stillBad)?.id, '修掉 D9 后应该是 D6').toBe('D6');

    // 修 D6（fps 回来，且持续 2s 才撤）→ 撤掉之后是 D7
    stillBad.fps = 18;
    clock.tick(0, stillBad);
    const afterD6 = clock.tick(2_000, stillBad);
    expect(afterD6?.id, 'D6 撤销后应该是 D7').toBe('D7');

    // 修 D7（麦克风有声音，持续 2s 才撤）→ 剩 D5
    stillBad.audioRmsDb = -16;
    clock.tick(0, stillBad);
    const afterD7 = clock.tick(2_000, stillBad);
    expect(afterD7?.id, 'D7 撤销后应该只剩 D5').toBe('D5');

    // 修 D5（码率恢复，持续 3s 才撤）→ 全清
    stillBad.bitrateKbps = 800;
    clock.tick(0, stillBad);
    expect(clock.tick(3_000, stillBad), '全部修好后必须回到无结论').toBeFalsy();
  });
});

describe('evaluateDiagnostics — fixing 期间不被抢占（§四 状态机）', () => {
  /** 让 D5 命中（连续 5s 低码率） */
  function reachD5(clock: ReturnType<typeof makeClock>) {
    clock.tick(0, { bitrateKbps: 100, peakBitrateKbps: 800, connected: true });
    clock.tick(5_000, { bitrateKbps: 100, peakBitrateKbps: 800, connected: true });
    const verdict = clock.tick(0, { bitrateKbps: 100, peakBitrateKbps: 800, connected: true });
    expect(verdict?.id, '前置条件：先让 D5 命中').toBe('D5');
    return verdict;
  }

  it('state.fixing 有值时：即使更高优先级的 D2 命中，也仍返回正在修的那一条', () => {
    const clock = makeClock(createState());
    const d5 = reachD5(clock);

    // sequence-diagram §3：state.fixing = verdict.id
    clock.state.fixing = 'D5';

    const during = clock.tick(1_000, {
      template: 'ppt', // D2 命中（优先级最高）
      audioRmsDb: -80, // D7 也命中
      bitrateKbps: 0,
      connected: false,
      captureTrackActive: true,
      fps: 0,
    });
    expect(during?.id, 'fixing 期间不得被其它规则（含更高优先级）抢占').toBe('D5');
    expect(during?.reason, 'fixing 期间结论文案也要保持同一条').toBe(d5?.reason);

    // 修复失败：清掉 fixing 后回到真实最高优先级
    clock.state.fixing = null;
    expect(
      clock.tick(0, { template: 'ppt', bitrateKbps: 0 })?.id,
      '修复失败回到同一结论的场景见 useDiagnostics；规则层清掉 fixing 后按真实优先级出结论',
    ).toBe('D2');
  });

  it('fixing 期间低优先级规则也抢不走（D5 修复中 · D7 命中）', () => {
    const clock = makeClock(createState());
    reachD5(clock);

    clock.state.fixing = 'D5';
    const during = clock.tick(1_000, {
      bitrateKbps: 100,
      peakBitrateKbps: 800,
      audioRmsDb: -80,
    });
    expect(during?.id).toBe('D5');
  });
});

/* ============================================================================================
 * 增补 B（HACK-1024 §十一 B / CONTEXT D35）：网络波动分级 networkWavering
 *
 * 契约文本在这里**自相矛盾**（已报主代理，需要 评审人 裁定并回写计划）：
 *   - `docs/execution-plan.md` §十一 B 表格：「码率在**基线 60%–100%** 之间持续 ≥ 5 秒」
 *     → 波动带 = [0.6×基线, 1.0×基线)；只要比峰值低一点点（例如峰值 800、当前 796）就算波动。
 *   - `CONTEXT.md` D35：「码率**跌破基线 60%** 但未断流 → warning」
 *     → 波动带 = [D5 下限, 0.6×基线)，是「断流前兆」而不是「任何掉码」。
 *
 * 本文件按 **计划 §十一 B 表格（= 主代理派单口径：60%–100% 区间）** 锁，
 * 与当前实现（`NETWORK_WAVERING.maxRatio = 0.6`，`bitrate >= 0.6×基线 && bitrate < 基线`）一致。
 * ⚠ 产品风险：按这个口径，真实推流只要码率抖到峰值以下 5 秒，自检条就会常态挂一条「网络波动」；
 *   若 评审人 裁定按 D35，则把下面 65% / 70% 两条（true）与 55%（false）的期望整体翻过来。
 *
 * 计划没给函数签名（与 D31 的 `DiagnosticSignals` 一样属于「TestSpec 固化」）：
 *   `evaluateAdvisories(signals, state) → DiagnosticAdvisory[]`（返回布尔 / `{networkWavering}` 也接受）
 *   advisory 用自己的 hold 计时表，与硬诊断的 `fixing / active / activeVerdict` 互不影响。
 * ========================================================================================== */

type AdvisoryResult =
  | boolean
  | { networkWavering?: boolean }
  | { advisories?: string[] | Record<string, boolean> }
  | Array<string | { id?: string }>
  | null
  | undefined;

function resolveAdvisoryEvaluator(): (signals: Signals, state: Record<string, unknown>) => AdvisoryResult {
  const mod = rulesModule as unknown as Record<string, unknown>;
  for (const name of [
    'evaluateAdvisories',
    'evaluateAdvisory',
    'evaluateAdvisoryRules',
    'evaluateNetworkWavering',
  ]) {
    const candidate = mod[name];
    if (typeof candidate === 'function') {
      return candidate as (signals: Signals, state: Record<string, unknown>) => AdvisoryResult;
    }
  }
  throw new Error(
    'apps/pusher/src/diagnostics/rules.ts 需导出 advisory 判定 evaluateAdvisories(signals, state)（§十一 B / D35）',
  );
}

function createAdvisoryState(): Record<string, unknown> {
  const mod = rulesModule as unknown as Record<string, unknown>;
  for (const name of ['createAdvisoryState', 'createAdvisoriesState', 'createDiagnosticsState']) {
    const factory = mod[name];
    if (typeof factory === 'function') return (factory as () => Record<string, unknown>)();
  }
  return {};
}

/** 把实现可能采用的几种返回形态统一读成 boolean */
function networkWaveringOf(result: AdvisoryResult): boolean {
  if (typeof result === 'boolean') return result;
  if (Array.isArray(result)) {
    return result.some((item) =>
      typeof item === 'string' ? item === 'networkWavering' : item?.id === 'networkWavering',
    );
  }
  if (result && typeof result === 'object') {
    const bag = result as Record<string, unknown>;
    if (typeof bag.networkWavering === 'boolean') return bag.networkWavering;
    const nested = bag.advisories;
    if (Array.isArray(nested)) return nested.includes('networkWavering');
    if (nested && typeof nested === 'object') {
      return (nested as Record<string, unknown>).networkWavering === true;
    }
  }
  return false;
}

/** 用固定时钟驱动 advisory：同一个 state 连续调用，模拟 1s tick */
function makeAdvisoryClock() {
  const evaluate = resolveAdvisoryEvaluator();
  const state = createAdvisoryState();
  let now = T0;
  return {
    state,
    get now() {
      return now;
    },
    tick(advanceMs: number, overrides: Signals = {}): boolean {
      now += advanceMs;
      return networkWaveringOf(evaluate({ ...healthy(now), ...overrides, now }, state));
    },
  };
}

/**
 * 码率降到峰值的 `ratio`（基线取 peakBitrateKbps = 1000）。
 * 按计划 §十一 B：波动带 = [600, 1000)（含下沿、不含「与基线持平」）。
 */
function bitrateAt(ratio: number, overrides: Signals = {}): Signals {
  return { bitrateKbps: Math.round(1000 * ratio), peakBitrateKbps: 1000, ...overrides };
}

describe('evaluateAdvisories — networkWavering（§十一 B / D35）', () => {
  it('码率掉到基线 70% 且持续 5 秒 → advisory 为 true（4_999ms 还不能报）', () => {
    const clock = makeAdvisoryClock();

    expect(clock.tick(0, bitrateAt(0.7)), '刚掉下来不能立刻报（要先攒 5 秒）').toBe(false);
    expect(clock.tick(4_999, bitrateAt(0.7)), '差 1ms 到 5 秒不能报').toBe(false);
    expect(clock.tick(1, bitrateAt(0.7)), '刚好 5 秒必须给出「网络波动」提醒').toBe(true);
  });

  it('基线 65%（区间下沿附近）也能识别，说明不是只认某个点', () => {
    const clock = makeAdvisoryClock();

    clock.tick(0, bitrateAt(0.65));
    expect(clock.tick(5_000, bitrateAt(0.65)), '65% 在「60%–100%」区间内').toBe(true);
  });

  it('码率回到基线（100%）→ advisory 撤销', () => {
    const clock = makeAdvisoryClock();

    clock.tick(0, bitrateAt(0.7));
    clock.tick(5_000, bitrateAt(0.7));
    expect(clock.tick(0, bitrateAt(0.7)), '前置条件：advisory 已成立').toBe(true);

    expect(
      clock.tick(1_000, bitrateAt(1)),
      '码率回到基线就不再是「波动」，advisory 必须撤销',
    ).toBe(false);
  });

  it('码率低于基线 60%（不属于波动区间）→ advisory 为 false', () => {
    const clock = makeAdvisoryClock();

    clock.tick(0, bitrateAt(0.55));
    expect(
      clock.tick(10_000, bitrateAt(0.55)),
      '低于 60% 不在计划的「60%–100%」区间内：更严重的掉底由 D5 出结论，不能两条一起说',
    ).toBe(false);
  });

  it('码率高于基线（120%）→ 不是波动，advisory 为 false', () => {
    const clock = makeAdvisoryClock();

    clock.tick(0, bitrateAt(1.2));
    expect(clock.tick(10_000, bitrateAt(1.2)), '超过基线不是「掉码率」').toBe(false);
  });

  it('连接态不是 connected → 不返回 advisory（断流归 D5）', () => {
    const clock = makeAdvisoryClock();

    clock.tick(0, bitrateAt(0.7, { connected: false }));
    expect(
      clock.tick(10_000, bitrateAt(0.7, { connected: false })),
      '连接断了是断流，不是「网络波动」',
    ).toBe(false);
  });

  it('不改变 evaluateDiagnostics 的硬诊断结果，也不写 activeVerdict', () => {
    const state = createState();
    const evaluate = resolveEvaluate();
    const advisory = makeAdvisoryClock();

    // 波动区间：硬诊断必须仍然「无结论」
    let now = T0;
    expect(evaluate({ ...healthy(now), ...bitrateAt(0.7), now }, state)).toBeFalsy();
    advisory.tick(0, bitrateAt(0.7));

    for (let index = 0; index < 8; index += 1) {
      now += 1_000;
      expect(
        evaluate({ ...healthy(now), ...bitrateAt(0.7), now }, state),
        '网络波动是 advisory，不能凭空造出一条硬结论（自检条仍是「一切正常」）',
      ).toBeFalsy();
      advisory.tick(1_000, bitrateAt(0.7));
    }

    expect(advisory.tick(0, bitrateAt(0.7)), '前置条件：advisory 成立').toBe(true);
    const bag = state as Record<string, unknown>;
    expect(bag.activeVerdict ?? null, 'advisory 绝不能写 activeVerdict').toBeNull();
    expect(bag.active ?? null, 'advisory 绝不能占用硬诊断的 active 槽位').toBeNull();
  });

  it('D5 真触发（低于 max(150kbps, 峰值 40%)）时 advisory 为 false，硬诊断仍是 D5', () => {
    const state = createState();
    const evaluate = resolveEvaluate();
    const advisory = makeAdvisoryClock();
    const severe: Signals = { bitrateKbps: 100, peakBitrateKbps: 1000, connected: true };

    let now = T0;
    evaluate({ ...healthy(now), ...severe, now }, state);
    advisory.tick(0, severe);
    now += 5_000;
    const verdict = evaluate({ ...healthy(now), ...severe, now }, state);

    expect(verdict?.id, '100kbps < max(150, 40%×1000) → D5 必须命中').toBe('D5');
    expect(
      advisory.tick(10_000, severe),
      'D5 已经命中时不能再叠一条 advisory（同一时刻只说一句话）',
    ).toBe(false);
  });
});
