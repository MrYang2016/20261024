/**
 * 验收契约来源：CONTEXT.md **D41**（评审人 2026-10-23 第三次真机实测）
 *
 * 实测缺陷 ①：未开播时点【重新授权 / 换设备】修复 → 诊断卡显示已恢复，但**直接开播了**。
 *   根因在 `App.vue` 的 `executeFix`：`reauthorize` / `switch-device` / `lower-resolution`
 *   收尾一律 `restartSession()`，而 `restartSession()` 无条件 `start()`。
 *   契约：修复前是 `idle` → 只允许「重新获取采集流 + 重跑判定」，**不得 start()**；
 *        修复前是 `live`（`wasLive`） → 才恢复推流。
 *
 * 实测缺陷 ②：浏览器权限已被拒绝时点【重新检测】 → 浏览器不会弹授权框
 *   （规范：`permissions.query` 为 `denied` 后 `getUserMedia` 立即 reject）。
 *   契约：不得盲目重试 `getUserMedia`、不得盲目切设备；诊断卡要给出
 *   「点地址栏左侧的摄像头图标 → 允许 → 再点重新检测」这类可执行指引（含「地址栏」「允许」）。
 *
 * 为什么用**组件测试**而不是猜一个纯函数签名：
 *   计划（CONTEXT D41）冻结的是**行为**（点修复之后推流器会不会 start），不是 `executeFix` 的内部结构。
 *   本文件把 `usePushSession` / `useDiagnostics` 换成桩，从 `useDiagnostics` 拿回 App 注入的 `runFix`
 *   （就是 `executeFix`）直接驱动，因此：
 *     - 实现把决策抽成纯函数、或留在 `executeFix` 里，本文件都不用改；
 *     - 断言只落在「`session.start` 调了几次」「`getUserMedia` 调了几次」这些可观测事实上。
 *   只有「denied → 给出指引」这条要看**渲染结果**，所以那一条用真实的 `useDiagnostics`（含规则引擎）
 *   跑一遍，断言诊断卡里的文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { ChannelInfo, DiagnosticAction } from '@live1024/shared';
import type { PushState } from './composables/usePushSession';
import App from './App.vue';

/** 固定基准时刻：2026-10-23T10:00:00Z */
const T0 = Date.parse('2026-10-23T10:00:00.000Z');
const CHANNEL_ID = '1000031';
const CHANNEL_STORAGE_KEY = 'live1024.pusher.channel';

/** 提示：`vi.mock` 的工厂会被提升到 import 之前，跨工厂共享的东西必须走 `vi.hoisted` */
const harness = vi.hoisted(() => ({
  /** true = 用真实的 useDiagnostics（只有「权限 denied 要给指引」那条需要） */
  useReal: false,
  /** App 交给 useDiagnostics 的 options（含 runFix = executeFix） */
  lastOptions: null as null | { runFix?: (action: DiagnosticAction) => Promise<void> },
  /** 推流会话桩（App 通过 usePushSession 拿到它） */
  session: null as null | Record<string, any>,
  /** 服务端返回的频道（测试可换） */
  channel: null as null | ChannelInfo,
}));

/** 推流会话桩：状态机只保留 App / usePushStats / useMetricsRecorder 读的那几个字段 */
vi.mock('./composables/usePushSession', async () => {
  const { computed, ref, shallowRef } = await import('vue');
  const state = ref<PushState>('idle');
  const session = {
    state,
    status: state,
    error: ref(null),
    errorMessage: computed(() => null),
    connectionStatus: ref('disconnected'),
    stats: shallowRef(null),
    startedAt: ref(null),
    elapsedMs: ref(0),
    encoding: ref(null),
    isBusy: computed(() => false),
    canStart: computed(() => state.value === 'idle' || state.value === 'error'),
    canStop: computed(() => state.value === 'live'),
    // start / stop 是本文件的核心观测点：spy 记录「修复动作有没有擅自开播」
    start: vi.fn(async () => {
      state.value = 'live';
    }),
    stop: vi.fn(async () => {
      state.value = 'idle';
    }),
    clearError: vi.fn(),
  };
  harness.session = session;
  return { usePushSession: () => session };
});

