<script setup lang="ts">
defineProps<{
  tone: 'info' | 'warning' | 'danger';
  text: string;
  dismissible?: boolean;
}>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    class="notice"
    :data-tone="tone"
    :role="tone === 'danger' ? 'alert' : 'status'"
  >
    <p class="notice__text">
      {{ text }}
    </p>
    <button
      v-if="dismissible"
      type="button"
      class="notice__dismiss"
      @click="emit('dismiss')"
    >
      知道了
    </button>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-container);
  border: 1px solid var(--color-border);
  background: var(--color-panel);
}

.notice__text {
  flex: 1;
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-2);
}

.notice[data-tone='warning'] {
  border-color: color-mix(in srgb, var(--color-warning) 42%, transparent);
  background: color-mix(in srgb, var(--color-warning) 10%, var(--color-panel));
}

.notice[data-tone='warning'] .notice__text {
  color: var(--color-warning);
}

.notice[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--color-danger) 12%, var(--color-panel));
}

.notice[data-tone='danger'] .notice__text {
  color: var(--color-danger);
}

.notice__dismiss {
  min-height: var(--control-height);
  padding: 0 var(--space-3);
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  background: transparent;
  border-color: transparent;
  color: var(--color-text-2);
}
</style>
