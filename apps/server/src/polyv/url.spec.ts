/**
 * 验收契约来源：docs/execution-plan.md
 *   - §五「实现要点」：`webrtcUrl = rtmpUrl.replace('rtmp://', 'webrtc://')`
 *   - §Done when 第 5 条：rtmp://push-t2.videocc.net/recordf/x?txSecret=a&txTime=b
 *     → webrtc://push-t2.videocc.net/recordf/x?txSecret=a&txTime=b，其余字符不变
 *
 * 约定的实现位置与导出：
 *   apps/server/src/polyv/url.ts  →  export function toWebrtcUrl(rtmpUrl: string): string
 */
import { describe, expect, it } from 'vitest';
import * as urlModule from './url';

function resolveToWebrtcUrl(): (rtmpUrl: string) => string {
  const mod = urlModule as unknown as Record<string, unknown>;
  const fn =
    (mod.toWebrtcUrl as Function | undefined) ??
    (mod.rtmpToWebrtc as Function | undefined) ??
    (mod.toWebrtc as Function | undefined) ??
    (mod.toPushWebrtcUrl as Function | undefined);
  expect(
    typeof fn,
    'apps/server/src/polyv/url.ts 需导出 rtmp→webrtc 地址转换函数（约定名 toWebrtcUrl(url)）',
  ).toBe('function');
  return fn as (rtmpUrl: string) => string;
}

describe('toWebrtcUrl — 推流地址协议转换', () => {
  it('Done when 逐字用例：只换协议头，其余字符一个不动', () => {
    const toWebrtcUrl = resolveToWebrtcUrl();

    const rtmp = 'rtmp://push-t2.videocc.net/recordf/x?txSecret=a&txTime=b';
    const expected = 'webrtc://push-t2.videocc.net/recordf/x?txSecret=a&txTime=b';

    expect(toWebrtcUrl(rtmp)).toBe(expected);
  });

  it('真实形态：txSecret 大小写混合 + txTime 十六进制时间戳原样保留', () => {
    const toWebrtcUrl = resolveToWebrtcUrl();

    const rtmp =
      'rtmp://push-t2.videocc.net/recordf/demoapp1d06a1b2c3d4e5f60?txSecret=AbCdEf0123456789aBcDeF0123456789&txTime=68F1A2B3';

    expect(toWebrtcUrl(rtmp)).toBe(
      'webrtc://push-t2.videocc.net/recordf/demoapp1d06a1b2c3d4e5f60?txSecret=AbCdEf0123456789aBcDeF0123456789&txTime=68F1A2B3',
    );
  });

  it('查询参数顺序与额外参数保持原样', () => {
    const toWebrtcUrl = resolveToWebrtcUrl();

    const rtmp = 'rtmp://push-t2.videocc.net/recordf/x?txTime=b&txSecret=a&extra=1';

    expect(toWebrtcUrl(rtmp)).toBe(
      'webrtc://push-t2.videocc.net/recordf/x?txTime=b&txSecret=a&extra=1',
    );
  });

  it('路径里后续出现的 rtmp:// 不被误改（只换开头的协议头）', () => {
    const toWebrtcUrl = resolveToWebrtcUrl();

    const rtmp = 'rtmp://push-t2.videocc.net/recordf/x?backup=rtmp://other.example/y';

    expect(toWebrtcUrl(rtmp)).toBe(
      'webrtc://push-t2.videocc.net/recordf/x?backup=rtmp://other.example/y',
    );
  });

  it('幂等：已是 webrtc:// 的地址再转一次不变', () => {
    const toWebrtcUrl = resolveToWebrtcUrl();

    const webrtc = 'webrtc://push-t2.videocc.net/recordf/x?txSecret=a&txTime=b';

    expect(toWebrtcUrl(webrtc)).toBe(webrtc);
  });
});
