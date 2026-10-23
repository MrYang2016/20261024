import {
  DIAGNOSTIC_ADVISORY_META,
  DIAGNOSTIC_META,
  DIAGNOSTIC_PRIORITY,
  DIAGNOSTIC_THRESHOLDS,
  NETWORK_WAVERING,
  diagnosticCode,
  type DiagnosticAction,
  type DiagnosticAdvisory,
  type DiagnosticAdvisoryId,
  type DiagnosticId,
  type DiagnosticVerdict,
} from '@live1024/shared';

/**
 * 诊断规则引擎（计划 §五 5.3 / §三 规则表）。
 *
 * **纯函数 + 外部状态**：`evaluateDiagnostics(signals, state)` 不改任何全局东西，
 * 所有 hold / recover 计时都落在调用方持有的 `state` 上，时刻来自 `signals.now`——
 * 所以单测可以用假时钟把 8 秒直接拨过去，不依赖真实计时器。
 *
 * 同一时刻只返回**最高优先级**一条（D2 > D1 > D3 > D9 > D6 > D7 > D5）。
 * `state.fixing` 有值时（sequence-diagram §3：`state.fixing = verdict.id`）只返回正在修的那一条，
 * 更高优先级的规则也抢不走。
 *
 * 结论一旦确认就**冻结**：`reason / measured / code / at` 保持命中那一刻的值。
 * 这样详情区不会每秒跳字，同一个诊断码在讲师报障时也始终指同一件事。
 */

/** 规则输入：全部可选，缺省 = 该项无数据 / 健康（不命中） */
export interface DiagnosticSignals {
  /** 当前时刻（ms）：所有 hold / recover 判定都基于它 */
  now: number;
  /** 频道模板：'alone' = 纯视频（D2） */
  template?: string | null;
  /**
   * 取频道 / 取推流地址时撞上「模板不是纯视频」——D2 的**错误路径**（D29）。
   * 真实链路里非纯视频模板的请求本身就是 502，`template` 根本拿不到，
   * 只能靠 `error-to-signal.ts` 的错误分类判定（不要为了凑判定伪造一个模板值）。
   */
  templateMismatch?: boolean;
  /** 推流地址有效期（ISO）：D1 的第二条路径 */
  pushExpiresAt?: string | null;
  /** 推流被拒且错误分类为鉴权类（D1） */
  pushRejectedAuth?: boolean;
  /** 本次推流开始时刻（D3 的首帧超时从这一刻算） */
  pushStartedAt?: number | null;
  /** 拿到首帧的时刻（D3 的恢复条件） */
  firstFrameAt?: number | null;
  /** 是否处于 connected（D5 判定连接态；未知时不要传） */
  connected?: boolean;
  /** 连接失败 / ICE 失败（D3 即时命中） */
  connectFailed?: boolean;
  /**
   * 预检网络探测不通过（D38）：还没开播时 `GET /api/health` 探测不通。
   * 这是 D3 「连不上服务器」在**预检阶段**的证据（推流阶段仍只认推流器错误 / 首帧超时）。
   */
  networkUnreachable?: boolean;
  /** 实时帧率 */
  fps?: number | null;
  /** 实时上行码率（kbps） */
  bitrateKbps?: number | null;
  /** 本次会话观测到的码率峰值（kbps） */
  peakBitrateKbps?: number | null;
  /** 麦克风实测电平（dBFS，负值；静音约 -100） */
  audioRmsDb?: number | null;
  /** 预览画面平均亮度（0-255） */
  averageLuma?: number | null;
  /** getUserMedia 失败时的错误名 / 分类码（D9 即时命中） */
  captureError?: string | null;
  /** 采集轨道是否仍在出帧（D6 的判定前提） */
  captureTrackActive?: boolean;

