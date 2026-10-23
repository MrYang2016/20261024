import { Injectable } from '@nestjs/common';
import type { PushSessionState } from '@live1024/shared';

interface PushSession {
  state: PushSessionState;
  updatedAt: number;
}

/** 推流会话存活时间：推流端每 60s 续期一次，超过这个窗口视为已断（进程被杀也能自愈） */
const SESSION_TTL_MS = 150_000;
/** 推流端报过 stop 之后，这段时间内把平台侧还没跟上的状态判为已结束 */
const STOPPED_HOLD_MS = 10 * 60_000;

/**
 * 推流会话状态（内存态，无 DB）。
 * 第一期只服务直播状态判定；24061 的实时大纲 / AI 答疑会在这里拿到「是否正在推流」。
 */
@Injectable()
export class PushSessionRegistry {
  private readonly sessions = new Map<string, PushSession>();

  mark(channelId: string, state: PushSessionState): PushSession {
    const session: PushSession = { state, updatedAt: Date.now() };
    this.sessions.set(channelId, session);
    return session;
  }

  get(channelId: string): PushSession | undefined {
    return this.sessions.get(channelId);
  }

  isPushing(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (!session || session.state !== 'started') return false;
    return Date.now() - session.updatedAt < SESSION_TTL_MS;
  }

  hasRecentlyStopped(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (!session || session.state !== 'stopped') return false;
    return Date.now() - session.updatedAt < STOPPED_HOLD_MS;
  }
}
