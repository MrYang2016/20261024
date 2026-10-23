import { createWatchCore, PlayerEvents, type PolyvWatchCore } from '@polyv/live-watch-sdk';
import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import { mapWatchError, type WatchErrorInfo } from '../lib/errors';

export type WatchPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface UseWatchCoreResult {
  phase: Ref<WatchPhase>;
  error: Ref<WatchErrorInfo | null>;
  isPlaying: Ref<boolean>;
  start: (channelId: string, container: HTMLElement) => Promise<void>;
  /** 直播状态切到「直播中」时刷新流，观众不用手动点重连 */
  refreshStream: () => void;
  /** 出错后重新连接 */
  reconnect: () => Promise<void>;
  destroy: () => void;
}

/**
 * 观看页核心：按官方用法 createWatchCore → setup → setupPlayer。
 * 播放器容器由我们自己布局，SDK 只负责逻辑与播放。
 */
export function useWatchCore(): UseWatchCoreResult {
  const phase = ref<WatchPhase>('idle');
  const error = ref<WatchErrorInfo | null>(null);
  const isPlaying = ref(false);
  const core = shallowRef<PolyvWatchCore | null>(null);

  let currentChannelId: string | null = null;
  let container: HTMLElement | null = null;

  async function start(channelId: string, element: HTMLElement): Promise<void> {
    if (currentChannelId === channelId && phase.value === 'ready' && container === element) return;

    destroy();
    currentChannelId = channelId;
    container = element;
    phase.value = 'loading';
    error.value = null;

    try {
      const watchCore = createWatchCore({ channelId });
      core.value = watchCore;

      bindPlayerEvents(watchCore);

      await watchCore.setup();
      await watchCore.player.setupPlayer({ container: element as HTMLDivElement, autoplay: true });

      phase.value = 'ready';
      // 自动播放可能被浏览器拦，尝试播一次；失败交给播放器自带的播放按钮
      try {
        watchCore.player.play();
      } catch {
        // 忽略：用户点播放器按钮即可
      }
    } catch (unknownError) {
      error.value = mapWatchError(unknownError);
      phase.value = 'error';
    }
  }

  function bindPlayerEvents(watchCore: PolyvWatchCore): void {
    watchCore.player.eventEmitter.on(PlayerEvents.PlayerPlaying, () => {
      isPlaying.value = true;
    });
    watchCore.player.eventEmitter.on(PlayerEvents.PlayerPause, () => {
      isPlaying.value = false;
    });
    watchCore.player.eventEmitter.on(PlayerEvents.LivePlayerError, (payload: unknown) => {
      if (phase.value === 'ready') {
        error.value = mapWatchError(toError(payload));
      }
    });
  }

  function refreshStream(): void {
    const watchCore = core.value;
    if (!watchCore) return;
    try {
      watchCore.player.refresh();
    } catch {
      // 不支持刷新时忽略，直播状态切换后 SDK 自己会重试
    }
  }

  async function reconnect(): Promise<void> {
    if (!currentChannelId || !container) return;
    const channelId = currentChannelId;
    const element = container;
    destroy();
    await start(channelId, element);
  }

  function destroy(): void {
    const active = core.value;
    core.value = null;
    isPlaying.value = false;
    if (!active) return;
    try {
      active.destroy();
    } catch {
      // 卸载失败不影响页面，下一次 start 会新建实例
    }
  }

  onBeforeUnmount(destroy);

  return { phase, error, isPlaying, start, refreshStream, reconnect, destroy };
}

function toError(payload: unknown): Error {
  if (payload instanceof Error) return payload;
  if (typeof payload === 'string') return new Error(payload);
  try {
    return new Error(JSON.stringify(payload));
  } catch {
    return new Error('直播流播放失败');
  }
}
