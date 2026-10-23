/**
 * 验收契约来源：docs/execution-plan.md
 *   - §三 D7：音频 `RMS`（dBFS）连续 8 秒 < -60 dBFS；恢复 > -50 dBFS 持续 2 秒
 *   - §五 5.3：`src/diagnostics/audio-level.ts` → `createAudioMeter(stream)`：
 *     `AnalyserNode` 算 RMS → dBFS，每 250ms 采样，返回 `{ read(): number, close(): void }`
 *
 * 说明（为什么这样测）：jsdom 里没有真实的 Web Audio，也没有麦克风，跑不了真 `AnalyserNode`。
 * 所以本文件在 jsdom 里装一套**受控的 AudioContext / AnalyserNode 假实现**：
 *   - 假 analyser 同时实现 `getFloatTimeDomainData` 与 `getByteTimeDomainData`（两种取帧方式都支持，
 *     实现用哪种都行），两者都填同一条已知振幅的方波；
 *   - 方波振幅 = a 时 RMS = a，dBFS = 20·log10(a)，所以期望值可手算：
 *       振幅 1      → 0 dBFS
 *       振幅 0.001  → -60 dBFS
 *       振幅 0.01   → -40 dBFS
 *       振幅 0      → 静音（-Infinity，实现用 -100/-Infinity 之类的下限都接受）
 *   - 电平用真实时间轮询（不用假时钟）：实现用 setInterval 还是 requestAnimationFrame 都能测。
 * 真实链路（真麦克风 → 真 AnalyserNode）由 e2e `e2e/diagnostics.spec.ts` 的 D7 用例覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioMeter } from './audio-level';

/** 受控 AnalyserNode：时域数据是振幅可调的方波（RMS 偏移最小、期望值可手算） */
class FakeAnalyserNode {
  amplitude = 0;
  fftSize = 2048;
  frequencyBinCount = 1024;
  smoothingTimeConstant = 0.8;

  getFloatTimeDomainData(target: Float32Array): void {
    for (let index = 0; index < target.length; index += 1) {
      target[index] = index % 2 === 0 ? this.amplitude : -this.amplitude;
    }
  }

  getByteTimeDomainData(target: Uint8Array): void {
    const offset = Math.round(this.amplitude * 127);
    for (let index = 0; index < target.length; index += 1) {
      target[index] = index % 2 === 0 ? 128 + offset : 128 - offset;
    }
  }

  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 48_000;
  analyser = new FakeAnalyserNode();
  closed = false;

  createAnalyser(): FakeAnalyserNode {
    return this.analyser;
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closed = true;
    this.state = 'closed';
  }
}

const contexts: FakeAudioContext[] = [];

