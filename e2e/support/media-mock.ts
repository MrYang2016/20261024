/**
 * e2e 共用：浏览器媒体层 mock（不依赖真实摄像头/麦克风，也不联网）。
 *
 * Done when 第 6 条要求 Playwright「mock getUserMedia」。本文件在页面脚本执行前注入：
 *   - navigator.mediaDevices.enumerateDevices → 固定设备列表（含可断言的设备名）
 *   - navigator.mediaDevices.getUserMedia      → 用 canvas.captureStream + AudioContext 造真实 MediaStream
 *     （真实 MediaStream 对象，<video>.srcObject 能直接吃，比手搓假对象稳）
 *   - navigator.mediaDevices.getDisplayMedia   → 拒掉（本期不做屏幕共享）
 *
 * 24060（诊断卡）补的可控项：
 *   - `silentAudio: true`  → 音轨是**真静音**（振荡器 + GainNode 0），D7「麦克风没声音」才测得出来。
 *     默认仍是有声音的 440Hz 振荡器，保证 24059 的既有 20 条 e2e 不受影响（不会误命中 D7）。
 *   - `videoPixel: 'black'`→ 画面每帧填纯黑（亮度 0），D9「摄像头黑屏」才测得出来。
 *     默认仍是交替色块（亮度约 46~73，非黑），同样避免影响既有用例（不会误命中 D9）。
 *
 * D41（修复动作不得擅自开播 + 权限授权指引）补的可控项：
 *   - `permission: 'denied'` → `navigator.permissions.query({name:'camera'|'microphone'})` 回 **denied**，
 *     且 `getUserMedia` 立即 reject `NotAllowedError`（浏览器规范：denied 之后不会再弹授权框，
 *     不是「点了没反应」）。默认 `'granted'`，既有 39 条 e2e 行为不变。
 *   - `setMediaPermission(page, next)` → **运行中**改权限状态，用来模拟「权限被撤 / 地址栏重新允许」。
 *     为什么必须自己打 `permissions.query` 的桩：Playwright 的 `context.clearPermissions()` 在 Chromium 里
 *     把状态清回 `prompt`（不是 `denied`），而 `grant/clearPermissions` 也没有「拒绝」这一档；
 *     真实「拒绝」只有用户在浏览器里点过「阻止」才会出现，用桩才能稳定复现。
 *
 * 注意：addInitScript 的函数体被序列化后在页面上下文里跑，不能引用模块外变量（所以要传 arg）。
 */
import type { BrowserContext, Page } from '@playwright/test';

/** 浏览器权限状态（与 Permissions API 的 PermissionState 同值） */
export type MediaPermissionState = 'granted' | 'denied' | 'prompt';

export const E2E_CAMERA_LABEL = 'E2E 摄像头';
export const E2E_CAMERA_LABEL_2 = 'E2E 备用摄像头';
export const E2E_MIC_LABEL = 'E2E 麦克风';

export interface MediaMockOptions {
  /** 麦克风静音（D7 用例）；默认 false = 有 440Hz 声音 */
  silentAudio?: boolean;
  /** 画面像素：'dynamic'（默认，交替色块，非黑）/ 'black'（全黑，D9 用例） */
  videoPixel?: 'dynamic' | 'black';
  /**
   * D41：摄像头/麦克风权限状态（默认 `'granted'`）。
   * `'denied'` → `getUserMedia` 立即 reject `NotAllowedError`（D41 ② 的前提）；
   * `'prompt'` → 仍能取到流（按钮点击是用户手势，可以正常弹授权框）。
   */
  permission?: MediaPermissionState;
}

