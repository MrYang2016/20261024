import type { DiagnosticId } from '@live1024/shared';

/**
 * 「让 AI 分析」的客户端（AI 解释诊断）。
 *
 * 服务端接口：`POST /api/channels/:channelId/analyze`。
 * 服务端已经有 25 秒的模型超时，这里再兜一层 30 秒——前端不能出现「点了没反应也不知道等多久」。
 * 失败一律抛 `AnalyzeError`（客户向一句话），由自检条原地显示 + 可重试。
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** 客户端总超时：30 秒（服务端模型超时 25 秒 + 网络余量） */
export const ANALYZE_TIMEOUT_MS = 30_000;

export type AnalyzeConfidence = 'high' | 'medium' | 'low';

/** 请求体：三个字段都可选——没有结论时也能只分析历史数据 */
export interface AnalyzePayload {
  verdictId?: DiagnosticId | null;
  reason?: string | null;
  question?: string | null;
}

/** 服务端响应（`source: 'rules'` = AI 不可用，规则引擎兜底） */
export interface DiagnosisAnalysis {
  channelId: string;
  source: 'llm' | 'rules';
  summary: string;
  cause: string;
  steps: string[];
  confidence: AnalyzeConfidence;
  evidence: string[];
  model: string;
  tookMs: number;
}

export type AnalyzeErrorKind = 'timeout' | 'network' | 'server' | 'invalid';

export class AnalyzeError extends Error {
  constructor(
    readonly kind: AnalyzeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyzeError';
  }
}

/**
 * 请求一次 AI 分析。
 *
 * 只做「请求 + 校验形状」，不做任何展示逻辑（自检条负责渲染）：
 * 服务端已经保证无 key / 模型失败时回 200 + `source: 'rules'`，所以这里只有真正的传输/形状问题才抛错。
 */
export async function analyzeDiagnosis(
  channelId: string,
  payload: AnalyzePayload = {},
): Promise<DiagnosisAnalysis> {
  const body: Record<string, string> = {};
  if (payload.verdictId) body.verdictId = payload.verdictId;
  if (payload.reason) body.reason = payload.reason;
  if (payload.question) body.question = payload.question;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/channels/${encodeURIComponent(channelId)}/analyze`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new AnalyzeError('timeout', 'AI 分析超时了，请再试一次');
    }
    throw new AnalyzeError('network', '连不上服务端，请确认网络后重试');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const parsed = text ? safeParse(text) : null;

  if (!response.ok) {
    const message = (parsed as { message?: unknown } | null)?.message;
    throw new AnalyzeError('server', typeof message === 'string' && message ? message : '分析失败，请稍后重试');
  }

  const analysis = toAnalysis(parsed);
  if (!analysis) throw new AnalyzeError('invalid', 'AI 返回内容无法解析，请再试一次');
  return analysis;
}

/** 置信度的中文展示（自检条用小字显示） */
export function confidenceText(confidence: AnalyzeConfidence): string {
  if (confidence === 'high') return '高';
  if (confidence === 'low') return '低';
  return '中';
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 形状校验：缺 summary / cause / steps 的响应当失败处理，
 * 不能让自检条渲染出一块空白（客户会以为功能坏了）。
 */
function toAnalysis(value: unknown): DiagnosisAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const summary = asText(source.summary);
  const cause = asText(source.cause);
  const steps = asList(source.steps);
  if (!summary || !cause || steps.length === 0) return null;
  return {
    channelId: asText(source.channelId) ?? '',
    source: source.source === 'llm' ? 'llm' : 'rules',
    summary,
    cause,
    steps,
    confidence: asConfidence(source.confidence),
    evidence: asList(source.evidence),
    model: asText(source.model) ?? '',
    tookMs: typeof source.tookMs === 'number' && Number.isFinite(source.tookMs) ? source.tookMs : 0,
  };
}

function asConfidence(value: unknown): AnalyzeConfidence {
  return value === 'high' || value === 'low' ? value : 'medium';
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}
