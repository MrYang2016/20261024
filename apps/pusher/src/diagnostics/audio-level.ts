/**
 * 麦克风电平表（D7 的判定输入）。
 *
 * `AnalyserNode` 取时域数据算 RMS → dBFS：0 dBFS = 满幅，-60 dBFS ≈ 静音门槛。
 * 每 250ms 采样一次（计划 §五 5.3）：D7 的保持窗口是 8 秒，采样再快也只是白烧 CPU。
 *
 * 两个约定：
 * - `read()` 永远返回**数字**（静音给下限 -100，不返回 NaN / -Infinity）——
 *   NaN 会让所有阈值比较静默失真。
 * - `available` 表示「电平可信」：浏览器把 AudioContext 挂起（没有用户手势）时读到的全是 0，
 *   那不是「麦克风没声音」，所以调用方要按 available 决定是否把它当作 D7 的输入。
 */

/** 静音下限：低于这个值一律按 -100 dBFS 报（不返回 -Infinity） */
const SILENCE_FLOOR_DBFS = -100;
/** 采样周期 250ms */
const SAMPLE_INTERVAL_MS = 250;

export interface AudioMeter {
  /** 最近一次采样的电平（dBFS，-100 ~ 0） */
  read(): number;
  /** 电平是否可信（AudioContext 处于 running；挂起 / 关闭时为 false） */
  readonly available: boolean;
  close(): void;
}

export function createAudioMeter(stream: MediaStream | null): AudioMeter {
  let level = SILENCE_FLOOR_DBFS;
  let available = false;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let buffer: Float32Array<ArrayBuffer> | null = null;

  const tracks = typeof stream?.getAudioTracks === 'function' ? stream.getAudioTracks() : [];

  if (stream && tracks.length > 0) {
    try {
      const ContextCtor =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (ContextCtor) {
        context = new ContextCtor();
        const source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);
        buffer = new Float32Array(analyser.fftSize || 512);
        available = context.state === 'running';
        // 挂起时（自动播放策略）尝试恢复；恢复不了就读不到真电平，交给 available 表达
        if (!available && typeof context.resume === 'function') {
          void context.resume().then(
            () => {
              available = context?.state === 'running';
            },
            () => undefined,
          );
        }
        sample();
        timer = setInterval(sample, SAMPLE_INTERVAL_MS);
      }
    } catch {
      // 拿不到 Web Audio 就没法判 D7：保持不可用，不影响推流本身
      close();
    }
  }

  function sample(): void {
    const node = analyser;
    if (!node || !buffer) return;
    try {
      if (typeof node.getFloatTimeDomainData === 'function') {
        node.getFloatTimeDomainData(buffer);
      } else {
        // 老浏览器只有字节接口：128 为零点，127 为满幅
        const bytes = new Uint8Array(buffer.length);
        node.getByteTimeDomainData(bytes);
        for (let index = 0; index < bytes.length; index += 1) {
          buffer[index] = ((bytes[index] ?? 128) - 128) / 128;
        }
      }
      level = toDbfs(rmsOf(buffer));
      if (context) available = context.state === 'running';
    } catch {
      available = false;
    }
  }

  function close(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    analyser = null;
    buffer = null;
    available = false;
    const active = context;
    context = null;
    if (active) {
      void active.close().catch(() => undefined);
    }
  }

  return {
    read: () => level,
    get available() {
      return available;
    },
    close,
  };
}

/** 均方根（0-1） */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** 线性幅度 → dBFS（0 → 下限，1 → 0 dBFS） */
export function toDbfs(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return SILENCE_FLOOR_DBFS;
  const dbfs = 20 * Math.log10(rms);
  return Math.max(SILENCE_FLOOR_DBFS, Math.min(0, dbfs));
}
