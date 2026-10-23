/**
 * 验收契约来源：CONTEXT.md D18 / 评审 C2 / docs/execution-plan.md Done when 第 11 条前半
 *   「编码参数 = 实际采集分辨率」：`getUserMedia` 拿到轨道后用 `track.getSettings()` 的
 *   实际 width/height/frameRate 作为编码参数，不再固定 1280×720；
 *   读不到时返回 null 交给调用方兜底，**不在这里编一个数字出来**。
 *
 * 纯函数单测（node/jsdom 都能跑，不碰真摄像头）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENCODING, readCaptureSettings, toEncoding } from './encoding';

/** 造一个只暴露 getVideoTracks().getSettings() 的最小 MediaStream 替身 */
function fakeStream(settings: unknown): MediaStream {
  return {
    getVideoTracks: () => [{ getSettings: () => settings }],
  } as unknown as MediaStream;
}

describe('readCaptureSettings — 读实际采集分辨率', () => {
  it('有视频轨且 getSettings 给出尺寸时，原样读出（含帧率）', () => {
    expect(readCaptureSettings(fakeStream({ width: 640, height: 480, frameRate: 24 }))).toEqual({
      width: 640,
      height: 480,
      frameRate: 24,
    });
  });

  it('轨道没声明帧率时 frameRate 为 null（不编 30fps）', () => {
    const settings = readCaptureSettings(fakeStream({ width: 320, height: 180 }));

    expect(settings?.width).toBe(320);
    expect(settings?.height).toBe(180);
    expect(settings?.frameRate).toBeNull();
  });

  it('没有流 / 没有视频轨 / 浏览器不给尺寸 → null（由调用方决定兜底，不编数字）', () => {
    expect(readCaptureSettings(null)).toBeNull();
    expect(readCaptureSettings(undefined)).toBeNull();
    expect(readCaptureSettings({ getVideoTracks: () => [] } as unknown as MediaStream)).toBeNull();
    expect(readCaptureSettings(fakeStream({}))).toBeNull();
    expect(readCaptureSettings(fakeStream({ width: 0, height: 0 }))).toBeNull();
  });
});

describe('toEncoding — 采集设置 → 编码参数', () => {
  it('分辨率/帧率跟随实际采集，码率用固定档', () => {
    const encoding = toEncoding({ width: 640, height: 480, frameRate: 24 });

    expect(encoding.width).toBe(640);
    expect(encoding.height).toBe(480);
    expect(encoding.fps).toBe(24);
    expect(encoding.bitrateKbps).toBe(DEFAULT_ENCODING.bitrateKbps);
  });

  it('帧率是小数时四舍五入（29.97 → 30），缺帧率时回落兜底帧率', () => {
    expect(toEncoding({ width: 640, height: 480, frameRate: 29.97 }).fps).toBe(30);
    expect(toEncoding({ width: 640, height: 480, frameRate: null }).fps).toBe(DEFAULT_ENCODING.fps);
  });

  it('没有采集设置时回落到兜底档（但「画面」仍不得用兜底档冒充实测）', () => {
    const encoding = toEncoding(null);

    expect(encoding.width).toBe(DEFAULT_ENCODING.width);
    expect(encoding.height).toBe(DEFAULT_ENCODING.height);
  });
});
