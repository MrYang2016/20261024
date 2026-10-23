<script setup lang="ts">
import { computed } from 'vue';
import type { LiveStatus } from '@live1024/shared';
import { formatViewerCount } from '../lib/format';

const props = withDefaults(
  defineProps<{
    liveStatus: LiveStatus;
    viewerCount: number;
    pending?: boolean;
    /** 频道级错误：状态取不到时不能冒充「未开始」 */
    failed?: boolean;
  }>(),
  { pending: false, failed: false },
);

const tone = computed<'live' | 'neutral' | 'warning' | 'danger'>(() => {
  if (props.failed) return 'danger';
  if (props.liveStatus === 'live') return 'live';
  if (props.liveStatus === 'playback') return 'warning';
  return 'neutral';
});

const label = computed(() => {
  if (props.failed) return '加载失败';
  if (props.pending) return '加载中';
  switch (props.liveStatus) {
    case 'live':
      return '直播中';
    case 'playback':
      return '回放中';
    case 'end':
      return '已结束';
    default:
      return '未开始';
  }
});
</script>

<template>
  <div class="status-bar">
    <p
      class="status-chip status-bar__pill"
      :data-tone="tone"
      role="status"
      aria-live="polite"
    >
      <span
        class="status-chip__dot"
        aria-hidden="true"
      />
      <span>{{ label }}</span>
    </p>
    <p class="status-bar__count numeric">
      <template v-if="pending || failed">
        —
      </template>
      <template v-else>
        累计观看 {{ formatViewerCount(viewerCount) }}
      </template>
    </p>
  </div>
</template>

<style scoped>
/* 芯片形态（色块 / 红点呼吸 / reduced-motion 降级）统一在 theme.css 的 .status-chip */
.status-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.status-bar__count {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}
</style>
