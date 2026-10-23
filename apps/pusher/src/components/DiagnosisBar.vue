<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DiagnosticVerdict } from '@live1024/shared';
import { analyzeDiagnosis, confidenceText, type DiagnosisAnalysis } from '../lib/ai';
import { diagnosticCopyText, diagnosticName } from '../diagnostics/useDiagnostics';

/**
 * 常驻自检条（D21）：指标条上方一条健康结论。
 * 正常时一句话说「一切正常 / 预检通过」，异常时变红并给**一个**下一步（D22）。
 * 详情默认收起：讲师日常只看一句话，排障时才展开看实测 vs 期望。
 */
const props = defineProps<{
  status: 'checking' | 'ok' | 'warning' | 'danger' | 'fixing';
  /** 自检条上那句话（异常时就是 verdict.reason） */
  conclusion: string;
  /** 当前结论（正常时为 null） */
  verdict: DiagnosticVerdict | null;
  /** fixing 期间的主按钮文案 */
  fixingLabel: string | null;
  /** 本条诊断已尝试的修复次数 */
  attempts: number;
  /** 修复失败提示 */
  retryHint: string | null;
  /** 权限被浏览器拒绝时的 3 步操作（D41 ②：详情展开区里逐条列出） */
  steps?: string[];
  /** 预检提醒（例如线路不是腾讯云）：不是诊断项，但也不该没人说 */
  advisories: string[];
  /** 分析用的频道号（会话固化的那个）；没有频道号时按钮仍显示，点击只提示先选频道 */
  channelId?: string | null;
}>();

const emit = defineEmits<{ fix: []; copy: [text: string] }>();

const expanded = ref(false);

/**
 * 「让 AI 分析」（AI 解释诊断）：在诊断条原地展开一块解释区。
 * 不用 spinner 挡页面：loading 期间只把按钮文案换成「正在分析…」，页面其它部分照常可操作。
 */
type AiState = 'idle' | 'loading' | 'done' | 'error';

const aiOpen = ref(false);
const aiState = ref<AiState>('idle');
const aiResult = ref<DiagnosisAnalysis | null>(null);
const aiError = ref<string | null>(null);

const isFixing = computed(() => props.status === 'fixing');
const action = computed(() => props.verdict?.action ?? null);
const canExpand = computed(() => props.verdict !== null);
const helpHref = computed(() => (action.value?.kind === 'open-help' ? (action.value.href ?? null) : null));