/**
 * `useDiagnostics` 桩：
 * - 缺省（`useReal = false`）：只把 App 注入的 options 记下来（`runFix` 就是 `executeFix`），返回最小结果；
 * - `useReal = true`：转交真实实现，让诊断卡真的渲染出 D9 与详情文案。
 */
vi.mock('./diagnostics/useDiagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diagnostics/useDiagnostics')>();
  const { ref } = await import('vue');
  return {
    ...actual,
    useDiagnostics: (options: Parameters<typeof actual.useDiagnostics>[0]) => {
      harness.lastOptions = options as typeof harness.lastOptions;
      if (harness.useReal) return actual.useDiagnostics(options);
      return {
        verdict: ref(null),
        status: ref('ok'),
        conclusion: ref(''),
        fixingLabel: ref(null),
        attempts: ref(0),
        retryHint: ref(null),
        records: ref([]),
        advisories: ref([]),
        device: ref(null),
        networkProbe: ref('ok'),
        runFix: vi.fn(async () => undefined),
        tick: vi.fn(),
      };
    },
  };
});

/** 服务端 API 桩：组件挂载会走 device/report 系列，一律不出网 */
vi.mock('./lib/api', async () => {
  class ApiRequestError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiRequestError,
    // D38 探测：真实 useDiagnostics 会调它（顶层导出，不在 liveApi 里），
    // true = 网络可达（否则 D3「连不上服务器」会抢在 D9 前面）
    probeHealth: vi.fn(async () => true),
    liveApi: {
      getChannel: vi.fn(async () => harness.channel),
      createChannel: vi.fn(async () => harness.channel),
      reportPushSession: vi.fn(async () => ({})),
      reportDiagnostic: vi.fn(async () => ({ stored: true })),
      reportMetric: vi.fn(async () => ({ stored: true })),
      reportDeviceSnapshot: vi.fn(async () => ({ stored: true })),
    },
  };
});

function channelFixture(): ChannelInfo {
  const stream = `${CHANNEL_ID}_d41`;
  return {
    channelId: CHANNEL_ID,
    name: 'D41 修复回归频道',
    watchUrl: `http://127.0.0.1:5174/?channelId=${CHANNEL_ID}`,
    template: 'alone',
    stream,
    push: {
      rtmpUrl: `rtmp://push-t2.videocc.net/recordf/${stream}?txSecret=d41&txTime=68F1A2B3`,
      webrtcUrl: `webrtc://push-t2.videocc.net/recordf/${stream}?txSecret=d41&txTime=68F1A2B3`,
      expiresAt: new Date(T0 + 6 * 60 * 60 * 1000).toISOString(),
    },
  };
}

/** 预览区桩：只需暴露 `videoElement()`（黑帧检测拿它采样），jsdom 里不真放 video */
const PreviewStageStub = defineComponent({
  name: 'PreviewStage',
  props: {
    stream: { type: Object, default: null },
    state: { type: String, default: 'idle' },
    level: { type: Number, default: 0 },
    channelId: { type: String, default: null },
  },
  setup(_props, { expose }) {
    expose({ videoElement: () => null });
    return () => h('div', { 'data-stub': 'preview-stage' });
  },
});

type Permission = 'granted' | 'denied' | 'prompt';

/**
 * 浏览器媒体层桩（真实 `useMediaDevices` 跑在上面）：
 * - 权限状态是**可变**的：`media.permission = 'denied'` 之后 `getUserMedia` 立即 reject NotAllowedError
 *   （浏览器规范：denied 之后不会再弹授权框）；`permissions.query` 现读同一个值，
 *   所以实现用「composable 上的权限字段」还是「自己 query」都能拿到 denied。
 * - `getUserMedia` 是 spy：断言「有没有重新请求设备」。
 */
const media = {
  permission: 'granted' as Permission,
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

function notAllowedError(): Error {
  const error = new Error('Permission denied');
  error.name = 'NotAllowedError';
  return error;
}

function fakeStream(): MediaStream {
  const settings = () => ({ width: 640, height: 360, frameRate: 24 });
  const tracks = [
    { kind: 'video', readyState: 'live', stop: vi.fn(), getSettings: settings },
    { kind: 'audio', readyState: 'live', stop: vi.fn(), getSettings: settings },
  ] as unknown as MediaStreamTrack[];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
  } as unknown as MediaStream;
}

