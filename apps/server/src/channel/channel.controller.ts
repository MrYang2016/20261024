import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import type {
  ApiErrorBody,
  ChannelInfo,
  LiveStatusSnapshot,
  PushSessionState,
} from '@live1024/shared';
import { ChannelService } from './channel.service';
import { toUpstreamError } from '../polyv/upstream-error';

const CHANNEL_ID_PATTERN = /^\d{4,20}$/;

@Controller('channels')
export class ChannelController {
  private readonly logger = new Logger(ChannelController.name);

  constructor(private readonly channels: ChannelService) {}

  /** 新建频道并返回推流凭证 */
  @Post()
  async create(@Body() body: { name?: unknown } | undefined): Promise<ChannelInfo> {
    const name = typeof body?.name === 'string' ? body.name : undefined;
    try {
      return await this.channels.createChannel(name);
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /** 频道信息 + 一条新的推流地址 */
  @Get(':channelId')
  async detail(@Param('channelId') channelId: string): Promise<ChannelInfo> {
    const id = assertChannelId(channelId);
    try {
      return await this.channels.getChannel(id);
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /** 直播状态与观看数 */
  @Get(':channelId/live-status')
  async liveStatus(@Param('channelId') channelId: string): Promise<LiveStatusSnapshot> {
    const id = assertChannelId(channelId);
    try {
      return await this.channels.getLiveStatus(id);
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  /**
   * 推流端上报本地推流会话（started 需每 60s 续期，stopped 在停止后上报一次）。
   * 平台状态接口对 API 新建频道不可靠，本地会话用于校正直播状态。
   */
  @Post(':channelId/push-session')
  pushSession(
    @Param('channelId') channelId: string,
    @Body() body: { state?: unknown } | undefined,
  ): { channelId: string; state: PushSessionState; updatedAt: string } {
    const id = assertChannelId(channelId);
    const state = body?.state;
    if (state !== 'started' && state !== 'stopped') {
      throw new BadRequestException({
        code: 400,
        message: '推流状态只能是 started 或 stopped',
      } satisfies ApiErrorBody);
    }
    return this.channels.reportPushSession(id, state);
  }

  /**
   * 预留：`GET /channels/:channelId/watch-token`。
   * 本期频道都是无观看条件的频道，观看页直接装观看页 SDK 即可，所以不实现；
   * 将来接有观看条件（验证码 / 付费 / 授权）的频道时在这里下发 watch token。
   */

  /** 上游错误统一翻译成客户向一句话；上游原始报文只进服务端日志 */
  private toHttpError(error: unknown): HttpException {
    if (!(error instanceof HttpException)) {
      this.logger.warn(`频道接口失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return toUpstreamError(error);
  }
}

function assertChannelId(channelId: string): string {
  if (!CHANNEL_ID_PATTERN.test(channelId ?? '')) {
    throw new BadRequestException({ code: 400, message: '频道号格式不正确' } satisfies ApiErrorBody);
  }
  return channelId;
}
