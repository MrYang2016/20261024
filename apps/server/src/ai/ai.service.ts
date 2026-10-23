import { Injectable } from '@nestjs/common';
import {
  DIAGNOSTIC_META,
  type DeviceSnapshot,
  type DiagnosticId,
  type DiagnosticRecord,
  type MetricSample,
} from '@live1024/shared/diagnostics';
import { DiagnosticsService } from '../diagnostics/diagnostics.service';
import { MetricsService } from '../diagnostics/metrics.service';
import { AiClient, getDeepSeekConfig, type AiMessage } from './ai.client';

/** 诊断记录只给最近 10 条（历史留给抽屉，模型只需要当前这几次故障） */
const RECENT_RECORDS = 10;
/** 指标只取最近 120 条（5 秒一条 ≈ 10 分钟），且只把**统计量**给模型（控制 token） */
const RECENT_SAMPLES = 120;
const DEFAULT_MODEL = 'deepseek-chat';
/** summary 上限 40 字（提示词要求 ≤40 汉字，上游偶尔超了就在这里截断） */
const SUMMARY_MAX = 40;

/** `POST /api/channels/:channelId/analyze` 的请求体（已归一，服务端内部用） */
export interface AnalyzeInput {
  /** 当前规则结论的 id（可空：只分析历史数据时没有结论） */
  verdictId?: DiagnosticId;
  /** 当前规则结论的一句话原因（可空） */
  reason?: string;
  /** 讲师自己补的一句话问题（可空，限长） */
  question?: string;
}

export type AiConfidence = 'high' | 'medium' | 'low';

/** `POST /api/channels/:channelId/analyze` 的响应体 */
export interface AnalyzeResult {
  channelId: string;
  /** `llm` = 真的调到了 DeepSeek；`rules` = 规则引擎兜底（无 key / 报错 / 超时） */
  source: 'llm' | 'rules';
  summary: string;
  cause: string;
  steps: string[];
  confidence: AiConfidence;
  evidence: string[];
  model: string;
  tookMs: number;
}

/** 断流区间（connection 不是 connected 的那一段） */
interface OutageWindow {
  from: number;
  to: number | null;
}

/** 指标降采样后的统计量：只把这些交给模型，不把 120 条原始采样塞进提示词 */
interface MetricsSummary {
  count: number;
  minutes: number;
  minKbps: number | null;
  maxKbps: number | null;
  avgKbps: number | null;
  minFps: number | null;
  avgFps: number | null;
  outages: OutageWindow[];
}

interface ParsedAnalysis {
  summary: string;
  cause: string;
  steps: string[];
  confidence: AiConfidence;
  evidence: string[];
}

/**
 * AI 诊断解释（这条需求的「让 AI 分析」）。
 *
 * 只做「解释 + 建议」，不新增诊断规则：判定仍然是推流端 7 条硬规则，
 * 这里把本地实测数据（指标统计 + 最近诊断记录 + 设备快照）和当前结论发给 DeepSeek，
 * 换回人话的因果解释与可执行步骤。
 *
 * 三条边界：
 * 1. **数据不外泄**：只发频道号、统计量、诊断项与设备型号级别的字段，不发 key / 不发电商信息；
 * 2. **不编造**：提示词禁止超出给定数据；解析失败 / 无 key / 超时一律回落规则兜底（`source: 'rules'`）；
 * 3. **不阻塞**：走一次 25 秒超时的 `AiClient.chat`，失败也是对客户有意义的固定解释，不是错误页。
 */
@Injectable()
export class AiService {
  constructor(
    private readonly client: AiClient,
    private readonly diagnostics: DiagnosticsService,
    private readonly metrics: MetricsService,
  ) {}