function installMediaEnvironment(): void {
  media.permission = 'granted';
  media.getUserMedia.mockReset();
  media.getUserMedia.mockImplementation(async () => {
    if (media.permission === 'denied') throw notAllowedError();
    return fakeStream();
  });
  media.enumerateDevices.mockReset();
  media.enumerateDevices.mockImplementation(async () => [
    { deviceId: 'cam-1', groupId: 'g', kind: 'videoinput', label: '摄像头 1' },
    { deviceId: 'cam-2', groupId: 'g', kind: 'videoinput', label: '摄像头 2' },
    { deviceId: 'mic-1', groupId: 'g', kind: 'audioinput', label: '麦克风 1' },
  ]);

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: media.enumerateDevices,
      getUserMedia: media.getUserMedia,
      addEventListener: media.addEventListener,
      removeEventListener: media.removeEventListener,
    },
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: vi.fn(async (descriptor: { name?: string }) => ({
        state:
          descriptor?.name === 'camera' || descriptor?.name === 'microphone'
            ? media.permission
            : 'granted',
        name: descriptor?.name ?? 'unknown',
      })),
    },
  });
}

const wrappers: VueWrapper[] = [];

function mountApp(): VueWrapper {
  const wrapper = mount(App, {
    global: { stubs: { PreviewStage: PreviewStageStub } },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 把 microtask / 定时器都推干净（组件 setUp 期就起 1s tick，不能用真实计时器） */
async function settle(ms = 0): Promise<void> {
  await nextTick();
  await vi.advanceTimersByTimeAsync(ms);
  await nextTick();
}

function session(): Record<string, any> {
  const value = harness.session;
  expect(value, 'usePushSession 桩必须已创建').not.toBeNull();
  return value as Record<string, any>;
}

/** 调 App 交给诊断卡的 runFix（= `executeFix`），等价于点一下修复按钮 */
async function triggerFix(action: DiagnosticAction): Promise<void> {
  const runFix = harness.lastOptions?.runFix;
  expect(typeof runFix, 'App 必须把 executeFix 作为 runFix 注入 useDiagnostics').toBe('function');
  await runFix?.(action);
  await settle();
}

/** 修复按钮的动作对象（label 不参与判定，与 DIAGNOSTIC_META 的文案一致） */
const ACTION: Record<'reauthorize' | 'switchDevice' | 'lowerResolution', DiagnosticAction> = {
  reauthorize: { kind: 'reauthorize', label: '重新检测摄像头' },
  switchDevice: { kind: 'switch-device', label: '换麦克风', device: 'audio' },
  lowerResolution: { kind: 'lower-resolution', label: '降低分辨率重推' },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  harness.useReal = false;
  harness.lastOptions = null;
  harness.channel = channelFixture();

  window.localStorage.clear();
  // 频道已载入：这样「未开播修复」这条路径上 restartSession 有频道可用（旧实现在这里真的会 start）
  window.localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(harness.channel));

  installMediaEnvironment();
  const current = session();
  current.state.value = 'idle';
  current.start.mockClear();
  current.stop.mockClear();
  current.clearError.mockClear();
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('D41 ① 未开播（idle）时修复不得擅自开播', () => {
  it('idle + reauthorize → 重新取采集流，但 session.start 一次都不许调', async () => {
    mountApp();
    await settle();
    const gUMBefore = media.getUserMedia.mock.calls.length;
    session().start.mockClear();

    await triggerFix(ACTION.reauthorize);

    expect(
      session().start,
      'D41 ①：未开播时【重新授权】只允许「重新获取采集流 + 重跑判定」，不得调用 start() 自动开播',
    ).not.toHaveBeenCalled();
    expect(
      media.getUserMedia.mock.calls.length,
      '修复动作仍要重新获取采集流（否则按钮等于没作用）——只是不能顺手开播',
    ).toBeGreaterThan(gUMBefore);
  });

  it('idle + switch-device → session.start 一次都不许调', async () => {
    mountApp();
    await settle();
    session().start.mockClear();

    await triggerFix(ACTION.switchDevice);

    expect(
      session().start,
      'D41 ①：未开播时【换设备】同样只能重建采集流，不得自动开播',
    ).not.toHaveBeenCalled();
  });

  it('idle + lower-resolution → session.start 一次都不许调', async () => {
    mountApp();
    await settle();
    session().start.mockClear();

    await triggerFix(ACTION.lowerResolution);

    expect(
      session().start,
      'D41 ①：未开播时【降低分辨率重推】不得自动开播（先停再 start 的写法在 idle 下同样越界）',
    ).not.toHaveBeenCalled();
  });
});

describe('D41 ① 推流中（live）修复后要恢复推流', () => {
  it('live + reauthorize → 先 stop，再 start 恰好一次（修复后画面回来）', async () => {
    mountApp();
    await settle();
    session().state.value = 'live';
    session().start.mockClear();
    session().stop.mockClear();

    await triggerFix(ACTION.reauthorize);

    expect(
      session().start,
      'D41 ①：修复前处于 live 时必须恢复推流（记录 wasLive 的意义就在这里）',
    ).toHaveBeenCalledTimes(1);
    expect(session().stop, 'D41 ①：推流中换流必须先停播（旧轨道要释放）').toHaveBeenCalled();
  });
});

describe('D41 ② 权限 denied：不盲目重试、给地址栏授权指引', () => {
  it('denied + reauthorize → 不再调用 getUserMedia、不切设备，诊断卡给出含「地址栏」「允许」的指引', async () => {
    // 这条要看渲染结果（诊断卡的结论 / 详情），所以用真实的规则引擎与诊断 composable
    harness.useReal = true;
    media.permission = 'denied';

    const wrapper = mountApp();
    await settle(1_000);

    const selfCheck = wrapper.find('[aria-label="推流自检"]');
    expect(selfCheck.exists(), 'D41 ②：权限失败时必须渲染自检条（D21：故障提示只走这里）').toBe(true);
    expect(
      selfCheck.text(),
      `D41 ②：权限被拒时结论必须点名「权限 / 浏览器已阻止」，不能只说「摄像头没有画面」，实际：${selfCheck.text()}`,
    ).toMatch(/权限|阻止/);

    const gUMBefore = media.getUserMedia.mock.calls.length;
    expect(gUMBefore, '权限 denied 时首次取流就已经失败过一次（前提断言）').toBeGreaterThan(0);
    session().start.mockClear();

    const fixButton = wrapper
      .findAll('button')
      .find((button) => /重新检测摄像头|重新授权|恢复画面/.test(button.text()));
    expect(fixButton, 'D41 ②：诊断卡上必须有可点的修复按钮').toBeTruthy();
    await fixButton?.trigger('click');
    await settle(1_000);

    expect(
      media.getUserMedia.mock.calls.length,
      'D41 ②：权限 denied 后浏览器不会再弹授权框，点修复不得再调 getUserMedia（只会立刻 reject）',
    ).toBe(gUMBefore);
    expect(
      session().start,
      'D41 ②：权限没恢复时（未开播）点修复也不得擅自开播',
    ).not.toHaveBeenCalled();

    // 详情里要有「地址栏 → 允许」这类可执行步骤（D41 ②：不能只说「没有权限」）
    const detailsButton = wrapper.findAll('button').find((button) => /详情/.test(button.text()));
    expect(detailsButton, 'D41 ②：D9 必须有可展开的详情').toBeTruthy();
    await detailsButton?.trigger('click');
    await settle();

    const text = wrapper.text();
    expect(
      text,
      `D41 ②：诊断卡必须给出「点地址栏左侧的摄像头图标 → 允许 → 再点重新检测」一类指引，实际：\n${text}`,
    ).toMatch(/地址栏/);
    expect(text, `D41 ②：指引里必须出现「允许」（或引导到浏览器设置），实际：\n${text}`).toMatch(
      /允许|浏览器设置/,
    );
  });
});
