/**
 * 验收契约来源（本轮缺陷修复第 4 项 / docs/test-results.md §4.2 第 4 条）：
 *   服务端把「频道不存在」翻译成 404 +「频道不存在，请确认频道号后重试」之后，
 *   观看页不能再拼一次下一步，否则出现「…请稍后重试，按提示处理后重试」这类重复措辞。
 *
 * 约定的实现位置：apps/watch/src/lib/errors.ts
 *   mapWatchError(error) → { code, message, nextStep }
 *   errorSentence(info)  → message + （有 nextStep 时才拼「，nextStep」）
 *
 * 断言的是文案行为（一句话原因 + 不重复的下一步），不锁死具体措辞。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api';
import { errorSentence, hasNextStep, mapWatchError } from '../src/lib/errors';

const countOf = (text: string, word: string) => (text.match(new RegExp(word, 'g')) ?? []).length;

describe('观看页错误文案 — 服务端已给完整句子时不再重复下一步', () => {
  it('404 频道不存在：原样展示服务端文案，不追加「按提示处理后重试」', () => {
    const info = mapWatchError(new ApiRequestError(404, 404, '频道不存在，请确认频道号后重试'));

    const sentence = errorSentence(info);

    expect(sentence).toContain('频道不存在');
    expect(sentence).not.toContain('按提示处理');
    // 服务端那句话自带一次「重试」，前端不得再拼第二次
    expect(countOf(sentence, '重试'), `重复「重试」：${sentence}`).toBe(1);
  });

  it('502 上游不可用：同样只出现一次「重试」，不叠加后缀', () => {
    const info = mapWatchError(new ApiRequestError(502, 502, '上游服务暂时不可用，请稍后重试'));

    const sentence = errorSentence(info);

    expect(sentence).not.toContain('按提示处理');
    expect(countOf(sentence, '重试')).toBe(1);
  });

  it('下一步提示机制本身没被削弱：原始报错没有行动词时仍会补一个下一步', () => {
    const info = mapWatchError(new Error('Failed to fetch'));

    expect(hasNextStep(info.message), '原始报错文案不含行动词').toBe(false);
    expect(info.nextStep.length, '没有下一步就不叫「一句话原因 + 一个下一步」').toBeGreaterThan(0);
    expect(errorSentence(info)).toContain(info.nextStep);
  });
});
