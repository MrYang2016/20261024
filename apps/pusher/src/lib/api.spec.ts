/**
 * 验收契约来源：CONTEXT.md **D39 ②**（评审人 2026-10-23 第二次实测）
 *
 * 真实缺陷：关 Wi-Fi 后刷新推流端仍显示「预检通过」。浏览器到 `127.0.0.1` 走回环，断网不影响，
 * 而服务端 `/api/health` 在上游不可达时**旧实现回 200 + `{ok:true, polyv:'unreachable'}`**。
 * 前端 `probeHealth` 只判 `response.ok` → 把「上游不可达」当成「网络正常」。
 *
 * D39 ②：`probeHealth` 必须**同时**要求
 *   `response.ok === true` **且** JSON `ok !== false` **且** `polyv !== 'unreachable'`，
 * 三者缺一即判「探测失败」（返回 false）；探测本身**绝不抛错**（它是诊断结论，不是异常）。
 *
 * 本文件把 `globalThis.fetch` 换成受控桩，直接断言 `probeHealth` 的返回值，
 * 不依赖任何真实网络 / 真实服务端。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeHealth } from './api';

/** 记录每次 fetch 的入参（断言打的是 /api/health、GET） */
const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

/**
 * 造一个最小 Response 桩。
 *
 * 不用真 `Response`：jsdom 环境不保证有 undici 的 Response，而且实现可能用 `json()`
 * 也可能用 `text()` + `JSON.parse`，这里两种都提供（`json()` 在非 JSON 时 reject，与真 Response 一致）。
 */
function fakeResponse(body: string, status = 200, contentType = 'application/json; charset=utf-8') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? contentType : null,
    },
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
    clone() {
      return fakeResponse(body, status, contentType);
    },
  } as unknown as Response;
}

function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fetchCalls.length = 0;
});

describe('probeHealth — 预检网络探测（D38/D39）', () => {
  it('200 + { ok: true, polyv: reachable } → true（唯一可以判「网络正常」的形状）', async () => {
    stubFetch(() => fakeResponse(JSON.stringify({ ok: true, polyv: 'reachable' })));

    await expect(probeHealth()).resolves.toBe(true);

    expect(fetchCalls, '探测必须真的打一次 /api/health').toHaveLength(1);
    expect(fetchCalls[0]?.url.endsWith('/api/health'), `实际请求：${fetchCalls[0]?.url}`).toBe(true);
    expect(fetchCalls[0]?.init?.method ?? 'GET', '探测是 GET').toBe('GET');
  });

  it('200 + { ok: true, polyv: "unreachable" } → false（D39 核心回归：旧实现只看 response.ok 会误判 true）', async () => {
    // 这正是旧服务端在「上游不可达」时回的形状：HTTP 200 但 polyv 字段明说连不上外网
    stubFetch(() => fakeResponse(JSON.stringify({ ok: true, polyv: 'unreachable' })));

    const reachable = await probeHealth();

    expect(
      reachable,
      'D39 ②：HTTP 200 + polyv:"unreachable" 必须判「探测失败」，否则断网时会显示「预检通过」',
    ).toBe(false);
  });

  it('200 + { ok: false } → false', async () => {
    stubFetch(() => fakeResponse(JSON.stringify({ ok: false, polyv: 'reachable' })));

    await expect(probeHealth(), 'JSON 里 ok:false 也算探测失败').resolves.toBe(false);
  });

  it('503 + { ok: false, polyv: "unreachable" } → false（D39 ①：服务端上游不可达的新形状）', async () => {
    stubFetch(() => fakeResponse(JSON.stringify({ ok: false, polyv: 'unreachable' }), 503));

    await expect(probeHealth()).resolves.toBe(false);
  });

  it('非 JSON 响应（例如网关 HTML 错误页）→ false，不抛错', async () => {
    stubFetch(() => fakeResponse('<html><body>502 Bad Gateway</body></html>', 200, 'text/html'));

    await expect(probeHealth(), '探测绝不抛错，非 JSON 一律按失败处理').resolves.toBe(false);
  });

  it('fetch reject（浏览器断网 / 回环不通）→ false，不抛错', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(probeHealth()).resolves.toBe(false);
  });

  it('超时 3 秒 → false（D38：探测失败即判「连不上服务器」，不能无限等）', async () => {
    vi.useFakeTimers();
    let aborted = false;
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('The operation was aborted.'));
          });
        }),
    );

    const pending = probeHealth();

    // 2999ms 时还不能放弃
    await vi.advanceTimersByTimeAsync(2_999);
    expect(aborted, '不到 3 秒就 abort 会把「网络慢」误判成「断网」').toBe(false);

    // 到 3000ms 必须中止并判定失败
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending, '3 秒超时必须返回 false').resolves.toBe(false);
    expect(aborted, '超时必须 abort 掉这次探测（信号要真的传给 fetch）').toBe(true);
  });
});