  /* ---- 以下只用于详情文案，不参与判定 ---- */
  /** 当前模板值（D2 详情） */
  templateHint?: string | null;
  /** 模板不符的上游原文 / 失败码（D2 详情；只进详情，不参与判定） */
  templateMismatchDetail?: string | null;
  /** 推流错误的原文 / 失败码（D3 详情） */
  pushErrorDetail?: string | null;
  /** 推流错误的一句话原因（D3 / D1 用它替代通用原因，避免丢掉具体信息） */
  pushErrorMessage?: string | null;
  /** 采集错误的一句话原因（D9） */
  captureErrorMessage?: string | null;
  /** 当前麦克风设备名（D7 详情） */
  audioDeviceLabel?: string | null;
  /** 上行域名（D3 详情：推流域名） */
  pushHost?: string | null;
  /** 目标码率（D5 详情） */
  bitrateTargetKbps?: number | null;
  /**
   * 规则引擎内部填充：本 tick 刚拿到一条**更晚**的推流地址（地址被刷新）。
   * 刷新那一刻不判 D1「已过期」——刚取到的新地址不该在同一个 tick 里再报一次过期。
   */
  pushUrlRefreshed?: boolean;
}

/** 规则引擎状态：由调用方持有并在多次评估间复用 */
export interface DiagnosticsState {
  /** 正在执行修复的诊断项（fixing 期间不被任何规则抢占） */
  fixing: DiagnosticId | null;
  /** 每条规则命中条件首次成立的时刻 */
  holdSince: Partial<Record<DiagnosticId, number>>;
  /** 命中后「恢复信号」首次出现的时刻 */
  recoverSince: Partial<Record<DiagnosticId, number>>;
  /** 当前已确认的结论 */
  active: DiagnosticId | null;
  /** 当前结论的确认时刻（诊断码 / 发生时间用它，保证同一条结论稳定） */
  activeSince: number | null;
  /** 冻结的结论：确认后不再随每秒实测值抖动 */
  activeVerdict: DiagnosticVerdict | null;
  /** 每条规则修复失败次数（D5 两次失败后转「降低分辨率重推」） */
  failures: Partial<Record<DiagnosticId, number>>;
  /** 上一次见到的推流地址有效期（毫秒）：用来识别「地址刚被刷新」 */
  lastExpiresAtMs: number | null;
}

export function createDiagnosticsState(): DiagnosticsState {
  return {
    fixing: null,
    holdSince: {},
    recoverSince: {},
    active: null,
    activeSince: null,
    activeVerdict: null,
    failures: {},
    lastExpiresAtMs: null,
  };
}

interface RuleDefinition {
  /** 即时命中条件 */
  condition: (signals: DiagnosticSignals) => boolean;
  /** 需要持续多久才算命中（毫秒）：D9 的权限失败是即时的，黑屏要 3 秒 */
  holdMs?: (signals: DiagnosticSignals) => number;
  /** 恢复需要持续多久（毫秒，缺省 0 = 即时撤销） */
  recoverMs?: number;
  /** 恢复信号（缺省 = 条件不再成立）
   * 例：D7 的「恢复」是电平回到 -50 dBFS 以上，而不是「不再低于 -60」。 */
  recovered?: (signals: DiagnosticSignals) => boolean;
  /** 实测值文案 */
  measured: (signals: DiagnosticSignals) => string;
  /** 详情补充（失败码 / 设备名 / 模板值） */
  detail?: (signals: DiagnosticSignals) => string | null;
  /** 一句话原因（可从错误信息里取更具体的那句） */
  reason?: (signals: DiagnosticSignals) => string;
  /** 修复失败后的升级动作（例如 D5 两次失败 → 降低分辨率重推） */
  escalate?: (failures: number) => DiagnosticAction | null;
}

const THRESHOLDS = DIAGNOSTIC_THRESHOLDS;

