<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChannelInfo, DiagnosticAction, DiagnosticVerdict, PushSessionState } from '@live1024/shared';
import ChannelSetupPanel from './components/ChannelSetupPanel.vue';
import DemoFaultPanel from './components/DemoFaultPanel.vue';
import DevicePicker from './components/DevicePicker.vue';
import DiagnosisBar from './components/DiagnosisBar.vue';
import DiagnosisHistoryDrawer from './components/DiagnosisHistoryDrawer.vue';
import MetricsBar from './components/MetricsBar.vue';
import NoticeBar from './components/NoticeBar.vue';
import PreviewStage from './components/PreviewStage.vue';
import PushControlBar from './components/PushControlBar.vue';
import { isDemoMode, type DemoFaultKind } from './diagnostics/demo-faults';
import { useDiagnostics } from './diagnostics/useDiagnostics';
import { useMetricsRecorder } from './diagnostics/useMetricsRecorder';
import { useMediaDevices } from './composables/useMediaDevices';
import { useMediaPermissions } from './composables/useMediaPermissions';
import { usePushSession } from './composables/usePushSession';
import { usePushStats } from './composables/usePushStats';
import { liveApi } from './lib/api';
import { errorText, mapPushError, type PushErrorInfo } from './lib/errors';
import {
  CAMERA_BLOCKED_GUIDANCE,
  MICROPHONE_BLOCKED_GUIDANCE,
  type PermissionBlockedGuidance,
} from './lib/permissions';

const WATCH_BASE_URL = (import.meta.env.VITE_WATCH_BASE_URL ?? 'http://localhost:5174').replace(/\/+$/, '');
const CHANNEL_STORAGE_KEY = 'live1024.pusher.channel';
/** 推流端每 60s 续期一次会话，服务端 150s 内没收到续期就认为断流 */
const SESSION_HEARTBEAT_MS = 60_000;
/** 操作类反馈（复制成功/失败）在页面上停留多久 */
const NOTICE_DURATION_MS = 2_500;
/** 一键修复时等「连接中」落下结论的上限 */
const SETTLE_TIMEOUT_MS = 3_000;

const channel = ref<ChannelInfo | null>(readStoredChannel());
/**
 * 本次推流会话的频道号：start() 时固化（D17）。
 * onLive / onIdle / 60s 心跳 / push-session 上报 / 诊断上报一律用它，不再回调里现读 channel.value ——
 * 否则换了频道会把 stopped 报到新频道（新频道观众看到「已结束」）、旧频道靠心跳永久维持「直播中」。
 */
const sessionChannelId = ref<string | null>(null);
const channelBusy = ref(false);
/**
 * 频道类错误（频道不存在 / 模板不符 / 上游故障）：
 * - 非模板类：只在频道面板内联展示；
 * - 模板不符（D29 的 502）：同时交给 useDiagnostics，由自检条给 D2 结论（D27 诊断条收编故障提示）。
 */
const channelError = ref<PushErrorInfo | null>(null);
const copied = ref(false);
const historyOpen = ref(false);
/** 操作类反馈（D27：NoticeBar 只留这一类） */
const notice = ref<{ tone: 'info' | 'danger'; text: string } | null>(null);
/** 演示故障注入（D37）：只有 `?demo=1` 才挂面板；默认 null = 不注入任何故障 */
const demoMode = isDemoMode(window.location.search);
const demoFault = ref<DemoFaultKind | null>(null);

const media = useMediaDevices();
const { cameras, microphones, cameraId, microphoneId, stream, level, error: mediaError } = media;
/** D41 ②：权限状态（denied 时不再调用 getUserMedia，改成给「去地址栏改允许」的指引） */
const permissions = useMediaPermissions();

const previewRef = ref<InstanceType<typeof PreviewStage> | null>(null);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const session = usePushSession({
  ensureStream: media.ensureStream,
  resolvePushUrl: async () => {
    const sessionId = sessionChannelId.value;
    if (!sessionId) throw new Error('还没有频道');
    // 推流地址有时效，每次开播前重新取一条（按会话固化的频道号取，不看 channel.value）
    const fresh = await liveApi.getChannel(sessionId);
    setChannel(fresh);
    return fresh.push.webrtcUrl;
  },
  onLive: () => {
    const sessionId = sessionChannelId.value;
    if (!sessionId) return;
    void reportSession(sessionId, 'started');
    stopHeartbeat();
    heartbeatTimer = setInterval(() => void reportSession(sessionId, 'started'), SESSION_HEARTBEAT_MS);
  },
  onIdle: () => {
    stopHeartbeat();
    const sessionId = sessionChannelId.value;
    if (sessionId) void reportSession(sessionId, 'stopped');
    sessionChannelId.value = null;
  },
});

