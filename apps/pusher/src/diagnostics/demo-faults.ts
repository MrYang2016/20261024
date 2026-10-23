import type { DiagnosticSignals } from './rules';

/**
 * 演示故障注入（D37）：**仅录制演示视频用**，`?demo=1` 才挂面板，不进生产路径。
 *
 * 关键约束（计划 §十一 D）：注入点必须落在 `signals.ts` 的 source 里——也就是
 * 「先变成规则引擎看到的信号，再由规则层判定」，和真实故障走同一条判定链路。
 * 录像里看到的 D5 / D7 / D9 结论、自检条状态、诊断历史都是规则层真实算出来的，
 * 不是直接改 UI 文案（那会让演示变成假的）。
 */

export type DemoFaultKind =
  | 'low-bitrate'
  | 'mic-muted'
  | 'black-screen'
  | 'fps-zero'
  | 'disconnect'
  | 'url-expired'
  | 'template-mismatch';

export interface DemoFaultOption {
  kind: DemoFaultKind;
  label: string;
  /** 注入后规则层应该给出的结论（面板上给操作者看，不是页面主文案） */
  hint: string;
}

/** 注入面板的按钮顺序 = 演示脚本的讲解顺序 */
export const DEMO_FAULTS: readonly DemoFaultOption[] = [
  { kind: 'low-bitrate', label: '低码率', hint: 'D5 上行带宽不足' },
  { kind: 'mic-muted', label: '麦克风静音', hint: 'D7 没有检测到麦克风声音' },
  { kind: 'black-screen', label: '黑屏', hint: 'D9 摄像头没有画面' },
  { kind: 'fps-zero', label: 'fps=0', hint: 'D6 编码器没有输出画面' },
  { kind: 'disconnect', label: '断流', hint: 'D5 上行连接已断开' },
  { kind: 'url-expired', label: '地址过期', hint: 'D1 推流地址已过期' },
  { kind: 'template-mismatch', label: '模板错误', hint: 'D2 当前频道不是纯视频模板' },
];

/** 低码率注入值（kbps）：低于 D5 下限 max(150, 峰值 40%)，让规则层真的判出来 */
export const DEMO_LOW_BITRATE_KBPS = 100;
/** 静音注入值（dBFS）：低于 D7 的 -60 dBFS 阈值 */
export const DEMO_SILENT_DBFS = -100;

/** `?demo=1` 判定（也接受 `demo=true`，方便手打） */
export function isDemoMode(search: string): boolean {
  try {
    const value = new URLSearchParams(search).get('demo');
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
}

/**
 * 把注入的故障写进**规则引擎的输入**（纯函数，返回新对象，不改入参）。
 * 规则层拿到的就是这份信号，因此判定链路与真实故障完全一致。
 */
export function injectDemoFault(
  signals: DiagnosticSignals,
  kind: DemoFaultKind,
  now: number = signals.now,
): DiagnosticSignals {
  switch (kind) {
    case 'low-bitrate':
      return { ...signals, bitrateKbps: DEMO_LOW_BITRATE_KBPS };
    case 'mic-muted':
      return { ...signals, audioRmsDb: DEMO_SILENT_DBFS };
    case 'black-screen':
      // 0/255 亮度 = 纯黑（D9 阈值 < 8/255）
      return { ...signals, averageLuma: 0 };
    case 'fps-zero':
      return { ...signals, fps: 0 };
    case 'disconnect':
      return { ...signals, connected: false };
    case 'url-expired':
      // 过期 1 分钟：D1 判「剩余 < 3 分钟」，并且不会触发「地址刚刷新」的豁免
      return { ...signals, pushExpiresAt: new Date(now - 60_000).toISOString() };
    case 'template-mismatch':
      return { ...signals, templateMismatch: true };
    default:
      return signals;
  }
}
