/**
 * 验收契约来源：docs/execution-plan.md
 *   - §五 服务端接口契约「实现要点」：签名纯函数 MD5(appSecret + 按 key 升序拼接 k+v + appSecret)，结果大写，参数含 appId / timestamp
 *   - §Done when 第 5 条：固定 appId/appSecret/timestamp/params → 与手算 MD5 一致（覆盖参数排序、大小写）
 *
 * 约定的实现位置与导出（本文件是唯一契约，CodingAgent 若改了路径/名字，改下面一行 import 与 resolveSign 的候选名即可）：
 *   apps/server/src/polyv/sign.ts  →  export function buildSign(params, appSecret): string
 *
 * 下面所有期望值都是作者用 node crypto 离线手算的固定向量，不是调用被测函数算出来的。
 */
import { describe, expect, it } from 'vitest';
import * as signModule from './sign';

/** 容忍同义导出名（buildSign / sign / createSign / getSign），但断言的是行为而不是名字。 */
function resolveSign(): (params: Record<string, unknown>, appSecret: string) => string {
  const mod = signModule as unknown as Record<string, unknown>;
  const fn =
    (mod.buildSign as Function | undefined) ??
    (mod.sign as Function | undefined) ??
    (mod.createSign as Function | undefined) ??
    (mod.getSign as Function | undefined);
  expect(
    typeof fn,
    'apps/server/src/polyv/sign.ts 需导出一个签名函数（约定名 buildSign(params, appSecret)）',
  ).toBe('function');
  return fn as (params: Record<string, unknown>, appSecret: string) => string;
}

const APP_SECRET = 'test-app-secret';
const APP_ID = 'demoapp1d0';

describe('buildSign — POLYV 公开 API 签名', () => {
  it('固定向量（appId + timestamp）与手算 MD5 一致，且为 32 位大写十六进制', () => {
    const buildSign = resolveSign();

    // MD5( 'test-app-secret' + 'appId{APP_ID}timestamp1700000000' + 'test-app-secret' )
    const expected = 'FC126D66FBB5C83E5AA5167B685882F5';

    const actual = buildSign({ appId: APP_ID, timestamp: '1700000000' }, APP_SECRET);

    expect(actual).toBe(expected);
  });

  it('大小写：结果为大写十六进制（不接受小写 md5）', () => {
    const buildSign = resolveSign();

    const actual = buildSign({ appId: APP_ID, timestamp: '1700000000' }, APP_SECRET);

    expect(actual).toMatch(/^[0-9A-F]{32}$/);
    expect(actual).toBe(actual.toUpperCase());
    // 小写形式绝不能通过（防止实现里 toUpperCase 丢失）
    expect(actual).not.toBe(actual.toLowerCase());
  });

  it('参数排序：按 key 升序拼接，与调用方传参顺序无关', () => {
    const buildSign = resolveSign();

    // 升序后：appId + channelId + timestamp  ⇒  按 k+v 拼接后取 MD5
    const expected = '1E27412621CCC386280668BC54720D50';

    const ordered = buildSign(
      { appId: APP_ID, channelId: '1000001', timestamp: '1700000000' },
      APP_SECRET,
    );
    const shuffled = buildSign(
      { timestamp: '1700000000', channelId: '1000001', appId: APP_ID },
      APP_SECRET,
    );

    expect(ordered).toBe(expected);
    expect(shuffled).toBe(expected);
  });

  it('签名参数自身不参与计算（sign 字段被排除），其余 k+v 拼接不变', () => {
    const buildSign = resolveSign();

    const withoutSign = buildSign(
      { appId: APP_ID, channelId: '1000001', timestamp: '1700000000' },
      'local-dev-secret',
    );
    const withSign = buildSign(
      {
        appId: APP_ID,
        channelId: '1000001',
        timestamp: '1700000000',
        sign: 'STALE-SIGN-MUST-BE-IGNORED',
      },
      'local-dev-secret',
    );

    // MD5('local-dev-secret' + 'appIddemoapp1d0channelId1000001timestamp1700000000' + 'local-dev-secret')
    expect(withoutSign).toBe('77EDB756F8CD41F0D16B46BF9A67C8EF');
    expect(withSign).toBe(withoutSign);
  });

  it('appSecret 参与首尾拼接：换 secret 结果必须变', () => {
    const buildSign = resolveSign();
    const params = { appId: APP_ID, timestamp: '1700000000' };

    expect(buildSign(params, APP_SECRET)).not.toBe(buildSign(params, 'another-secret'));
  });

  it('数字型值与字符串型值等价（timestamp 传 number 也走同一条签名）', () => {
    const buildSign = resolveSign();

    const asString = buildSign({ appId: APP_ID, timestamp: '1700000000' }, APP_SECRET);
    const asNumber = buildSign({ appId: APP_ID, timestamp: 1700000000 }, APP_SECRET);

    expect(asNumber).toBe(asString);
    expect(asNumber).toBe('FC126D66FBB5C83E5AA5167B685882F5');
  });
});
