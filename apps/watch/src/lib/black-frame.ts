/**
 * 观众侧黑屏采样（W3 的判定输入）。
 *
 * 与推流端 `apps/pusher/src/diagnostics/black-frame.ts` 同一思路，但观众侧独立一份：
 * 两个 app 之间不互相 import（各 app 各自可构建），阈值判定在 `useWatchDiagnostics` 的规则里。
 *
 * 把视频当前帧画到一张 32 像素宽的小 canvas 上取平均亮度（0-255，Rec.601 加权）。
 * 拿不到画面（元素还没就绪 / 没有尺寸 / 跨域读不到像素）时返回 null ——
 * 「还没开始渲染」不能被当成「黑屏」。
 */
/** 采样画布宽度：只要平均亮度，不需要原分辨率 */
const SAMPLE_WIDTH = 32;

/**
 * 像素平均亮度（0-255）。
 * 签名宽容：接受 `ImageData`，也接受裸 RGBA 数组。
 */
export function averageLumaOf(
  pixels: Uint8ClampedArray | Uint8Array | { data: Uint8ClampedArray | Uint8Array },
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

/**
 * 采一帧的平均亮度；不可采样时返回 null（不编造读数）。
 * 采样失败（上下文丢失 / 跨域）同样返回 null。
 */
export function sampleAverageLuma(
  video: HTMLVideoElement | null | undefined,
  canvas: HTMLCanvasElement | null | undefined,
): number | null {
  if (!video || !canvas) return null;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height || video.readyState < 2) return null;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  const sampleWidth = Math.min(SAMPLE_WIDTH, width);
  const sampleHeight = Math.max(1, Math.round((height / width) * sampleWidth));
  if (canvas.width !== sampleWidth) canvas.width = sampleWidth;
  if (canvas.height !== sampleHeight) canvas.height = sampleHeight;

  try {
    context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    return averageLumaOf(context.getImageData(0, 0, sampleWidth, sampleHeight));
  } catch {
    return null;
  }
}
