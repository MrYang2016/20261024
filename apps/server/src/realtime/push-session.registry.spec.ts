/**
 * 验收契约来源：docs/sequence-diagram.md §1/§2 + CONTEXT.md（平台状态不可靠 → 用推流端会话校正）
 *   - 推流端每 60s 上报一次 `started`（心跳），服务端会话 **150s** 没续期即视为已断流（进程被杀也能自愈）
 *   - 推流端上报 `stopped` 后，**10 分钟**内把平台侧还没跟上的状态判为「已结束」（STOPPED_HOLD_MS）
 *   - `isPushing` / `hasRecentlyStopped` 只看「最近一次上报」的状态
 *
 * 为什么单测这层：评审 W5 指出 `PushSessionRegistry` + 60s 心跳 + liveStatus 合并
 * 是本单唯一能在平台接口不可靠时仍显示「直播中」的机制，却没有任何自动化锁。
 * 这里用假时钟（vi.useFakeTimers + setSystemTime）验证 TTL 边界，不 sleep 真时间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushSessionRegistry } from './push-session.registry';

/** 会话 TTL：推流端 60s 心跳、150s 过期（docs/sequence-diagram.md §1 与评审 W5 记录的口径） */
const SESSION_TTL_MS = 150_000;
/** 停止保持窗口：报过 stopped 之后 10 分钟内判为已结束（评审 C1/W2 引用的 STOPPED_HOLD_MS） */
const STOPPED_HOLD_MS = 10 * 60_000;

const CHANNEL_ID = '1000001';
const T0 = new Date('2026-10-23T10:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (milliseconds: number) => vi.advanceTimersByTime(milliseconds);

describe('PushSessionRegistry — 推流会话 TTL', () => {
  it('没有任何上报时：既不是推流中，也不是刚停播', () => {
    const registry = new PushSessionRegistry();

    expect(registry.isPushing(CHANNEL_ID)).toBe(false);
    expect(registry.hasRecentlyStopped(CHANNEL_ID)).toBe(false);
  });

  it('上报 started 后 TTL 窗口内 isPushing 为真，超过 150s 没续期即自动失效（自愈）', () => {
    const registry = new PushSessionRegistry();

    registry.mark(CHANNEL_ID, 'started');
    expect(registry.isPushing(CHANNEL_ID), '刚上报 started 必须是推流中').toBe(true);
    expect(registry.hasRecentlyStopped(CHANNEL_ID)).toBe(false);

    // 149s：还在 TTL 内（60s 心跳本应已经续期过）
    advance(SESSION_TTL_MS - 1_000);
    expect(registry.isPushing(CHANNEL_ID), '150s 窗口内（含 149s）仍算推流中').toBe(true);

    // 151s：超过 TTL 且没有任何心跳 → 视为断流，不能永久挂「直播中」
    advance(2_000);
    expect(
      registry.isPushing(CHANNEL_ID),
      '超过 150s 没有心跳必须自动失效（推流端进程被杀也能自愈）',
    ).toBe(false);
  });

  it('60s 心跳能续期：第一次上报后 200s，只要有心跳就仍在 TTL 内', () => {
    const registry = new PushSessionRegistry();

    registry.mark(CHANNEL_ID, 'started');
    advance(60_000);
    registry.mark(CHANNEL_ID, 'started'); // 60s 心跳

    advance(140_000); // 距第一次上报 200s，距心跳 140s
    expect(registry.isPushing(CHANNEL_ID), '心跳续期后必须仍在推流中').toBe(true);

    advance(11_000); // 距心跳 151s
    expect(registry.isPushing(CHANNEL_ID), '心跳停掉后 150s 仍然要过期').toBe(false);
  });

  it('上报 stopped 后 isPushing 立刻为假、10 分钟保持窗口内「刚停播」为真', () => {
    const registry = new PushSessionRegistry();

    registry.mark(CHANNEL_ID, 'started');
    advance(60_000);
    registry.mark(CHANNEL_ID, 'stopped');

    expect(registry.isPushing(CHANNEL_ID), 'stopped 之后不能再算推流中').toBe(false);
    expect(registry.hasRecentlyStopped(CHANNEL_ID)).toBe(true);

    advance(STOPPED_HOLD_MS - 1_000);
    expect(registry.hasRecentlyStopped(CHANNEL_ID), '10 分钟窗口内仍要压住平台状态').toBe(true);

    advance(2_000);
    expect(
      registry.hasRecentlyStopped(CHANNEL_ID),
      '超过 10 分钟保持窗口后必须交还给平台状态（不能永远显示已结束）',
    ).toBe(false);
  });

  it('状态只看最近一次上报：stopped 后再 started，立刻回到推流中且不再算刚停播', () => {
    const registry = new PushSessionRegistry();

    registry.mark(CHANNEL_ID, 'stopped');
    expect(registry.hasRecentlyStopped(CHANNEL_ID)).toBe(true);

    registry.mark(CHANNEL_ID, 'started');
    expect(registry.isPushing(CHANNEL_ID)).toBe(true);
    expect(registry.hasRecentlyStopped(CHANNEL_ID), '重新开播后不能残留「刚停播」').toBe(false);
  });

  it('会话按频道隔离：A 频道推流中不影响 B 频道', () => {
    const registry = new PushSessionRegistry();

    registry.mark(CHANNEL_ID, 'started');

    expect(registry.isPushing(CHANNEL_ID)).toBe(true);
    expect(registry.isPushing('1000032')).toBe(false);
    expect(registry.hasRecentlyStopped('1000032')).toBe(false);
  });
});
