/**
 * 黑屏检测（D9 的判定输入）。
 *
 * 每 500ms 把预览画面的当前帧画到一张小 canvas 上（32 像素宽，够用又便宜），
 * 取像素平均亮度（0-255）：< 8/255 连续 3 秒就判「摄像头没有画面」（阈值在 rules.ts，不在这里）。
 *
 * 拿不到画面（视频还没就绪 / 没有尺寸）时**不采样**，读数是 null ——
 * 不能把「还没开始渲染」报成「黑屏」。
 */
const SAMPLE_INTERVAL_MS = 500;
/** 采样画布宽度：只要平均亮度，不需要原分辨率 */
const SAMPLE_WIDTH = 32;

export interface BlackFrameDetector {
  /** 最近一次采样的平均亮度（0-255）；还没有可用样本时为 null */
  readonly averageLuma: number | null;
  /** 最近一次采样的时刻（ms） */
  readonly sampledAt: number | null;
  /** 立即采一帧（创建时已采过一次，这里给需要手动触发的场景） */
  sample(): void;
  stop(): void;
}

export function createBlackFrameDetector(
  video: HTMLVideoElement | null | undefined,
  canvas: HTMLCanvasElement | null | undefined,
  intervalMs = SAMPLE_INTERVAL_MS,
): BlackFrameDetector {
  let averageLuma: number | null = null;
  let sampledAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function sample(): void {
    if (!video || !canvas) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height || video.readyState < 2) return;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    const sampleWidth = Math.min(SAMPLE_WIDTH, width);
    const sampleHeight = Math.max(1, Math.round((height / width) * sampleWidth));
    if (canvas.width !== sampleWidth) canvas.width = sampleWidth;
    if (canvas.height !== sampleHeight) canvas.height = sampleHeight;

    try {
      context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
      const image = context.getImageData(0, 0, sampleWidth, sampleHeight);
      averageLuma = averageLumaOf(image.data);
      sampledAt = Date.now();
    } catch {
      // 跨域画面 / 上下文丢失：保持上一次读数，不编新值
    }
  }

  sample();
  timer = setInterval(sample, intervalMs);

  return {
    get averageLuma() {
      return averageLuma;
    },
    get sampledAt() {
      return sampledAt;
    },
    sample,
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * 像素平均亮度（Rec.601 加权，0-255）。
 * 签名宽容：接受 `ImageData`、RGBA 数组，或 `(data, width, height)`。
 */
export function averageLumaOf(
  pixels: Uint8ClampedArray | Uint8Array | { data: Uint8ClampedArray | Uint8Array },
  _width?: number,
  _height?: number,
): number {
  const data = pixels && 'data' in pixels ? pixels.data : (pixels as Uint8ClampedArray);
  if (!data || data.length < 4) return 0;

  const count = Math.floor(data.length / 4);
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    sum += 0.299 * red + 0.587 * green + 0.114 * blue;
  }
  return sum / count;
}