/** 时间文案：把毫秒说成人话（详情区「实测」用） */
function secondsOf(milliseconds: number): string {
  return `${Math.round(milliseconds / 1000)} 秒`;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const RULES: Record<DiagnosticId, RuleDefinition> = {
  /**
   * D2 频道非纯视频模板：即时命中、即时撤销（改模板后下一次载入就恢复）。
   * 两条判定路径（D29）：拿得到频道就用 `template`；请求本身 502 时只认错误分类 `templateMismatch`。
   */
  D2: {
    condition: (signals) =>
      signals.templateMismatch === true ||
      (typeof signals.template === 'string' && signals.template !== 'alone'),
    measured: (signals) => {
      const template = signals.templateHint ?? signals.template;
      if (typeof template === 'string' && template.length > 0) return `当前模板 ${template}`;
      // 错误路径下服务端根本没下发模板值：说「未下发」，不编一个值出来（D29）
      return signals.templateMismatch === true
        ? '服务端判定模板不是纯视频（模板值未下发）'
        : '当前模板 未知';
    },
    detail: (signals) =>
      [
        signals.template ? `template=${signals.template}` : null,
        signals.templateMismatchDetail ?? null,
      ]
        .filter((piece): piece is string => Boolean(piece))
        .join(' · ') || null,
  },
  /** D1 推流地址过期 / 被拒：剩余 < 3 分钟或鉴权类拒绝，即时命中 */
  D1: {
    condition: (signals) => {
      if (signals.pushRejectedAuth === true) return true;
      if (signals.pushUrlRefreshed === true) return false;
      const expiresAt = toMillis(signals.pushExpiresAt);
      if (expiresAt === null) return false;
      return expiresAt - signals.now < THRESHOLDS.D1.pushUrlExpiryWarningMs;
    },
    measured: (signals) => {
      if (signals.pushRejectedAuth === true) return signals.pushErrorMessage ?? '推流被服务器拒绝';
      const expiresAt = toMillis(signals.pushExpiresAt);
      if (expiresAt === null) return '推流地址有效期未知';
      const remaining = expiresAt - signals.now;
      if (remaining <= 0) return '已过期';
      return `剩余 ${round(remaining / 60_000, 1)} 分钟（需 > ${THRESHOLDS.D1.pushUrlExpiryWarningMinutes} 分钟）`;
    },
    detail: (signals) => signals.pushErrorDetail ?? null,
    reason: (signals) => signals.pushErrorMessage ?? DIAGNOSTIC_META.D1.reason,
  },
  /** D3 连不上推流服务器：连接失败即时命中；首帧 8 秒未到也命中 */
  D3: {
    condition: (signals) => {
      // 模板不符不是网络问题：撞模板 502 时推流地址根本取不到，不许 D3 顶上来
      // （否则自检条会把「频道模板不对」误报成「连不上推流服务器」）
      if (signals.templateMismatch === true) return false;
      // D38：预检网络探测不通 = 连不上服务器（还没开播，没有推流器错误可看）
      if (signals.networkUnreachable === true) return true;
      if (signals.connectFailed === true) return true;
      if (signals.connected === true) return false;
      if (signals.firstFrameAt != null) return false;
      if (signals.pushStartedAt == null) return false;
      return signals.now - signals.pushStartedAt >= THRESHOLDS.D3.firstFrameTimeoutMs;
    },
    measured: (signals) => {
      if (signals.connectFailed === true) return signals.pushErrorDetail ?? '连接失败';
      // D39 / D40：上游网络层失败回 503，缺凭证回 200 + polyv:'unreachable'，两种都会让探测**立刻**失败
      // （不是只有超时才失败），所以证据不能只写「3 秒没响应」，也不能写死「回了 503」
      if (signals.networkUnreachable === true) return '健康检查未通过（服务端没探到外网）';
      const startedAt = signals.pushStartedAt;
      const waited = startedAt == null ? THRESHOLDS.D3.firstFrameTimeoutMs : signals.now - startedAt;
      return `首帧 ${secondsOf(Math.max(0, waited))}未到（超时 ${secondsOf(THRESHOLDS.D3.firstFrameTimeoutMs)}）`;
    },
    detail: (signals) =>
      [
        signals.pushErrorDetail,
        signals.networkUnreachable === true
          ? '健康检查 GET /api/health 未通过（上游不可达 / 服务端未配置直播凭证 / 3 秒超时）'
          : null,
        signals.pushHost ? `推流域名 ${signals.pushHost}` : null,
      ]
        .filter((piece): piece is string => Boolean(piece))
        .join(' · ') || null,
    reason: (signals) =>
      signals.pushErrorMessage ??
      // D38：预检阶段明确说「连不上服务器」，别把讲师引去看推流器
      (signals.networkUnreachable === true
        ? '连不上服务器，请检查网络'
        : DIAGNOSTIC_META.D3.reason),
  },
  /** D9 摄像头无画面：采集失败即时命中；持续黑屏 3 秒命中 */
  D9: {
    condition: (signals) => {
      if (signals.captureError) return true;
      return signals.averageLuma != null && signals.averageLuma < THRESHOLDS.D9.blackFrameMaxLuma;
    },
    holdMs: (signals) => (signals.captureError ? 0 : THRESHOLDS.D9.blackFrameHoldMs),
    measured: (signals) => {
      if (signals.captureError) return `采集失败：${signals.captureError}`;
      const luma = signals.averageLuma;
      if (luma == null) return '画面亮度未知';
      return `平均亮度 ${round(luma)}/255 持续 ${secondsOf(THRESHOLDS.D9.blackFrameHoldMs)}`;
    },
    detail: (signals) =>
      [signals.captureError, signals.averageLuma != null ? `亮度 ${round(signals.averageLuma)}/255` : null]
        .filter((piece): piece is string => Boolean(piece))
        .join(' · ') || null,
    reason: (signals) => signals.captureErrorMessage ?? DIAGNOSTIC_META.D9.reason,
  },
  /** D6 编码器无输出：fps=0 且采集轨道仍在出帧，连续 5 秒 */
  D6: {
    condition: (signals) => signals.fps === 0 && signals.captureTrackActive === true,
    holdMs: () => THRESHOLDS.D6.holdMs,
    recoverMs: THRESHOLDS.D6.recoverMs,
    recovered: (signals) => typeof signals.fps === 'number' && signals.fps > 0,
    measured: (signals) =>
      `帧率 ${signals.fps ?? 0} fps 持续 ${secondsOf(THRESHOLDS.D6.holdMs)}（采集仍在出帧）`,
    escalate: (failures) =>
      failures >= 1 ? { kind: 'lower-resolution', label: '降低分辨率重推' } : null,
  },
  /** D7 麦克风没声音：电平连续 8 秒 < -60 dBFS；回到 -50 dBFS 以上 2 秒才撤销 */
  D7: {
    condition: (signals) =>
      signals.audioRmsDb != null && signals.audioRmsDb < (THRESHOLDS.D7.silenceMaxDbfs as number),
    holdMs: () => THRESHOLDS.D7.holdMs,
    recoverMs: THRESHOLDS.D7.recoverMs,
    recovered: (signals) =>
      signals.audioRmsDb != null && signals.audioRmsDb > (THRESHOLDS.D7.recoverMinDbfs as number),
    measured: (signals) =>
      `${round(signals.audioRmsDb ?? 0)} dBFS 持续 ${secondsOf(THRESHOLDS.D7.holdMs)}`,
    detail: (signals) =>
      [signals.audioDeviceLabel, signals.audioRmsDb != null ? `${round(signals.audioRmsDb)} dBFS` : null]
        .filter((piece): piece is string => Boolean(piece))
        .join(' · ') || null,
  },
  /** D5 断流 / 码率掉底：连续 5 秒低于 max(150kbps, 峰值 40%)，或连接态掉出 connected */
  D5: {
    condition: (signals) => {
      const bitrate = signals.bitrateKbps;
      if (bitrate != null && bitrate < bitrateFloor(signals)) return true;
      // 「断流」的前提是本来推上去了：还没拿到过首帧的连接问题归 D3，不归 D5
      if (signals.connected === false) return signals.firstFrameAt != null;
      return false;
    },
    holdMs: () => THRESHOLDS.D5.holdMs,
    recoverMs: THRESHOLDS.D5.recoverMs,
    recovered: (signals) =>
      signals.connected !== false &&
      signals.bitrateKbps != null &&
      signals.bitrateKbps >= bitrateFloor(signals),
    measured: (signals) => {
      if (signals.connected === false && signals.bitrateKbps == null) return '上行连接已断开';
      const peak = signals.peakBitrateKbps;
      const bitrate = signals.bitrateKbps;
      const parts = [
        `${round(bitrate ?? 0)} kbps`,
        peak != null ? `峰值 ${round(peak)} kbps` : null,
        `下限 ${round(bitrateFloor(signals))} kbps`,
      ];
      return `${parts.filter((piece): piece is string => Boolean(piece)).join(' · ')} 持续 ${secondsOf(THRESHOLDS.D5.holdMs)}`;
    },
    detail: (signals) =>
      signals.connected === false ? '上行连接已断开' : (signals.bitrateTargetKbps != null ? `目标码率 ${round(signals.bitrateTargetKbps)} kbps` : null),
    /** 两次修复都没成功 → 降到低一档分辨率重推（D22） */
    escalate: (failures) => {
      if (failures >= 2) return { kind: 'lower-resolution', label: '降低分辨率重推' };
      if (failures >= 1) return { kind: 'reconnect', label: '再试一次' };
      return null;
    },
  },
};

/** D5 的生效下限：max(150kbps, 峰值 40%) */
function bitrateFloor(signals: DiagnosticSignals): number {
  const peak = signals.peakBitrateKbps ?? 0;
  return Math.max(THRESHOLDS.D5.minBitrateKbps, peak * THRESHOLDS.D5.peakRatio);
}

/* ------------------------------------------------------------------ *
 * 提醒（advisory）通道：D35 网络波动
 * ------------------------------------------------------------------ */

/** advisory 的 hold 计时：与硬规则的 `holdSince` 分开，互相不污染 */
export interface AdvisoryState {
  holdSince: Partial<Record<DiagnosticAdvisoryId, number>>;
}

export function createAdvisoryState(): AdvisoryState {
  return { holdSince: {} };
}

/**
 * 评估「提醒」类信号（D35）：目前只有 `networkWavering`。
 *
 * 它**不是**诊断结论：不进 `DIAGNOSTIC_PRIORITY`、不写 `state.activeVerdict`，所以永远不会抢占 D5
 * （码率真的掉到底时仍由 D5 出结论），只在自检条上把状态降成 warning 并给一句「网络波动，可能会断流」。
 *
 * 判定：仍有连接（`connected === true`）、码率落在基线的 **60% – 100%** 之间（含 60%，不含 100%：
 * 与基线持平不算波动）并持续 ≥ 5 秒。基线取本次会话的码率峰值（拿不到峰值就退到目标码率），
 * 这样「从多少掉到多少」是可解释的。更严重的掉底（< 60% / 到 D5 下限）归 D5 硬诊断，
 * advisory 不插手——同一时刻只说一句话。
 *
 * 口径来源：计划 §十一 B 表格（主代理派单口径）；CONTEXT D35 写的是「跌破基线 60%」，
 * 两者字面矛盾，本实现跟计划表格（与 rules.spec / e2e 锁定的区间一致）。
 */
export function evaluateAdvisories(
  signals: DiagnosticSignals,
  state: AdvisoryState,
): DiagnosticAdvisory[] {
  const advisoryId: DiagnosticAdvisoryId = 'networkWavering';
  const baseline = signals.peakBitrateKbps ?? signals.bitrateTargetKbps ?? null;
  const bitrate = signals.bitrateKbps;
  const wavering =
    signals.connected === true &&
    baseline != null &&
    baseline > 0 &&
    bitrate != null &&
    bitrate >= baseline * NETWORK_WAVERING.maxRatio &&
    bitrate < baseline;

  if (!wavering) {
    state.holdSince[advisoryId] = undefined;
    return [];
  }

  state.holdSince[advisoryId] ??= signals.now;
  const since = state.holdSince[advisoryId];
  if (since == null || signals.now - since < NETWORK_WAVERING.holdMs) return [];

  const meta = DIAGNOSTIC_ADVISORY_META[advisoryId];
  return [{ id: advisoryId, level: meta.level, text: meta.text }];
}

/**
 * 构造一条结论（也是 useDiagnostics 在「修复失败后重建同一结论」时用的入口）。
 * `at` / `code` 取 `state.activeSince`（没有就取当前时刻），保证同一条结论的诊断码稳定。
 */
export function buildDiagnosticVerdict(
  id: DiagnosticId,
  signals: DiagnosticSignals,
  state: DiagnosticsState,
): DiagnosticVerdict {
  const meta = DIAGNOSTIC_META[id];
  const rule = RULES[id];
  const at = state.activeSince ?? signals.now;
  const failures = state.failures[id] ?? 0;
  const escalated = rule.escalate?.(failures) ?? null;

  return {
    id,
    level: meta.level,
    reason: rule.reason?.(signals) ?? meta.reason,
    expected: meta.expected,
    measured: rule.measured(signals),
    detail: rule.detail?.(signals) ?? null,
    action: escalated ?? meta.action,
    code: diagnosticCode(id, at),
    at: new Date(at).toISOString(),
  };
}

/** 把外部传进来的 state 补齐（允许调用方从 `{}` 起步） */
function ensureState(state: DiagnosticsState): DiagnosticsState {
  state.holdSince ??= {};
  state.recoverSince ??= {};
  state.failures ??= {};
  state.fixing ??= null;
  state.active ??= null;
  if (state.activeSince === undefined) state.activeSince = null;
  if (state.activeVerdict === undefined) state.activeVerdict = null;
  return state;
}

/**
 * 评估所有诊断规则，返回当前应当展示的唯一一条结论（null = 一切正常）。
 * 见文件头的语义说明；这里只做四件事：固定结论、更新计时、按优先级挑一条、按恢复窗口撤销。
 */
export function evaluateDiagnostics(
  signals: DiagnosticSignals,
  state: DiagnosticsState,
): DiagnosticVerdict | null {
  const current = ensureState(state);
  const now = signals.now;

  // 地址刷新识别：更晚的 txTime 说明服务端刚发了一条新地址 → 本 tick 不判 D1
  const expiresAtMs = toMillis(signals.pushExpiresAt);
  const refreshed =
    expiresAtMs !== null && current.lastExpiresAtMs !== null && expiresAtMs > current.lastExpiresAtMs;
  if (expiresAtMs !== null) current.lastExpiresAtMs = expiresAtMs;
  const view: DiagnosticSignals = refreshed ? { ...signals, pushUrlRefreshed: true } : signals;

  // 1) 修复中：只保持正在修的那一条，任何规则（含更高优先级）都不得抢占（计划 §四）
  if (current.fixing) {
    if (current.activeVerdict?.id === current.fixing) return current.activeVerdict;
    current.activeSince = now;
    current.activeVerdict = buildDiagnosticVerdict(current.fixing, view, current);
    current.active = current.fixing;
    return current.activeVerdict;
  }

  // 2) 更新每条规则的 hold / recover 计时
  for (const id of DIAGNOSTIC_PRIORITY) {
    const rule = RULES[id];
    const hit = rule.condition(view);
    if (hit) {
      current.holdSince[id] ??= now;
      current.recoverSince[id] = undefined;
      continue;
    }

    current.holdSince[id] = undefined;
    // 恢复计时只对「已确认命中」的规则累积：没命中的规则不需要撤销
    if (current.active !== id) continue;
    if (isRecovered(id, view)) {
      current.recoverSince[id] ??= now;
    } else {
      current.recoverSince[id] = undefined;
    }
  }

  // 3) 已确认的结论是否已经恢复够了时长 → 撤销
  if (current.active) {
    const activeRule = RULES[current.active];
    const during = current.recoverSince[current.active];
    if (during != null && now - during >= (activeRule.recoverMs ?? 0)) {
      current.holdSince[current.active] = undefined;
      current.recoverSince[current.active] = undefined;
      current.active = null;
      current.activeSince = null;
      current.activeVerdict = null;
    }
  }

  // 4) 按优先级挑一条：先看谁已经攒够 hold
  const chosen = DIAGNOSTIC_PRIORITY.find((id) => isMatured(id, view, current, now)) ?? current.active;

  if (!chosen) return null;

  // 同一条结论：保持冻结（detail 里的实测值不每秒跳字，诊断码也不变）
  if (chosen === current.active && current.activeVerdict) return current.activeVerdict;

  current.active = chosen;
  current.activeSince = now;
  current.activeVerdict = buildDiagnosticVerdict(chosen, view, current);
  return current.activeVerdict;
}

function isMatured(
  id: DiagnosticId,
  signals: DiagnosticSignals,
  state: DiagnosticsState,
  now: number,
): boolean {
  const rule = RULES[id];
  if (!rule.condition(signals)) return false;
  const since = state.holdSince[id];
  if (since == null) return false;
  const required = rule.holdMs?.(signals) ?? 0;
  return now - since >= required;
}

function isRecovered(id: DiagnosticId, signals: DiagnosticSignals): boolean {
  const rule = RULES[id];
  if (rule.recovered) return rule.recovered(signals);
  return !rule.condition(signals);
}

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