const at = computed(() => {
  if (!props.verdict) return '';
  const date = new Date(props.verdict.at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
});

const copyPayload = computed(() => (props.verdict ? diagnosticCopyText(props.verdict) : ''));

function onFix(): void {
  if (isFixing.value) return;
  emit('fix');
}

function onCopy(): void {
  if (copyPayload.value) emit('copy', copyPayload.value);
}

/** 点「让 AI 分析」/「重新分析」：拿当前结论 + 频道号请求服务端，失败原地给一句话 + 可重试 */
async function runAnalyze(): Promise<void> {
  if (aiState.value === 'loading') return;
  aiOpen.value = true;
  const channelId = props.channelId ?? null;
  if (!channelId) {
    aiState.value = 'error';
    aiError.value = '还没有频道号，先选择频道再分析';
    return;
  }
  aiState.value = 'loading';
  aiError.value = null;
  try {
    aiResult.value = await analyzeDiagnosis(channelId, {
      verdictId: props.verdict?.id ?? null,
      reason: props.verdict?.reason ?? null,
    });
    aiState.value = 'done';
  } catch (error) {
    aiResult.value = null;
    aiError.value = error instanceof Error && error.message ? error.message : '分析失败，请稍后重试';
    aiState.value = 'error';
  }
}
</script>

<template>
  <section
    class="diagnosis panel"
    :data-status="status"
    aria-label="推流自检"
  >
    <div class="diagnosis__main">
      <span
        class="diagnosis__dot"
        aria-hidden="true"
      />
      <p
        class="diagnosis__text"
        :data-tone="status === 'danger' ? 'strong' : 'normal'"
        role="status"
        aria-live="polite"
      >
        {{ conclusion }}
      </p>

      <div class="diagnosis__actions">
        <a
          v-if="action && action.kind === 'open-help'"
          :href="helpHref ?? '#'"
          target="_blank"
          rel="noopener"
          class="diagnosis__cta"
          data-variant="primary"
        >{{ action.label }}</a>
        <button
          v-else-if="action"
          type="button"
          class="diagnosis__cta"
          data-variant="primary"
          :disabled="isFixing"
          :aria-busy="isFixing ? 'true' : 'false'"
          @click="onFix"
        >
          {{ isFixing ? (fixingLabel ?? '正在处理…') : action.label }}
        </button>

        <button
          v-if="canExpand && !isFixing"
          type="button"
          class="diagnosis__ghost"
          :aria-expanded="expanded ? 'true' : 'false'"
          aria-controls="diagnosis-details"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起详情' : '详情' }}
        </button>

        <!-- 次要入口：不抢主 CTA；无结论时也允许点（服务端会分析历史数据） -->
        <button
          type="button"
          class="diagnosis__ghost"
          :disabled="aiState === 'loading'"
          :aria-busy="aiState === 'loading' ? 'true' : 'false'"
          :aria-expanded="aiOpen ? 'true' : 'false'"
          aria-controls="diagnosis-ai"
          @click="runAnalyze"
        >
          {{ aiState === 'loading' ? '正在分析…' : '让 AI 分析' }}
        </button>
      </div>
    </div>

    <!-- AI 分析结果（原地展开）：aria-live 让读屏软件播报结论变化 -->
    <div
      v-if="aiOpen"
      id="diagnosis-ai"
      class="diagnosis__ai"
      role="status"
      aria-live="polite"
    >
      <p
        v-if="aiState === 'loading'"
        class="diagnosis__ai-hint"
      >
        正在分析…
      </p>
      <template v-else-if="aiState === 'error'">
        <p class="diagnosis__ai-hint">
          {{ aiError }}
        </p>
        <button
          type="button"
          class="diagnosis__ghost"
          @click="runAnalyze"
        >
          重新分析
        </button>
      </template>
      <template v-else-if="aiResult">
        <p class="diagnosis__ai-summary">
          {{ aiResult.summary }}
        </p>
        <p class="diagnosis__ai-cause">
          {{ aiResult.cause }}
        </p>
        <ol class="diagnosis__ai-steps">
          <li
            v-for="(step, index) in aiResult.steps"
            :key="index"
          >
            {{ step }}
          </li>
        </ol>
        <p class="diagnosis__ai-meta">
          可信度：{{ confidenceText(aiResult.confidence) }}{{ aiResult.source === 'rules' ? '（规则引擎兜底）' : '' }}
        </p>
      </template>
    </div>

    <p
      v-if="props.advisories.length > 0"
      class="diagnosis__advisory"
    >
      <span
        class="diagnosis__advisory-mark"
        aria-hidden="true"
      >!</span>
      {{ props.advisories.join('；') }}
    </p>

    <p
      v-if="retryHint"
      class="diagnosis__advisory"
    >
      <span
        class="diagnosis__advisory-mark"
        aria-hidden="true"
      >!</span>
      {{ retryHint }}
      <template v-if="attempts > 1">
        （已尝试 {{ attempts }} 次）
      </template>
    </p>

    <div
      v-if="expanded && verdict"
      id="diagnosis-details"
      class="diagnosis__details"
    >
      <p class="diagnosis__row">
        <span class="diagnosis__label">诊断项</span>
        <span class="diagnosis__value">{{ diagnosticName(verdict.id) }}（{{ verdict.id }}）</span>
      </p>
      <!-- D41 ②：权限被浏览器拒绝时，详情里逐条列出「去地址栏改成允许」的 3 步 -->
      <div
        v-if="props.steps && props.steps.length > 0"
        class="diagnosis__steps"
      >
        <p class="diagnosis__label">
          操作步骤
        </p>
        <ol>
          <li
            v-for="(step, index) in props.steps"
            :key="index"
          >
            {{ step }}
          </li>
        </ol>
      </div>
      <p class="diagnosis__row">
        <span class="diagnosis__label">实测</span>
        <span class="diagnosis__value numeric">{{ verdict.measured }}</span>
      </p>
      <p class="diagnosis__row">
        <span class="diagnosis__label">期望</span>
        <span class="diagnosis__value">{{ verdict.expected }}</span>
      </p>
      <p class="diagnosis__row">
        <span class="diagnosis__label">发生时间</span>
        <span class="diagnosis__value numeric">{{ at }}</span>
      </p>
      <p class="diagnosis__row">
        <span class="diagnosis__label">诊断码</span>
        <span class="diagnosis__value numeric">{{ verdict.code }}</span>
      </p>
      <p
        v-if="verdict.detail"
        class="diagnosis__row"
      >
        <span class="diagnosis__label">详情</span>
        <span class="diagnosis__value">{{ verdict.detail }}</span>
      </p>

      <div class="diagnosis__details-footer">
        <button
          type="button"
          class="diagnosis__ghost"
          @click="onCopy"
        >
          复制诊断信息
        </button>
      </div>
    </div>
  </section>
</template>