const { state, canStart, canStop, start, stop } = session;
const { durationText, bitrateText, fpsText, resolutionText, connectionText, connectionTone, encodingText, hasLiveStats } =
  usePushStats(session, media.captureSettings);

/**
 * 指标时间序列（D34）：推流中每 5 秒一条，落服务端内存（每频道 300 条）。
 * 上报失败只 warn，不影响推流主链路。
 */
const metricsRecorder = useMetricsRecorder({
  session,
  getChannelId: () => sessionChannelId.value ?? channel.value?.channelId ?? null,
  report: (channelId, sample) => liveApi.reportMetric(channelId, sample),
});
const metricsSamples = metricsRecorder.samples;

/** 诊断卡：常驻自检条 + 一键修复 + 历史留痕（D21 / D22 / D23） */
const diagnostics = useDiagnostics({
  session,
  channel,
  // 频道类错误也要进自检条：非纯视频模板时服务端直接 502，channel 为 null，
  // 只有这条错误能把 D2 抬上来（D29：服务端行为不变，仍回 502）
  channelError,
  mediaError,
  stream,
  getVideoElement: () => previewRef.value?.videoElement() ?? null,
  getAudioDeviceLabel: () => microphones.value.find((device) => device.deviceId === microphoneId.value)?.label ?? null,
  getChannelId: () => sessionChannelId.value ?? channel.value?.channelId ?? null,
  runFix: executeFix,
  report: (channelId, report) => liveApi.reportDiagnostic(channelId, report),
  // D36：会话开始时上报一次设备快照（浏览器拿不到的字段为 null）
  reportDevice: (channelId, device) => liveApi.reportDeviceSnapshot(channelId, device),
  // D37：演示注入走规则层输入（`signals.ts` 的 source），不绕过判定链路
  demoFault: () => demoFault.value,
});
const { verdict, status: diagnosisStatus, conclusion, fixingLabel, attempts, retryHint, records, networkProbe } =
  diagnostics;

/**
 * 权限被浏览器拒绝时的指引（D41 ②）。
 * `denied` 是浏览器侧的持久状态：`getUserMedia` 会立即 reject 且**不再弹授权框**，
 * 所以这时不能盲目切设备、也不能反复重试，只能把「去地址栏改成允许」说清楚。
 */
const blockedGuidance = computed<PermissionBlockedGuidance | null>(() => {
  const current = verdict.value;
  if (!current) return null;
  if (current.id === 'D9' && permissions.camera.value === 'denied') return CAMERA_BLOCKED_GUIDANCE;
  if (current.id === 'D7' && permissions.microphone.value === 'denied') return MICROPHONE_BLOCKED_GUIDANCE;
  return null;
});

/**
 * 自检条上展示的结论：权限 denied 时换成「浏览器已阻止摄像头」这一句
 * （默认的「浏览器没有摄像头/麦克风权限」说不清是「没申请」还是「被拒绝」）。
 */
const barConclusion = computed(() => blockedGuidance.value?.reason ?? conclusion.value);

/**
 * 自检条上展示的结论对象：D41 ③ 按钮文案随推流状态区分——
 * 未开播 =「重新检测摄像头」，推流中 =「恢复画面」（都是同一次重新取流 + 重跑判定）。
 */
const barVerdict = computed<DiagnosticVerdict | null>(() => {
  const current = verdict.value;
  if (!current) return null;
  const label =
    current.action.kind === 'reauthorize'
      ? state.value === 'live'
        ? '恢复画面'
        : '重新检测摄像头'
      : current.action.label;
  const relabeled =
    label === current.action.label ? current : { ...current, action: { ...current.action, label } };
  const guidance = blockedGuidance.value;
  return guidance ? { ...relabeled, reason: guidance.reason } : relabeled;
});

