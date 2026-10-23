import { Injectable, Logger } from '@nestjs/common';
import { getPolyvConfig } from '../env';
import { signRequest, type SignParams } from './sign';
import { PolyvUpstreamError } from './polyv-errors';
import type { PolyvEnvelope } from './polyv.types';

const API_BASE = 'https://api.polyv.net';
const TIMEOUT_MS = 8_000;

/**
 * Polyv 公开 API 薄封装。
 * - 鉴权参数（appId / timestamp / sign）一律放 query，POST 业务参数走 JSON body（create-init 的契约要求）
 * - 非 200 / code != 200 统一抛 PolyvUpstreamError，由上层翻译成客户向文案
 */
@Injectable()
export class PolyvClient {
  private readonly logger = new Logger(PolyvClient.name);

  async get<T>(path: string, params: SignParams): Promise<T> {
    return this.request<T>('GET', path, params);
  }

  async post<T>(path: string, params: SignParams, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, params, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, params: SignParams, body?: unknown): Promise<T> {
    const { appId, appSecret } = getPolyvConfig();
    const signed = signRequest(params, appId, appSecret);
    const query = new URLSearchParams(
      Object.entries(signed).map(([key, value]): [string, string] => [key, String(value)]),
    ).toString();
    const url = `${API_BASE}${path}?${query}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      this.logger.warn(`Polyv ${method} ${path} 网络失败: ${String(error)}`);
      throw new PolyvUpstreamError(-1, 'network unreachable');
    }

    const text = await response.text();
    const envelope = parseEnvelope<T>(text);
    if (!envelope) {
      this.logger.warn(`Polyv ${method} ${path} 返回非 JSON（HTTP ${response.status}）: ${text.slice(0, 200)}`);
      throw new PolyvUpstreamError(response.status, `unexpected response (http ${response.status})`, response.status);
    }

    if (!response.ok || envelope.code !== 200) {
      const desc = envelope.error?.desc ?? envelope.message ?? envelope.status ?? 'unknown error';
      this.logger.warn(`Polyv ${method} ${path} 业务失败: http=${response.status} code=${envelope.code} desc=${desc}`);
      throw new PolyvUpstreamError(envelope.error?.code ?? envelope.code, desc, response.status);
    }

    return envelope.data as T;
  }
}

function parseEnvelope<T>(text: string): PolyvEnvelope<T> | null {
  try {
    const parsed = JSON.parse(text) as PolyvEnvelope<T>;
    return typeof parsed?.code === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
