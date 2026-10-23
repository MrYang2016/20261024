<script setup lang="ts">
import type { WatchVerdict } from '../composables/useWatchDiagnostics';

/**
 * 观众侧自检条：与推流端自检条同形态（左 4px 状态色条 + 状态点 + 一句话 + 一个按钮）。
 * 状态不只靠颜色：色点旁边永远有一句中文（「画面卡住了」「连不上服务器，请检查网络」）。
 * 只在有结论时渲染（父组件 v-if）——正常时不占位，保持观看页原有布局。
 */
const props = withDefaults(
  defineProps<{
    verdict: WatchVerdict;
    /** 修复动作进行中：按钮置忙，防重复触发 */
    fixing?: boolean;
  }>(),
  { fixing: false },
);

const emit = defineEmits<{ fix: [] }>();

function onFix(): void {
  if (props.fixing) return;
  emit('fix');
}
</script>

<template>
  <section
    class="wdiag panel"
    :data-status="verdict.level"
    aria-label="观看自检"
  >
    <div class="wdiag__main">
      <span
        class="wdiag__dot"
        aria-hidden="true"
      />
      <p
        class="wdiag__text"
        role="status"
        aria-live="polite"
      >
        {{ verdict.reason }}
      </p>

      <button
        type="button"
        class="wdiag__cta"
        data-variant="primary"
        :disabled="fixing"
        :aria-busy="fixing ? 'true' : 'false'"
        @click="onFix"
      >
        {{ fixing ? '正在处理…' : verdict.actionLabel }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.wdiag {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 56px;
  padding: var(--space-3) var(--space-4);
  /* 左 4px 状态色条：与推流端自检条同一形态 */
  border-left: 4px solid var(--color-warning);
}

.wdiag[data-status='danger'] {
  border-left-color: var(--color-danger);
}

.wdiag[data-status='warning'] {
  border-left-color: var(--color-warning);
}

.wdiag__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.wdiag__dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color-warning);
}

.wdiag[data-status='danger'] .wdiag__dot {
  background: var(--color-danger);
}

.wdiag__text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-16);
  line-height: var(--line-height-26);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-1);
}

/* 主按钮形态（44 高、品牌蓝、白字）来自 theme.css 的 button[data-variant='primary'] */
.wdiag__cta {
  flex: none;
}

@media (max-width: 560px) {
  .wdiag__cta {
    width: 100%;
  }
}
</style>