/** 只实现 createAudioMeter 会用到的那几个成员（MediaStream 在 jsdom 里也不完整） */
function fakeStream(): MediaStream {
  const track = { kind: 'audio', label: 'E2E 麦克风', enabled: true, readyState: 'live' };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

function currentAnalyser(): FakeAnalyserNode {
  const context = contexts[contexts.length - 1];
  expect(context, 'createAudioMeter 必须创建一个 AudioContext').toBeTruthy();
  return context.analyser;
}

/** 真实时间轮询读电平（实现按 250ms 采样，这里给 1.5s 余量，但不接受「永远读不到」） */
async function waitForLevel(
  meter: { read: () => number },
  predicate: (level: number) => boolean,
  timeoutMs = 1_500,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = meter.read();
  while (Date.now() < deadline) {
    last = meter.read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

beforeEach(() => {
  contexts.length = 0;

  const AudioContextStub = function AudioContextStub(this: unknown) {
    const context = new FakeAudioContext();
    contexts.push(context);
    return context;
  } as unknown as typeof AudioContext;

  vi.stubGlobal('AudioContext', AudioContextStub);
  vi.stubGlobal('webkitAudioContext', AudioContextStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createAudioMeter — RMS → dBFS（D7 的判定输入）', () => {
  it('全幅信号 → 约 0 dBFS', async () => {
    const meter = createAudioMeter(fakeStream());
    try {
      currentAnalyser().amplitude = 1;
      const level = await waitForLevel(meter, (value) => Math.abs(value) <= 1);

      expect(level).toBeGreaterThan(-1);
      expect(level).toBeLessThanOrEqual(0.5);
    } finally {
      meter.close();
    }
  });

  it('振幅 0.001 → 约 -60 dBFS（D7 的判定阈值本身）', async () => {
    const meter = createAudioMeter(fakeStream());
    try {
      currentAnalyser().amplitude = 0.001;
      const level = await waitForLevel(meter, (value) => value <= -58 && value >= -62);

      expect(level, `实测 ${level} dBFS，期望 ≈ -60 dBFS`).toBeGreaterThan(-62);
      expect(level).toBeLessThan(-58);
    } finally {
      meter.close();
    }
  });

  it('振幅 0.01 → 约 -40 dBFS（D7 的恢复阈值 > -50 一侧）', async () => {
    const meter = createAudioMeter(fakeStream());
    try {
      currentAnalyser().amplitude = 0.01;
      const level = await waitForLevel(meter, (value) => value > -45 && value < -35);

      expect(level).toBeGreaterThan(-45);
      expect(level).toBeLessThan(-35);
    } finally {
      meter.close();
    }
  });

  it('静音 → 极低电平（≤ -90 dBFS，允许 -Infinity 或实现自定的下限）', async () => {
    const meter = createAudioMeter(fakeStream());
    try {
      currentAnalyser().amplitude = 0;
      const level = await waitForLevel(meter, (value) => value <= -90);

      expect(Number.isNaN(level), 'read() 不能返回 NaN（NaN 会让所有阈值比较都失真）').toBe(false);
      expect(level).toBeLessThanOrEqual(-90);
    } finally {
      meter.close();
    }
  });

  it('电平随实测变化（不是启动时算一次就固定）', async () => {
    const meter = createAudioMeter(fakeStream());
    try {
      const analyser = currentAnalyser();

      analyser.amplitude = 0;
      const silent = await waitForLevel(meter, (value) => value <= -90);
      expect(silent).toBeLessThanOrEqual(-90);

      // 有声音进来（≈ -6 dBFS）：必须在采样周期内更新
      analyser.amplitude = 0.5;
      const loud = await waitForLevel(meter, (value) => value > -20);
      expect(loud, `说话后应当读到远高于静音的电平，实测 ${loud} dBFS`).toBeGreaterThan(-20);

      // 再回到静音
      analyser.amplitude = 0;
      const silentAgain = await waitForLevel(meter, (value) => value <= -90);
      expect(silentAgain).toBeLessThanOrEqual(-90);
    } finally {
      meter.close();
    }
  });

  it('采样周期约 250ms（计划 §五 5.3）：500ms 内必须已经刷新过电平', async () => {
    const meter = createAudioMeter(fakeStream());
    try {
      const analyser = currentAnalyser();
      analyser.amplitude = 0;
      await waitForLevel(meter, (value) => value <= -90);

      analyser.amplitude = 1;
      const startedAt = Date.now();
      await waitForLevel(meter, (value) => value > -3, 1_000);

      expect(Date.now() - startedAt, '电平刷新不能慢于 500ms').toBeLessThan(500);
    } finally {
      meter.close();
    }
  });
});

describe('createAudioMeter — 生命周期', () => {
  it('close() 之后不再抛错、并真的关掉 AudioContext（不留悬挂的采样定时器）', async () => {
    const meter = createAudioMeter(fakeStream());
    currentAnalyser().amplitude = 0.001;
    await waitForLevel(meter, (value) => value < -50);

    expect(() => meter.close()).not.toThrow();
    expect(() => meter.read()).not.toThrow();
    expect(contexts[0]?.closed, 'close() 必须关闭 AudioContext').toBe(true);
  });

  it('拿不到音轨时也不抛错（没麦克风是 D7 的判定场景，采集层不能先崩）', () => {
    const emptyStream = {
      getAudioTracks: () => [],
      getTracks: () => [],
      getVideoTracks: () => [],
    } as unknown as MediaStream;

    expect(() => {
      const meter = createAudioMeter(emptyStream);
      meter.read();
      meter.close();
    }).not.toThrow();
  });
});
