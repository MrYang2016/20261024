import type { DeviceSnapshot } from '@live1024/shared';

/**
 * 会话设备快照（D36，回应国开客户函「设备配置接口」）。
 *
 * 一条铁律：**取不到一律 `null`，不编造**。
 * 浏览器出于隐私保护会挡掉一部分信息（`navigator.deviceMemory` 只有 Chromium 有、
 * WebGL 渲染器可能被指纹保护屏蔽），这时说「未知」比猜一个配置有用——客户拿着假配置去找原因只会更慢。
 *
 * 纯读取，不改任何全局状态；任何异常（WebGL 不可用、UA 解析失败）都退化成 `null`。
 */
export function collectDeviceSnapshot(): DeviceSnapshot {
  return {
    ua: readUa(),
    os: parseOs(readUa()),
    cpuCores: readCpuCores(),
    deviceMemoryGb: readDeviceMemory(),
    gpuRenderer: readGpuRenderer(),
    screen: readScreen(),
  };
}

function readUa(): string | null {
  try {
    const ua = globalThis.navigator?.userAgent;
    return typeof ua === 'string' && ua.trim() ? ua.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从 UA 解析系统（只做「够用」的粗粒度判断，不做完整 UA 解析库）：
 * `macOS 15.3` / `Windows 10/11` / `Android 14` / `iOS 18.1` / `ChromeOS` / `Linux`。
 * 认不出来就 `null`。
 */
export function parseOs(ua: string | null): string | null {
  if (!ua) return null;

  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  if (mac) return `macOS ${mac[1]}.${mac[2]}`;

  // Windows NT 10.0 同时对应 Win10 / Win11（UA 已冻结），不硬猜具体版本
  if (/Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/Windows/.test(ua)) return 'Windows';

  const ios = /(?:iPhone|iPad).*?OS (\d+)[._](\d+)/.exec(ua);
  if (ios) return `iOS ${ios[1]}.${ios[2]}`;

  const android = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (android) return `Android ${android[1]}`;

  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

function readCpuCores(): number | null {
  const value = globalThis.navigator?.hardwareConcurrency;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** `navigator.deviceMemory`（GB，Chromium 独有，且被粗化成 0.5/1/2/4/8） */
function readDeviceMemory(): number | null {
  const value = (globalThis.navigator as Navigator & { deviceMemory?: unknown })?.deviceMemory;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** WebGL 渲染器：拿不到（无 WebGL / 无调试扩展 / 被指纹保护屏蔽）就是 null */
function readGpuRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return null;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    if (!extension) return null;
    const renderer = gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
    return typeof renderer === 'string' && renderer.trim() ? renderer.trim() : null;
  } catch {
    return null;
  }
}

/** 屏幕：`宽×高@dpr`（例：`1728×1117@2`） */
function readScreen(): string | null {
  try {
    const screenLike = globalThis.screen;
    const width = screenLike?.width;
    const height = screenLike?.height;
    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      return null;
    }
    const ratio = globalThis.devicePixelRatio;
    const dpr =
      typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0
        ? Number.isInteger(ratio)
          ? String(ratio)
          : ratio.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
        : null;
    return dpr ? `${width}×${height}@${dpr}` : `${width}×${height}`;
  } catch {
    return null;
  }
}
