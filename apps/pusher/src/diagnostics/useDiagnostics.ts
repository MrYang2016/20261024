import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  DIAGNOSTIC_DEDUPE_WINDOW_MS,
  DIAGNOSTIC_HISTORY_LIMIT,
  DIAGNOSTIC_META,
  DIAGNOSTIC_STATS_STALE_MS,
  type ChannelInfo,
  type DeviceSnapshot,
  type DiagnosticAction,
  type DiagnosticAdvisory,
  type DiagnosticId,
  type DiagnosticRecord,
  type DiagnosticReport,
  type DiagnosticVerdict,
} from '@live1024/shared';
import type { PushSession } from '../composables/usePushSession';
import type { PushErrorInfo } from '../lib/errors';
import type { PushStatsSnapshot } from '../transports/types';
import { createAudioMeter, type AudioMeter } from './audio-level';
import { createBlackFrameDetector, type BlackFrameDetector } from './black-frame';
import { collectDeviceSnapshot } from './device-snapshot';
import type { DemoFaultKind } from './demo-faults';
import { buildSignals } from './signals';
import {
  NETWORK_PROBE_INTERVAL_MS,
  probeServerHealth,
  resolveProbeStatus,
  type NetworkProbeStatus,
} from './network-probe';
import {
  buildDiagnosticVerdict,
  createAdvisoryState,
  createDiagnosticsState,
  evaluateAdvisories,
  evaluateDiagnostics,
} from './rules';

/** 自检条展示态（计划 §四 状态机 + §七 视觉） */
export type DiagnosticStatus = 'checking' | 'ok' | 'warning' | 'danger' | 'fixing';

/** 规则 tick 间隔：1 秒（计划 §五 5.3） */
const TICK_MS = 1_000;
/** 码率历史保留条数（算峰值用，30 秒足够覆盖一次抖动） */
const STATS_HISTORY_SIZE = 30;
/** 本地历史镜像上限（与服务端环形缓冲同口径） */
const LOCAL_HISTORY_LIMIT = DIAGNOSTIC_HISTORY_LIMIT;

export interface UseDiagnosticsOptions {
  /** 推流会话（读 state / connectionStatus / stats） */
  session: PushSession;
  /** 当前频道（预检读 template / push.expiresAt） */
  channel: Ref<ChannelInfo | null>;
  /** 频道类错误（取频道 / 取推流地址失败）：D2 的错误路径靠它（D29） */
  channelError?: Ref<PushErrorInfo | null>;
  /** 采集层错误（getUserMedia 失败） */
  mediaError: Ref<PushErrorInfo | null>;
  /** 当前采集流（音量表挂在它上面） */
  stream: Ref<MediaStream | null>;
  /** 预览画面的 video 元素（黑帧检测挂它；还没挂载时返回 null） */
  getVideoElement: () => HTMLVideoElement | null;
  /** 当前麦克风设备名（详情用） */
  getAudioDeviceLabel: () => string | null;
  /** 上报用的频道号（会话固化的那个，不是当前选中的频道） */
  getChannelId: () => string | null;
  /** 执行一键修复（App 提供：重连 / 重载推流器 / 换设备 / 重新授权 / 降分辨率） */
  runFix: (action: DiagnosticAction) => Promise<void>;
  /** 上报一条诊断（App 提供）：失败不打扰讲师，只影响历史留痕 */
  report?: (channelId: string, report: DiagnosticReport) => Promise<unknown>;
  /** 上报会话设备快照（D36，App 提供）：失败只 warn */
  reportDevice?: (channelId: string, device: DeviceSnapshot) => Promise<unknown>;
  /** 设备快照采集（单测可注入假实现；缺省读真实浏览器） */
  collectDevice?: () => DeviceSnapshot;
  /** 演示故障注入（D37，仅 `?demo=1` 才有值）；注入的是规则层输入，不绕过规则 */
  demoFault?: () => DemoFaultKind | null;
  /**
   * 预检网络探测（D38）：`() => Promise<boolean>`，true = 连得上、false / reject = 没探测通。
   * 缺省实现打一次 `GET /api/health`（3 秒超时）；单测可注入假实现。绝不向上抛。
   */
  probeNetwork?: () => Promise<boolean>;
  /** 时钟（单测可注入假时钟） */
  now?: () => number;
}

