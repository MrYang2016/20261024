import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorBody } from '@live1024/shared';
import { CHANNEL_NOT_FOUND_PATTERN, isChannelNotFound, PolyvUpstreamError } from './polyv-errors';

/** 客户向兜底文案：上游失败时只给一句能行动的中文，不透传上游原始报文 */
const UPSTREAM_FAILED: ApiErrorBody = {
  code: 502,
  message: '上游服务暂时不可用，请稍后重试',
};

const TEMPLATE_MISMATCH: ApiErrorBody = {
  code: 502,
  message: '频道模板不是纯视频，无法用于第三方推流，请在直播后台改为纯视频模板后重试',
};

const CHANNEL_NOT_FOUND: ApiErrorBody = {
  code: 404,
  message: '频道不存在，请确认频道号后重试',
};

interface UpstreamDetail {
  /** 上游原始描述，只用于分类，绝不写进响应体 */
  message: string;
  /** 模板相关（模板不符/第三方推流不支持） */
  templateRelated: boolean;
  channelNotFound: boolean;
}

/**
 * 上游错误 → 502（或 404）客户向错误。
 * 入参兼容三种形态：PolyvUpstreamError、`{ status, data: { code, message } }` 形状的上游报文、任意其它错误。
 * 出参统一为 HttpException，响应体只有 `{ code, message }`。
 */
export function toUpstreamError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;

  const detail = describeUpstream(error);
  if (detail.channelNotFound) {
    return new HttpException(CHANNEL_NOT_FOUND, HttpStatus.NOT_FOUND);
  }
  if (detail.templateRelated) {
    return new HttpException(TEMPLATE_MISMATCH, HttpStatus.BAD_GATEWAY);
  }
  return new HttpException(UPSTREAM_FAILED, HttpStatus.BAD_GATEWAY);
}

function describeUpstream(error: unknown): UpstreamDetail {
  const message = extractMessage(error);
  return {
    message,
    templateRelated: /template|模板|not alone|third-party push/i.test(message),
    channelNotFound: isChannelNotFound(error) || CHANNEL_NOT_FOUND_PATTERN.test(message),
  };
}

/** 从各种错误形态里挖出「上游说了什么」，只用于内部分类 */
function extractMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof PolyvUpstreamError) return `${error.name} ${error.message}`;
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: unknown;
      desc?: unknown;
      data?: { message?: unknown; desc?: unknown; error?: { desc?: unknown } } | null;
    };
    const nested = candidate.data;
    const pieces = [
      candidate.message,
      candidate.desc,
      nested?.message,
      nested?.desc,
      nested?.error?.desc,
    ];
    return pieces.filter((piece): piece is string => typeof piece === 'string').join(' ');
  }
  return '';
}