/** D41 ②：权限 denied 的提示行用「去地址栏改允许」的指引，不再说「上次修复没有成功」 */
const barRetryHint = computed(() => blockedGuidance.value?.nextStep ?? retryHint.value);
/** 指引本身就是下一步，不是「修复次数」，所以 denied 时不显示「已尝试 N 次」 */
const barAttempts = computed(() => (blockedGuidance.value ? 0 : attempts.value));
const barSteps = computed(() => blockedGuidance.value?.steps ?? []);
/** 进行中文案也跟按钮口径一致：未开播是「检测」不是「重新授权」（D41 ③） */
const barFixingLabel = computed(() => {
  if (fixingLabel.value === null) return null;
  if (verdict.value?.action.kind === 'reauthorize' && state.value !== 'live') return '正在重新检测…';
  return fixingLabel.value;
});

// 采集报错（含用户在弹框里点了阻止）之后权限状态会变：查一次，界面才不会停在旧状态
watch(mediaError, () => void permissions.refresh());

const watchLink = computed(() => (channel.value ? `${WATCH_BASE_URL}/?channelId=${channel.value.channelId}` : ''));

/**
 * 测试账号只在腾讯云线路可推流；出现别的域名要提前告知，不要等推流失败。
 * D27 之后这类「链路提醒」也归诊断卡（NoticeBar 只留操作类反馈），所以它作为自检条的预检提醒展示。
 */
const networkNotice = computed(() => {
  const rtmpUrl = channel.value?.push.rtmpUrl;
  if (!rtmpUrl) return null;
  try {
    const host = new URL(rtmpUrl).hostname;
    if (host.startsWith('push-t2')) return null;
    return `当前频道走的是 ${host} 线路，测试账号只在腾讯云线路（push-t2）可推流，请在直播后台把线路切到腾讯云后重试。`;
  } catch {
    return null;
  }
});

const advisories = computed(() =>
  networkNotice.value ? [networkNotice.value] : [],
);

const deviceLocked = computed(() => state.value !== 'idle' && state.value !== 'error');
const deviceLockHint = computed(() =>
  state.value === 'live' ? '推流中不支持切换设备，停止后可切换' : null,
);
/** 推流中（含准备/连接/停止中）不允许换频道，必须先停播（D17） */
const channelSwitchBlockedReason = computed(() => (deviceLocked.value ? '请先停止直播再换频道' : null));
const startBlockedReason = computed(() => (channel.value ? null : '先在下方新建频道或填入已有频道号'));
/** 预检拦截（D25）：模板不是纯视频 / 地址已过期时，按开播键不能真的推上去 */
const precheckBlockedReason = computed(() => {
  if (!channel.value) return null;
  if (verdict.value?.id === 'D2') return '频道不是纯视频模板，改完模板后再开播';
  if (verdict.value?.id === 'D1') return '推流地址已过期，点【重新连接】重新取地址';
  return null;
});
/**
 * 预检拦截（D39 ③）：探测确认「连不上服务器」时，除自检条变红，【开始直播】也要禁用。
 * 探测不看浏览器到本进程的回环链路，看的是服务端探到的上游可达性（D39 ①②），恢复后自动解除。
 */
const networkBlockedReason = computed(() =>
  networkProbe.value === 'failed' ? '网络还没恢复，先检查网络再开播' : null,
);
const blockedStartReason = computed(
  () => startBlockedReason.value ?? precheckBlockedReason.value ?? networkBlockedReason.value,
);
const historyChannelId = computed(() => sessionChannelId.value ?? channel.value?.channelId ?? null);

function setChannel(next: ChannelInfo): void {
  channel.value = next;
  channelError.value = null;
  persistChannel(next);
}

function showNotice(tone: 'info' | 'danger', text: string): void {
  notice.value = { tone, text };
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
    noticeTimer = null;
  }, NOTICE_DURATION_MS);
}

async function createChannel(name: string): Promise<void> {
  if (channelBusy.value) return;
  channelBusy.value = true;
  channelError.value = null;
  try {
    setChannel(await liveApi.createChannel(name));
  } catch (unknownError) {
    channelError.value = mapPushError(unknownError);
  } finally {
    channelBusy.value = false;
  }
}

