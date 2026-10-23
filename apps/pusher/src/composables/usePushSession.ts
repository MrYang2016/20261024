import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import { mapPushError, errorText, type PushErrorInfo } from '../lib/errors';
import { readCaptureSettings, toEncoding } from '../transports/encoding';
import { WebRtcTxTransport } from '../transports/webrtc-tx-transport';
import type {
  PushConnectionStatus,
  PushEncoding,
  PushStatsSnapshot,
  PushTransport,
  PushTransportObserver,
} from '../transports/types';

/** 推流状态机：idle → preparing → connecting → live → stopping → idle（出错另有 error） */
export type PushState = 'idle' | 'preparing' | 'connecting' | 'live' | 'stopping' | 'error';

export interface PushSessionOptions {
  /** 拿到可用的 MediaStream（内部会缓存并复用同一份流） */
  ensureStream?: () => Promise<MediaStream>;
  /** 每次开播前重新取一条推流地址（服务端下发，客户端不签名） */
  resolvePushUrl?: () => Promise<string>;
  /** 指定传输层实例（测试或多传输层实现时用）；不传则用 createTransport 新建 */
  transport?: PushTransport;
  /** 固定推流地址（不传则走 resolvePushUrl） */
  pushUrl?: string;
  /** 新建传输层；参数是本次会话按实际采集算出的编码参数（D18） */
  createTransport?: (encoding: PushEncoding) => PushTransport;
  /** 进入 live 时回调（用于上报推流会话） */
  onLive?: () => void;
  /** 回到 idle 时回调 */
  onIdle?: () => void;
}

export interface PushSession {
  state: Ref<PushState>;
  /** state 的别名，便于外部按 status 读取 */
  status: Ref<PushState>;
  error: Ref<PushErrorInfo | null>;
  errorMessage: ComputedRef<string | null>;
  connectionStatus: Ref<PushConnectionStatus>;
  stats: Ref<PushStatsSnapshot | null>;
  startedAt: Ref<number | null>;
  elapsedMs: Ref<number>;
  /** 本次会话的编码参数：start() 时按实际采集固化，没开播过为 null（D18） */
  encoding: Ref<PushEncoding | null>;
  isBusy: ComputedRef<boolean>;
  canStart: ComputedRef<boolean>;
  canStop: ComputedRef<boolean>;
  start: (pushUrl?: string, stream?: MediaStream) => Promise<void>;
  stop: () => Promise<void>;
  clearError: () => void;
}

/**
 * 推流会话状态机。
 * 硬约束：start 只允许从 idle（或错误重试）进入；stop 必须等传输层真正释放后才回 idle。
 */
export function usePushSession(options: PushSessionOptions = {}): PushSession {
  const state = ref<PushState>('idle');
  const error = ref<PushErrorInfo | null>(null);
  const connectionStatus = ref<PushConnectionStatus>('disconnected');
  const stats = shallowRef<PushStatsSnapshot | null>(null);
  const startedAt = ref<number | null>(null);
  const elapsedMs = ref(0);
  const encoding = ref<PushEncoding | null>(null);

  let transport: PushTransport | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  const errorMessage = computed(() => (error.value ? errorText(error.value) : null));
  const isBusy = computed(
    () => state.value === 'preparing' || state.value === 'connecting' || state.value === 'stopping',
  );
  const canStart = computed(() => state.value === 'idle' || state.value === 'error');
  const canStop = computed(() => state.value === 'live');

  async function start(pushUrl?: string, stream?: MediaStream): Promise<void> {
    // live / stopping 期间一律拒绝；这也是 -12 会话竞态的防线
    if (!canStart.value) return;

    error.value = null;
    stats.value = null;
    state.value = 'preparing';

    try {
      const mediaStream = stream ?? (await acquireStream());
      const url = pushUrl ?? options.pushUrl ?? (await resolvePushUrl());
      if (!url) {
        throw Object.assign(new Error('推流地址为空'), { name: 'EmptyPushUrl' });
      }

      // 编码参数 = 实际采集分辨率/帧率（D18）：拿不到轨道设置才用兜底档
      const sessionEncoding = toEncoding(readCaptureSettings(mediaStream));
      encoding.value = sessionEncoding;

      const nextTransport =
        options.transport ?? (options.createTransport ?? defaultCreateTransport)(sessionEncoding);
      transport = nextTransport;
      observeTransport(nextTransport);

      state.value = 'connecting';
      await nextTransport.start(url, mediaStream);

      state.value = 'live';
      startedAt.value = Date.now();
      elapsedMs.value = 0;
      startElapsedTimer();
      options.onLive?.();
    } catch (unknownError) {
      error.value = mapPushError(unknownError);
      state.value = 'error';
      connectionStatus.value = 'disconnected';
      // 不 await：传输层可能卡在停止上，但状态机必须能立刻给出错误
      releaseTransportInBackground();
    }
  }

  async function stop(): Promise<void> {
    if (state.value !== 'live') return;

    state.value = 'stopping';
    stopElapsedTimer();
    try {
      await releaseTransport();
    } finally {
      // 只有传输层真正释放完（await 完成）才回到 idle
      startedAt.value = null;
      elapsedMs.value = 0;
      // 上一次会话的码率/帧率/画面尺寸必须清掉，否则停止后指标条会残留旧数字
      stats.value = null;
      connectionStatus.value = 'disconnected';
      state.value = 'idle';
      options.onIdle?.();
    }
  }

  function clearError(): void {
    error.value = null;
    if (state.value === 'error') state.value = 'idle';
  }

  async function acquireStream(): Promise<MediaStream> {
    if (!options.ensureStream) throw new Error('缺少采集实现');
    return options.ensureStream();
  }

  async function resolvePushUrl(): Promise<string> {
    if (!options.resolvePushUrl) throw new Error('缺少推流地址来源');
    return options.resolvePushUrl();
  }

  function observeTransport(active: PushTransport): void {
    const capable = active as { setObserver?: (observer: PushTransportObserver) => void };
    if (typeof capable.setObserver !== 'function') return;
    capable.setObserver({
      onStatus: (status) => {
        connectionStatus.value = status;
      },
      onStats: (snapshot) => {
        stats.value = snapshot;
      },
      onError: (transportError) => {
        // 推流中 SDK 报错：留在 live 但把原因显示出来，避免用户不知道已经断流
        if (state.value === 'live') error.value = mapPushError(transportError);
      },
    });
  }

  async function releaseTransport(): Promise<void> {
    const active = transport;
    transport = null;
    if (!active) return;
    try {
      await active.stop();
    } catch (unknownError) {
      // 已有错误（例如开播失败的原因）优先展示，不被停止失败覆盖
      if (!error.value) error.value = mapPushError(unknownError);
    }
  }

  function releaseTransportInBackground(): void {
    void releaseTransport();
  }

  function defaultCreateTransport(sessionEncoding: PushEncoding): PushTransport {
    return new WebRtcTxTransport(sessionEncoding);
  }

  function startElapsedTimer(): void {
    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
      if (startedAt.value !== null) elapsedMs.value = Date.now() - startedAt.value;
    }, 1000);
  }

  function stopElapsedTimer(): void {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      stopElapsedTimer();
      void releaseTransport();
    });
  }

  return {
    state,
    status: state,
    error,
    errorMessage,
    connectionStatus,
    stats,
    startedAt,
    elapsedMs,
    encoding,
    isBusy,
    canStart,
    canStop,
    start,
    stop,
    clearError,
  };
}
