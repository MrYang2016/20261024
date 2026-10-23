/**
 * 直播诊断卡（HACK-1024）的共享契约：诊断项枚举、阈值、优先级、文案与上报体。
 *
 * 这是 shared 的第一份**运行时**导出（此前只有类型）。
 * 前端（apps/pusher）按规则表判定，服务端（apps/server）只做留痕，两边读同一份阈值与枚举，
 * 不允许各写一套（计划 §三 / §Done when 4）。
 *
 * 服务端走 `@live1024/shared/diagnostics` 子路径引入：node 加载 .ts 源码时不做省略扩展名的解析，
 * 所以子路径必须映射到确切文件（见 packages/shared/diagnostics.d.ts 与 package.json exports）。
 */

/** 一期 7 个诊断项（D28）：不做 D4 / D8 / D10 / D11 */
export type DiagnosticId = 'D1' | 'D2' | 'D3' | 'D5' | 'D6' | 'D7' | 'D9';

/** 诊断严重度：只有这两种（fixing / ok 是自检条的展示态，不是诊断级别） */
export type DiagnosticLevel = 'danger' | 'warning';

/** 诊断项的稳定枚举值（服务端校验 POST 体用，顺序同优先级） */
export const DIAGNOSTIC_IDS: readonly DiagnosticId[] = ['D2', 'D1', 'D3', 'D9', 'D6', 'D7', 'D5'];

/**
 * 同一时刻只显示最高优先级一条（计划 §三）：D2 > D1 > D3 > D9 > D6 > D7 > D5。
 * 数组顺序即优先级，改动顺序等于改产品行为。
 */
export const DIAGNOSTIC_PRIORITY = ['D2', 'D1', 'D3', 'D9', 'D6', 'D7', 'D5'] as const satisfies readonly DiagnosticId[];

/**
 * 阈值表（D24「均衡档」，计划 §三逐项给出），按诊断项分桶。
 * 单位尽量写进键名：Ms = 毫秒，Kbps = 千比特每秒，Dbfs = 分贝满刻度，Luma = 0-255 亮度。
 */
export interface DiagnosticRule {
  /** 触发后需要持续多久才确认命中（毫秒） */
  holdMs?: number;
  /** 恢复信号需要持续多久才撤销（毫秒；0 / 缺省 = 即时） */
  recoverMs?: number;
  /** 其余判定阈值（各诊断项不同，见下方逐项注释） */
  [threshold: string]: number | undefined;
}

export const DIAGNOSTIC_THRESHOLDS = {
  /**
   * D1：推流地址剩余有效期 < 3 分钟即告警（即时判定，无保持窗口）。
   * 毫秒是规则比较用的值，分钟是同一阈值的展示口径（详情区「期望」一句话读它）。
   */
  D1: { pushUrlExpiryWarningMs: 3 * 60_000, pushUrlExpiryWarningMinutes: 3 },
  /** D2：模板不是纯视频就命中，没有节流阈值 */
  D2: {},
  /** D3：首帧 8 秒未到即判连不上（时长从推流开始算） */
  D3: { firstFrameTimeoutMs: 8_000 },
  /** D9：黑屏连续 3 秒；平均亮度 < 8/255 算黑帧；权限失败即时命中 */
  D9: { blackFrameHoldMs: 3_000, blackFrameMaxLuma: 8 },
  /** D6：帧率为 0 连续 5 秒；恢复后需 fps > 0 持续 2 秒 */
  D6: { holdMs: 5_000, recoverMs: 2_000 },
  /** D7：麦克风连续 8 秒 < -60 dBFS；恢复需 > -50 dBFS 持续 2 秒 */
  D7: { holdMs: 8_000, recoverMs: 2_000, silenceMaxDbfs: -60, recoverMinDbfs: -50 },
  /** D5：码率连续 5 秒 < max(150kbps, 峰值 40%)；恢复需持续 3 秒 */
  D5: { holdMs: 5_000, recoverMs: 3_000, minBitrateKbps: 150, peakRatio: 0.4 },
} as const satisfies Record<DiagnosticId, DiagnosticRule>;

/**
 * 实测统计超过这个时长没有更新，就当作「没有数据」——
 * 不能拿一份几分钟前的 fps/码率继续判 D5 / D6（会误报）。SDK 正常 1-2 秒回报一次。
 */
export const DIAGNOSTIC_STATS_STALE_MS = 10_000;

/** 每频道保留的诊断记录条数（D23 / D26：内存态，重启清空） */
export const DIAGNOSTIC_HISTORY_LIMIT = 50;

/**
 * 网络波动 advisory 的阈值（D35 / 计划 §十一 B）。
 * 走 `advisories` 通道：不进 7 条硬优先级、不写 `activeVerdict`，避免抢占 D5。
 *
 * 判定区间 = 码率在基线的 **60% – 100%**（含 60%，不含 100%：与基线持平不算波动；
 * 低于 60% 属于 D5 的地盘，不能再叠一条提醒，否则同一故障两种说法）。
 */