async function useExistingChannel(channelId: string): Promise<void> {
  if (channelBusy.value) return;
  if (!/^\d{4,20}$/.test(channelId)) {
    channelError.value = {
      code: 'invalid_channel_id',
      message: '频道号是纯数字，请检查后再填。',
      nextStep: '',
      text: '频道号是纯数字，请检查后再填。',
    };
    return;
  }
  channelBusy.value = true;
  channelError.value = null;
  try {
    setChannel(await liveApi.getChannel(channelId));
  } catch (unknownError) {
    channelError.value = mapPushError(unknownError);
  } finally {
    channelBusy.value = false;
  }
}

async function startSession(): Promise<void> {
  if (!channel.value) return;
  // 会话频道号在开播这一刻固化，后续上报/心跳都只认它（D17）
  sessionChannelId.value = channel.value.channelId;
  await start();
}

function switchChannel(): void {
  // 推流中换频道会把会话、心跳、观众侧状态口径全弄乱（C1/D17）：必须先停止
  if (channelSwitchBlockedReason.value) return;
  stopHeartbeat();
  sessionChannelId.value = null;
  channel.value = null;
  persistChannel(null);
  channelError.value = null;
  session.clearError();
  mediaError.value = null;
}

async function copyWatchLink(): Promise<void> {
  if (!watchLink.value) return;
  try {
    await navigator.clipboard.writeText(watchLink.value);
    copied.value = true;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 2_000);
  } catch {
    copied.value = false;
    showNotice('danger', '复制失败，请手动复制观看链接');
  }
}

async function copyToClipboard(text: string, successText: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showNotice('info', successText);
  } catch {
    showNotice('danger', '复制失败，请手动选择文本复制');
  }
}

function onCopyDiagnosis(text: string): void {
  void copyToClipboard(text, '诊断信息已复制');
}

function onCopyHistory(text: string): void {
  void copyToClipboard(text, '诊断历史已复制');
}

/**
 * 一键修复的执行侧（D22）：诊断卡只决定「修哪个」，具体动作在这里落到推流状态机上。
 * 失败必须抛出 —— 抛了诊断卡才会回到同一条结论并把修复次数 +1。
 *
 * **D41 ①：修复动作不得擅自开播。** 修复前先记 `wasLive`，只有修复前正在推流才恢复推流；
 * 未开播时的修复只允许「重新取采集流 + 重跑判定」——讲师点的是「检测」，不是「开播」。
 */
async function executeFix(action: DiagnosticAction): Promise<void> {
  const wasLive = session.state.value === 'live';
  switch (action.kind) {
    case 'open-help':
      // D2 只给帮助中心链接（上方渲染成新窗口链接），不走这里
      return;
    case 'reconnect': {
      if (session.state.value === 'idle') {
        // 还没开播（D1 预检）：只重新取一条地址，不擅自开播
        const sessionId = channel.value?.channelId ?? sessionChannelId.value;
        if (!sessionId) throw new Error('还没有频道');
        setChannel(await liveApi.getChannel(sessionId));
        return;
      }
      await restartSession();
      return;
    }
    case 'reload-pusher': {
      // 推流器只在推流时有东西可重载；未开播时不重启（D41 ①：不得擅自开播）
      const stoppedLive = await stopIfStreaming();
      if (!wasLive && !stoppedLive) return;
      await restartSession();
      return;
    }
    case 'switch-device': {
      const nextPermission = await permissions.refresh();
      // D41 ②：麦克风被浏览器拒绝时切设备也没用（getUserMedia 一律 reject），只给指引
      if (nextPermission.microphone === 'denied') throw new Error(MICROPHONE_BLOCKED_GUIDANCE.reason);
      // 推流中换设备必须先停播：旧轨道会被 stop，继续推会没有声音
      const stoppedLive = await stopIfStreaming();
      const nextId = nextDeviceId(microphones.value, microphoneId.value);
      if (nextId) {
        await media.applySelection({ microphoneId: nextId });
      } else {
        // 只有一个麦克风：重建一次采集（设备被系统静音时，重新取流常常就能恢复）
        media.stopStream();
        await media.ensureStream();
      }
      ensureStreamHealthy();
      await permissions.refresh();
      // D41 ①：只有修复前在推流才恢复推流
      if (wasLive || stoppedLive) await restartSession();
      return;
    }
    case 'reauthorize': {
      const nextPermission = await permissions.refresh();
      // D41 ②：denied 时浏览器永久不再弹授权框（规范行为）——
      // 既不切设备也不反复重试，抛出去让诊断卡保留 D9 并给出「去地址栏改允许」的指引。
      if (nextPermission.camera === 'denied') throw new Error(CAMERA_BLOCKED_GUIDANCE.reason);
      const stoppedLive = await stopIfStreaming();
      media.stopStream();
      try {
        // prompt 状态下这一步就发生在按钮点击手势里，浏览器才会正常弹授权框
        await media.ensureStream();
      } catch {
        // 非权限原因（设备被占用 / 不存在等）→ 切下一个摄像头（计划 §三 D9 的下一步第二步）
        const nextCamera = nextDeviceId(cameras.value, cameraId.value);
        if (!nextCamera) throw new Error('没有可切换的摄像头');
        await media.applySelection({ cameraId: nextCamera });
        await permissions.refresh();
      }
      ensureStreamHealthy();
      // D41 ①：只有修复前在推流才恢复推流；未开播时到这里就结束（重新取流 + 重跑判定）
      if (wasLive || stoppedLive) await restartSession();
      return;
    }
    case 'lower-resolution': {
      const stoppedLive = await stopIfStreaming();
      await media.downgradeResolution();
      ensureStreamHealthy();
      // D41 ①：只有修复前在推流才恢复推流
      if (wasLive || stoppedLive) await restartSession();
      return;
    }
    default:
      return;
  }
}

