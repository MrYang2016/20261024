import { Injectable, Logger } from '@nestjs/common';
import { loadEnvFiles } from '../env';

/** 一条对话消息（OpenAI 兼容口径） */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatOptions {
  /** 采样温度（诊断解释要稳定，缺省 0.2） */
  temperature?: number;
  /** 输出上限（缺省 900，够写 2-4 句原因 + 3 条步骤） */
  maxTokens?: number;
  /** 让上游按 JSON 对象输出（deepseek-chat 支持 `response_format: { type: 'json_object' }`） */
  jsonObject?: boolean;
  /** 超时（毫秒，缺省 25 秒） */
  timeoutMs?: number;
}

export interface AiChatResult {
  /** 上游返回的文本内容（`choices[0].message.content`） */
  content: string;
  /** 实际使用的模型名（上游回什么算什么，缺省回落配置值） */
  model: string;
}

/** 上游超时：25 秒（讲师点「让 AI 分析」后最多等这么久，再久就走规则兜底） */
export const AI_TIMEOUT_MS = 25_000;

const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

export interface DeepSeekConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/**
 * 读 DeepSeek 配置。**没有 key 返回 null**（调用方走规则兜底，不抛错——缺 key 是部署态，
 * 不是客户的问题）。key 只在服务端进程内使用，绝不出现在响应体 / 日志 / 前端 bundle 里。
 */
export function getDeepSeekConfig(): DeepSeekConfig | null {
  loadEnvFiles();
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: (process.env.DEEPSEEK_MODEL ?? '').trim() || DEFAULT_MODEL,
    baseUrl: ((process.env.DEEPSEEK_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

/**
 * DeepSeek（OpenAI 兼容）客户端：一次 `POST {base}/chat/completions`。
 *
 * 契约：**永不抛错**。缺 key / 网络失败 / 上游报错 / 超时一律返回 `null`，
 * 由 `AiService` 拼规则兜底回答——AI 不可用不能变成「分析功能 500」。
 */
@Injectable()
export class AiClient {
  private readonly logger = new Logger(AiClient.name);

  async chat(messages: AiMessage[], options: AiChatOptions = {}): Promise<AiChatResult | null> {
    const config = getDeepSeekConfig();
    if (!config) return null;

    const timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 900,
          ...(options.jsonObject ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 只记状态码：错误体可能回显请求内容，日志里不留任何上下文
        this.logger.warn(`AI 上游返回 HTTP ${response.status}，本次分析走规则兜底`);
        return null;
      }

      const body = (await response.json()) as {
        model?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
      } | null;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        this.logger.warn('AI 上游返回空内容，本次分析走规则兜底');
        return null;
      }
      return { content, model: typeof body?.model === 'string' ? body.model : config.model };
    } catch (error) {
      const aborted = (error as { name?: string } | null)?.name === 'AbortError';
      this.logger.warn(
        aborted ? `AI 请求超时（${timeoutMs}ms），本次分析走规则兜底` : 'AI 请求失败，本次分析走规则兜底',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
