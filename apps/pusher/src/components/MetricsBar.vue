<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  durationText: string;
  bitrateText: string;
  fpsText: string;
  resolutionText: string;
  connectionText: string;
  connectionTone: 'healthy' | 'pending' | 'neutral';
  encodingText: string;
  hasLiveStats: boolean;
}>();

/** 指标值拆成「数字 + 单位」：数字 30px，单位 14px 灰（v2 §1） */
function splitUnit(text: string): { number: string; unit: string } {
  const matched = /^(.+?)\s([a-zA-Z%]+)$/.exec(text);
  if (!matched) return { number: text, unit: '' };
  return { number: matched[1], unit: matched[2] };
}

const metrics = computed(() => ({
  duration: splitUnit(props.durationText),
  bitrate: splitUnit(props.bitrateText),
  fps: splitUnit(props.fpsText),
  resolution: splitUnit(props.resolutionText),
}));
</script>

<template>
  <section
    class="metrics panel"
    aria-label="推流指标"
  >
    <div class="metrics__item">
      <p class="metrics__label">
        推流时长
      </p>
      <p
        class="metrics__value numeric"
        :data-empty="metrics.duration.number === '—' ? 'true' : undefined"
      >
        {{ metrics.duration.number }}<span
          v-if="metrics.duration.unit"
          class="metrics__unit"
        >{{ metrics.duration.unit }}</span>
      </p>
    </div>
    <div class="metrics__item">
      <p class="metrics__label">
        上行码率
      </p>
      <p
        class="metrics__value numeric"
        :data-empty="metrics.bitrate.number === '—' ? 'true' : undefined"
      >
        {{ metrics.bitrate.number }}<span
          v-if="metrics.bitrate.unit"
          class="metrics__unit"
        >{{ metrics.bitrate.unit }}</span>
      </p>
    </div>
    <div class="metrics__item">
      <p class="metrics__label">
        帧率
      </p>
      <p
        class="metrics__value numeric"
        :data-empty="metrics.fps.number === '—' ? 'true' : undefined"
      >
        {{ metrics.fps.number }}<span
          v-if="metrics.fps.unit"
          class="metrics__unit"
        >{{ metrics.fps.unit }}</span>
      </p>
    </div>
    <div class="metrics__item">
      <p class="metrics__label">
        画面
      </p>
      <p
        class="metrics__value numeric"
        :data-empty="metrics.resolution.number === '—' ? 'true' : undefined"
      >
        {{ metrics.resolution.number }}<span
          v-if="metrics.resolution.unit"
          class="metrics__unit"
        >{{ metrics.resolution.unit }}</span>
      </p>
    </div>
    <div class="metrics__item">
      <p class="metrics__label">
        上行连接
      </p>
      <p
        class="metrics__value metrics__value--text"
        :data-tone="connectionTone"
      >
        <span
          class="metrics__dot"
          aria-hidden="true"
        />{{ connectionText }}
      </p>
    </div>
    <p class="metrics__footnote">
      目标编码参数 {{ encodingText }}<template v-if="!hasLiveStats">
        ，码率与帧率等首次统计回报后显示
      </template>
    </p>
  </section>
</template>

<style scoped>
.metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-4) var(--space-6);
  padding: var(--space-6);
}

.metrics__label {
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}

.metrics__value {
  margin-top: var(--space-2);
  font-size: var(--metric-font-size);
  line-height: var(--line-height-38);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-1);
  overflow-wrap: anywhere;
}

/* 占位符（—）不抢数字的视觉权重 */
.metrics__value[data-empty='true'] {
  color: var(--color-text-3);
}

.metrics__unit {
  margin-left: var(--space-1);
  font-size: var(--metric-unit-font-size);
  line-height: var(--line-height-22);
  font-weight: var(--font-weight-normal);
  color: var(--color-text-3);
}

.metrics__value--text {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-20);
  line-height: var(--line-height-38);
}

/* 绿点表链路健康，文字保持白字（#23AA4F 作 20px 文字在面板底只有 5.92:1，
   但绿点在深底上更像「信号灯」且不承担可读性；文字一律用可读层级） */
.metrics__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-3);
}

.metrics__value--text[data-tone='healthy'] .metrics__dot {
  background: var(--color-success);
}

.metrics__value--text[data-tone='pending'] .metrics__dot {
  background: var(--color-warning);
}

.metrics__value--text[data-tone='neutral'] {
  color: var(--color-text-3);
}

.metrics__value--text[data-tone='neutral'] .metrics__dot {
  background: var(--color-text-4);
}

.metrics__footnote {
  grid-column: 1 / -1;
  font-size: var(--font-size-14);
  line-height: var(--line-height-22);
  color: var(--color-text-3);
}

@media (max-width: 900px) {
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: var(--space-4);
  }
}
</style>