export interface UseDiagnosticsResult {
  verdict: Ref<DiagnosticVerdict | null>;
  status: ComputedRef<DiagnosticStatus>;
  /** 自检条上那句话（正常 / 检查中 / 异常各一句，异常时就是 verdict.reason） */
  conclusion: ComputedRef<string>;
  /** fixing 期间主按钮文案 */
  fixingLabel: Ref<string | null>;
  /** 本条诊断已经尝试过几次修复 */
  attempts: ComputedRef<number>;
  /** 修复失败提示（含「再试一次」措辞：按钮已经是「再试一次」时不重复） */
  retryHint: ComputedRef<string | null>;
  /** 本地历史镜像（抽屉加载服务端历史失败时兜底） */
  records: Ref<DiagnosticRecord[]>;
  /** 提醒（D35 网络波动）：**不是**诊断结论，不参与硬优先级 */
  advisories: ComputedRef<DiagnosticAdvisory[]>;
  /** 本场会话上报过一次的设备快照（D36）；没开播 / 采集失败为 null */
  device: Ref<DeviceSnapshot | null>;
  /**
   * 预检网络探测状态（D38）：`unknown` = 还在探测（界面「正在检查网络…」）、
   * `ok` = 真的连得上（只有这时才能说「预检通过」）、`failed` = 连续探测不通（D3 结论）。
   */
  networkProbe: Ref<NetworkProbeStatus>;
  /** 执行当前结论的下一步（重入受控：fixing 中直接返回） */
  runFix: () => Promise<void>;
  /** 立即评估一次（挂载后不用等 1 秒） */
  tick: () => void;
}

/**
 * 诊断卡 composable（计划 §四 / §五 5.3）。
 *
 * 职责边界：**判定 + 修复编排 + 留痕**；具体的 stop/start、切设备、降分辨率由 App 注入的 `runFix` 做，
 * 这样规则层与推流状态机保持解耦（usePushSession 的契约不需要改，见计划 §八 第 6 项）。
 *
 * 三条硬约束都落在 `runFix` 里：
 * 1. `fixing` 中不重复触发（按钮也会 disabled，但这里是最后一道防线）；
 * 2. `fixing` 期间不被其它规则抢占（规则引擎读 `state.fixing`）；
 * 3. 修复失败回到**同一条** verdict，并把修复次数 +1（D5 两次失败后升级为「降低分辨率重推」）。
 */
