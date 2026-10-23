/**
 * 验收契约来源：docs/execution-plan.md §十一 C 段 + CONTEXT.md D36
 *   - `apps/pusher/src/diagnostics/device-snapshot.ts`（新增）`collectDeviceSnapshot()`：
 *     `ua`、`os`（从 UA 解析）、`cpuCores`（`navigator.hardwareConcurrency`）、
 *     `deviceMemoryGb`（`navigator.deviceMemory`，缺失 `null`）、
 *     `gpuRenderer`（WebGL `UNMASKED_RENDERER_WEBGL`，失败 `null`）、
 *     `screen`（`width×height@dpr`）；**取不到一律 `null`，不编造**
 *   - §「十一补 Done when」第 14 条：`device-snapshot.spec.ts`（缺失字段为 `null`，不编造）
 *   - 用途（客户函第③条「设备配置接口」）：报障时能说清是哪台机器什么配置
 *
 * 断言口径：
 *   1. `os` 只锁「能识别出平台」（例：macOS UA → 含 `macOS`），不锁版本号格式（计划没规定）。
 *   2. `screen` 锁格式 `width×height@dpr`（× 是 U+00D7，与计划 / 契约 JSON 一致）。
 *   3. 「不编造」= 浏览器没给的字段只能是 `null`，**不能**出现 4 核 / 8GB 之类的兜底常量。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as deviceModule from './device-snapshot';

const CHROME_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const CHROME_WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Safari/537.36';

interface DeviceSnapshot {
  ua: string | null;
  os: string | null;
  cpuCores: number | null;
  deviceMemoryGb: number | null;
  gpuRenderer: string | null;
  screen: string | null;
}

type AnyFn = (...args: unknown[]) => unknown;

function resolveCollector(): AnyFn {
  const bag = deviceModule as unknown as Record<string, unknown>;
  for (const name of ['collectDeviceSnapshot', 'collectDeviceInfo', 'readDeviceSnapshot']) {
    const candidate = bag[name];
    if (typeof candidate === 'function') return candidate as AnyFn;
  }
  throw new Error(
    'apps/pusher/src/diagnostics/device-snapshot.ts 需导出 collectDeviceSnapshot()',
  );
}

/** 采集一次快照（实现同步 / 异步都接受：WebGL 读取是同步的，但可能被包成 async） */
async function collect(): Promise<DeviceSnapshot> {
  return (await resolveCollector()()) as DeviceSnapshot;
}

/** 覆盖属性的还原动作（jsdom 里这些属性多是自有属性，delete 会把平台实现删掉，必须存原值还原） */
const restorers: Array<() => void> = [];

function define(target: object, key: string, value: unknown): void {
  const bag = target as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(bag, key);
  const original = bag[key];
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restorers.push(() => {
    if (hadOwn) Object.defineProperty(target, key, { value: original, configurable: true, writable: true });
    else delete bag[key];
  });
}

/** 让 WebGL 返回指定 renderer（或 null / 抛错） */
function stubWebgl(mode: { renderer: string } | { throw: string } | 'unavailable'): void {
  const original = HTMLCanvasElement.prototype.getContext;
  const fake = function getContext(this: HTMLCanvasElement, type: string) {
    if (type !== 'webgl' && type !== 'experimental-webgl' && type !== 'webgl2') {
      return original.call(this, type as never);
    }
    if (mode === 'unavailable') return null;
    if ('throw' in mode) throw new Error(mode.throw);
    const rendererValue = mode.renderer;
    return {
      // 真实浏览器要这个扩展才能拿到未打码的 GPU 名
      getExtension: (name: string) =>
        name === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 }
          : null,
      getParameter: (parameter: number) => (parameter === 0x9246 ? rendererValue : null),
    } as unknown as WebGLRenderingContext;
  };
  HTMLCanvasElement.prototype.getContext = fake as unknown as typeof original;
  restorers.push(() => {
    HTMLCanvasElement.prototype.getContext = original;
  });
}