export const NETWORK_WAVERING = {
  /** 区间下沿：码率 ≥ 基线 × 这个比例才算「还在波动区间内」（60%） */
  maxRatio: 0.6,
  /** 连续多久才算确认（毫秒） */
  holdMs: 5_000,
} as const;

/** 提醒（advisory）而不是诊断结论的项：目前只有「网络波动」一条（D35） */
export type DiagnosticAdvisoryId = 'networkWavering';

/** 一条提醒：**不是**诊断结论，不参与硬优先级，展示在自检条上 */
export interface DiagnosticAdvisory {
  id: DiagnosticAdvisoryId;
  level: DiagnosticLevel;
  /** 客户向一句话（与 `DiagnosticVerdict.reason` 同口径） */
  text: string;
}

export const DIAGNOSTIC_ADVISORY_META: Record<
  DiagnosticAdvisoryId,
  { level: DiagnosticLevel; text: string }
> = {
  networkWavering: { level: 'warning', text: '网络波动，可能会断流' },
};

/** 同一条诊断的合并 / 去重窗口：服务端合并 occurrences，前端同结论 60 秒内只上报一次 */
export const DIAGNOSTIC_DEDUPE_WINDOW_MS = 60_000;

/** 诊断项的一键修复动作类型（D22：能一键执行的都做成按钮，D2 只给帮助中心链接） */
export type DiagnosticActionKind =
  | 'open-help'
  | 'reconnect'
  | 'reload-pusher'
  | 'switch-device'
  | 'reauthorize'
  | 'lower-resolution';

/** 一个「下一步」 */
export interface DiagnosticAction {
  kind: DiagnosticActionKind;
  /** 按钮文案（客户向，动词开头） */
  label: string;
  /** open-help 专用：帮助中心地址（新窗口打开） */
  href?: string;
  /** switch-device 专用：换音频还是视频设备 */
  device?: 'audio' | 'video';
}

/** 诊断项元信息：中文名 / 一句话原因 / 期望值 / 下一步标签 */
export interface DiagnosticMeta {
  /** 诊断项中文名（历史抽屉里当标题用） */
  name: string;
  level: DiagnosticLevel;
  /** 一句话原因（客户向，不带句号；规则可覆盖） */
  reason: string;
  /** 期望值说明（详情区「期望」一行） */
  expected: string;
  /** 下一步按钮文案（和 action.label 同值，便于按诊断项取标签） */
  actionLabel: string;
  /** 下一步默认动作 */
  action: DiagnosticAction;
}

/** 频道模板不是纯视频时的帮助文档（D2 只给链接，不做一键改模板） */
export const DIAGNOSTIC_TEMPLATE_HELP_URL = 'https://help.polyv.net/';

export const DIAGNOSTIC_META: Record<DiagnosticId, DiagnosticMeta> = {
  D2: {
    name: '频道模板',
    level: 'danger',
    reason: '当前频道不是纯视频模板',
    expected: '频道模板 = 纯视频（alone）',
    actionLabel: '怎么改模板',
    action: { kind: 'open-help', label: '怎么改模板', href: DIAGNOSTIC_TEMPLATE_HELP_URL },
  },
  D1: {
    name: '推流地址',
    level: 'danger',
    reason: '推流地址已过期',
    expected: '推流地址剩余有效期 > 3 分钟',
    actionLabel: '重新连接',
    action: { kind: 'reconnect', label: '重新连接' },
  },
  D3: {
    name: '推流服务器',
    level: 'danger',
    reason: '连不上推流服务器，网络可能受限',
    expected: '8 秒内连上推流服务器并拿到首帧',
    actionLabel: '重试连接',
    action: { kind: 'reconnect', label: '重试连接' },
  },
  D9: {
    name: '摄像头画面',
    level: 'danger',
    reason: '摄像头没有画面',
    expected: '画面平均亮度 > 8/255',
    actionLabel: '重新授权',
    action: { kind: 'reauthorize', label: '重新授权' },
  },
  D6: {
    name: '编码器输出',
    level: 'danger',
    reason: '编码器没有输出画面',
    expected: '帧率 > 0',
    actionLabel: '重载推流器',
    action: { kind: 'reload-pusher', label: '重载推流器' },
  },
  D7: {
    name: '麦克风声音',
    level: 'warning',
    reason: '没有检测到麦克风声音',
    expected: '麦克风电平 > -50 dBFS',
    actionLabel: '换麦克风',
    action: { kind: 'switch-device', label: '换麦克风', device: 'audio' },
  },
  D5: {
    name: '上行带宽',
    level: 'danger',
    reason: '上行带宽不足，推流已中断或降质',
    expected: '上行码率 > 150 kbps 且不低于峰值的 40%',
    actionLabel: '自动重连',
    action: { kind: 'reconnect', label: '自动重连' },
  },
};

