<script setup lang="ts">
import { computed } from 'vue';
import type { PushState } from '../composables/usePushSession';

const props = defineProps<{ state: PushState }>();

const LABELS: Record<PushState, string> = {
  idle: '未开始',
  preparing: '准备中',
  connecting: '连接中',
  live: '推流中',
  stopping: '停止中',
  error: '出错',
};

const TONE: Record<PushState, 'neutral' | 'pending' | 'live' | 'danger'> = {
  idle: 'neutral',
  preparing: 'pending',
  connecting: 'pending',
  live: 'live',
  stopping: 'pending',
  error: 'danger',
};

const label = computed(() => LABELS[props.state]);
const tone = computed(() => TONE[props.state]);
// 形态（底色 / 描边 / 红点呼吸 / reduced-motion 降级）统一在 theme.css 的 .status-chip
</script>

<template>
  <p
    class="status-chip status-pill"
    :data-tone="tone"
    role="status"
    aria-live="polite"
  >
    <span
      class="status-chip__dot"
      aria-hidden="true"
    />
    <span class="status-pill__text">{{ label }}</span>
  </p>
</template>