/**
 * 停播（只有 live 才需要停；连接中先等它落下结论）。
 * 返回「停之前是否真的在推流」：修复后要不要恢复推流只看这个 + 进入修复时的 `wasLive`（D41 ①）。
 */
async function stopIfStreaming(): Promise<boolean> {
  if (session.state.value === 'preparing' || session.state.value === 'connecting') {
    await waitForSettle();
  }
  if (session.state.value !== 'live') return false;
  await stop();
  return true;
}

/** 重连：停 → 重新取地址 → 再开播；失败必须抛给诊断卡（回同一结论 + 再试一次） */
async function restartSession(): Promise<void> {
  const sessionId = channel.value?.channelId ?? sessionChannelId.value;
  if (!sessionId) throw new Error('还没有频道');
  await stopIfStreaming();
  sessionChannelId.value = sessionId;
  await start();
  if (session.state.value !== 'live') {
    throw new Error(session.errorMessage.value ?? '重连没有成功');
  }
}

/** 等「准备中 / 连接中」有个结论（live / error / idle），超时也继续往下修 */
async function waitForSettle(): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = session.state.value;
    if (current === 'live' || current === 'error' || current === 'idle') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function ensureStreamHealthy(): void {
  if (!media.stream.value || media.error.value) {
    throw new Error(media.error.value?.message ?? '设备没有就绪');
  }
}

/** 设备列表里的下一个（到末尾回到第一个）；只有一个设备时返回 null */
function nextDeviceId(devices: { deviceId: string }[], currentId: string): string | null {
  if (devices.length < 2) return null;
  const index = devices.findIndex((device) => device.deviceId === currentId);
  const next = devices[(index + 1) % devices.length];
  return next && next.deviceId !== currentId ? next.deviceId : null;
}

