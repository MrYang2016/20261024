import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { ChannelInfo, LiveStatus, LiveStatusSnapshot } from '@live1024/shared';
import { watchApi } from '../lib/api';
import { mapWatchError, type WatchErrorInfo } from '../lib/errors';

/** 直播状态轮询间隔：验收要求 5 秒内看到画面与状态变化 */
const POLL_INTERVAL_MS = 4000;

export interface LiveStatusView {
  liveStatus: Ref<LiveStatus>;
  viewerCount: Ref<number>;
  /** 首帧状态还没回来时为 true */
  pending: Ref<boolean>;
  error: Ref<WatchErrorInfo | null>;
  refresh: () => Promise<void>;
}

/**
 * 直播状态：订阅服务端（服务端合并平台状态与推流端会话）。
 * 切到「直播中」时回调 onLive，用于刷新播放器流。
 */
export function useLiveStatus(
  channelId: Ref<string | null>,
  options: { onLive?: () => void } = {},
): LiveStatusView {
  const liveStatus = ref<LiveStatus>('unStart');
  const viewerCount = ref(0);
  const pending = ref(true);
  const error = ref<WatchErrorInfo | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastStatus: LiveStatus | null = null;

  async function refresh(): Promise<void> {
    const id = channelId.value;
    if (!id) return;
    try {
      const snapshot: LiveStatusSnapshot = await watchApi.getLiveStatus(id);
      liveStatus.value = snapshot.liveStatus;
      viewerCount.value = snapshot.viewerCount;
      error.value = null;
      pending.value = false;

      if (snapshot.liveStatus === 'live' && lastStatus !== 'live') {
        options.onLive?.();
      }
      lastStatus = snapshot.liveStatus;
    } catch (unknownError) {
      error.value = mapWatchError(unknownError);
      pending.value = false;
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  watch(
    channelId,
    (id) => {
      stop();
      if (!id) {
        pending.value = true;
        return;
      }
      pending.value = true;
      lastStatus = null;
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    },
    { immediate: true },
  );

  onBeforeUnmount(stop);

  return { liveStatus, viewerCount, pending, error, refresh };
}

export interface ChannelInfoView {
  channel: Ref<ChannelInfo | null>;
  error: Ref<WatchErrorInfo | null>;
  refresh: () => Promise<void>;
}

/** 频道信息（名称 / 频道号 / 观看数口径说明用） */
export function useChannelInfo(channelId: Ref<string | null>): ChannelInfoView {
  const channel = ref<ChannelInfo | null>(null);
  const error = ref<WatchErrorInfo | null>(null);

  async function refresh(): Promise<void> {
    const id = channelId.value;
    if (!id) return;
    try {
      channel.value = await watchApi.getChannel(id);
      error.value = null;
    } catch (unknownError) {
      error.value = mapWatchError(unknownError);
    }
  }

  watch(
    channelId,
    (id) => {
      channel.value = null;
      if (id) void refresh();
    },
    { immediate: true },
  );

  return { channel, error, refresh };
}
