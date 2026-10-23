<script setup lang="ts">
import { DEMO_FAULTS, type DemoFaultKind } from '../diagnostics/demo-faults';

/**
 * 演示故障注入面板（D37，仅录制 1024 演示视频用）。
 *
 * **只有 URL 带 `?demo=1` 时 App 才挂载它**——默认不进页面、不进生产路径。
 * 按钮不直接改 UI：它把故障写进 `signals.ts` 的输入，由规则层照常判定，
 * 所以录像里出现的 D5 / D7 / D9 结论与「诊断历史」记录都是真实判定结果。
 */
const props = defineProps<{
  /** 当前注入的故障（null = 正常） */
  active: DemoFaultKind | null;
}>();

const emit = defineEmits<{ inject: [kind: DemoFaultKind]; reset: [] }>();

function onInject(kind: DemoFaultKind): void {
  emit('inject', kind);
}
</script>

<template>
  <section
    class="demo panel"
    aria-label="演示故障注入"
    data-demo-panel="true"
  >
    <div class="demo__head">
      <h2 class="demo__title">
        演示故障注入
      </h2>
      <p class="demo__note">
        仅本机演示（`?demo=1`）· 注入的是真实信号入口，判定链路与线上一致
      </p>
    </div>

    <div class="demo__buttons">
      <button
        v-for="fault in DEMO_FAULTS"
        :key="fault.kind"
        type="button"
        class="demo__button"
        :aria-pressed="props.active === fault.kind ? 'true' : 'false'"
        :data-active="props.active === fault.kind ? 'true' : 'false'"
        :title="fault.hint"
        @click="onInject(fault.kind)"
      >
        {{ fault.label }}
      </button>
      <button
        type="button"
        class="demo__button demo__button--reset"
        :aria-pressed="props.active === null ? 'true' : 'false'"
        @click="emit('reset')"
      >
        恢复正常
      </button>
    </div>
  </section>
</template>
