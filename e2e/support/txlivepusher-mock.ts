/**
 * e2e 共用：腾讯云推流 SDK（TXLivePusher 2.1.1）mock。
 *
 * Done when 第 6 条要求 e2e 不依赖真实推流与真实网络。计划 §六 规定的传输层是：
 *   动态加载 https://video.sdk.qcloudecdn.com/web/TXLivePusher-2.1.1.min.js
 *   → new TXLivePusher() → setProperty(...) → startCustomCapture(stream) → startPush(webrtcUrl)
 *
 * 本 mock 做三件事：
 *   1. 拦截该 SDK 脚本请求，返回一个定义 window.TXLivePusher 的桩脚本（不出网）。
 *   2. 在页面脚本执行前预置 window.TXLivePusher（兼容「先判断已存在再加载」的实现）。
 *   3. 把推流实际用到的地址记到 window.__E2E_TX_PUSH__，让 e2e 能断言「客户端推的是
 *      webrtc:// 地址且带 txSecret」（D5 腾讯云线路 + D7 rtmp→webrtc + Done when 第 9 条思路）。
 *
 * 如果推流端要等 SDK 的某个具体事件/码值才切「推流中」，把实际用到的回调名与码值告诉 TestSpec，
 * 本文件需要补齐那一处（当前桩在 startPush 落地后广播一次成功事件，码值 1002）。
 *
 * 本轮补强（缺陷：停止后指标条残留上次统计）：
 *   WebRtcTxTransport 的实测统计走 `pusher.setObserver({ onPushStatusUpdate, onStatisticsUpdate, onError })`，
 *   原来的桩只实现了 handler/on 风格，`setObserver` 不存在 → 码率/帧率永远是「—」，e2e 无法断言指标条。
 *   现在补上 setObserver：startPush 成功后回报一次 E2E_TX_STATS，stopPush 后报 disconnected（0），
 *   这也让 transport.release() 不必等 1500ms 超时，停止用例更快更接近真实。
 * 本轮补强（评审 D18 / C2）：`画面` 在首次统计回报前必须是占位符 `—`。
 * 原来桩在 startPush 成功后立刻回报一次统计，e2e 无法观察「首帧统计回报前」这个窗口。
 * 现在支持 `installTxLivePusherMock(page, { autoStats: false })`：不自动回报，
 * 由测试在需要的时刻调用 `emitTxStats(page)`（页面侧 `window.__E2E_TX_EMIT_STATS__()`）手动触发。
 */
import type { Page } from '@playwright/test';

const SDK_URL_PATTERN = '**/TXLivePusher-2.1.1.min.js';

export interface TxMockOptions {
  /** 是否在 startPush 成功后自动回报一次实测统计（默认 true；D18 用例要传 false 才能观察首帧前的占位符） */
  autoStats?: boolean;
  /** startPush 接管多久后才 resolve（模拟 CDN 握手耗时，用来观察「连接中」这个中间态；默认 0） */
  startDelayMs?: number;
}

/**
 * 桩回报的实测统计（单位与真 SDK 一致：bitrate 为 bps）。
 * WebRtcTxTransport.handleStatistics 会 ÷1000 得到 kbps，所以 UI 上会看到 800 kbps / 15 fps / 320×180。
 * e2e 断言指标条文案时引用这里，避免桩与断言各写一套数字。
 */
export const E2E_TX_STATS = {
  bitrateBps: 800_000,
  bitrateKbps: 800,
  fps: 15,
  width: 320,
  height: 180,
} as const;

const TX_STATS_PAYLOAD = {
  timestamp: 0,
  video: {
    bitrate: E2E_TX_STATS.bitrateBps,
    framesPerSecond: E2E_TX_STATS.fps,
    frameWidth: E2E_TX_STATS.width,
    frameHeight: E2E_TX_STATS.height,
  },
};

/** onPushStatusUpdate 的状态码（与 apps/pusher/src/transports/tx-live-pusher.ts 的 TxPushStatusCode 对齐） */
const TX_STATUS = { disconnected: 0, connected: 2 } as const;

