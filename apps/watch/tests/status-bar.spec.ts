/**
 * 验收契约来源：docs/execution-plan.md §七 观看页实现要点
 *   - 状态条：`直播中`（红点 + 在线人数）/ `未开始`（灰）/ `已结束`（灰 + 回放入口文案）
 *   - §八 质量底线：状态不只靠颜色（红点 + 文案「直播中」）
 *   - §五 live-status 枚举：'unStart' | 'live' | 'end' | 'playback'
 *
 * 约定的实现位置：apps/watch/src/components/StatusBar.vue
 * props 名未在计划里固定，本文件同时传 liveStatus / status / viewerCount / onlineCount，
 * 断言的是「渲染出来的中文文案」，不是 props 形状。
 *
 * @vitest-environment jsdom
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StatusBar from '../src/components/StatusBar.vue';

function render(liveStatus: string, viewerCount = 3) {
  return mount(StatusBar, {
    props: {
      liveStatus,
      status: liveStatus,
      viewerCount,
      onlineCount: viewerCount,
    },
  });
}

describe('StatusBar — 观看页状态条文案', () => {
  it('live → 显示「直播中」与在线人数', () => {
    const wrapper = render('live', 3);
    const text = wrapper.text();

    expect(text).toContain('直播中');
    expect(text).toContain('3');
  });

  it('unStart → 显示「未开始」', () => {
    const text = render('unStart').text();

    expect(text).toContain('未开始');
    expect(text).not.toContain('直播中');
  });

  it('end → 显示「已结束」', () => {
    const text = render('end').text();

    expect(text).toContain('已结束');
    expect(text).not.toContain('直播中');
  });

  it('状态不只靠颜色表达：每种状态都有可见中文文案（无颜色也能读）', () => {
    for (const [liveStatus, label] of [
      ['live', '直播中'],
      ['unStart', '未开始'],
      ['end', '已结束'],
    ] as const) {
      const text = render(liveStatus).text();
      expect(text, `${liveStatus} 必须有文案 ${label}，不能只靠颜色`).toContain(label);
    }
  });
});
