import type { ApiErrorBody, ChannelInfo, LiveStatusSnapshot } from '@live1024/shared';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

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

async function request<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, { headers: { Accept: 'application/json' } });
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

/** health 探测的默认超时：3 秒（与推流端预检同一口径） */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * 探测「服务端 + 上游」是否可达（观众侧自检 W1 的输入）。
 *
 * 只认 200 + `ok !== false` + `polyv === 'reachable'`：
 * 上游不可达是 503、缺凭证是 200 + `polyv:'unreachable'`，两者都不能当成「网是通的」——
 * 观众真正关心的是「能不能看到画面」，不是「本机进程活着」。
 * 超时 / 网络失败 / 非 JSON（代理页）一律按「连不上」处理，不向上抛。
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
    const body = (await response.json()) as { ok?: unknown; polyv?: unknown } | null;
    if (!body || typeof body !== 'object') return false;
    if (body.ok === false) return false;
    return body.polyv === 'reachable';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const watchApi = {
  getChannel(channelId: string): Promise<ChannelInfo> {
    return request<ChannelInfo>(`/channels/${encodeURIComponent(channelId)}`);
  },

  getLiveStatus(channelId: string): Promise<LiveStatusSnapshot> {
    return request<LiveStatusSnapshot>(`/channels/${encodeURIComponent(channelId)}/live-status`);
  },

  /**
   * 预留：有观看条件的频道需要服务端下发 watch token。
   * 本期频道都是无鉴权频道，直接安装观看页 SDK 即可，这里只留占位。
   */
  // getWatchToken(channelId: string): Promise<{ token: string }> {
  //   return request(`/channels/${encodeURIComponent(channelId)}/watch-token`);
  // },
};