const SDK_STUB_TEMPLATE = String.raw`
(function () {
  function noop() {}

  /* SDK 内部状态码（值来自模块里的 TX_STATUS，注入到页面上下文，页面里不能直接引用 Node 侧变量） */
  var TX_CONNECTED = ${TX_STATUS.connected};
  var TX_DISCONNECTED = ${TX_STATUS.disconnected};
  /* 是否自动回报实测统计（D18 用例需要关掉，手动控制「首帧统计回报前」这个窗口） */
  var AUTO_STATS = __AUTO_STATS__;
  /* startPush 的握手耗时（D17 用例用来观察「连接中」窗口） */
  var START_DELAY_MS = __START_DELAY__;

  /* 可被测试随时改写的实测统计（24060：D5 低码率 / D6 fps=0 都靠它注入） */
  var STATS = __STATS_PAYLOAD__;

  /* startPush / stopPush 的调用次数（24060：断言「一键修复」真的重连/重载过推流器） */
  window.__E2E_TX_COUNTS__ = window.__E2E_TX_COUNTS__ || { start: 0, stop: 0 };
  /* 置 true 后下一次 startPush 直接失败（24060：修复失败 → 回到同一结论 +「再试一次」） */
  window.__E2E_TX_FAIL_NEXT_START__ = false;

  window.__E2E_TX_PUSHERS__ = window.__E2E_TX_PUSHERS__ || [];

  function TXLivePusher(options) {
    this.options = options || {};
    this.isPushing = false;
    this.properties = {};
    this.handlers = {};
    this.listener = null;
    this.observer = null;
    this.lastPushUrl = null;
    this._stream = null;
    this.statsEmitted = 0;
    window.__E2E_TX_PUSHERS__.push(this);
  }

  TXLivePusher.prototype.setProperty = function (key, value) {
    if (key && typeof key === 'object') {
      Object.assign(this.properties, key);
    } else if (key) {
      this.properties[key] = value;
    }
  };

  TXLivePusher.prototype.setRenderView = function (view) {
    this.renderView = view;
  };

  TXLivePusher.prototype.on = function (event, handler) {
    if (typeof event === 'function') {
      this.listener = event;
      return;
    }
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  };

  TXLivePusher.prototype.off = function (event, handler) {
    var list = this.handlers[event] || [];
    this.handlers[event] = list.filter(function (item) { return item !== handler; });
  };

  TXLivePusher.prototype.setListener = function (listener) {
    this.listener = listener;
  };

  TXLivePusher.prototype.removeListener = function () {
    this.listener = null;
  };

  /* 官方 SDK 的观察者入口（WebRtcTxTransport 用的是这个，不是 on/handler 风格） */
  TXLivePusher.prototype.setObserver = function (observer) {
    this.observer = observer || null;
  };

  TXLivePusher.prototype._emitStatus = function (status, message) {
    if (!this.observer || typeof this.observer.onPushStatusUpdate !== 'function') return;
    try {
      this.observer.onPushStatusUpdate(status, message || '');
    } catch (e) {}
  };

  /* 模拟 SDK 的 onStatisticsUpdate：码率/帧率/画面尺寸的实测值 */
  TXLivePusher.prototype._emitStatistics = function () {
    this.statsEmitted += 1;
    window.__E2E_TX_STATS_EMITTED__ = (window.__E2E_TX_STATS_EMITTED__ || 0) + 1;
    if (!this.observer || typeof this.observer.onStatisticsUpdate !== 'function') return;
    try {
      this.observer.onStatisticsUpdate(JSON.parse(JSON.stringify(STATS)));
    } catch (e) {}
  };

  TXLivePusher.prototype._emit = function (code, message) {
    var payload = { code: code, message: message };
    var self = this;
    var names = ['pushEvent', 'push', 'onPushEvent'];
    names.forEach(function (name) {
      var list = self.handlers[name] || [];
      list.forEach(function (handler) {
        try { handler(code, message, payload); } catch (e) {}
      });
      if (typeof self[name] === 'function') {
        try { self[name](code, message, payload); } catch (e) {}
      }
    });
    if (typeof this.listener === 'function') {
      try { this.listener(payload); } catch (e) {}
    }
  };

  TXLivePusher.prototype.startCustomCapture = function (stream) {
    this._stream = stream || null;
    window.__E2E_TX_PUSH__ = Object.assign({}, window.__E2E_TX_PUSH__, {
      customCapture: true,
      hasVideoTrack: !!(stream && stream.getVideoTracks && stream.getVideoTracks().length),
      hasAudioTrack: !!(stream && stream.getAudioTracks && stream.getAudioTracks().length),
    });
    return Promise.resolve();
  };

  TXLivePusher.prototype.startPush = function (url) {
    var self = this;
    window.__E2E_TX_COUNTS__.start += 1;
    /* 修复失败注入：本次 startPush 直接失败，用来验证「修复失败回到同一结论」 */
    if (window.__E2E_TX_FAIL_NEXT_START__) {
      window.__E2E_TX_FAIL_NEXT_START__ = false;
      window.__E2E_TX_PUSH__ = Object.assign({}, window.__E2E_TX_PUSH__, {
        failedStartAt: Date.now(),
        lastFailedUrl: url,
        isPushing: false,
      });
      self.isPushing = false;
      return Promise.reject({ code: -1, message: 'e2e: push start failed' });
    }
    self.lastPushUrl = url;
    self.isPushing = true;
    window.__E2E_TX_PUSH__ = Object.assign({}, window.__E2E_TX_PUSH__, {
      url: url,
      startedAt: Date.now(),
      properties: self.properties,
    });
    var settleStart = function () {
      self._emit(1002, 'start push success');
      /* 先报连接成功，再回报一次实测统计（真 SDK 是周期性回报；D18 用例可关掉这一步） */
      self._emitStatus(TX_CONNECTED, 'connected');
      if (AUTO_STATS) self._emitStatistics();
      return { code: 0, url: url };
    };
    if (START_DELAY_MS > 0) {
      return new Promise(function (resolve) {
        window.setTimeout(function () {
          resolve(settleStart());
        }, START_DELAY_MS);
      });
    }
    return Promise.resolve().then(settleStart);
  };

  TXLivePusher.prototype.stopPush = function () {
    var self = this;
    window.__E2E_TX_COUNTS__.stop += 1;
    self.isPushing = false;
    window.__E2E_TX_PUSH__ = Object.assign({}, window.__E2E_TX_PUSH__, {
      stoppedAt: Date.now(),
      isPushing: false,
    });
    return Promise.resolve().then(function () {
      self._emit(1003, 'stop push success');
      /* 报 disconnected：transport 不必等 1500ms 超时就能释放会话 */
      self._emitStatus(TX_DISCONNECTED, 'disconnected');
      return { code: 0 };
    });
  };

  TXLivePusher.prototype.getStats = function () {
    return { videoBitrate: 800, videoFps: 15, videoWidth: 320, videoHeight: 180 };
  };

  TXLivePusher.prototype.destroy = noop;

  /* D18：让 e2e 精确控制在「首帧统计回报前」观察指标条，再手动回报一次真实统计 */
  window.__E2E_TX_EMIT_STATS__ = function () {
    var list = window.__E2E_TX_PUSHERS__ || [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].isPushing) {
        list[i]._emitStatistics();
        return true;
      }
    }
    return false;
  };

  /* 24060：测试随时注入实测统计（码率 / fps / 画面尺寸），并立刻回报一次 */
  window.__E2E_TX_SET_STATS__ = function (next) {
    if (!next || typeof next !== 'object') return false;
    if (typeof next.bitrate === 'number') STATS.video.bitrate = next.bitrate;
    if (typeof next.framesPerSecond === 'number') STATS.video.framesPerSecond = next.framesPerSecond;
    if (typeof next.frameWidth === 'number') STATS.video.frameWidth = next.frameWidth;
    if (typeof next.frameHeight === 'number') STATS.video.frameHeight = next.frameHeight;
    return window.__E2E_TX_EMIT_STATS__();
  };

  /* 24060：注入连接状态（D5 的「连接态掉出 connected」路径） */
  window.__E2E_TX_SET_STATUS__ = function (status, message) {
    var list = window.__E2E_TX_PUSHERS__ || [];
    for (var i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].isPushing) {
        list[i]._emitStatus(status, message || '');
        return true;
      }
    }
    return false;
  };

  window.TXLivePusher = TXLivePusher;
  window.__E2E_TX_SDK_LOADED__ = true;
})();
`;

