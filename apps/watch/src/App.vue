<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AiPanelPlaceholder from './components/AiPanelPlaceholder.vue';
import ChannelMeta from './components/ChannelMeta.vue';
import PlayerStage from './components/PlayerStage.vue';
import StatusBar from './components/StatusBar.vue';
import WatchDiagnosisBar from './components/WatchDiagnosisBar.vue';
import { useChannelInfo, useLiveStatus } from './composables/useLiveStatus';
import { useWatchDiagnostics } from './composables/useWatchDiagnostics';
import { errorSentence } from './lib/errors';
import { useWatchCore } from './composables/useWatchCore';

const channelId = ref<string | null>(readChannelIdFromUrl());
const inputChannelId = ref('');
const inputError = ref<string | null>(null);
const aiOpen = ref(false);
const playerContainer = ref<HTMLElement | null>(null);
const aiToggleRef = ref<HTMLButtonElement | null>(null);

const { phase, error: playerError, start, refreshStream, reconnect } = useWatchCore();
const {
  liveStatus,
  viewerCount,
  pending,
  error: statusError,
  refresh: refreshStatus,
} = useLiveStatus(channelId, {
  onLive: () => refreshStream(),
});
const { channel, error: channelError, refresh: refreshChannel } = useChannelInfo(channelId);

/**
 * 观众侧自检（W1–W4）：一句话原因 + 一个下一步。
 * 视频元素由 SDK 渲染在容器里、重连后会换，所以传 getter 每次取当前那个。
 */
const {
  verdict: watchVerdict,
  fixing: watchFixing,
  runFix: runWatchFix,
} = useWatchDiagnostics({
  liveStatus,
  videoEl: () => playerContainer.value?.querySelector('video') ?? null,
  playerState: { phase, error: playerError },
  enabled: () => channelId.value !== null,
  onRetryConnect: () => retryAfterError(),
  onReloadPicture: () => reconnect(),
});

const channelName = computed(() => channel.value?.name ?? (channelId.value ? `频道 ${channelId.value}` : '直播观看页'));
/** 频道本身取不到（404 频道不存在等）时，页面进入错误态，不再冒充「未开始」 */
const channelFailed = computed(() => channelError.value !== null);
/** 频道级错误已经占了播放区的提示位，状态轮询的同类错误不再重复一句 */
const statusErrorText = computed(() =>
  channelFailed.value || !statusError.value ? null : errorSentence(statusError.value),
);

async function enterChannel(): Promise<void> {
  const id = inputChannelId.value.trim();
  if (!/^\d{4,20}$/.test(id)) {
    inputError.value = '频道号是纯数字，请检查后再填。';
    return;
  }
  inputError.value = null;
  channelId.value = id;
  writeChannelIdToUrl(id);
}

async function retryAfterError(): Promise<void> {
  // 频道级错误先重新拉频道信息 + 直播状态，再重连播放器；只是拉流失败时只重连
  if (channelFailed.value) {
    await Promise.all([refreshChannel(), refreshStatus()]);
  }
  await reconnect();
}

function toggleAi(): void {
  aiOpen.value = !aiOpen.value;
}

function closeAi(): void {
  aiOpen.value = false;
  aiToggleRef.value?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && aiOpen.value) closeAi();
}

watch(
  [channelId, playerContainer],
  async ([id, element]) => {
    if (!id || !element) return;
    await nextTick();
    await start(id, element);
  },
  { immediate: true, flush: 'post' },
);

watch(
  channelName,
  (name) => {
    document.title = `${name} | 保利直播观看页`;
  },
  { immediate: true },
);

watch(aiOpen, (open) => {
  if (open) {
    void nextTick(() => document.getElementById('ai-drawer-close')?.focus());
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});

function readChannelIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('channelId')?.trim() ?? '';
  return /^\d{4,20}$/.test(value) ? value : null;
}

function writeChannelIdToUrl(id: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('channelId', id);
  window.history.replaceState(null, '', url.toString());
}
</script>

<template>
  <main class="watch">
    <header class="watch__top">
      <div class="watch__identity">
        <h1 class="watch__title">
          {{ channelName }}
        </h1>
        <StatusBar
          v-if="channelId"
          :live-status="liveStatus"
          :viewer-count="viewerCount"
          :pending="pending"
          :failed="channelFailed"
        />
      </div>
      <button
        ref="aiToggleRef"
        type="button"
        class="watch__ai-toggle"
        aria-controls="ai-drawer"
        :aria-expanded="aiOpen ? 'true' : 'false'"
        @click="toggleAi"
      >
        AI 面板
      </button>
    </header>

    <section
      v-if="!channelId"
      class="watch__entry panel"
      aria-labelledby="watch-entry-title"
    >
      <h2
        id="watch-entry-title"
        class="watch__entry-title"
      >
        填频道号开始观看
      </h2>
      <p class="watch__entry-desc">
        从推流端复制「观看页链接」打开会自动带上频道号，也可以在这里直接填。
      </p>
      <form
        class="watch__entry-form"
        @submit.prevent="enterChannel"
      >
        <label
          class="visually-hidden"
          for="watch-channel-input"
        >频道号</label>
        <input
          id="watch-channel-input"
          v-model="inputChannelId"
          type="text"
          inputmode="numeric"
          maxlength="20"
          placeholder="例如：1000001"
        >
        <button
          type="submit"
          data-variant="primary"
        >
          进入观看
        </button>
      </form>
      <p
        v-if="inputError"
        class="watch__entry-error"
        role="alert"
      >
        {{ inputError }}
      </p>
    </section>

    <template v-else>
      <!-- 观众侧自检条：状态条下方，无结论时不渲染（不占位）。
           频道本身取不到时播放区已有「原因 + 下一步 + 重新连接」，这里不重复一遍。 -->
      <WatchDiagnosisBar
        v-if="watchVerdict && !channelFailed"
        :verdict="watchVerdict"
        :fixing="watchFixing"
        @fix="runWatchFix"
      />

      <div class="watch__body">
        <div class="watch__main">
          <PlayerStage
            :phase="phase"
            :live-status="liveStatus"
            :error="playerError"
            :channel-error="channelError"
            @reconnect="retryAfterError"
          >
            <div
              ref="playerContainer"
              class="watch__player-mount"
            />
          </PlayerStage>

          <ChannelMeta :channel-id="channelId" />
          <p
            v-if="statusErrorText"
            class="watch__notice"
            role="status"
          >
            {{ statusErrorText }}
          </p>
        </div>
      </div>

      <aside
        id="ai-drawer"
        class="watch__drawer"
        :data-open="aiOpen"
        :aria-hidden="aiOpen ? 'false' : 'true'"
      >
        <div class="watch__drawer-inner">
          <AiPanelPlaceholder
            :open="aiOpen"
            @close="closeAi"
          />
        </div>
      </aside>
    </template>
  </main>
</template>