  async analyze(channelId: string, input: AnalyzeInput = {}): Promise<AnalyzeResult> {
    const startedAt = Date.now();
    const model = getDeepSeekConfig()?.model ?? DEFAULT_MODEL;
    const records = this.diagnostics.list(channelId, RECENT_RECORDS);
    const samples = this.metrics.list(channelId, RECENT_SAMPLES);
    const device = this.diagnostics.getDevice(channelId);
    const stats = summarizeMetrics(samples);

    const completion = await this.client.chat(buildMessages(channelId, input, records, stats, device), {
      jsonObject: true,
      temperature: 0.2,
      maxTokens: 900,
    });

    const parsed = completion ? parseAnalysis(completion.content) : null;
    if (completion && parsed) {
      return {
        channelId,
        source: 'llm',
        summary: parsed.summary,
        cause: parsed.cause,
        steps: parsed.steps,
        confidence: parsed.confidence,
        evidence: parsed.evidence,
        // 报告配置里的模型名（契约字段）：上游偶尔回自己的别名，运维对不上 DEEPSEEK_MODEL
        model,
        tookMs: Date.now() - startedAt,
      };
    }

    return {
      channelId,
      source: 'rules',
      ...buildFallback(input, records, stats),
      model,
      tookMs: Date.now() - startedAt,
    };
  }
}

/* ---------------- 提示词 ---------------- */

const SYSTEM_PROMPT = [
  '你是保利威（POLYV）直播推流诊断助手，服务对象是准备开播的讲师和技术支持。',
  '铁律：',
  '1. 只能依据用户消息里给出的数据作答，不得编造数据、设备型号、客户信息或未给出的原因；',
  '   数据不足以判断时，就在 cause 里说明「数据不足」，confidence 给 low。',
  '2. 只输出一个 JSON 对象，不要 Markdown、不要代码块、不要任何解释性前后缀。',
  '3. JSON 结构：',
  '{"summary":"一句话结论（≤40 字）","cause":"可能原因（2-4 句，引用给出数据里的具体数值）",',
  '"steps":["步骤1","步骤2","步骤3"],"confidence":"high|medium|low","evidence":["引用的关键数据"]}',
  '4. summary：说清哪里出了问题，一句话，不带句号以外的标点堆叠。',
  '5. cause：先给判断，再给依据（引用数值），不要罗列所有字段。',
  '6. steps：3 条讲师照着就能做的动作，按执行顺序排，动词开头，不要「请检查」这类空话。',
  '7. evidence：2-5 条直接从给定数据里摘的关键数值，不要改写数值；不要摘频道号，也不要把「无记录 / 数据不足」当证据。',
].join('\n');

function buildMessages(
  channelId: string,
  input: AnalyzeInput,
  records: DiagnosticRecord[],
  stats: MetricsSummary,
  device: DeviceSnapshot | null,
): AiMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(channelId, input, records, stats, device) },
  ];
}

function buildUserPrompt(
  channelId: string,
  input: AnalyzeInput,
  records: DiagnosticRecord[],
  stats: MetricsSummary,
  device: DeviceSnapshot | null,
): string {
  const lines: string[] = [`频道号：${channelId}`, `当前规则结论：${verdictLine(input)}`];
  lines.push(`指标统计：${metricsLine(stats)}`);
  if (stats.outages.length > 0) lines.push(`断流区间：${outageLine(stats.outages)}`);
  lines.push(`诊断历史（最近 ${records.length} 条，新→旧）：`);
  if (records.length === 0) lines.push('- （无历史诊断记录）');
  for (const record of records) lines.push(`- ${recordLine(record)}`);
  if (device) lines.push(`推流设备：${deviceLine(device)}`);
  if (input.question) lines.push(`讲师补充：${input.question}`);
  return lines.join('\n');
}

function verdictLine(input: AnalyzeInput): string {
  if (!input.verdictId) return '推流端本次没有给出规则结论，请依据下面的历史数据判断';
  const meta = DIAGNOSTIC_META[input.verdictId];
  const reason = input.reason ?? meta.reason;
  return `${input.verdictId} ${meta.name}｜${reason}｜期望：${meta.expected}`;
}