function buildSdkStub(autoStats: boolean, startDelayMs: number): string {
  return SDK_STUB_TEMPLATE.replace('__AUTO_STATS__', autoStats ? 'true' : 'false')
    .replace('__START_DELAY__', String(startDelayMs))
    .replace('__STATS_PAYLOAD__', () => JSON.stringify(TX_STATS_PAYLOAD));
}

export async function installTxLivePusherMock(page: Page, options: TxMockOptions = {}): Promise<void> {
  const source = buildSdkStub(options.autoStats !== false, options.startDelayMs ?? 0);

  // 1) 脚本请求走桩，绝不出网
  await page.route(SDK_URL_PATTERN, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: source,
    });
  });

  // 2) 预置全局，兼容「window.TXLivePusher 已存在则跳过加载」的实现
  await page.addInitScript({ content: source });
}

/** 手动回报一次实测统计（仅 `autoStats: false` 的场景需要；D18 用） */
export async function emitTxStats(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as any).__E2E_TX_EMIT_STATS__?.()));
}

export interface E2eTxPushRecord {
  url?: string;
  customCapture?: boolean;
  hasVideoTrack?: boolean;
  hasAudioTrack?: boolean;
  startedAt?: number;
  stoppedAt?: number;
  failedStartAt?: number;
  lastFailedUrl?: string;
  isPushing?: boolean;
  properties?: Record<string, unknown>;
}

