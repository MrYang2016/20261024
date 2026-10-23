<script setup lang="ts">
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <aside
    class="ai-panel"
    :data-open="open"
    aria-label="AI 实时大纲"
  >
    <header class="ai-panel__head">
      <h2 class="ai-panel__title">
        AI 实时大纲
      </h2>
      <button
        id="ai-drawer-close"
        type="button"
        class="ai-panel__close"
        aria-label="收起 AI 面板"
        @click="emit('close')"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
    </header>

    <p class="ai-panel__badge">
      即将上线
    </p>
    <p class="ai-panel__desc">
      开播后这里会按直播内容实时生成章节大纲，方便迟到的观众快速跟上进度。
    </p>
  </aside>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-6);
  border-radius: var(--radius-container);
  border: 1px solid var(--color-border);
  background: var(--color-panel-raised);
  box-shadow: var(--shadow-raised);
}

.ai-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.ai-panel__title {
  font-size: var(--font-size-20);
  line-height: var(--line-height-30);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-1);
}

.ai-panel__close {
  min-height: var(--control-height);
  min-width: var(--control-height);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border-color: transparent;
  color: var(--color-text-2);
}

.ai-panel__badge {
  align-self: flex-start;
  padding: 2px var(--space-2);
  border-radius: var(--radius-control);
  background: var(--color-brand-soft);
  border: 1px solid color-mix(in srgb, var(--color-brand) 45%, transparent);
  color: var(--color-text-1);
  font-size: var(--font-size-12);
  line-height: var(--line-height-18);
}

.ai-panel__desc {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}
</style>
