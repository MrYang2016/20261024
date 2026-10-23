import type {
  ApiErrorBody,
  ChannelInfo,
  DeviceSnapshot,
  DiagnosticRecord,
  DiagnosticReport,
  DiagnosticStoreResult,
  LiveStatusSnapshot,
  MetricSample,
  MetricsResponse,
  MetricStoreResult,
  PushSessionState,
} from '@live1024/shared';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** 服务端返回的错误（已翻译成客户向一句话） */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiRequestError(0, -1, '连不上服务端，请确认 API 服务已启动（默认 3000 端口）');
  }

  const text = await response.text();
  const body = text ? safeParse(text) : null;

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null;
    throw new ApiRequestError(
      response.status,
      errorBody?.code ?? response.status,
      errorBody?.message ?? '请求失败，请稍后重试',
    );
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 健康探测超时：3 秒（D38） */
export const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * 预检网络探测（D38 / D39）：打一次 `GET /api/health`，超时 3 秒。
 *
 * 只回布尔、**绝不抛错**：探测不通是「诊断结论」，不是异常——不能让它影响推流主链路。
 *
 * 判定「通」要同时满足三件事（D39 / D40）：
 * 1. `response.ok === true`——服务端在 Polyv 上游不可达时回 503，不能只判「有没有 HTTP 响应」；
 * 2. 响应体解析出来是 JSON，且 `ok !== false`；
 * 3. `polyv === 'reachable'`——浏览器到 `127.0.0.1` 走回环，断网也连得上本进程，
 *    只有服务端替我们探过的上游结论才算数。只认白名单：`unreachable`（上游不可达 / 未配置凭证）
 *    与任何未知值都算不通，避免服务端多回一个字段值就把预检放绿。
 * 解析失败（非 JSON）/ 超时 / 任何异常一律当「没探测通」。
 */
export async function probeHealth(timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_BASE}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    // 不是 JSON（代理页、登录跳转页等）不能当成「通」
    const body = (await response.json()) as { ok?: unknown; polyv?: unknown } | null;
    if (!body || typeof body !== 'object') return false;
    if (body.ok === false) return false;
    // D40：只认白名单值，`unreachable` 与未知值都不算通
    return body.polyv === 'reachable';
  } catch {
    // 超时（AbortError）/ 网络失败 / JSON 解析失败：都按「连不上服务器」处理
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const liveApi = {
  createChannel(name: string): Promise<ChannelInfo> {
    return request<ChannelInfo>('/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  getChannel(channelId: string): Promise<ChannelInfo> {
    return request<ChannelInfo>(`/channels/${encodeURIComponent(channelId)}`);
  },

  getLiveStatus(channelId: string): Promise<LiveStatusSnapshot> {
    return request<LiveStatusSnapshot>(`/channels/${encodeURIComponent(channelId)}/live-status`);
  },

  reportPushSession(channelId: string, state: PushSessionState): Promise<unknown> {
    return request<unknown>(`/channels/${encodeURIComponent(channelId)}/push-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
  },

  /** 上报一条诊断（D23 留痕，内存态） */
  reportDiagnostic(channelId: string, report: DiagnosticReport): Promise<DiagnosticStoreResult> {
    return request<DiagnosticStoreResult>(`/channels/${encodeURIComponent(channelId)}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  },

  /** 读该频道的诊断历史（最近 limit 条，服务端上限 50） */
  listDiagnostics(
    channelId: string,
    limit = 50,
  ): Promise<{ channelId: string; items: DiagnosticRecord[]; device?: DeviceSnapshot | null }> {
    return request<{ channelId: string; items: DiagnosticRecord[]; device?: DeviceSnapshot | null }>(
      `/channels/${encodeURIComponent(channelId)}/diagnostics?limit=${limit}`,
    );
  },

  /**
   * 上报会话设备快照（D36）：只带 `device` 不带 `id`，服务端只更新「最近一次会话设备」，
   * 不产生诊断记录（诊断枚举里没有「设备」这一项，也不应该有）。
   */
  reportDeviceSnapshot(channelId: string, device: DeviceSnapshot): Promise<DiagnosticStoreResult> {
    return request<DiagnosticStoreResult>(`/channels/${encodeURIComponent(channelId)}/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device }),
    });
  },

  /** 上报一条指标采样（D34 时间序列，内存态） */
  reportMetric(channelId: string, sample: MetricSample): Promise<MetricStoreResult> {
    return request<MetricStoreResult>(`/channels/${encodeURIComponent(channelId)}/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
  },

  /** 读该频道的指标时间序列（按 at 升序，服务端上限 300） */
  listMetrics(channelId: string, limit = 300): Promise<MetricsResponse> {
    return request<MetricsResponse>(
      `/channels/${encodeURIComponent(channelId)}/metrics?limit=${limit}`,
    );
  },
};
