import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { ApiErrorBody } from '@live1024/shared';
import {
  type MetricConnection,
  type MetricSample,
  type MetricsResponse,
  type MetricStoreResult,
} from '@live1024/shared/diagnostics';
import { MetricsService } from './metrics.service';

/** 频道号口径与 channel.controller.ts 的 assertChannelId 一致（`/^\d{4,20}$/`） */
const CHANNEL_ID_PATTERN = /^\d{4,20}$/;
const INVALID_CHANNEL_ID: ApiErrorBody = { code: 400, message: '频道号格式不正确' };
const INVALID_CONNECTION: ApiErrorBody = { code: 400, message: '上行连接状态不合法' };
const INVALID_SAMPLE: ApiErrorBody = { code: 400, message: '指标采样数据不完整' };
const INVALID_AT: ApiErrorBody = { code: 400, message: '采样时间不合法' };
const INVALID_KBPS: ApiErrorBody = { code: 400, message: '码率必须是数字' };
const INVALID_FPS: ApiErrorBody = { code: 400, message: '帧率必须是数字' };
const INVALID_DROP_FPS: ApiErrorBody = { code: 400, message: '丢帧率必须是数字' };

/** 与推流传输层的连接态同口径（apps/pusher/src/transports/types.ts 的 PushConnectionStatus） */
const CONNECTIONS: readonly MetricConnection[] = [
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
];

/** POST 体按脏数据处理：只接受契约里的字段 */
interface MetricSampleBody {
  kbps?: unknown;
  fps?: unknown;
  dropFps?: unknown;
  connection?: unknown;
  at?: unknown;
}

/**
 * 指标时间序列接口（D34 / 计划 §十一 A）：
 *   POST /api/channels/:channelId/metrics → 201 `{ channelId, stored, total }`
 *   GET  /api/channels/:channelId/metrics?limit=300 → `{ channelId, items }`（按 at 升序）
 * 只做内存留痕，不引数据库；错误体走统一的 ApiErrorBody（客户向一句话）。
 */
@Controller('channels/:channelId/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {
    // 控制器方法常被当作引用传递，构造时绑定 this，避免调用时丢上下文
    this.report = this.report.bind(this);
    this.list = this.list.bind(this);
  }

  @Post()
  report(
    @Param('channelId') channelId: string,
    @Body() body: MetricSampleBody | undefined,
  ): MetricStoreResult {
    const id = assertChannelId(channelId);
    return this.metrics.record(id, toSample(body));
  }

  @Get()
  list(
    @Param('channelId') channelId: string,
    @Query('limit') limit?: string,
  ): MetricsResponse {
    const id = assertChannelId(channelId);
    return { channelId: id, items: this.metrics.list(id, limit) };
  }
}

function assertChannelId(channelId: string): string {
  if (!CHANNEL_ID_PATTERN.test(channelId ?? '')) {
    throw new BadRequestException(INVALID_CHANNEL_ID);
  }
  return channelId;
}

/**
 * 校验 + 归一一条采样。
 * - `at` / `kbps` / `fps` 必填且必须合法（脏值不进内存，否则画出来的曲线会有一个没有时间的点）；
 * - `dropFps` 可选（SDK 未暴露丢帧时客户端传 null）；
 * - `connection` 必须是传输层枚举之一。
 */
function toSample(body: MetricSampleBody | undefined): MetricSample {
  if (!body || typeof body !== 'object') throw new BadRequestException(INVALID_SAMPLE);

  const connection = body.connection;
  if (typeof connection !== 'string' || !(CONNECTIONS as readonly string[]).includes(connection)) {
    throw new BadRequestException(INVALID_CONNECTION);
  }

  const at = toIsoString(body.at);
  if (!at) throw new BadRequestException(INVALID_AT);

  const kbps = toAmount(body.kbps);
  if (kbps === null) throw new BadRequestException(INVALID_KBPS);

  const fps = toAmount(body.fps);
  if (fps === null) throw new BadRequestException(INVALID_FPS);

  // 可选字段：不传 / 传 null 当作「拿不到」，传了就必须是数字
  const hasDropFps = body.dropFps !== undefined && body.dropFps !== null;
  const dropFps = hasDropFps ? toAmount(body.dropFps) : null;
  if (hasDropFps && dropFps === null) throw new BadRequestException(INVALID_DROP_FPS);

  return {
    kbps,
    fps,
    dropFps,
    connection: connection as MetricConnection,
    at,
  };
}

/** 非负有限数才收；其余（undefined / 字符串 / NaN / 负数）一律 null */
function toAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

function toIsoString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