export async function installMediaMocks(
  page: Page,
  options: MediaMockOptions = {},
): Promise<void> {
  const initOptions = {
    silentAudio: options.silentAudio === true,
    videoPixel: options.videoPixel ?? 'dynamic',
    permission: options.permission ?? 'granted',
  };

  await page.addInitScript(/* js */ (opts: {
    silentAudio: boolean;
    videoPixel: string;
    permission: string;
  }) => {
    const w = window as any;
    const nav = w.navigator as any;

    /**
     * D41：权限状态的唯一真相（页面内可变）。
     * `setMediaPermission()` 改的就是它，`permissions.query` 与 `getUserMedia` 都现读。
     */
    const mediaState = { permission: opts.permission };
    (w as any).__E2E_MEDIA_STATE__ = mediaState;

    /** 权限名 → 状态：camera / microphone 跟随桩，其余一律 granted（不让别的能力误判） */
    function permissionStateOf(name: unknown): string {
      if (name === 'camera' || name === 'microphone') return mediaState.permission;
      return 'granted';
    }

    // Permissions API 的桩：现有代码 / D41 实现都可能用 permissions.query 判断「会不会再弹框」
    const permissionStub = {
      query: async (descriptor: any) => ({
        state: permissionStateOf(descriptor?.name),
        name: typeof descriptor?.name === 'string' ? descriptor.name : 'unknown',
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    try {
      Object.defineProperty(nav, 'permissions', { configurable: true, value: permissionStub });
    } catch {
      // 极端情况下 navigator 不可改：直接放弃打桩（用例会因拿不到 denied 而红，不会静默错判）
      try {
        if (nav.permissions) nav.permissions.query = permissionStub.query;
      } catch {
        // ignore
      }
    }

    /** getUserMedia 在 denied 下的规范行为：立即 reject，浏览器不会再弹授权框 */
    function deniedError(): any {
      const message = 'Permission denied';
      if (typeof w.DOMException === 'function') return new w.DOMException(message, 'NotAllowedError');
      const error = new Error(message);
      error.name = 'NotAllowedError';
      return error;
    }

    const devices = [
      {
        deviceId: 'e2e-cam-1',
        groupId: 'e2e-group',
        kind: 'videoinput',
        label: 'E2E 摄像头',
      },
      {
        deviceId: 'e2e-cam-2',
        groupId: 'e2e-group',
        kind: 'videoinput',
        label: 'E2E 备用摄像头',
      },
      {
        deviceId: 'e2e-mic-1',
        groupId: 'e2e-group',
        kind: 'audioinput',
        label: 'E2E 麦克风',
      },
    ];

    let cachedStream: any = null;

    function buildVideoTrack(stream: any) {
      const doc = w.document;
      const canvas = doc.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const timer = w.setInterval(() => {
        if (!ctx) return;
        frame += 1;
        if (opts.videoPixel === 'black') {
          // 纯黑：#000000 → 平均亮度 0（远低于 8/255，D9 必命中）
          ctx.fillStyle = '#000000';
        } else {
          // 交替色块：#123456 亮度约 46、#654321 约 73，都远离黑屏阈值
          ctx.fillStyle = frame % 2 ? '#123456' : '#654321';
        }
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }, 100);
      const canvasStream = canvas.captureStream(10);
      canvasStream.getVideoTracks().forEach((track: any) => {
        track.addEventListener('ended', () => w.clearInterval(timer));
        stream.addTrack(track);
      });
    }

    function buildAudioTrack(stream: any) {
      try {
        const AudioCtor = w.AudioContext || w.webkitAudioContext;
        if (!AudioCtor) return;
        const ac = new AudioCtor();
        const destination = ac.createMediaStreamDestination();
        const oscillator = ac.createOscillator();
        oscillator.frequency.value = 440;

        if (opts.silentAudio) {
          // 真静音：信号被 gain=0 掐掉，但音轨仍在出帧（D7 要的正是「有轨道、没声音」）
          const gain = ac.createGain ? ac.createGain() : null;
          if (gain) {
            gain.gain.value = 0;
            oscillator.connect(gain);
            gain.connect(destination);
          } else {
            destination.connect(oscillator);
          }
        } else {
          oscillator.connect(destination);
        }

        oscillator.start();
        destination.stream.getAudioTracks().forEach((track: any) => stream.addTrack(track));
      } catch (error) {
        // 造不出音轨不影响推流画面测试
      }
    }

    function buildStream(constraints: any) {
      const stream = new w.MediaStream();
      if (constraints?.video) buildVideoTrack(stream);
      if (constraints?.audio) buildAudioTrack(stream);
      return stream;
    }

    const mediaDevices = nav.mediaDevices ?? {};
    if (!nav.mediaDevices) {
      // 严格模式下直接赋值给只读 getter 会抛错，用 defineProperty 更安全
      Object.defineProperty(nav, 'mediaDevices', { configurable: true, value: mediaDevices });
    }
    mediaDevices.enumerateDevices = async () => devices.map((device) => ({ ...device }));
    mediaDevices.getUserMedia = async (constraints: any) => {
      cachedStream = buildStream(constraints);
      return cachedStream;
    };
    mediaDevices.getDisplayMedia = async () => {
      const error = new Error('getDisplayMedia is not supported in this build');
      (error as any).name = 'NotSupportedError';
      throw error;
    };
    if (typeof mediaDevices.addEventListener !== 'function') {
      mediaDevices.addEventListener = () => undefined;
      mediaDevices.removeEventListener = () => undefined;
    }

    // 方便测试排查：记录被请求的约束（24060：「换麦克风」要断言真的重新请求过设备）
    (w as any).__E2E_MEDIA_CALLS__ = [];
    (w as any).__E2E_MEDIA_OPTIONS__ = opts;

    // getUserMedia 的桩：先记录约束，再按当前权限状态决定「给流」还是「立即 reject」
    const originalGetUserMedia = mediaDevices.getUserMedia;
    mediaDevices.getUserMedia = async (constraints: any) => {
      (w as any).__E2E_MEDIA_CALLS__.push(constraints ?? {});
      if (mediaState.permission === 'denied') throw deniedError();
      return originalGetUserMedia(constraints);
    };
  }, initOptions);
}

/** 读「被请求过的 getUserMedia 约束」列表（24060：换设备 / 换麦克风必须真的重新请求） */
export async function readMediaCalls(page: Page): Promise<unknown[]> {
  return page.evaluate(() => ((window as any).__E2E_MEDIA_CALLS__ ?? []) as unknown[]);
}

/**
 * D41：运行中改摄像头/麦克风权限状态（`'denied'` = 用户在浏览器里点了「阻止」，或系统收回了权限）。
 *
 * 配合 `context.clearPermissions()` 一起用更真实（Playwright 侧也把授权记录清掉），
 * 但**判定以本桩为准**：Playwright 清权限只会回到 `prompt`，拿不到 `denied`。
 */
export async function setMediaPermission(page: Page, permission: MediaPermissionState): Promise<void> {
  await page.evaluate((next) => {
    const state = (window as any).__E2E_MEDIA_STATE__;
    if (state) state.permission = next;
  }, permission);
}

/** 读当前桩里的权限状态（断言「修复动作没有偷偷把权限改回去」用） */
export async function readMediaPermission(page: Page): Promise<MediaPermissionState | null> {
  return page.evaluate(() => ((window as any).__E2E_MEDIA_STATE__?.permission ?? null) as
    | MediaPermissionState
    | null);
}

/**
 * D41：把浏览器侧摄像头/麦克风权限「撤掉」。
 *
 * ⚠ Chromium 里 `clearPermissions()` 只把状态清回 `prompt`（不是 `denied`），而 Playwright 也没有
 * 「拒绝」这一档；真正的 `denied` 只能靠本文件的 `permissions.query` 桩表达。
 * 所以这里只做「浏览器侧也跟着清」，**判定用 `setMediaPermission(page, 'denied')`**。
 */
export async function revokeBrowserPermissions(context: BrowserContext): Promise<void> {
  await context.clearPermissions();
}

/** D41：把浏览器侧摄像头/麦克风权限重新授予（模拟讲师在地址栏点「允许」后回来） */
export async function grantBrowserPermissions(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['camera', 'microphone']);
}