export function useDiagnostics(options: UseDiagnosticsOptions): UseDiagnosticsResult {
  const clock = options.now ?? (() => Date.now());
  const state = createDiagnosticsState();
  const advisoryState = createAdvisoryState();

  const verdict = ref<DiagnosticVerdict | null>(null);
  const advisoryList = ref<DiagnosticAdvisory[]>([]);
  const device = ref<DeviceSnapshot | null>(null);
  const fixingId = ref<DiagnosticId | null>(null);
  const fixingLabel = ref<string | null>(null);
  const records = ref<DiagnosticRecord[]>([]);
  const networkProbe = ref<NetworkProbeStatus>('unknown');

  const statsHistory: PushStatsSnapshot[] = [];
  const lastReportedAt = new Map<DiagnosticId, number>();
  let pushStartedAt: number | null = null;
  let firstFrameAt: number | null = null;
  let audioMeter: AudioMeter | null = null;
  let blackFrame: BlackFrameDetector | null = null;
  let blackFrameVideo: HTMLVideoElement | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  /** 当前结论的确认时刻（算断流时长用，D35） */
  let activeSinceMs: number | null = null;
  /** 本场会话是否已经上报过设备快照（一次会话只报一次，D36） */
  let deviceReported = false;
  /** 连续探测失败次数（D38 防抖：连续 2 次才判 failed） */
  let probeFailures = 0;
  /** 探测进行中（避免并发探测） */
  let probing = false;
  /** 上一次探测的发起时刻（算 15 秒间隔；null = 还没探测过） */
  let lastProbeAt: number | null = null;
  /** 下一次探测是不是「刚载入频道」的首次探测（首次失败立即判 failed） */
  let firstProbePending = false;

  const attempts = computed(() => (verdict.value ? (state.failures[verdict.value.id] ?? 0) : 0));

  /** 提醒只在没有硬结论时展示：同一时刻只说一件事，避免和 D5 抢同一个提示位（D35） */
  const advisories = computed<DiagnosticAdvisory[]>(() =>
    verdict.value ? [] : advisoryList.value,
  );

  const status = computed<DiagnosticStatus>(() => {
    if (fixingId.value) return 'fixing';
    // 级别跟着 DIAGNOSTIC_META.level 走：D7（麦克风没声音）观众听不到但画面还在 → 橙色提醒，
    // 其余（D1/D2/D3/D5/D6/D9）断流 / 没画面 → 红色
    if (verdict.value) return verdict.value.level === 'warning' ? 'warning' : 'danger';
    // 网络波动（D35）：不进硬优先级，但自检条要提前转 warning
    if (advisories.value.length > 0) return 'warning';
    const sessionState = options.session.state.value;
    if (sessionState === 'preparing' || sessionState === 'connecting') {
      return 'checking';
    }
    if (sessionState === 'live' || sessionState === 'stopping') return 'ok';
    // D38：预检结论必须有网络探测支撑，探测没成功之前不能给绿
    return networkProbe.value === 'ok' ? 'ok' : 'checking';
  });

  const conclusion = computed(() => {
    if (verdict.value) return verdict.value.reason;
    const advisory = advisories.value[0];
    if (advisory) return advisory.text;
    if (status.value === 'checking') {
      // 预检阶段「检查中」= 在探测网络（D38）；开播阶段才是连推流服务器
      const sessionState = options.session.state.value;
      return sessionState === 'idle' || sessionState === 'error'
        ? '正在检查网络…'
        : '正在连接推流服务器…';
    }
    if (options.session.state.value === 'stopping') return '正在停止推流…';
    if (options.session.state.value === 'live') {
      const bitrate = freshStats()?.bitrateKbps;
      return typeof bitrate === 'number' ? `推流一切正常，上行 ${Math.round(bitrate)} kbps` : '推流一切正常';
    }
    // D38：只有真正探测到网络通才允许说这句话；探测未知 / 失败的分支都在上面拦住了
    return '预检通过，可以开播';
  });

  const retryHint = computed(() => {
    const current = verdict.value;
    const count = current ? (state.failures[current.id] ?? 0) : 0;
    if (!current || count === 0) return null;
    return current.action.label === '再试一次'
      ? '上次修复没有成功'
      : '上次修复没有成功，可以再试一次';
  });

  watch(
    options.stream,
    (next) => {
      audioMeter?.close();
      audioMeter = next && next.getAudioTracks().length > 0 ? createAudioMeter(next) : null;
    },
    { immediate: true },
  );

  // D38：载入频道后探测一次网络（新频道 = 新预检，探测状态归零）
  watch(
    () => options.channel.value?.channelId ?? null,
    (channelId, previousChannelId) => {
      // 同一频道重新取地址（开播前 resolvePushUrl / D1 修复）不算新预检，探测状态保持
      if (channelId === previousChannelId) return;
      networkProbe.value = 'unknown';
      probeFailures = 0;
      lastProbeAt = null;
      firstProbePending = true;
      if (!channelId) return;
      void probeNetwork();
    },
    { immediate: true },
  );

  watch(
    () => options.session.state.value,
    (next, previous) => {
      const entering = next === 'preparing' || next === 'connecting';
      const previousEntering = previous === 'preparing' || previous === 'connecting';
      if (entering && !previousEntering) {
        pushStartedAt = clock();
        firstFrameAt = null;
        statsHistory.length = 0;
        // D38：修复失败计数**不在这里清**——清掉就丢了「再试一次 / 降低分辨率重推」的升级依据
        lastReportedAt.clear();
        // 真的要开播了：之前的探测结果不再是「现在」的证据，推流阶段也不探测
        networkProbe.value = 'unknown';
        probeFailures = 0;
        lastProbeAt = null;
        firstProbePending = true;
      }
      if (next === 'idle') {
        pushStartedAt = null;
        firstFrameAt = null;
        statsHistory.length = 0;
        state.holdSince = {};
        state.recoverSince = {};
        advisoryState.holdSince = {};
        advisoryList.value = [];
        deviceReported = false;

        // D38：idle 不得**无条件**清结论。修复动作是「先 stop 再 start」，
        // stop 完成进入 idle 的这一瞬间如果把结论清掉，界面就会在断网 / 修复失败时
        // 回落到「预检通过，可以开播」。只有「探测确认连得上」且「不在修复途中」才撤销。
        if (!shouldKeepConclusion(verdict.value)) {
          state.active = null;
          state.activeSince = null;
          state.activeVerdict = null;
          verdict.value = null;
          activeSinceMs = null;
        }
      }
      // 会话开始（进入 live）：上报一次设备快照（D36），每场只报一次
      if (next === 'live' && !deviceReported) {
        deviceReported = true;
        void reportDeviceSnapshot();
      }
    },
  );

  watch(
    () => options.session.connectionStatus.value,
    (next) => {
      if (next === 'connected' && firstFrameAt === null) firstFrameAt = clock();
    },
    { immediate: true },
  );

  watch(
    options.session.stats,
    (next) => {
      if (!next) return;
      statsHistory.push(next);
      while (statsHistory.length > STATS_HISTORY_SIZE) statsHistory.shift();
    },
    { immediate: true },
  );

  /** 只认新鲜统计：过期的快照不能拿来当「一切正常」的证据 */
  function freshStats(): PushStatsSnapshot | null {
    const snapshot = options.session.stats.value;
    if (!snapshot) return null;
    return clock() - snapshot.at <= DIAGNOSTIC_STATS_STALE_MS ? snapshot : null;
  }

  /** 黑帧检测器懒创建：video 元素要等预览区挂载后才拿得到 */
  function ensureBlackFrameDetector(): BlackFrameDetector | null {
    const video = options.getVideoElement();
    if (!video) return null;
    if (blackFrame && blackFrameVideo === video) return blackFrame;
    blackFrame?.stop();
    blackFrameVideo = video;
    blackFrame = createBlackFrameDetector(video, document.createElement('canvas'));
    return blackFrame;
  }

  function tick(): void {
    if (disposed) return;
    const now = clock();
    maybeProbe();
    const detector = ensureBlackFrameDetector();
    const signals = buildSignals({
      now,
      pushState: options.session.state.value,
      connection: options.session.connectionStatus.value,
      stats: options.session.stats.value,
      statsHistory,
      pushStartedAt,
      firstFrameAt,
      channel: options.channel.value,
      channelError: options.channelError?.value ?? null,
      mediaError: options.mediaError.value,
      pushError: options.session.error.value,
      audioDbfs: audioMeter?.available ? audioMeter.read() : null,
      audioDeviceLabel: options.getAudioDeviceLabel(),
      hasAudioTrack: Boolean(options.stream.value?.getAudioTracks().length),
      averageLuma: detector?.averageLuma ?? null,
      hasVideoTrack: Boolean(options.stream.value?.getVideoTracks().length),
      targetBitrateKbps: options.session.encoding.value?.bitrateKbps ?? null,
      networkProbe: networkProbe.value,
      demo: options.demoFault?.() ?? null,
    });

    const previous = verdict.value;
    const evaluated = evaluateDiagnostics(signals, state);
    // D38：规则暂时没命中 ≠ 问题已经好了。修复途中、或探测没确认连通时，保留同一条结论
    // （reason / retryHint / 按钮都不变），不冒充「一切正常 / 预检通过」。
    const held = evaluated === null && shouldKeepConclusion(previous);
    const next = held ? previous : evaluated;
    verdict.value = next;
    // 提醒走独立通道（D35）：不进硬优先级、不写 activeVerdict
    advisoryList.value = evaluateAdvisories(signals, advisoryState);

    // 结论变更时重算「本条结论从何时开始」：断流时长靠它（D35）
    if (next && next.id !== previous?.id) activeSinceMs = now;

    if (evaluated) {
      void reportOccurrence(evaluated, now);
    } else if (!held && previous) {
      void reportRecovery(previous, now, outageOf(previous, now));
      activeSinceMs = null;
    }
  }

  /**
   * 结论保留条件（D38 ③④）：修复途中 / 还没拿到「网络已经通」的证据时，不得把结论清掉。
   * `current` 为空、或已经在推流（规则说了算：真恢复就回「推流一切正常」）时不保留。
   *
   * - 修复动作进行中（真实链路是「先 stop 再 start」）：任何状态都保留，
   *   否则 stop→idle 的那一瞬间就把结论清了（= 本次实测缺陷）；
   * - 预检 / 重连途中（idle / error / preparing / connecting / stopping）：只有探测确认连得上才撤销；
   * - 修复失败计数（`state.failures`）已不再被 preparing 清除，所以「再试一次 / 降低分辨率重推」
   *   不会丢；但它不作为「永远不能撤」的理由——探测确认网络已恢复后仍按真实证据回到 ok。
   */
  function shouldKeepConclusion(current: DiagnosticVerdict | null): boolean {
    if (!current) return false;
    if (fixingId.value !== null) return true;
    if (options.session.state.value === 'live') return false;
    return networkProbe.value !== 'ok';
  }

  /**
   * 探测时机（D38 ②）：载入频道后 / 修复结束后（`runFix` 的 finally）/ 还没开播时每 15 秒一次。
   * 推流中（preparing / connecting / live / stopping）不探测：不跟上行抢带宽，也不拿探测结果去判推流本身。
   */
  function maybeProbe(): void {
    if (disposed || probing) return;
    if (!options.channel.value) return;
    const sessionState = options.session.state.value;
    // error 也算预检阶段（上一次开播失败）：不补探测的话旧结论会一直卡在「探测未知」
    if (sessionState !== 'idle' && sessionState !== 'error') return;
    const now = clock();
    if (lastProbeAt !== null && now - lastProbeAt < NETWORK_PROBE_INTERVAL_MS) return;
    void probeNetwork();
  }

  /** 探测一次网络（D38）：结果落 `networkProbe`，由下一次 tick 落成结论；任何异常都归为「没探测通」 */
  async function probeNetwork(): Promise<void> {
    if (probing || disposed) return;
    probing = true;
    lastProbeAt = clock();
    const firstProbe = firstProbePending;
    firstProbePending = false;

    let reachable = false;
    try {
      reachable = (await (options.probeNetwork ?? probeServerHealth)()) === true;
    } catch {
      // 探测本身抛错也算没探测通：探测绝不能影响推流主链路
      reachable = false;
    }

    probing = false;
    if (disposed) return;

    const resolved = resolveProbeStatus({
      reachable,
      consecutiveFailures: probeFailures,
      firstProbe,
    });
    probeFailures = resolved.consecutiveFailures;
    networkProbe.value = resolved.status;
    // 不在这里额外 tick：探测结果交给下一次 1 秒 tick 落地（最多 1 秒延迟）。
    // 修复失败后立刻再评估一次会把「修复失败回到同一结论」的展示顶掉（D22 / 计划 §四），
    // 真实的恢复判断也不差这 1 秒。
  }

  /** 断流时长（毫秒）：只有断流 / 码率掉底（D5）才有意义，其余诊断不写“断流 N 秒” */
  function outageOf(current: DiagnosticVerdict, now: number): number | undefined {
    if (current.id !== 'D5' || activeSinceMs === null) return undefined;
    return Math.max(0, now - activeSinceMs);
  }

  /** 会话设备快照上报（D36）：失败只 warn，不影响推流 */
  async function reportDeviceSnapshot(): Promise<void> {
    const channelId = options.getChannelId();
    if (!channelId || !options.reportDevice) return;
    try {
      const snapshot = (options.collectDevice ?? collectDeviceSnapshot)();
      device.value = snapshot;
      await options.reportDevice(channelId, snapshot);
    } catch (error) {
      // 设备快照只是辅助证据，报不上不影响诊断与推流
      console.warn('[diagnostics] 设备快照上报失败', error);
    }
  }

  async function runFix(): Promise<void> {
    const current = verdict.value;
    if (!current || fixingId.value) return;

    fixingId.value = current.id;
    fixingLabel.value = current.action.kind === 'open-help' ? null : fixingText(current.action);
    state.fixing = current.id;

    try {
      await options.runFix(current.action);
      // 修复动作完成：让规则重新判定（真正的「好了」由下一次评估确认，不在这里自证）
      state.fixing = null;
      state.holdSince = {};
      state.recoverSince = {};
      state.active = null;
      state.activeSince = null;
      state.activeVerdict = null;
      // 修复动作成功 = 本次「修复失败」循环结束：不重置的话 D38 的结论保留会永远解不开
      delete state.failures[current.id];
      fixingId.value = null;
      fixingLabel.value = null;
      tick();
      if (!verdict.value) reportRecovery(current, clock(), outageOf(current, clock()));
    } catch {
      // 修复失败：回到同一条 verdict，并把次数 +1（D5 两次失败 → 降低分辨率重推）
      state.failures[current.id] = (state.failures[current.id] ?? 0) + 1;
      state.fixing = null;
      state.active = current.id;
      state.activeVerdict = buildDiagnosticVerdict(current.id, lastSignals(), state);
      verdict.value = state.activeVerdict;
      fixingId.value = null;
      fixingLabel.value = null;
    } finally {
      // D38：修复结束后重新探测一次网络——修到底有没有效，由这次探测 + 下一次评估决定
      void probeNetwork();
    }
  }

  /** 修复失败重建结论时的输入（拿最近一次评估用的信号；没有就用最小集） */
  function lastSignals() {
    const now = clock();
    return buildSignals({
      now,
      pushState: options.session.state.value,
      connection: options.session.connectionStatus.value,
      stats: options.session.stats.value,
      statsHistory,
      pushStartedAt,
      firstFrameAt,
      channel: options.channel.value,
      channelError: options.channelError?.value ?? null,
      mediaError: options.mediaError.value,
      pushError: options.session.error.value,
      audioDbfs: audioMeter?.available ? audioMeter.read() : null,
      audioDeviceLabel: options.getAudioDeviceLabel(),
      hasAudioTrack: Boolean(options.stream.value?.getAudioTracks().length),
      averageLuma: blackFrame?.averageLuma ?? null,
      hasVideoTrack: Boolean(options.stream.value?.getVideoTracks().length),
      targetBitrateKbps: options.session.encoding.value?.bitrateKbps ?? null,
      networkProbe: networkProbe.value,
      demo: options.demoFault?.() ?? null,
    });
  }

  /** 命中：同一条结论 60 秒内只上报一次（服务端还会按同 id 合并 occurrences） */
  async function reportOccurrence(current: DiagnosticVerdict, now: number): Promise<void> {
    const channelId = options.getChannelId();
    if (!channelId || !options.report) return;
    const lastAt = lastReportedAt.get(current.id);
    if (lastAt != null && now - lastAt < DIAGNOSTIC_DEDUPE_WINDOW_MS) {
      mergeLocalRecord(current, now);
      return;
    }
    lastReportedAt.set(current.id, now);
    mergeLocalRecord(current, now);
    try {
      await options.report(channelId, toReport(current));
    } catch {
      // 留痕失败不影响讲师修问题；本地镜像仍保留这一条
    }
  }

  /** 恢复：给同一条记录补 recoveredAt（服务端据此在历史里标记「已恢复」） */
  async function reportRecovery(
    recovered: DiagnosticVerdict,
    now: number,
    outageMs?: number,
  ): Promise<void> {
    const channelId = options.getChannelId();
    if (!channelId || !options.report) return;
    const item = records.value.find((record) => record.id === recovered.id && !record.recoveredAt);
    if (item) {
      // 与服务端同口径：恢复只写 recoveredAt，不动 lastAt（那一行的时间是最后一次出问题的时间）
      item.recoveredAt = new Date(now).toISOString();
      if (outageMs != null) item.outageMs = outageMs;
    }
    try {
      await options.report(channelId, {
        ...toReport(recovered),
        recoveredAt: new Date(now).toISOString(),
        ...(outageMs != null ? { outageMs } : {}),
      });
    } catch {
      // 同上
    }
  }

  function mergeLocalRecord(current: DiagnosticVerdict, now: number): void {
    const at = new Date(now).toISOString();
    const existing = records.value.find(
      (record) =>
        record.id === current.id && now - Date.parse(record.lastAt) < DIAGNOSTIC_DEDUPE_WINDOW_MS,
    );
    if (existing) {
      existing.occurrences += 1;
      existing.lastAt = at;
      existing.code = current.code;
      existing.reason = current.reason;
      existing.measured = current.measured;
      existing.expected = current.expected;
      existing.recoveredAt = null;
      existing.outageMs = null;
      return;
    }
    records.value.unshift({
      id: current.id,
      code: current.code,
      level: current.level,
      reason: current.reason,
      measured: current.measured,
      expected: current.expected,
      firstAt: at,
      lastAt: at,
      occurrences: 1,
      recoveredAt: null,
      outageMs: null,
    });
    while (records.value.length > LOCAL_HISTORY_LIMIT) records.value.pop();
  }

  function toReport(current: DiagnosticVerdict): DiagnosticReport {
    return {
      id: current.id,
      code: current.code,
      level: current.level,
      reason: current.reason,
      measured: current.measured,
      expected: current.expected,
      at: current.at,
    };
  }

  timer = setInterval(tick, TICK_MS);
  tick();

  onBeforeUnmount(() => {
    disposed = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    audioMeter?.close();
    audioMeter = null;
    blackFrame?.stop();
    blackFrame = null;
  });

  return {
    verdict,
    status,
    conclusion,
    fixingLabel,
    attempts,
    retryHint,
    records,
    advisories,
    device,
    networkProbe,
    runFix,
    tick,
  };
}

/** 修复中的按钮文案（D22：点下去要有「正在做什么」的回执） */
function fixingText(action: DiagnosticAction): string {
  switch (action.kind) {
    case 'reconnect':
      return '正在重新连接…';
    case 'reload-pusher':
      return '正在重载推流器…';
    case 'switch-device':
      return '正在切换设备…';
    case 'reauthorize':
      return '正在重新授权…';
    case 'lower-resolution':
      return '正在降低分辨率重推…';
    default:
      return '正在处理…';
  }
}

/** 诊断项的展示名（抽屉 / 复制用） */
export function diagnosticName(id: DiagnosticId): string {
  return DIAGNOSTIC_META[id].name;
}

/**
 * 「复制诊断信息」的文本：讲师把这段发给技术支持就能对上日志（诊断码 + 时间 + 实测 vs 期望）。
 */
export function diagnosticCopyText(current: DiagnosticVerdict): string {
  const at = new Date(current.at);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return [
    `诊断信息 ${diagnosticName(current.id)}（${current.id}）`,
    `诊断码：${current.code}`,
    `发生时间：${time}`,
    `原因：${current.reason}`,
    `实测：${current.measured}`,
    `期望：${current.expected}`,
    current.detail ? `详情：${current.detail}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
