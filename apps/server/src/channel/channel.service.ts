import { Injectable, Logger } from '@nestjs/common';
import type { ChannelInfo, LiveStatus, LiveStatusSnapshot, PushSessionState } from '@live1024/shared';
import { randomInt } from 'node:crypto';
import { PolyvClient } from '../polyv/polyv.client';
import { isChannelNotFound, PolyvUpstreamError } from '../polyv/polyv-errors';
import { extractStreamName, isRtmpUrl, toWebrtcUrl } from '../polyv/url';
import type {
  PolyvChannelBasic,
  PolyvChannelCreateResult,
  PolyvLiveStatusItem,
} from '../polyv/polyv.types';
import { PushSessionRegistry } from '../realtime/push-session.registry';
import { toLiveStatus } from './live-status';

const WATCH_URL_BASE = 'https://live.polyv.cn/watch';
const PURE_VIDEO_TEMPLATE = 'alone';
const MAX_NAME_LENGTH = 50;

/** Polyv 只对纯视频模板开放第三方推流；模板不符时后续推流必失败，所以在服务端硬校验 */
export class TemplateMismatchError extends Error {
  constructor(readonly template: string) {
    super(`channel template is "${template}", expect "${PURE_VIDEO_TEMPLATE}"`);
    this.name = 'TemplateMismatchError';
  }
}

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    private readonly polyv: PolyvClient,
    private readonly sessions: PushSessionRegistry,
  ) {}

  /** 新建频道：create-init（纯视频模板）→ update-template 校正 → 取推流地址 */
  async createChannel(rawName?: string): Promise<ChannelInfo> {
    const name = normalizeChannelName(rawName);
    let created: PolyvChannelCreateResult;
    try {
      created = await this.polyv.post<PolyvChannelCreateResult>(
        '/live/v4/channel/create-init',
        {},
        {
          basicSetting: {
            name,
            newScene: PURE_VIDEO_TEMPLATE,
            template: PURE_VIDEO_TEMPLATE,
            channelPasswd: randomChannelPassword(),
            type: 'normal',
            linkMicLimit: 0,
            pureRtcEnabled: 'N',
          },
        },
      );
    } catch (error) {
      this.logger.warn(`新建频道失败: ${describe(error)}`);
      throw new PolyvUpstreamError(-2, 'create channel failed');
    }

    const channelId = String(created?.channelId ?? '');
    if (!channelId) {
      throw new PolyvUpstreamError(-3, 'create channel returned empty channelId');
    }

    const basic = await this.ensurePureVideoTemplate(channelId);
    return this.buildChannelInfo(channelId, name, basic);
  }

  /** 已有频道：校验模板并取一条新的推流地址 */
  async getChannel(channelId: string): Promise<ChannelInfo> {
    const basic = await this.fetchBasic(channelId);
    if (basic.template !== PURE_VIDEO_TEMPLATE) {
      throw new TemplateMismatchError(basic.template);
    }
    return this.buildChannelInfo(channelId, basic.name);
  }

  /** 直播状态：平台状态 + 推流端本地会话（内存态）合并 */
  async getLiveStatus(channelId: string): Promise<LiveStatusSnapshot> {
    const platformStatus = await this.fetchPlatformLiveStatus(channelId);
    // 频道不存在必须与 GET /channels/:id 同口径（404），不能被「观看数按 0 处理」吞掉
    const basic = await this.fetchBasic(channelId).catch((error: unknown) => {
      if (isChannelNotFound(error)) throw error;
      this.logger.warn(`拉频道信息失败，观看数按 0 处理: ${describe(error)}`);
      return null;
    });

    const status = this.resolveLiveStatus(channelId, platformStatus);
    return {
      liveStatus: status,
      // 公开 API 只提供累计观看人次（pageView），没有实时在线人数
      viewerCount: Math.max(0, Number(basic?.pageView ?? 0)),
    };
  }

  /** 推流会话上报（推流端 start / heartbeat / stop 都走这里） */
  reportPushSession(channelId: string, state: PushSessionState): { channelId: string; state: PushSessionState; updatedAt: string } {
    const session = this.sessions.mark(channelId, state);
    return { channelId, state: session.state, updatedAt: new Date(session.updatedAt).toISOString() };
  }

  async fetchBasic(channelId: string): Promise<PolyvChannelBasic> {
    return this.polyv.get<PolyvChannelBasic>('/live/v4/channel/basic/get', { channelId });
  }

  private async fetchPlatformLiveStatus(channelId: string): Promise<LiveStatus> {
    try {
      const items = await this.polyv.get<PolyvLiveStatusItem[]>('/live/v4/channel/live-status/list', {
        channelIds: channelId,
      });
      const status = items?.[0]?.liveStatus;
      return toLiveStatus(status);
    } catch (error) {
      if (isChannelNotFound(error)) throw error;
      this.logger.warn(`查询直播状态失败，按未开始处理: ${describe(error)}`);
      return 'unStart';
    }
  }

  /**
   * 平台状态接口对 API 新建的频道不可靠（CONTEXT 实测：观众能看但接口报 unStart）。
   * 所以推流端本地会话优先级最高；推流端报过 stop 且平台还没跟上时判为已结束。
   */
  private resolveLiveStatus(channelId: string, platformStatus: LiveStatus): LiveStatus {
    if (this.sessions.isPushing(channelId)) return 'live';
    if (platformStatus === 'live' || platformStatus === 'playback') return platformStatus;
    if (this.sessions.hasRecentlyStopped(channelId)) return 'end';
    return platformStatus;
  }

  private async ensurePureVideoTemplate(channelId: string): Promise<PolyvChannelBasic> {
    await this.polyv.post('/live/v4/channel/update-template', {
      channelId,
      template: PURE_VIDEO_TEMPLATE,
    });
    const basic = await this.fetchBasic(channelId);
    if (basic.template !== PURE_VIDEO_TEMPLATE) {
      throw new TemplateMismatchError(basic.template);
    }
    return basic;
  }

  private async buildChannelInfo(
    channelId: string,
    fallbackName: string,
    knownBasic?: PolyvChannelBasic,
  ): Promise<ChannelInfo> {
    const basic = knownBasic ?? (await this.fetchBasic(channelId));
    if (basic.template !== PURE_VIDEO_TEMPLATE) {
      throw new TemplateMismatchError(basic.template);
    }

    const pushUrl = await this.polyv.get<string>('/live/v3/channel/stream/get-push-url', { channelId });
    if (typeof pushUrl !== 'string' || !isRtmpUrl(pushUrl)) {
      throw new PolyvUpstreamError(-4, 'push url is empty or not rtmp');
    }

    return {
      channelId,
      name: basic.name || fallbackName,
      watchUrl: basic.watchUrl || `${WATCH_URL_BASE}/${channelId}`,
      push: {
        rtmpUrl: pushUrl,
        webrtcUrl: toWebrtcUrl(pushUrl),
        expiresAt: parsePushUrlExpiresAt(pushUrl),
      },
      stream: extractStreamName(pushUrl),
      template: basic.template,
    };
  }
}

