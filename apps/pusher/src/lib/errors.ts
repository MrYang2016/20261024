import type { DiagnosticId } from '@live1024/shared';
import { ApiRequestError } from './api';
import { PushTransportError } from '../transports/types';

export interface PushErrorInfo {
  /** 稳定错误码，便于诊断卡（24060）后续分类 */
  code: string;
  /** 一句话原因 */
  message: string;
  /** 一个下一步 */
  nextStep: string;
  /** 原因 + 下一步合成的一句话，页面直接展示这一条 */
  text: string;
  /**
   * 这个错误归哪个诊断项（D27：推流 / 设备错误只走诊断条）。
   * 频道类错误（404 频道不存在 / 上游 502）没有诊断项：它们留在线上的频道面板里内联展示。
   */
  diagnosticId?: DiagnosticId;
}

function info(code: string, message: string, nextStep: string, diagnosticId?: DiagnosticId): PushErrorInfo {
  return { code, message, nextStep, text: `${message}，${nextStep}`, diagnosticId };
}

/** 计划 §六 逐字给出的四条映射 */
const MESSAGES = {
  sessionConflict: () => info('push_session_conflict', '上一次推流还没完全结束', '请稍候几秒再试', 'D3'),
  permission: () => info('media_permission_denied', '浏览器没有摄像头/麦克风权限', '请在地址栏允许后重试', 'D9'),
  deviceBusy: () => info('media_busy', '摄像头或麦克风被其他程序占用', '关掉会议软件后重试', 'D9'),
  deviceMissing: () => info('media_not_found', '没有检测到摄像头', '请接入设备后重试', 'D9'),
} as const;

/** 兜底：说不出原因的推流失败一律按「连不上推流服务器」处理（诊断条上仍会说清原因） */
const FALLBACK = () => info('unknown', '推流没有成功', '刷新页面后重试', 'D3');

interface ErrorShape {
  name: string;
  message: string;
  sdkCode: number | null;
}

/** 鸭子类型读取错误信息：DOMException / Error / SDK 抛的普通对象 / 字符串都能处理 */
function readError(error: unknown): ErrorShape {
  if (error instanceof PushTransportError) {
    return { name: error.name, message: error.message, sdkCode: error.sdkCode ?? null };
  }
  if (typeof error === 'string') return { name: '', message: error, sdkCode: null };
  if (error && typeof error === 'object') {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      errCode?: unknown;
    };
    const code = candidate.errCode ?? candidate.code;
    return {
      name: typeof candidate.name === 'string' ? candidate.name : '',
      message: typeof candidate.message === 'string' ? candidate.message : '',
      sdkCode: typeof code === 'number' ? code : null,
    };
  }
  return { name: '', message: '', sdkCode: null };
}

/**
 * 把任意错误翻译成「一句话原因 + 一个下一步」。
 * -12 单独归类：spike 实测它不是鉴权问题，而是上一次推流未释放的会话竞态。
 */
export function mapPushError(error: unknown): PushErrorInfo {
  const shape = readError(error);

  // -12：只认码值与原始报文特征，不说成鉴权失败
  if (shape.sdkCode === -12 || /-12\b|streamurl authentication failed/i.test(shape.message)) {
    return MESSAGES.sessionConflict();
  }

  // 浏览器媒体层
  switch (shape.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return MESSAGES.permission();
    case 'NotReadableError':
    case 'TrackStartError':
      return MESSAGES.deviceBusy();
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return MESSAGES.deviceMissing();
    case 'OverconstrainedError':
      return info('media_constraint', '选择的设备当前不可用', '在设备下拉里换一个摄像头或麦克风', 'D9');
    default:
      break;
  }

  // 传输层
  if (error instanceof PushTransportError) {
    switch (error.code) {
      case 'script_load_failed':
        return info('sdk_script_failed', '推流 SDK 加载失败', '检查网络后重试', 'D3');
      case 'invalid_push_url':
        return info('invalid_push_url', '推流地址不可用', '重新获取频道推流地址后再开播', 'D1');
      case 'start_failed':
        return info('push_start_failed', '推流连接没建立起来', '检查网络后重试', 'D3');
      default:
        return info('sdk_error', '推流 SDK 报错', '停止后重新开始直播', 'D3');
    }
  }

  // 服务端错误：message 已经是「一句话原因 + 下一步」的客户向句子，可直接展示
  if (error instanceof ApiRequestError) {
    const message = error.message.trim();
    // message 自带下一步时不再拼后缀，否则会出现「…请稍后重试，按提示处理后重试」这种重复措辞
    const nextStep = hasNextStep(message) ? '' : '按提示处理后重试';
    return { code: `api_${error.status}`, message, nextStep, text: nextStep ? `${message}，${nextStep}` : message };
  }

  return FALLBACK();
}

/** 页面展示用：一句话（原因 + 下一步） */
export function errorText(error: PushErrorInfo): string {
  return error.text;
}

/** 服务端 message 是否已经是一句带下一步的完整话（含「请…」「重试」「稍候」这类行动词） */
export function hasNextStep(message: string): boolean {
  return /请|重试|稍候|检查|确认|联系/.test(message);
}
