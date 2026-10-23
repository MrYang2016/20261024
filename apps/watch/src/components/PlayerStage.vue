<script setup lang="ts">
import { computed } from 'vue';
import type { LiveStatus } from '@live1024/shared';
import type { WatchErrorInfo } from '../lib/errors';
import type { WatchPhase } from '../composables/useWatchCore';

const props = defineProps<{
  phase: WatchPhase;
  liveStatus: LiveStatus;
  error: WatchErrorInfo | null;
  /** 频道级错误（如 404 频道不存在）：播放区显示错误态，不冒充「直播还没开始」 */
  channelError: WatchErrorInfo | null;
}>();

const emit = defineEmits<{ reconnect: [] }>();

const isLive = computed(() => props.liveStatus === 'live');
const isPlayback = computed(() => props.liveStatus === 'playback');
const channelFailed = computed(() => props.channelError !== null);
/** 直播中的拉流失败才算真的失败；未开播时「没有流」是正常状态 */
const showPlaybackError = computed(() => props.phase === 'error' && isLive.value && !channelFailed.value);
/** 未开播 / 已结束用我们自己的深色状态层，盖掉播放器自带的浅色封面；频道级错误时让位给错误态 */
const showWaitingLayer = computed(
  () =>
    !channelFailed.value &&
    props.phase !== 'loading' &&
    !showPlaybackError.value &&
    !isLive.value &&
    !isPlayback.value,
);

const waitingTitle = computed(() => (props.liveStatus === 'end' ? '直播已结束' : '直播还没开始'));
const waitingHint = computed(() =>
  props.liveStatus === 'end'
    ? '回放稍后可在直播后台查看；讲师再次开播后本页自动播放'
    : '讲师开播后本页自动播放，不用刷新',
);
</script>

<template>
  <section
    class="stage"
    aria-label="直播画面"
  >
    <div
      class="stage__player"
      :aria-busy="phase === 'loading' && !channelFailed ? 'true' : 'false'"
    >
      <slot />
    </div>

    <div
      v-if="channelFailed"
      class="stage__overlay stage__overlay--error"
    >
      <p
        class="stage__overlay-title"
        role="status"
      >
        {{ channelError?.message }}
      </p>
      <p
        v-if="channelError?.nextStep"
        class="stage__overlay-text"
      >
        {{ channelError?.nextStep }}
      </p>
      <button
        type="button"
        data-variant="primary"
        @click="emit('reconnect')"
      >
        重新连接
      </button>
    </div>

    <div
      v-else-if="phase === 'loading'"
      class="stage__overlay"
    >
      <p class="stage__overlay-text">
        正在连接播放器…
      </p>
    </div>

    <div
      v-else-if="showPlaybackError"
      class="stage__overlay stage__overlay--error"
      role="alert"
    >
      <p class="stage__overlay-title">
        {{ error?.message ?? '播放器没能加载直播流' }}
      </p>
      <p
        v-if="error?.nextStep"
        class="stage__overlay-text"
      >
        {{ error?.nextStep }}
      </p>
      <button
        type="button"
        data-variant="primary"
        @click="emit('reconnect')"
      >
        重新连接
      </button>
    </div>

    <div
      v-else-if="showWaitingLayer"
      class="stage__overlay"
    >
      <svg
        class="stage__overlay-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="2.5"
        />
        <path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14" />
      </svg>
      <p class="stage__overlay-title">
        {{ waitingTitle }}
      </p>
      <p class="stage__overlay-text">
        {{ waitingHint }}
      </p>
    </div>

    <p
      v-if="isPlayback && phase === 'ready'"
      class="stage__hint"
    >
      正在播放回放
    </p>
  </section>
</template>

<style scoped>
.stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-emphasis);
  border: 1px solid var(--color-border-strong);
  background: #000;
  overflow: hidden;
  box-shadow: var(--shadow-panel);
}

.stage__player {
  position: absolute;
  inset: 0;
}

.stage__player :deep(video) {
  width: 100%;
  height: 100%;
}

.stage__overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  /* 未开播 / 已结束是我们自己的状态层：用面板底，让播放器区仍读作一张卡 */
  background: var(--color-panel);
  color: var(--color-text-2);
  text-align: center;
}

.stage__overlay-icon {
  width: 48px;
  height: 48px;
  margin-bottom: var(--space-2);
  color: var(--color-text-3);
}

.stage__overlay-title {
  font-size: var(--font-size-20);
  line-height: var(--line-height-30);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-1);
}

.stage__overlay-text {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
  max-width: 34em;
}

.stage__overlay--error button {
  margin-top: var(--space-4);
}

.stage__hint {
  position: absolute;
  z-index: 5;
  left: var(--space-4);
  bottom: var(--space-4);
  min-height: 30px;
  padding: 0 var(--space-3);
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-pill);
  background: var(--color-overlay);
  border: 1px solid var(--color-border);
  color: var(--color-text-1);
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
}
</style>