/**
 * 从推流地址的 `txTime`（**hex 秒**，腾讯云云直播约定）解出有效期。
 * 解不出（没有 txTime / 不是 hex / 时间非法）一律返回 null：D1 预检宁可没有数据，也不要假时间。
 */
export function parsePushUrlExpiresAt(pushUrl: string): string | null {
  let query: URLSearchParams;
  try {
    query = new URL(pushUrl).searchParams;
  } catch {
    return null;
  }

  const raw = query.get('txTime');
  if (!raw || !/^[0-9a-f]+$/i.test(raw)) return null;

  const seconds = Number.parseInt(raw, 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeChannelName(rawName?: string): string {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) return defaultChannelName();
  // 去掉控制字符：频道名会出现在观看页标题上，控制字符会造成排版异常
  const printable = Array.from(trimmed)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  return printable.slice(0, MAX_NAME_LENGTH) || defaultChannelName();
}

/** 默认频道名：日期时刻，避免演示时出现一堆「未命名」 */
function defaultChannelName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `直播 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 讲师登录密码：6-16 位、同时含字母与数字（Polyv 校验规则） */
function randomChannelPassword(): string {
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  let body = '';
  for (let index = 0; index < 6; index += 1) {
    body += letters[randomInt(letters.length)];
  }
  body += digits[randomInt(digits.length)];
  body += digits[randomInt(digits.length)];
  return body;
}

function describe(error: unknown): string {
  if (error instanceof PolyvUpstreamError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