export async function readTxPushRecord(page: Page): Promise<E2eTxPushRecord | undefined> {
  return page.evaluate(() => (window as any).__E2E_TX_PUSH__);
}

/** startPush / stopPush 的累计调用次数（24060：断言一键修复真的重连 / 重载了推流器） */
export interface E2eTxCounts {
  start: number;
  stop: number;
}

export async function readTxCounts(page: Page): Promise<E2eTxCounts> {
  return page.evaluate(() => {
    const counts = (window as any).__E2E_TX_COUNTS__ ?? { start: 0, stop: 0 };
    return { start: Number(counts.start ?? 0), stop: Number(counts.stop ?? 0) };
  });
}

/** 注入实测统计并立刻回报一次（24060：D5 低码率 / D6 fps=0） */
export async function setTxStats(
  page: Page,
  next: { bitrateBps?: number; fps?: number; width?: number; height?: number },
): Promise<boolean> {
  return page.evaluate((input) => {
    const payload: Record<string, number> = {};
    if (typeof input.bitrateBps === 'number') payload.bitrate = input.bitrateBps;
    if (typeof input.fps === 'number') payload.framesPerSecond = input.fps;
    if (typeof input.width === 'number') payload.frameWidth = input.width;
    if (typeof input.height === 'number') payload.frameHeight = input.height;
    return Boolean((window as any).__E2E_TX_SET_STATS__?.(payload));
  }, next);
}

/** 注入连接状态（24060：D5 的「连接态掉出 connected」路径） */
export async function setTxStatus(page: Page, status: 'connected' | 'disconnected'): Promise<boolean> {
  const code = status === 'connected' ? 2 : 0;
  return page.evaluate((value) => Boolean((window as any).__E2E_TX_SET_STATUS__?.(value)), code);
}

/** 让下一次 startPush 失败（24060：修复失败 → 回到同一结论 +「再试一次」） */
export async function failNextTxStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__E2E_TX_FAIL_NEXT_START__ = true;
  });
}
