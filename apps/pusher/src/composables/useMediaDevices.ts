import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import { mapPushError, type PushErrorInfo } from '../lib/errors';
import { readCaptureSettings, type CaptureSettings } from '../transports/encoding';

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

const CAMERA_STORAGE_KEY = 'live1024.pusher.cameraId';
const MICROPHONE_STORAGE_KEY = 'live1024.pusher.microphoneId';

export interface UseMediaDevicesResult {
  cameras: Ref<MediaDeviceOption[]>;
  microphones: Ref<MediaDeviceOption[]>;
  cameraId: Ref<string>;
  microphoneId: Ref<string>;
  stream: Ref<MediaStream | null>;
  /** 当前采集轨道的实测分辨率/帧率（getSettings），没流时为 null（D18） */
  captureSettings: Ref<CaptureSettings | null>;
  /** 麦克风电平 0-100，仅用于音量条 */
  level: Ref<number>;
  error: Ref<PushErrorInfo | null>;
  preparing: Ref<boolean>;
  refreshDevices: () => Promise<void>;
  ensureStream: () => Promise<MediaStream>;
  applySelection: (next: { cameraId?: string; microphoneId?: string }) => Promise<void>;
  /** 降一档采集分辨率并重建流（D22：一键修复两次失败后的降级手段） */
  downgradeResolution: () => Promise<void>;
  stopStream: () => void;
}

/**
 * 设备枚举 + 采集 + 麦克风电平。
 * 同一份 MediaStream 既喂 <video> 预览又喂推流；切设备只重建这一份流。
 */
export function useMediaDevices(): UseMediaDevicesResult {
  const cameras = ref<MediaDeviceOption[]>([]);
  const microphones = ref<MediaDeviceOption[]>([]);
  const cameraId = ref<string>(readStoredId(CAMERA_STORAGE_KEY));
  const microphoneId = ref<string>(readStoredId(MICROPHONE_STORAGE_KEY));
  const stream = shallowRef<MediaStream | null>(null);
  const captureSettings = ref<CaptureSettings | null>(null);
  const level = ref(0);
  const error = ref<PushErrorInfo | null>(null);
  const preparing = ref(false);
  /** 主动降级时用的采集上界（D22：降低分辨率重推）；null = 不限制，由设备给最优档 */
  const maxResolution = ref<{ width: number; height: number } | null>(null);

  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let levelFrame: number | null = null;

  async function refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      error.value = {
        code: 'media_unsupported',
        message: '当前浏览器不支持采集音视频',
        nextStep: '换用 Chrome 或 Edge 的最新版本打开本页',
        text: '当前浏览器不支持采集音视频，换用 Chrome 或 Edge 的最新版本打开本页',
      };
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      cameras.value = toOptions(devices, 'videoinput', '摄像头');
      microphones.value = toOptions(devices, 'audioinput', '麦克风');
      cameraId.value = keepSelection(cameraId.value, cameras.value);
      microphoneId.value = keepSelection(microphoneId.value, microphones.value);
    } catch (unknownError) {
      error.value = mapPushError(unknownError);
    }
  }

  async function ensureStream(): Promise<MediaStream> {
    const current = stream.value;
    if (current && current.getTracks().some((track) => track.readyState === 'live')) {
      return current;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('浏览器不支持 getUserMedia'), { name: 'NotSupportedError' });
    }

    preparing.value = true;
    try {
      const video: MediaTrackConstraints | true = {
        ...(cameraId.value ? { deviceId: { exact: cameraId.value } } : {}),
        ...(maxResolution.value
          ? {
              width: { ideal: maxResolution.value.width },
              height: { ideal: maxResolution.value.height },
            }
          : {}),
      };
      const next = await navigator.mediaDevices.getUserMedia({
        video,
        audio: microphoneId.value ? { deviceId: { exact: microphoneId.value } } : true,
      });
      stopStream();
      stream.value = next;
      // 编码参数与指标条「画面」的取值都以实际采集为准，不用固定 1280×720（D18）
      captureSettings.value = readCaptureSettings(next);
      error.value = null;
      // 授权后设备标签才可读，这里再刷一次列表
      await refreshDevices();
      startLevelMeter(next);
      return next;
    } catch (unknownError) {
      error.value = mapPushError(unknownError);
      throw unknownError;
    } finally {
      preparing.value = false;
    }
  }

  async function applySelection(next: { cameraId?: string; microphoneId?: string }): Promise<void> {
    const cameraChanged = next.cameraId !== undefined && next.cameraId !== cameraId.value;
    const microphoneChanged = next.microphoneId !== undefined && next.microphoneId !== microphoneId.value;
    if (!cameraChanged && !microphoneChanged) return;

    if (next.cameraId !== undefined) {
      cameraId.value = next.cameraId;
      storeId(CAMERA_STORAGE_KEY, next.cameraId);
    }
    if (next.microphoneId !== undefined) {
      microphoneId.value = next.microphoneId;
      storeId(MICROPHONE_STORAGE_KEY, next.microphoneId);
    }

    // 先停旧轨道再建新流，避免设备被自己占用
    stopStream();
    try {
      await ensureStream();
    } catch {
      // 错误已在 ensureStream 内映射
    }
  }

  async function downgradeResolution(): Promise<void> {
    // 按当前实测分辨率减半，最低 320×180：再低就没有推流意义了
    const width = Math.max(320, Math.round((captureSettings.value?.width ?? 1280) / 2));
    const height = Math.max(180, Math.round((captureSettings.value?.height ?? 720) / 2));
    maxResolution.value = { width, height };
    stopStream();
    await ensureStream();
  }

  function stopStream(): void {
    stopLevelMeter();
    captureSettings.value = null;
    if (stream.value) {
      for (const track of stream.value.getTracks()) track.stop();
      stream.value = null;
    }
    level.value = 0;
  }

  function startLevelMeter(mediaStream: MediaStream): void {
    const AudioContextCtor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    stopLevelMeter();
    try {
      audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(mediaStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyser) return;
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / buffer.length);
        level.value = Math.min(100, Math.round(rms * 220));
        levelFrame = requestAnimationFrame(tick);
      };
      levelFrame = requestAnimationFrame(tick);
    } catch {
      // 电平条是辅助信息，拿不到就不展示动画，不影响推流
      stopLevelMeter();
    }
  }

  function stopLevelMeter(): void {
    if (levelFrame !== null) {
      cancelAnimationFrame(levelFrame);
      levelFrame = null;
    }
    analyser = null;
    if (audioContext) {
      void audioContext.close().catch(() => undefined);
      audioContext = null;
    }
    level.value = 0;
  }

  const onDeviceChange = (): void => {
    void refreshDevices();
  };

  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  }

  onBeforeUnmount(() => {
    stopStream();
    navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
  });

  return {
    cameras,
    microphones,
    cameraId,
    microphoneId,
    stream,
    captureSettings,
    level,
    error,
    preparing,
    refreshDevices,
    ensureStream,
    applySelection,
    downgradeResolution,
    stopStream,
  };
}

function toOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallbackLabel: string): MediaDeviceOption[] {
  return devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `${fallbackLabel} ${index + 1}`,
    }));
}

function keepSelection(current: string, options: MediaDeviceOption[]): string {
  if (current && options.some((option) => option.deviceId === current)) return current;
  return options[0]?.deviceId ?? '';
}

function readStoredId(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function storeId(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // 隐私模式下 localStorage 不可写，忽略即可
  }
}
