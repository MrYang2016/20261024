<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { PushState } from '../composables/usePushSession';

const props = defineProps<{
  state: PushState;
  canStart: boolean;
  canStop: boolean;
  /** 不能开播的原因（例如还没有频道），有值时优先展示 */
  blockedReason?: string | null;
}>();

const emit = defineEmits<{ start: []; stop: [] }>();

const isLive = computed(() => props.state === 'live');
const busyLabel = computed(() => {
  if (props.state === 'preparing') return '准备中…';
  if (props.state === 'connecting') return '连接中…';
  if (props.state === 'stopping') return '停止中…';
  return null;
});
const label = computed(() => {
  if (busyLabel.value) return busyLabel.value;
  return isLive.value ? '停止直播' : '开始直播';
});
const disabled = computed(() => (isLive.value ? !props.canStop : !props.canStart));

const hint = computed(() => {
  if (props.blockedReason) return props.blockedReason;
  return isLive.value ? '点击停止直播，观众会看到「已结束」' : '开播后把观看链接发给观众即可';
});

const buttonRef = ref<HTMLButtonElement | null>(null);
/** 用户主动按过这个按钮 → 状态变化后要把焦点还回来 */
let restoreFocus = false;

function onClick(): void {
  restoreFocus = true;
  if (isLive.value) emit('stop');
  else emit('start');
}

/**
 * 按钮在 preparing / connecting / stopping 期间是 disabled，浏览器会把焦点丢回 body：
 * 纯键盘用户按 Enter 开播后就再也停不了推流。回到可点状态（live / idle）时把焦点还给同一个按钮，
 * 这样「开始直播」→「停止直播」的焦点不会掉。
 */
watch(
  () => props.state,
  async (next) => {
    if (!restoreFocus) return;
    if (next === 'error') {
      restoreFocus = false;
      return;
    }
    if (next !== 'live' && next !== 'idle') return;
    await nextTick();
    buttonRef.value?.focus();
  },
);
</script>

<template>
  <div class="push-control">
    <button
      ref="buttonRef"
      type="button"
      :data-variant="isLive ? 'danger' : 'primary'"
      :disabled="disabled"
      :aria-busy="busyLabel ? 'true' : 'false'"
      @click="onClick"
    >
      {{ label }}
    </button>
    <p class="push-control__hint">
      {{ hint }}
    </p>
  </div>
</template>

<style scoped>
.push-control {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--space-2);
  margin-left: auto;
}

button {
  min-width: 148px;
}

.push-control__hint {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
  text-align: right;
  max-width: 34ch;
}

@media (max-width: 720px) {
  .push-control {
    align-items: stretch;
    margin-left: 0;
  }

  .push-control__hint {
    text-align: left;
    max-width: none;
  }
}
</style>
