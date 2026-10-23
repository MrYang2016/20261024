import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import type { ApiErrorBody } from '@live1024/shared';
import { DIAGNOSTIC_IDS, type DiagnosticId } from '@live1024/shared/diagnostics';
import { AiService, type AnalyzeInput, type AnalyzeResult } from './ai.service';

/** 频道号口径与 channel.controller.ts 的 assertChannelId 一致（`/^\d{4,20}$/`） */
const CHANNEL_ID_PATTERN = /^\d{4,20}$/;
const INVALID_CHANNEL_ID: ApiErrorBody = { code: 400, message: '频道号格式不正确' };
const INVALID_DIAGNOSTIC_ID: ApiErrorBody = { code: 400, message: '诊断项不合法' };

/** 讲师补充的话按脏数据处理：解不出的直接丢掉，不因为一句多余字段就 400 */
const REASON_MAX = 120;
const QUESTION_MAX = 200;

/**
 * AI 诊断解释接口：
 *   POST /api/channels/:channelId/analyze → 200 `AnalyzeResult`
 * 请求体所有字段都可选（`{ verdictId?, reason?, question? }`）：
 * 推流端点上「让 AI 分析」时会带上当前规则结论，没有结论时也能只分析历史数据。
 *
 * 降级口径：**缺少 DEEPSEEK_API_KEY 仍回 200**（`source: 'rules'`）——
 * AI 是增值能力，环境没配好不该让讲师看到错误页。
 */
@Controller('channels/:channelId/analyze')
export class AiController {
  constructor(private readonly ai: AiService) {
    // 控制器方法常被当作引用传递，构造时绑定 this，避免调用时丢上下文
    this.analyze = this.analyze.bind(this);
  }

  @Post()
  analyze(@Param('channelId') channelId: string, @Body() body: unknown): Promise<AnalyzeResult> {
    const id = assertChannelId(channelId);
    return this.ai.analyze(id, toInput(body));
  }
}

function assertChannelId(channelId: string): string {
  if (!CHANNEL_ID_PATTERN.test(channelId ?? '')) {
    throw new BadRequestException(INVALID_CHANNEL_ID);
  }
  return channelId;
}

/** 校验 + 归一体：`verdictId` 必须是一期 7 条之一（脏枚举进提示词会让模型解释不存在的诊断） */
function toInput(body: unknown): AnalyzeInput {
  const source = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const verdictId = source.verdictId;
  if (verdictId !== undefined && verdictId !== null) {
    if (typeof verdictId !== 'string' || !(DIAGNOSTIC_IDS as readonly string[]).includes(verdictId)) {
      throw new BadRequestException(INVALID_DIAGNOSTIC_ID);
    }
  }
  return {
    verdictId: verdictId === undefined || verdictId === null ? undefined : (verdictId as DiagnosticId),
    reason: clampText(source.reason, REASON_MAX),
    question: clampText(source.question, QUESTION_MAX),
  };
}

function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}