/** 一条诊断结论（自检条展示的唯一一句话 + 一个下一步） */
export interface DiagnosticVerdict {
  id: DiagnosticId;
  level: DiagnosticLevel;
  /** 一句话原因（客户向） */
  reason: string;
  /** 期望值（详情区） */
  expected: string;
  /** 实测值（详情区） */
  measured: string;
  /** 补充信息（失败码、上游原文、当前模板值等），没有就 null */
  detail: string | null;
  /** 下一步按钮 */
  action: DiagnosticAction;
  /** 诊断码：DIAG-<id>-<14 位时间> */
  code: string;
  /** 诊断发生时间（ISO），命中那一刻固定，不随 tick 变化 */
  at: string;
}

/** POST /api/channels/:channelId/diagnostics 的请求体 */
export interface DiagnosticReport {
  id: DiagnosticId;
  code: string;
  level: DiagnosticLevel;
  reason: string;
  measured: string;
  expected: string;
  /** 诊断发生时间（ISO） */
  at: string;
  /** 恢复时间（ISO）：带这个字段的上报表示「已恢复」，不改 occurrences */
  recoveredAt?: string;
  /**
   * 本次故障持续时长（毫秒，D35）：断流类诊断恢复时由推流端算出，服务端原样留痕，
   * 让客户来函问的「断了几秒」有客观数据。非断流恢复不带这个字段。
   */
  outageMs?: number;
  /**
   * 会话设备快照（D36）：会话开始时随第一次上报带一次。
   * 浏览器拿不到的字段一律 `null`，不编造。
   */
  device?: DeviceSnapshot;
}

/** GET /api/channels/:channelId/diagnostics 的列表项 */
export interface DiagnosticRecord {
  id: DiagnosticId;
  code: string;
  level: DiagnosticLevel;
  reason: string;
  measured: string;
  expected: string;
  /** 首次发生时间（ISO） */
  firstAt: string;
  /** 最近一次发生时间（ISO） */
  lastAt: string;
  /** 合并次数 */
  occurrences: number;
  /** 恢复时间（ISO），还在持续为 null */
  recoveredAt: string | null;
  /** 断流时长（毫秒，D35）；非断流诊断或还没恢复为 null */
  outageMs: number | null;
}

/** 诊断记录落库结果 */
export interface DiagnosticStoreResult {
  channelId: string;
  stored: boolean;
  total: number;
}

/**
 * 会话设备快照（D36，回应客户函「设备配置接口」）。
 * 浏览器拿不到的字段留 `null`——宁可说「未知」，也不编一个配置出来。
 */
export interface DeviceSnapshot {
  /** 完整 UA 串 */
  ua: string | null;
  /** 从 UA 解析出的系统（例：`macOS 15.3` / `Windows 10/11`） */
  os: string | null;
  /** 逻辑核数（`navigator.hardwareConcurrency`） */
  cpuCores: number | null;
  /** 内存 GB（`navigator.deviceMemory`，仅 Chromium 支持；拿不到 null） */
  deviceMemoryGb: number | null;
  /** 显卡渲染器（WebGL `UNMASKED_RENDERER_WEBGL`；被隐私保护挡住时为 null） */
  gpuRenderer: string | null;
  /** 屏幕：`宽×高@dpr` */
  screen: string | null;
}

/* ---- 指标时间序列（D34，回应客户函「推流帧率、码率等客观数据」） ---- */

/** 推流中采样间隔：5 秒一条 */
export const METRICS_SAMPLE_INTERVAL_MS = 5_000;

/** 每频道保留的采样条数（≈25 分钟），服务端环形缓冲上限 */
export const METRICS_HISTORY_LIMIT = 300;

/** 采样时的上行连接状态（与推流传输层的连接态同口径） */
export type MetricConnection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * 一条指标采样：`POST /api/channels/:channelId/metrics` 的请求体，也是 `GET` 的列表项。
 * 拿不到的实测值一律 `null`（不拿编码参数冒充实测，见 D18）。
 */
export interface MetricSample {
  /** 上行码率（kbps） */
  kbps: number | null;
  /** 帧率 */
  fps: number | null;
  /** 丢帧率（SDK 未暴露时为 null） */
  dropFps: number | null;
  connection: MetricConnection;
  /** 采样时刻（ISO） */
  at: string;
}

/** 指标落库结果（与诊断留痕同形态） */
export interface MetricStoreResult {
  channelId: string;
  stored: boolean;
  total: number;
}

/** `GET /api/channels/:channelId/metrics` 的响应：`items` 按 `at` 升序，便于画曲线 / 导 CSV */
export interface MetricsResponse {
  channelId: string;
  items: MetricSample[];
}

/**
 * 诊断码：`DIAG-<id>-<YYYYMMDDhhmmss>`（14 位本地时间）。
 * 讲师报障时念这个码，服务端日志与历史记录能对上。
 */
export function diagnosticCode(id: DiagnosticId, at: string | number | Date): string {
  const date = at instanceof Date ? at : new Date(at);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${safe.getFullYear()}${pad(safe.getMonth() + 1)}${pad(safe.getDate())}` +
    `${pad(safe.getHours())}${pad(safe.getMinutes())}${pad(safe.getSeconds())}`;
  return `DIAG-${id}-${stamp}`;
}
