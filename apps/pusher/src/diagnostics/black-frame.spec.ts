/**
 * 验收契约来源：docs/execution-plan.md
 *   - §三 D9：canvas 采样平均亮度，黑屏连续 3 秒（亮度 < 8/255）；恢复条件 = 出现非黑帧
 *   - §五 5.3：`src/diagnostics/black-frame.ts` → `createBlackFrameDetector(video, canvas)`：
 *     每 500ms 采样平均亮度，返回 `{ averageLuma, sampledAt, stop() }`
 *
 * 说明（为什么这样测）：jsdom 没有真的 `HTMLVideoElement` 画面、也没有 canvas 2D 实现，
 * 所以这里给检测器一对**受控的假 video / 假 canvas**：
 *   - 假 canvas 的 `getContext('2d').getImageData()` 返回「全画面同一种颜色」的像素数据，
 *     颜色由测试随时改（0 = 纯黑，128 = 中灰，255 = 纯白）；
 *   - 颜色取 r=g=b，任何亮度公式（Rec.601 加权 / 三通道均值）结果都一样，所以断言不绑定实现公式。
 * 采集端到底能不能采到黑帧这一层（真 video 元素 / 真 canvas）由 e2e
 * `e2e/diagnostics.spec.ts` 的 D9 用例覆盖（那里用「全黑画布」的假摄像头）。
 *
 * 阈值（3 秒 / 8/255）不在这里测：它属于 `rules.ts`，见 `rules.spec.ts` 的 D9 用例。
 * 本文件只测「亮度算得对、按 500ms 刷新、stop() 之后不再采」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as blackFrameModule from './black-frame';
import { createBlackFrameDetector } from './black-frame';

interface FakeDom {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  setColor: (value: number) => void;
  setReady: (ready: boolean) => void;
  drawCalls: () => number;
  imageDataCalls: () => number;
}

/** 造一对假 video / canvas：画面颜色可控、可随时「拔掉摄像头」 */
function makeFakeDom(initialColor = 0): FakeDom {
  let color = initialColor;
  let ready = true;
  let drawCalls = 0;
  let imageDataCalls = 0;

  const video = {
    get videoWidth() {
      return ready ? 320 : 0;
    },
    get videoHeight() {
      return ready ? 180 : 0;
    },
    get readyState() {
      return ready ? 4 : 0;
    },
    paused: false,
    currentTime: 0,
    srcObject: null,
  } as unknown as HTMLVideoElement;

  const context = {
    drawImage: () => {
      drawCalls += 1;
    },
    getImageData: (_sx: number, _sy: number, width: number, height: number) => {
      imageDataCalls += 1;
      const pixels = Math.max(1, Math.floor(width) * Math.floor(height));
      const data = new Uint8ClampedArray(pixels * 4);
      for (let index = 0; index < pixels; index += 1) {
        data[index * 4] = color;
        data[index * 4 + 1] = color;
        data[index * 4 + 2] = color;
        data[index * 4 + 3] = 255;
      }
      return { data, width, height, colorSpace: 'srgb' } as unknown as ImageData;
    },
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: (type: string) => (type === '2d' ? context : null),
  } as unknown as HTMLCanvasElement;

  return {
    video,
    canvas,
    setColor: (value: number) => {
      color = value;
    },
    setReady: (next: boolean) => {
      ready = next;
    },
    drawCalls: () => drawCalls,
    imageDataCalls: () => imageDataCalls,
  };
}

/** 检测器返回值可能是裸数值，也可能是 Vue ref（`.value`），两种都读 */
function readNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === 'number') return inner;
  }
  return Number.NaN;
}

const readLuma = (detector: { averageLuma: unknown }) => readNumber(detector.averageLuma);
const readSampledAt = (detector: { sampledAt: unknown }) => readNumber(detector.sampledAt);

