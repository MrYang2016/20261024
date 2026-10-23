/**
 * 验收契约来源：docs/execution-plan.md
 *   - §八「质量底线（不可妥协）」：正文对比度 ≥ 4.5:1；控件 / 焦点环 ≥ 3:1。
 *   - 视觉修订 v2 §4：主按钮品牌蓝**实底填满** + 白字 4.5:1+（D19），hover **压深**（不得提亮，提亮会掉对比度）；
 *     焦点环 2px `#7CA0FF`。
 *   - CONTEXT.md D19：主按钮底色由 `#3F76FC`（4.03:1）改为 `#2F63E0`（≥4.5:1），hover `#2A57C7`；
 *     焦点环、链接色不变。
 *   - 评审 C3：`#3F76FC` 白字 4.03:1 / hover `#5A8BFF` 3.20:1，违反本项目「不可妥协」的底线。
 *
 * 这是纯函数断言：直接读 `packages/shared/styles/theme.css` 里的 token 实际取值，
 * 用 WCAG 相对亮度公式手算对比度（不引入任何新依赖）。
 * 之所以读文件而不是抄常量：token 才是唯一真源，改错色值必须让这条测试红。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const THEME_CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** 白字（主按钮文字色，v2 §4） */
const WHITE = '#ffffff';
/** WCAG AA 正文对比度下限 */
const AA_NORMAL_TEXT = 4.5;
/** WCAG AA 非文本/图形对比度下限（焦点环） */
const AA_NON_TEXT = 3;

function readToken(name: string): string {
  const matched = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(THEME_CSS);
  expect(matched, `theme.css 里必须定义 ${name}（hex 色值）`).not.toBeNull();
  return (matched as RegExpExecArray)[1];
}

function toRgb(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((char) => char + char).join('') : raw.slice(0, 6);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.x 相对亮度 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度（1–21） */
function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

describe('主按钮白字对比度（D19 / 质量底线 ≥ 4.5:1）', () => {
  it('白字在品牌蓝实底上 ≥ 4.5:1（AA 正文）', () => {
    const brand = readToken('--color-brand');
    const ratio = contrastRatio(WHITE, brand);

    expect(
      round2(ratio),
      `白字 on ${brand} = ${round2(ratio)}:1，低于项目自定的 4.5:1 底线（评审 C3：曾为 #3F76FC → 4.03:1）`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('hover 态更深一档且仍 ≥ 4.5:1（不得靠提亮做 hover）', () => {
    const brand = readToken('--color-brand');
    const brandHover = readToken('--color-brand-hover');

    const hoverRatio = contrastRatio(WHITE, brandHover);
    expect(
      round2(hoverRatio),
      `白字 on ${brandHover} = ${round2(hoverRatio)}:1（评审 C3：曾为 #5A8BFF → 3.20:1）`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);

    expect(
      relativeLuminance(brandHover),
      'hover 必须压深而不是提亮（提亮会掉对比度，v2 §4 / D19）',
    ).toBeLessThan(relativeLuminance(brand));
  });

  it('焦点环仍是 #7CA0FF，且在页面底色上 ≥ 3:1（控件/图形对比度）', () => {
    const focus = readToken('--color-focus');
    const background = readToken('--color-bg');

    expect(focus.toLowerCase(), 'D19 明确「焦点环、链接色不变」').toBe('#7ca0ff');

    const ratio = contrastRatio(focus, background);
    expect(round2(ratio), `焦点环 ${focus} on 页面底 ${background} = ${round2(ratio)}:1`).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });
});
