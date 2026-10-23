<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { DiagnosticRecord, MetricSample } from '@live1024/shared';
import { diagnosticName } from '../diagnostics/useDiagnostics';
import { liveApi } from '../lib/api';

/** 导出 CSV 的列（D34 / 计划 §十一 A） */
const CSV_COLUMNS = ['at', 'kbps', 'fps', 'dropFps', 'connection'] as const;

/**
 * 诊断历史抽屉（D26）：顶部信息条「诊断历史」打开的右侧抽屉。
 * 只读服务端内存最近 50 条（D23），不做跨场次持久化、不做独立页面。
 * 服务端不可用时回落到本次会话的本地记录，并说明「仅本场」——不能装作是完整历史。
 *
 * 24060 增补（D34）：多一个「指标时间序列」分区，把「断了几秒、码率从多少掉到多少」
 * 变成可交付给客户的客观数据；导出走前端 Blob，不再往服务端发一次请求。
 */
const props = defineProps<{
  open: boolean;
  channelId: string | null;
  /** 本次会话的本地镜像：服务端读不到时兜底 */
  fallbackItems: DiagnosticRecord[];
  /** 本次会话的本地指标镜像：服务端读不到时兜底 */
  fallbackSamples?: MetricSample[];
}>();

const emit = defineEmits<{ close: []; copy: [text: string] }>();

const items = ref<DiagnosticRecord[]>([]);
const samples = ref<MetricSample[]>([]);
const loading = ref(false);
const metricsLoading = ref(false);
const errorText = ref<string | null>(null);
const metricsError = ref<string | null>(null);
const usingLocal = ref(false);
const usingLocalMetrics = ref(false);
const titleId = 'diagnosis-history-title';
const closeButton = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
let restoreFocusTo: HTMLElement | null = null;

const hasItems = computed(() => items.value.length > 0);
const hasSamples = computed(() => samples.value.length > 0);

/** 指标分区的一句话概况：多少条 + 最新一条的时间，不堆表格 */
const metricsSummary = computed(() => {
  if (!hasSamples.value) return '';
  const last = samples.value[samples.value.length - 1];
  return last ? `共 ${samples.value.length} 条 · 最近 ${formatTime(last.at)}` : '';
});

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

