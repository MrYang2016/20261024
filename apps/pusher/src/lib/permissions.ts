/**
 * 浏览器媒体权限状态（D41 ②）。
 *
 * 这里记的是一条**规范行为**，不是我们的 bug，免得后人再当「没弹授权框」去修：
 * 用户在浏览器的权限弹框里点过「阻止」之后，`navigator.permissions.query({name:'camera'})`
 * 变成 `denied`，此后 `getUserMedia` **立即 reject**（NotAllowedError），浏览器**永久不再弹授权框**。
 * JS 无法代为弹出授权框，只能由用户去地址栏左侧的图标里改回「允许」——所以 `denied` 时我们只给指引，
 * 不盲目切设备、不反复重试；`prompt` 时按钮点击本身就是用户手势，可以正常弹框。
 */
export type MediaPermissionState = 'granted' | 'denied' | 'prompt';

export type MediaPermissionKind = 'camera' | 'microphone';

/**
 * 查一次权限状态。
 * 浏览器不支持 Permissions API（或 `camera` / `microphone` 不在它的支持列表里）时**当作 `prompt`**：
 * 这种环境下 `getUserMedia` 仍会正常弹框，按 prompt 处理才是可用的那一半。
 */
export async function queryMediaPermission(kind: MediaPermissionKind): Promise<MediaPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'prompt';
  try {
    // TS 的 PermissionName 联合类型还没有 camera / microphone（Chrome 已实现），只能断言
    const status = await navigator.permissions.query({ name: kind as PermissionName });
    return normalizePermissionState(status.state);
  } catch {
    return 'prompt';
  }
}

function normalizePermissionState(state: string): MediaPermissionState {
  if (state === 'granted' || state === 'denied') return state;
  return 'prompt';
}

/** 权限被浏览器拒绝后的指引：一句话原因 + 一个下一步 + 详情里的 3 步操作（客户向） */
export interface PermissionBlockedGuidance {
  /** 一句话原因（自检条的结论行） */
  reason: string;
  /** 一个下一步（自检条的提示行） */
  nextStep: string;
  /** 详情展开区的 3 步操作 */
  steps: string[];
}

export const CAMERA_BLOCKED_GUIDANCE: PermissionBlockedGuidance = {
  reason: '浏览器已阻止摄像头',
  nextStep: '点地址栏左侧的摄像头图标 → 改为「允许」→ 再点重新检测',
  steps: [
    '点浏览器地址栏左侧的摄像头图标（或锁形图标）',
    '把「摄像头」改为「允许」，再关闭这个面板',
    '回到本页点「重新检测摄像头」',
  ],
};

export const MICROPHONE_BLOCKED_GUIDANCE: PermissionBlockedGuidance = {
  reason: '浏览器已阻止麦克风',
  nextStep: '点地址栏左侧的麦克风图标 → 改为「允许」→ 再点「换麦克风」',
  steps: [
    '点浏览器地址栏左侧的麦克风图标（或锁形图标）',
    '把「麦克风」改为「允许」，再关闭这个面板',
    '回到本页点「换麦克风」',
  ],
};