async function reportSession(channelId: string, sessionState: PushSessionState): Promise<void> {
  try {
    await liveApi.reportPushSession(channelId, sessionState);
  } catch {
    // 会话上报是状态校正用的辅助信息，失败不打扰讲师；下一次心跳会补
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function readStoredChannel(): ChannelInfo | null {
  try {
    const raw = window.localStorage.getItem(CHANNEL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChannelInfo;
    return parsed?.channelId ? parsed : null;
  } catch {
    return null;
  }
}

function persistChannel(next: ChannelInfo | null): void {
  try {
    if (next) window.localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(CHANNEL_STORAGE_KEY);
  } catch {
    // 隐私模式下 localStorage 不可写，忽略
  }
}

onMounted(async () => {
  await media.refreshDevices();
  try {
    await media.ensureStream();
  } catch {
    // 错误已映射到 mediaError，诊断条会给出原因与下一步
  }
});

onBeforeUnmount(() => {
  stopHeartbeat();
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});
</script>

<template>
  <main class="pusher">
    <header class="pusher__header">
      <div class="pusher__intro">
        <h1 class="pusher__title">
          讲师推流端
        </h1>
        <p class="pusher__subtitle">
          选好设备后点「开始直播」，观众在观看页实时看到画面
        </p>
      </div>
      <button
        type="button"
        class="pusher__history"
        :aria-expanded="historyOpen ? 'true' : 'false'"
        @click="historyOpen = true"
      >
        诊断历史
      </button>
    </header>

    <ChannelSetupPanel
      v-if="!channel"
      :busy="channelBusy"
      :error-message="channelError ? errorText(channelError) : null"
      @create="createChannel"
      @use-existing="useExistingChannel"
    />

    <section
      v-else
      class="channel-bar panel"
      aria-label="当前频道"
    >
      <div class="channel-bar__identity">
        <p class="channel-bar__name">
          {{ channel.name }}
        </p>
      </div>
      <a
        class="channel-bar__link"
        :href="watchLink"
        target="_blank"
        rel="noopener"
      >打开观看页</a>
      <button
        type="button"
        class="channel-bar__copy"
        @click="copyWatchLink"
      >
        {{ copied ? '已复制' : '复制观看链接' }}
      </button>
      <button
        type="button"
        class="channel-bar__switch"
        :disabled="Boolean(channelSwitchBlockedReason)"
        :title="channelSwitchBlockedReason ?? undefined"
        :aria-describedby="channelSwitchBlockedReason ? 'channel-switch-hint' : undefined"
        @click="switchChannel"
      >
        换频道
      </button>
      <p
        v-if="channelSwitchBlockedReason"
        id="channel-switch-hint"
        class="channel-bar__hint"
      >
        {{ channelSwitchBlockedReason }}
      </p>
    </section>

    <PreviewStage
      ref="previewRef"
      :stream="stream"
      :state="state"
      :level="level"
      :channel-id="channel?.channelId ?? null"
    />

    <section
      class="controls panel"
      aria-label="设备与开播"
    >
      <DevicePicker
        :cameras="cameras"
        :microphones="microphones"
        :camera-id="cameraId"
        :microphone-id="microphoneId"
        :disabled="deviceLocked"
        :disabled-hint="deviceLockHint"
        @update:camera-id="media.applySelection({ cameraId: $event })"
        @update:microphone-id="media.applySelection({ microphoneId: $event })"
      />
      <PushControlBar
        :state="state"
        :can-start="canStart && Boolean(channel) && !precheckBlockedReason && !networkBlockedReason"
        :can-stop="canStop"
        :blocked-reason="blockedStartReason"
        @start="startSession()"
        @stop="stop()"
      />
    </section>

    <!-- 自检条（D21）：指标条上方一条健康结论；频道未载入且无结论时不占位 -->
    <DiagnosisBar
      v-if="channel || verdict"
      :status="diagnosisStatus"
      :conclusion="barConclusion"
      :verdict="barVerdict"
      :fixing-label="barFixingLabel"
      :attempts="barAttempts"
      :retry-hint="barRetryHint"
      :steps="barSteps"
      :advisories="advisories"
      :channel-id="historyChannelId"
      @fix="diagnostics.runFix()"
      @copy="onCopyDiagnosis"
    />

    <MetricsBar
      :duration-text="durationText"
      :bitrate-text="bitrateText"
      :fps-text="fpsText"
      :resolution-text="resolutionText"
      :connection-text="connectionText"
      :connection-tone="connectionTone"
      :encoding-text="encodingText"
      :has-live-stats="hasLiveStats"
    />

    <!-- D27：推流 / 设备错误只在自检条上说一次；这里只留操作类反馈（复制成功 / 失败） -->
    <NoticeBar
      v-if="notice"
      :tone="notice.tone"
      :text="notice.text"
      dismissible
      @dismiss="notice = null"
    />

    <!-- 演示故障注入（D37，仅 `?demo=1`）：注入的是规则层输入，不绕过判定 -->
    <DemoFaultPanel
      v-if="demoMode"
      :active="demoFault"
      @inject="demoFault = $event"
      @reset="demoFault = null"
    />

    <p class="pusher__footnote">
      推流链路：浏览器采集 → 腾讯云 TXLivePusher（WebRTC）→ 保利威直播 CDN
    </p>

    <DiagnosisHistoryDrawer
      :open="historyOpen"
      :channel-id="historyChannelId"
      :fallback-items="records"
      :fallback-samples="metricsSamples"
      @close="historyOpen = false"
      @copy="onCopyHistory"
    />
  </main>
</template>