async function load(): Promise<void> {
  const channelId = props.channelId;
  if (!channelId) {
    items.value = [...props.fallbackItems];
    usingLocal.value = true;
    errorText.value = null;
    loadLocalMetrics();
    return;
  }
  loading.value = true;
  errorText.value = null;
  try {
    const response = await liveApi.listDiagnostics(channelId, 50);
    items.value = response.items;
    usingLocal.value = false;
  } catch (error) {
    // 服务端读不到就退回本地镜像，并说明这份只是本场的记录
    items.value = [...props.fallbackItems];
    usingLocal.value = true;
    errorText.value = error instanceof Error ? error.message : '诊断历史加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
  await loadMetrics(channelId);
}

/** 指标时间序列（D34）：与诊断历史分开 try，一边挂了一边仍能导出 */
async function loadMetrics(channelId: string): Promise<void> {
  metricsLoading.value = true;
  metricsError.value = null;
  try {
    const response = await liveApi.listMetrics(channelId, 300);
    samples.value = response.items;
    usingLocalMetrics.value = false;
  } catch (error) {
    loadLocalMetrics();
    metricsError.value =
      error instanceof Error ? error.message : '指标时间序列加载失败，请稍后重试';
  } finally {
    metricsLoading.value = false;
  }
}

function loadLocalMetrics(): void {
  samples.value = [...(props.fallbackSamples ?? [])];
  usingLocalMetrics.value = true;
}

/** 导出 CSV（前端 Blob）：列为 `at,kbps,fps,dropFps,connection`，拿不到的值留空 */
function exportCsv(): void {
  const lines = [
    CSV_COLUMNS.join(','),
    ...samples.value.map((sample) => CSV_COLUMNS.map((column) => csvCell(sample, column)).join(',')),
  ];
  download(lines.join('\n'), csvFileName(), 'text/csv;charset=utf-8');
}

/** 导出 JSON：原始采样数组，保留 null（“没采到”本身也是证据） */
function exportJson(): void {
  download(JSON.stringify(samples.value, null, 2), jsonFileName(), 'application/json;charset=utf-8');
}

function csvCell(sample: MetricSample, column: (typeof CSV_COLUMNS)[number]): string {
  const value = sample[column];
  if (value == null) return '';
  const text = String(value);
  // 逗号 / 引号 / 换行必须转义，否则导出的表列会错位
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvFileName(): string {
  return `metrics-${props.channelId ?? 'session'}.csv`;
}

function jsonFileName(): string {
  return `metrics-${props.channelId ?? 'session'}.json`;
}

function download(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 给下载一个启动的机会再回收 blob URL
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function close(): void {
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab' || !panel.value) return;
  // 焦点圈闭在抽屉内：Tab 到最后一项后回到第一项
  const focusable = panel.value.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function copyAll(): void {
  const payload = items.value.map((item) => ({
    id: item.id,
    code: item.code,
    level: item.level,
    reason: item.reason,
    measured: item.measured,
    expected: item.expected,
    firstAt: item.firstAt,
    lastAt: item.lastAt,
    occurrences: item.occurrences,
    recoveredAt: item.recoveredAt,
    outageMs: item.outageMs,
  }));
  emit('copy', JSON.stringify(payload, null, 2));
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      restoreFocusTo?.focus();
      restoreFocusTo = null;
      return;
    }
    // 记住触发按钮，关闭后把焦点还回去（键盘用户不丢位置）
    restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void load();
    await nextTick();
    closeButton.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="open"
    class="history"
  >
    <div
      class="history__backdrop"
      @click="close"
    />
    <aside
      ref="panel"
      class="history__panel panel"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      @keydown="onKeydown"
    >
      <header class="history__header">
        <h2
          :id="titleId"
          class="history__title"
        >
          诊断历史
        </h2>
        <button
          ref="closeButton"
          type="button"
          class="history__close"
          aria-label="关闭诊断历史"
          @click="close"
        >
          关闭
        </button>
      </header>

      <p
        v-if="channelId"
        class="history__meta"
      >
        频道 {{ channelId }} · 本场最近 50 条（服务重启后清空）
      </p>

      <div class="history__body">
        <p
          v-if="loading"
          class="history__hint"
        >
          正在加载诊断历史…
        </p>

        <template v-else-if="hasItems">
          <p
            v-if="usingLocal"
            class="history__hint"
          >
            {{ errorText }}——下面是本场会话的记录。
          </p>
          <ul class="history__list">
            <li
              v-for="item in items"
              :key="`${item.id}-${item.firstAt}`"
              class="history__item"
              :data-level="item.level"
            >
              <p class="history__item-head">
                <span class="history__time numeric">{{ formatTime(item.lastAt) }}</span>
                <span
                  v-if="item.occurrences > 1"
                  class="history__count"
                >出现 {{ item.occurrences }} 次</span>
                <span
                  v-if="item.recoveredAt"
                  class="history__recovered"
                >已恢复</span>
                <span
                  v-if="item.outageMs != null"
                  class="history__outage"
                >断流 {{ Math.round(item.outageMs / 1000) }} 秒，已自动恢复</span>
              </p>
              <p class="history__name">
                {{ diagnosticName(item.id) }}（{{ item.id }}）
              </p>
              <p class="history__reason">
                {{ item.reason }}
              </p>
              <p class="history__measured numeric">
                {{ item.measured }}
              </p>
              <p class="history__code numeric">
                {{ item.code }}
              </p>
            </li>
          </ul>
        </template>

        <p
          v-else
          class="history__empty"
        >
          还没有诊断记录。推流中一旦发现问题，这里会留下可追溯的记录。
        </p>

        <!-- 指标时间序列（D34）：客户要的「帧率、码率等客观数据」 -->
        <section
          class="history__metrics"
          aria-labelledby="metrics-title"
        >
          <h3
            id="metrics-title"
            class="history__metrics-title"
          >
            指标时间序列
          </h3>
          <p class="history__metrics-hint">
            推流中每 5 秒一条采样（最多 300 条，约 25 分钟）
          </p>

          <p
            v-if="metricsLoading"
            class="history__hint"
          >
            正在加载指标…
          </p>
          <template v-else>
            <p
              v-if="usingLocalMetrics && metricsError"
              class="history__hint"
            >
              {{ metricsError }}——下面是本场会话的采样。
            </p>
            <p
              v-if="hasSamples"
              class="history__metrics-summary numeric"
            >
              {{ metricsSummary }}
            </p>
            <p
              v-else
              class="history__hint"
            >
              本场还没有指标采样。推流开始后每 5 秒记录一次。
            </p>
          </template>

          <div class="history__exports">
            <button
              type="button"
              class="history__export"
              :disabled="!hasSamples"
              @click="exportCsv"
            >
              导出 CSV
            </button>
            <button
              type="button"
              class="history__export"
              :disabled="!hasSamples"
              @click="exportJson"
            >
              导出 JSON
            </button>
          </div>
        </section>
      </div>

      <footer class="history__footer">
        <button
          type="button"
          class="history__copy"
          :disabled="!hasItems"
          @click="copyAll"
        >
          复制全部
        </button>
      </footer>
    </aside>
  </div>
</template>