function stubScreen(width: number, height: number, dpr: number): void {
  define(window.screen, 'width', width);
  define(window.screen, 'height', height);
  define(window, 'devicePixelRatio', dpr);
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

describe('collectDeviceSnapshot — 正常取到全部字段（D36）', () => {
  it('ua / os / cpuCores / deviceMemoryGb / gpuRenderer / screen 都按真实来源取值', async () => {
    define(navigator, 'userAgent', CHROME_MAC_UA);
    define(navigator, 'hardwareConcurrency', 8);
    define(navigator, 'deviceMemory', 16);
    stubScreen(1728, 1117, 2);
    stubWebgl({ renderer: 'Apple M2' });

    const snapshot = await collect();

    expect(snapshot.ua, 'ua 必须原样取 navigator.userAgent').toBe(CHROME_MAC_UA);
    expect(snapshot.os, 'os 必须从 UA 解析出平台（macOS UA）').toMatch(/macos/i);
    expect(snapshot.cpuCores, 'cpuCores 取 navigator.hardwareConcurrency').toBe(8);
    expect(snapshot.deviceMemoryGb, 'deviceMemoryGb 取 navigator.deviceMemory（单位 GB）').toBe(16);
    expect(snapshot.gpuRenderer, 'gpuRenderer 取 WebGL UNMASKED_RENDERER_WEBGL').toBe('Apple M2');
    expect(
      snapshot.screen,
      'screen 格式必须是 width×height@dpr（× 是 U+00D7，与契约 JSON 一致）',
    ).toBe('1728×1117@2');
  });

  it('Windows UA 也能解析出平台（不是只会认 macOS）', async () => {
    define(navigator, 'userAgent', CHROME_WINDOWS_UA);
    define(navigator, 'hardwareConcurrency', 12);
    define(navigator, 'deviceMemory', 8);
    stubScreen(1920, 1080, 1);
    stubWebgl({ renderer: 'ANGLE (NVIDIA GeForce RTX 3060)' });

    const snapshot = await collect();

    expect(snapshot.os, 'Windows UA 必须解析出 Windows').toMatch(/windows/i);
    expect(snapshot.cpuCores).toBe(12);
    expect(snapshot.deviceMemoryGb).toBe(8);
    expect(snapshot.screen).toBe('1920×1080@1');
  });
});

describe('collectDeviceSnapshot — 取不到的字段一律 null，不编造（D36）', () => {
  it('navigator.deviceMemory 缺失 → deviceMemoryGb === null', async () => {
    define(navigator, 'userAgent', CHROME_MAC_UA);
    define(navigator, 'hardwareConcurrency', 8);
    // deviceMemory 在 Safari / Firefox 上不存在：不删掉原型上的 undefined 也读不到值
    define(navigator, 'deviceMemory', undefined);
    stubScreen(1728, 1117, 2);
    stubWebgl({ renderer: 'Apple M2' });

    const snapshot = await collect();

    expect(
      snapshot.deviceMemoryGb,
      '浏览器没给内存信息就必须是 null——不能编一个 8 / 16 出来',
    ).toBeNull();
    expect(snapshot.cpuCores, '其它字段不受影响').toBe(8);
  });

  it('navigator.hardwareConcurrency 缺失 → cpuCores === null', async () => {
    define(navigator, 'userAgent', CHROME_MAC_UA);
    define(navigator, 'hardwareConcurrency', undefined);
    define(navigator, 'deviceMemory', 16);
    stubScreen(1728, 1117, 2);
    stubWebgl({ renderer: 'Apple M2' });

    const snapshot = await collect();

    expect(
      snapshot.cpuCores,
      '拿不到核数就必须 null（编 4 核是最常见的假数据）',
    ).toBeNull();
    expect(snapshot.deviceMemoryGb).toBe(16);
  });

  it('WebGL 不可用（getContext 返回 null）→ gpuRenderer === null，其它字段照常', async () => {
    define(navigator, 'userAgent', CHROME_MAC_UA);
    define(navigator, 'hardwareConcurrency', 8);
    define(navigator, 'deviceMemory', 16);
    stubScreen(1728, 1117, 2);
    stubWebgl('unavailable');

    const snapshot = await collect();

    expect(snapshot.gpuRenderer, '读不到 GPU 名就是 null，不能编 "Unknown" / "WebGL"').toBeNull();
    expect(snapshot.cpuCores).toBe(8);
    expect(snapshot.deviceMemoryGb).toBe(16);
  });

  it('WebGL 抛错（隐私模式 / 被策略禁用）→ gpuRenderer === null，且整个快照不崩', async () => {
    define(navigator, 'userAgent', CHROME_MAC_UA);
    define(navigator, 'hardwareConcurrency', 8);
    define(navigator, 'deviceMemory', 16);
    stubScreen(1728, 1117, 2);
    stubWebgl({ throw: 'WebGL is blocked by policy' });

    const snapshot = await collect();

    expect(snapshot.gpuRenderer).toBeNull();
    expect(snapshot.ua, 'WebGL 失败不能影响其它字段').toBe(CHROME_MAC_UA);
    expect(snapshot.screen).toBe('1728×1117@2');
  });

  it('UA 解析不出平台 → os === null（不猜一个平台出来）', async () => {
    define(navigator, 'userAgent', 'MysteryAgent/1.0');
    define(navigator, 'hardwareConcurrency', 8);
    define(navigator, 'deviceMemory', 16);
    stubScreen(1728, 1117, 2);
    stubWebgl({ renderer: 'Apple M2' });

    const snapshot = await collect();

    expect(snapshot.os, '认不出的 UA 只能给 null').toBeNull();
    expect(snapshot.ua).toBe('MysteryAgent/1.0');
  });

  it('每个字段都只能是「真实值」或 null（不允许出现任何兜底常量）', async () => {
    define(navigator, 'userAgent', CHROME_MAC_UA);
    define(navigator, 'hardwareConcurrency', undefined);
    define(navigator, 'deviceMemory', undefined);
    stubScreen(1728, 1117, 2);
    stubWebgl('unavailable');

    const snapshot = await collect();

    for (const [field, value] of Object.entries(snapshot)) {
      expect(
        value === null || typeof value === 'string' || typeof value === 'number',
        `${field} 只能是具体值或 null`,
      ).toBe(true);
    }
    expect(snapshot.cpuCores).toBeNull();
    expect(snapshot.deviceMemoryGb).toBeNull();
    expect(snapshot.gpuRenderer).toBeNull();
    expect(snapshot.ua, 'ua 是有值的（浏览器一定有）').toBe(CHROME_MAC_UA);
  });
});
