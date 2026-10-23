import type { PushEncoding } from './types';

/**
 * 兜底编码参数（D18）：只有读不到采集轨道 getSettings() 时才用它。
 * 分辨率与帧率一律以实际采集为准——固定 720p 会让「编码参数」与真实画面不符。
 */
export const DEFAULT_ENCODING: PushEncoding = {
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 2000,
};

/** 采集轨道的实测设置（来自 MediaStreamTrack.getSettings） */
export interface CaptureSettings {
  width: number;
  height: number;
  /** 轨道未声明帧率时为 null */
  frameRate: number | null;
}

/**
 * 读采集轨道的实际分辨率/帧率。
 * 读不到（无视频轨、浏览器不给、测试替身不是真 MediaStream）时返回 null —— 由调用方决定兜底，
 * 不在这里编一个数字出来。
 */
export function readCaptureSettings(stream: MediaStream | null | undefined): CaptureSettings | null {
  try {
    const tracks = typeof stream?.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
    const track = tracks[0] as MediaStreamTrack | undefined;
    const settings = typeof track?.getSettings === 'function' ? track.getSettings() : undefined;
    const width = positiveOrNull(settings?.width);
    const height = positiveOrNull(settings?.height);
    if (width === null || height === null) return null;
    return { width, height, frameRate: positiveOrNull(settings?.frameRate) };
  } catch {
    return null;
  }
}

/** 采集设置 → 编码参数（码率仍用固定档位，分辨率/帧率跟随实际采集） */
export function toEncoding(settings: CaptureSettings | null): PushEncoding {
  return {
    width: settings?.width ?? DEFAULT_ENCODING.width,
    height: settings?.height ?? DEFAULT_ENCODING.height,
    fps: settings?.frameRate ? Math.round(settings.frameRate) : DEFAULT_ENCODING.fps,
    bitrateKbps: DEFAULT_ENCODING.bitrateKbps,
  };
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