/** 真实时间轮询（采样周期 500ms，给 2s 余量；假时钟对 requestAnimationFrame 不一定生效） */
async function waitForLuma(
  detector: { averageLuma: unknown },
  predicate: (luma: number) => boolean,
  timeoutMs = 2_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = readLuma(detector);
  while (Date.now() < deadline) {
    last = readLuma(detector);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createBlackFrameDetector — 平均亮度（D9 的判定输入）', () => {
  it('纯黑画面 → averageLuma ≈ 0（< 8/255 的判定阈值）', async () => {
    const dom = makeFakeDom(0);
    const detector = createBlackFrameDetector(dom.video, dom.canvas);

    try {
      const luma = await waitForLuma(detector, (value) => Number.isFinite(value));

      expect(Number.isNaN(luma), 'averageLuma 不能是 NaN').toBe(false);
      expect(luma, `纯黑画面 averageLuma 应接近 0，实测 ${luma}`).toBeLessThan(8);
      expect(luma).toBeGreaterThanOrEqual(0);
      expect(readSampledAt(detector), '采样后必须给出 sampledAt 时刻').toBeGreaterThan(0);
      expect(dom.drawCalls(), '必须把视频帧画到 canvas 上再采样').toBeGreaterThan(0);
    } finally {
      detector.stop();
    }
  });

  it('中灰画面 → averageLuma ≈ 128（非黑帧，D9 必须撤销）', async () => {
    const dom = makeFakeDom(128);
    const detector = createBlackFrameDetector(dom.video, dom.canvas);

    try {
      const luma = await waitForLuma(detector, (value) => value >= 120);

      expect(luma).toBeGreaterThan(120);
      expect(luma).toBeLessThan(136);
    } finally {
      detector.stop();
    }
  });

  it('纯白画面 → averageLuma ≈ 255', async () => {
    const dom = makeFakeDom(255);
    const detector = createBlackFrameDetector(dom.video, dom.canvas);

    try {
      const luma = await waitForLuma(detector, (value) => value > 240);

      expect(luma).toBeGreaterThan(240);
      expect(luma).toBeLessThanOrEqual(255);
    } finally {
      detector.stop();
    }
  });

  it('按 500ms 刷新：画面从黑变亮后必须在 1s 内反映出来', async () => {
    const dom = makeFakeDom(0);
    const detector = createBlackFrameDetector(dom.video, dom.canvas);

    try {
      await waitForLuma(detector, (value) => Number.isFinite(value) && value < 8);

      dom.setColor(255);
      const startedAt = Date.now();
      const luma = await waitForLuma(detector, (value) => value > 240, 1_500);

      expect(luma, `画面变亮后 averageLuma 必须重算，实测 ${luma}`).toBeGreaterThan(240);
      expect(
        Date.now() - startedAt,
        '采样周期是 500ms（计划 §五 5.3），1s 内必须刷新',
      ).toBeLessThan(1_000);
    } finally {
      detector.stop();
    }
  });
});

describe('createBlackFrameDetector — 生命周期', () => {
  it('stop() 之后不再采样（画面变化不再影响读数，也不继续画 canvas）', async () => {
    const dom = makeFakeDom(0);
    const detector = createBlackFrameDetector(dom.video, dom.canvas);

    const before = await waitForLuma(detector, (value) => Number.isFinite(value) && value < 8);
    expect(before).toBeLessThan(8);

    detector.stop();
    const drawsAfterStop = dom.drawCalls();
    const lumaAfterStop = readLuma(detector);

    dom.setColor(255);
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(dom.drawCalls(), 'stop() 后不能再画 canvas（否则会一直空转耗电）').toBe(drawsAfterStop);
    expect(readLuma(detector), 'stop() 后读数不能再变').toBe(lumaAfterStop);
  });

  it('视频还没就绪（拿不到尺寸）时不崩、也不编造亮度', async () => {
    const dom = makeFakeDom(0);
    dom.setReady(false);
    const detector = createBlackFrameDetector(dom.video, dom.canvas);

    try {
      await new Promise((resolve) => setTimeout(resolve, 700));

      const luma = readLuma(detector);
      // 没画面时允许 0 / null / NaN 之外的「无读数」表示，但不能报一个像真画面一样的亮度
      const looksLikeRealFrame = Number.isFinite(luma) && luma > 8;
      expect(looksLikeRealFrame, `视频未就绪时不能报出像真画面的亮度，实测 ${luma}`).toBe(false);
    } finally {
      detector.stop();
    }
  });
});

describe('亮度计算（若实现导出了纯函数则一并锁住）', () => {
  const moduleRecord = blackFrameModule as unknown as Record<string, unknown>;

  function resolvePureLuma(): ((pixels: unknown, width?: number, height?: number) => number) | null {
    for (const name of ['averageLumaOf', 'computeAverageLuma', 'averageLuma', 'lumaOf']) {
      const candidate = moduleRecord[name];
      if (typeof candidate === 'function') {
        return candidate as (pixels: unknown, width?: number, height?: number) => number;
      }
    }
    return null;
  }

  function rgba(color: number, count: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(count * 4);
    for (let index = 0; index < count; index += 1) {
      data[index * 4] = color;
      data[index * 4 + 1] = color;
      data[index * 4 + 2] = color;
      data[index * 4 + 3] = 255;
    }
    return data;
  }

  it('黑像素 → 0，白像素 → 255，黑白各半 → 约 127.5', () => {
    const pureLuma = resolvePureLuma();
    if (!pureLuma) {
      // 纯函数是可选的实现细节（计划只要求 createBlackFrameDetector），没导出不算违约
      expect(pureLuma, '未导出纯亮度函数时跳过（行为层已由上面的检测器用例覆盖）').toBeNull();
      return;
    }

    const blackPixels = rgba(0, 16);
    const whitePixels = rgba(255, 16);
    const mixed = new Uint8ClampedArray([...blackPixels, ...whitePixels]);

    const call = (pixels: Uint8ClampedArray, count: number) => {
      // 兼容 (data) / (data, width, height) / ({ data, width, height }) 三种签名
      const direct = pureLuma(pixels, count, 1);
      if (Number.isFinite(direct)) return direct;
      return pureLuma({ data: pixels, width: count, height: 1 });
    };

    expect(call(blackPixels, 16)).toBeLessThan(1);
    expect(call(whitePixels, 16)).toBeGreaterThan(254);
    const mixedLuma = call(mixed, 32);
    expect(mixedLuma).toBeGreaterThan(120);
    expect(mixedLuma).toBeLessThan(136);
  });
});