function recordLine(record: DiagnosticRecord): string {
  const meta = DIAGNOSTIC_META[record.id];
  const parts = [
    `${record.id} ${meta.name}`,
    record.reason,
    `实测 ${record.measured}`,
    `首次 ${hhmmss(record.firstAt)}`,
    `最近 ${hhmmss(record.lastAt)}`,
    `发生 ${record.occurrences} 次`,
    record.recoveredAt ? `已恢复（${hhmmss(record.recoveredAt)}）` : '未恢复',
  ];
  if (record.outageMs !== null) parts.push(`断流 ${secondsText(record.outageMs)}`);
  return parts.join('｜');
}

function deviceLine(device: DeviceSnapshot): string {
  const parts = [device.os, device.cpuCores ? `${device.cpuCores} 核` : null, device.deviceMemoryGb ? `${device.deviceMemoryGb}GB 内存` : null, device.gpuRenderer, device.screen]
    .filter((part): part is string => Boolean(part))
    .join('｜');
  return parts || '未知';
}

/* ---------------- 指标统计（降采样） ---------------- */

/** 把 120 条原始采样压成「最低 / 最高 / 均值 + 断流区间」 */
function summarizeMetrics(samples: MetricSample[]): MetricsSummary {
  const kbps = samples.map((sample) => sample.kbps).filter(isNumber);
  const fps = samples.map((sample) => sample.fps).filter(isNumber);
  const times = samples.map((sample) => Date.parse(sample.at)).filter((at) => !Number.isNaN(at));
  const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  return {
    count: samples.length,
    minutes: Math.max(1, Math.round(spanMs / 60_000)),
    minKbps: kbps.length > 0 ? Math.round(Math.min(...kbps)) : null,
    maxKbps: kbps.length > 0 ? Math.round(Math.max(...kbps)) : null,
    avgKbps: kbps.length > 0 ? Math.round(average(kbps)) : null,
    minFps: fps.length > 0 ? round1(Math.min(...fps)) : null,
    avgFps: fps.length > 0 ? round1(average(fps)) : null,
    outages: joinOutages(samples),
  };
}

/** 连续的非 connected 采样合并成一段断流（`to` 为 null 表示到最后一个采样还没恢复） */
function joinOutages(samples: MetricSample[]): OutageWindow[] {
  const outages: OutageWindow[] = [];
  let open: number | null = null;
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    if (Number.isNaN(at)) continue;
    const down = sample.connection !== 'connected';
    if (down && open === null) open = at;
    if (!down && open !== null) {
      outages.push({ from: open, to: at });
      open = null;
    }
  }
  if (open !== null) outages.push({ from: open, to: null });
  return outages.slice(-5);
}

function metricsLine(stats: MetricsSummary): string {
  if (stats.count === 0) return '最近没有指标采样（推流端可能还没开播）';
  const parts = [
    `最近 ${stats.minutes} 分钟共 ${stats.count} 条采样（每 5 秒一条）`,
    stats.avgKbps === null
      ? '码率数据不足'
      : `码率 最低 ${stats.minKbps} kbps / 最高 ${stats.maxKbps} kbps / 均值 ${stats.avgKbps} kbps`,
    stats.avgFps === null ? '帧率数据不足' : `帧率 均值 ${stats.avgFps} fps / 最低 ${stats.minFps} fps`,
  ];
  return parts.join('；');
}

function outageLine(outages: OutageWindow[]): string {
  return outages
    .map((outage) =>
      outage.to === null
        ? `${hhmmss(outage.from)} 起断流，到最后一个采样仍未恢复`
        : `${hhmmss(outage.from)}–${hhmmss(outage.to)}（${secondsText(outage.to - outage.from)}）`,
    )
    .join('；');
}

/* ---------------- 规则兜底（无 key / 报错 / 超时） ---------------- */

/**
 * 兜底解释：用已有规则结论 + 指标统计拼一段固定中文。
 * 措辞保持客户向、不承诺未验证的因果，`confidence` 固定 low。
 */
