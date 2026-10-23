<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PushState } from '../composables/usePushSession';
import StatusPill from './StatusPill.vue';

const props = defineProps<{
  stream: MediaStream | null;
  state: PushState;
  level: number;
  /** 当前频道号：压在画面左上角，讲师不用滚回上面的频道条确认自己在推哪个频道 */
  channelId?: string | null;
}>();

const videoRef = ref<HTMLVideoElement | null>(null);

// 诊断卡的黑帧检测要拿这个 video 元素采样（D9），父组件通过 ref 取
defineExpose({ videoElement: () => videoRef.value });

watch(
  () => props.stream,
  (stream) => {
    const element = videoRef.value;
    if (!element) return;
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    if (stream) void element.play().catch(() => undefined);
  },
  { immediate: true },
);

/** 空态（真的没有画面）时给的话：只说明为什么没画面 */
const emptyHint = computed(() => {
  if (props.state === 'connecting' || props.state === 'preparing') return '正在建立推流连接，请稍候';
  return '允许摄像头权限后，这里会显示你的画面';
});

/** 压在画面右下角的当前状态提示：只在有画面时渲染，不能复用空态文案 */
const stageHint = computed(() => {
  if (props.state === 'live') return '正在推流，观众看到的就是这个画面';
  if (props.state === 'connecting' || props.state === 'preparing') return '正在建立推流连接，请稍候';
  if (props.state === 'stopping') return '正在停止推流，请稍候';
  return '预览已就绪，点「开始直播」让观众看到画面';
});
</script>

<template>
  <section
    class="stage"
    aria-label="本地预览"
  >
    <video
      ref="videoRef"
      class="stage__video"
      autoplay
      muted
      playsinline
      :class="{ 'stage__video--hidden': !stream }"
    />

    <div
      v-if="!stream"
      class="stage__empty"
    >
      <svg
        class="stage__empty-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h7A2.5 2.5 0 0 1 15 7.5v9A2.5 2.5 0 0 1 12.5 19h-7A2.5 2.5 0 0 1 3 16.5v-9Z" />
        <path d="m15 11 5.2-3.1a.8.8 0 0 1 1.3.7v6.8a.8.8 0 0 1-1.3.7L15 13" />
      </svg>
      <p class="stage__empty-title">
        还没有预览画面
      </p>
      <p class="stage__empty-text">
        {{ emptyHint }}
      </p>
    </div>

    <!-- 画面四角：左上频道号 / 右上推流状态 / 左下麦克风电平 / 右下当前提示 -->
    <p
      v-if="channelId"
      class="stage__chip stage__chip--tl numeric"
    >
      频道 {{ channelId }}
    </p>

    <div class="stage__status">
      <StatusPill :state="state" />
    </div>

    <div class="stage__chip stage__chip--bl">
      <span class="stage__meter-label">麦克风</span>
      <div
        class="meter"
        role="meter"
        aria-label="麦克风音量"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="level"
        :aria-valuetext="`音量 ${level}`"
      >
        <span
          class="meter__fill"
          :style="{ width: `${level}%` }"
        />
      </div>
    </div>

    <p
      v-if="stream"
      class="stage__chip stage__chip--br"
    >
      {{ stageHint }}
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

.stage__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  transform: scaleX(-1);
}

.stage__video--hidden {
  visibility: hidden;
}

.stage__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  text-align: center;
  color: var(--color-text-3);
}

.stage__empty-icon {
  width: 48px;
  height: 48px;
  color: var(--color-text-3);
}

.stage__empty-title {
  margin-top: var(--space-2);
  font-size: var(--font-size-20);
  line-height: var(--line-height-30);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-1);
}

.stage__empty-text {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}

/* 压在画面上的芯片：不透明深底，文字对比度不随画面内容漂移 */
.stage__chip {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 30px;
  max-width: calc(100% - var(--space-8));
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  background: var(--color-overlay);
  color: var(--color-text-1);
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  white-space: nowrap;
}

.stage__chip--tl {
  top: var(--space-4);
  left: var(--space-4);
}

.stage__chip--bl {
  bottom: var(--space-4);
  left: var(--space-4);
}

.stage__chip--br {
  right: var(--space-4);
  bottom: var(--space-4);
  max-width: min(56%, 460px);
  overflow: hidden;
  text-overflow: ellipsis;
}

.stage__status {
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
}

.stage__meter-label {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-2);
}

.meter {
  width: 96px;
  height: 4px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.24);
  overflow: hidden;
}

.meter__fill {
  display: block;
  height: 100%;
  background: var(--color-success);
  transition: width 0.1s linear;
}

@media (max-width: 720px) {
  .stage__chip--br {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .meter__fill {
    transition: none;
  }
}
</style>
