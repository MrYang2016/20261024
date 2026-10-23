import { ApiRequestError } from './api';

export interface WatchErrorInfo {
  code: string;
  message: string;
  /** 下一步；服务端 message 已自带下一步时为空串（避免重复措辞） */
  nextStep: string;
}

/** 服务端 message 是否已经是一句带下一步的完整话（含「请…」「重试」「稍候」这类行动词） */
export function hasNextStep(message: string): boolean {
  return /请|重试|稍候|检查|确认|联系/.test(message);
}

/** 原因 + 下一步合成一句话；下一步为空时只用原因，不拼空尾巴 */
export function errorSentence(info: WatchErrorInfo): string {
  return info.nextStep ? `${info.message}，${info.nextStep}` : info.message;
}

/**
 * 观看侧错误 → 一句话原因 + 一个下一步。
 * 域名白名单问题单独归类：SDK 报错原文会被带进 detail，便于排查。
 */
export function mapWatchError(error: unknown): WatchErrorInfo & { detail?: string } {
  if (error instanceof ApiRequestError) {
    const message = error.message.trim();
    // 服务端已把上游错误翻译成「一句话原因 + 下一步」，不再拼后缀（否则会出现重复的「重试」）
    return {
      code: `api_${error.status}`,
      message,
      nextStep: hasNextStep(message) ? '' : '按提示处理后点重新连接',
    };
  }

  const detail = error instanceof Error ? error.message : String(error);
  const text = detail.toLowerCase();

  if (text.includes('domain') || detail.includes('域名') || text.includes('whitelist')) {
    return {
      code: 'domain_not_allowed',
      message: '观看页 SDK 不接受当前访问域名',
      nextStep: '把访问域名加入直播后台「开发设置-开发者信息」白名单后刷新',
      detail,
    };
  }

  if (text.includes('network') || text.includes('timeout') || text.includes('failed to fetch')) {
    return { code: 'network', message: '拉流失败，网络连接不稳定', nextStep: '检查网络后点重新连接', detail };
  }

  return { code: 'player_failed', message: '播放器没能加载直播流', nextStep: '点重新连接重试', detail };
}