function buildFallback(
  input: AnalyzeInput,
  records: DiagnosticRecord[],
  stats: MetricsSummary,
): Omit<AnalyzeResult, 'channelId' | 'source' | 'model' | 'tookMs'> {
  const verdict = input.verdictId ? DIAGNOSTIC_META[input.verdictId] : null;
  const latest = records[0] ?? null;
  const summary = verdict
    ? truncate(`${verdict.name}：${input.reason ?? verdict.reason}`, SUMMARY_MAX)
    : latest
      ? truncate(`${DIAGNOSTIC_META[latest.id].name}：${latest.reason}`, SUMMARY_MAX)
      : '暂无足够数据：还没有诊断记录和指标采样';

  const causeParts: string[] = [];
  if (verdict) {
    causeParts.push(`现有规则判定为「${verdict.name}」（${input.reason ?? verdict.reason}），期望是${verdict.expected}。`);
  } else if (latest) {
    causeParts.push(
      `最近一次诊断是「${DIAGNOSTIC_META[latest.id].name}」（${latest.reason}），实测 ${latest.measured}，期望 ${latest.expected}。`,
    );
  }
  causeParts.push(stats.count > 0 ? `实测数据看：${metricsLine(stats)}。` : '本次没有拿到指标采样，无法给出量化依据。');
  if (stats.outages.length > 0) causeParts.push(`期间出现断流：${outageLine(stats.outages)}。`);
  causeParts.push('AI 解释当前不可用，以上是规则引擎与实测数据的直接结论。');

  const steps: string[] = [];
  if (verdict) steps.push(`按自检条的下一步操作：${verdict.actionLabel}`);
  steps.push('改用有线网络或换成稳定的 Wi-Fi，确认上行带宽充足后重新连接');
  steps.push('把诊断历史与指标数据导出，附上诊断码发给保利威技术支持');

  const evidence: string[] = [];
  if (latest) evidence.push(`${latest.id} 实测 ${latest.measured}（期望 ${latest.expected}）`);
  if (stats.count > 0) {
    evidence.push(`码率 最低 ${stats.minKbps} kbps / 最高 ${stats.maxKbps} kbps / 均值 ${stats.avgKbps} kbps`);
    evidence.push(`帧率 均值 ${stats.avgFps} fps / 最低 ${stats.minFps} fps`);
  }
  if (stats.outages.length > 0) evidence.push(`断流：${outageLine(stats.outages)}`);

  return { summary, cause: causeParts.join(''), steps, confidence: 'low', evidence };
}

/* ---------------- 解析（JSON.parse + 容错提取） ---------------- */

/**
 * 解析模型输出：先直接 `JSON.parse`，失败再退一步取第一个 `{` 到最后一个 `}` 之间那段。
 * 结构不合格（缺 summary / cause / steps）视为失败 → 走规则兜底，绝不把半个结构发给前端。
 */
function parseAnalysis(raw: string): ParsedAnalysis | null {
  const payload = extractJsonObject(raw);
  if (!payload) return null;
  const summary = asText(payload.summary);
  const cause = asText(payload.cause);
  const steps = asTextList(payload.steps);
  if (!summary || !cause || steps.length === 0) return null;
  return {
    summary: truncate(summary, SUMMARY_MAX),
    cause,
    steps: steps.slice(0, 6),
    confidence: asConfidence(payload.confidence),
    evidence: asTextList(payload.evidence).slice(0, 6),
  };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidates = [text];
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 换下一个候选：模型偶尔会包一层 ```json ``` 或写一句开场白
    }
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asText(item))
    .filter((item): item is string => item !== null);
}

function asConfidence(value: unknown): AiConfidence {
  const text = asText(value)?.toLowerCase();
  return text === 'high' || text === 'low' ? text : 'medium';
}

/* ---------------- 小工具 ---------------- */

function isNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function secondsText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${seconds} 秒`;
}

/** ISO（或毫秒时间戳）→ 本地 `HH:MM:SS`（给模型看的时间尽量短，不占 token） */
function hhmmss(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
