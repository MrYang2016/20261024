import type { LiveStatus } from '@live1024/shared';

/** 计划 §五 对外只暴露这四个值，前端的状态条只按这四种分支渲染 */
const PUBLIC_STATUSES: readonly LiveStatus[] = ['unStart', 'live', 'end', 'playback'];

/**
 * 上游状态归一。
 * 平台可能给 waiting / banpush / true / undefined 之类不可靠值（CONTEXT 实测过），
 * 这里收敛到 4 个公开枚举：waiting → unStart、banpush → end，其余未知值兜底 unStart，且不抛异常。
 */
export function toLiveStatus(raw: unknown): LiveStatus {
  if (typeof raw !== 'string') return 'unStart';
  const value = raw.trim();
  if (PUBLIC_STATUSES.includes(value as LiveStatus)) return value as LiveStatus;
  if (value === 'banpush') return 'end';
  return 'unStart';
}
