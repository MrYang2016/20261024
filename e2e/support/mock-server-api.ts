/**
 * e2e 共用：服务端接口 mock + 外部网络隔离。
 *
 * 契约来自 docs/execution-plan-24059.md §五 + docs/execution-plan.md §六（24060 诊断端点）：
 *   POST /api/channels                    → { channelId, name, watchUrl, template, push: { rtmpUrl, webrtcUrl, expiresAt }, stream }
 *   GET  /api/channels/:channelId         → 同结构
 *   GET  /api/channels/:channelId/live-status → { liveStatus, viewerCount }
 *   GET  /api/health                      → { ok: true, polyv: 'reachable' }
 *         D38：默认成功（既有 e2e 不受影响）；传 `healthControl` 可在用例中切到断网（fetch 直接 reject）
 *         D39：另支持「服务端回了 200 但 polyv 说连不上外网」（旧实现的形状，专测前端误判）
 *              与「服务端回 503」（新契约的形状）；见 HealthMode
 *   POST /api/channels/:channelId/push-session { state } → { channelId, state, updatedAt }
 *        （评审 W5：以前该路由落到兜底 404，推流会话上报在 e2e 里静默失败、从未被断言）
 *   POST /api/channels/:channelId/diagnostics  → 201 { channelId, stored: true, total }
 *        id 不在 D1/D2/D3/D5/D6/D7/D9 → 400 { code: 400, message: '诊断项不合法' }
 *        §十一 B/C：POST 体新增可选 `outageMs` / `device`
 *   GET  /api/channels/:channelId/diagnostics?limit= → { channelId, items, device }
 *        （limit 缺省 50 / 上限 50；device = 该频道最近一次会话设备，没上报过为 null）
 *        只带 `device`、不带 `id` 的 POST = 会话设备上报（D36）：只更新 device，不产生诊断记录
 *   POST /api/channels/:channelId/metrics      → 201 { channelId, stored: true, total }（§十一 A / D34）
 *   GET  /api/channels/:channelId/metrics?limit= → { channelId, items }（按 at 升序；limit 缺省 300 / 上限 300）
 *
 * 24060 本轮补强（HACK-1024 诊断卡）：
 *   0. `channelGetFailure`：只让 `GET /api/channels/:id` 失败，用来复现 D29 的真实口径
 *      （非纯视频模板 → 502 + 「频道模板不是纯视频…」），新建频道（POST）仍成功。
 *
 *   1. `template` / `push.expiresAt` 两个新字段（计划 §五 5.2）。`expiresAt` 由 `txTime`（hex 秒）换算得出，
 *      与 `rtmpUrl` 查询串里的值**同源**，否则 D1 的「剩余 < 3 分钟」在 e2e 里无法复现。
 *   2. `txTime` 改为按当前时间动态生成（+6 小时）。原来是写死的 `68F1A2B3`（2025-10-15），
 *      在 2026 年跑 e2e 时这条地址**早就过期了**——诊断卡一上线就会让所有用例预检命中 D1（优先级高于 D5/D6/D7），
 *      把 D5/D6/D7 的断言全顶掉。需要过期地址的用例自己传 `txTimeHex`。
 *   3. 诊断端点：默认「能存能读」，并且把每次上报 append 到 `diagnosticsLog` 供 e2e 断言。
 *
 * 外部网络隔离：polyv / videocc / qcloudecdn 一律 abort，保证 e2e 不依赖网络
 * （TXLivePusher SDK 的桩由 support/txlivepusher-mock.ts 先行 route，Playwright 以先注册者为准）。
 */
import type { Page, Route } from '@playwright/test';

export const E2E_CHANNEL_ID = '1000001';
export const E2E_CHANNEL_NAME = 'E2E 直播测试频道';
export const E2E_STREAM_SUFFIX = 'e2e-stream-1024';

/** 一期诊断项枚举（D28：7 条，不做 D4/D8/D10/D11） */
export const E2E_DIAGNOSTIC_IDS = ['D1', 'D2', 'D3', 'D5', 'D6', 'D7', 'D9'] as const;
export type E2eDiagnosticId = (typeof E2E_DIAGNOSTIC_IDS)[number];

/** 推流地址有效期：mock 默认给 6 小时（真实链路 30 分钟~24 小时，6h 足够任何 e2e 用例跑完） */
export const E2E_TX_TTL_MS = 6 * 60 * 60 * 1000;

/** txTime 是 **hex 秒**（腾讯云鉴权格式），这里按当前时间算出「还没过期」的一条 */
export const E2E_TX_TIME_HEX = Math.floor((Date.now() + E2E_TX_TTL_MS) / 1000)
  .toString(16)
  .toUpperCase();

export const E2E_TX_QUERY = `txSecret=e2etxsecret&txTime=${E2E_TX_TIME_HEX}`;

/** 服务端 `push.expiresAt` 的期望值（由 txTime hex 秒换算） */
export const E2E_TX_EXPIRES_AT = new Date(
  Number.parseInt(E2E_TX_TIME_HEX, 16) * 1000,
).toISOString();

export const buildRtmpUrl = (stream: string, txQuery = E2E_TX_QUERY) =>
  `rtmp://push-t2.videocc.net/recordf/${stream}?${txQuery}`;
export const buildWebrtcUrl = (stream: string, txQuery = E2E_TX_QUERY) =>
  `webrtc://push-t2.videocc.net/recordf/${stream}?${txQuery}`;

/** 已经过期 1 小时的推流地址（D1 用例用） */
export const E2E_EXPIRED_TX_TIME_HEX = Math.floor((Date.now() - 60 * 60 * 1000) / 1000)
  .toString(16)
  .toUpperCase();
export const E2E_EXPIRED_TX_QUERY = `txSecret=e2etxsecret&txTime=${E2E_EXPIRED_TX_TIME_HEX}`;

export const E2E_STREAM = `${E2E_CHANNEL_ID}_${E2E_STREAM_SUFFIX}`;
export const E2E_RTMP_URL = buildRtmpUrl(E2E_STREAM);
export const E2E_WEBRTC_URL = buildWebrtcUrl(E2E_STREAM);

export type E2eLiveStatus = 'unStart' | 'live' | 'end' | 'playback';

/**
 * 不存在的频道：服务端对外契约（`apps/server/src/polyv/upstream-error.ts` 的 CHANNEL_NOT_FOUND）。
 * 对**同一频道号**，`GET /api/channels/:id` 与 `GET /api/channels/:id/live-status` 返回同一个 404 体。
 * 改这句话要同步 `apps/server/src/channel/channel.controller.spec.ts` 的期望值（两边锁同一句）。
 */
export const E2E_CHANNEL_NOT_FOUND_BODY = {
  code: 404,
  message: '频道不存在，请确认频道号后重试',
} as const;

/** 服务端对非法指标采样的 400 体（§十一 A；计划没给逐字文案，这里给一句客户向的话） */
export const E2E_METRICS_INVALID_BODY = {
  code: 400,
  message: '采样数据不合法',
} as const;

/** 服务端对非法诊断 id 的 400 体（计划 §六逐字给出） */
export const E2E_DIAGNOSTIC_INVALID_ID_BODY = {
  code: 400,
  message: '诊断项不合法',
} as const;

/**
 * 频道模板不是纯视频时真实服务端的响应体（D29）。
 * 逐字抄自 `apps/server/src/polyv/upstream-error.ts` 的 `TEMPLATE_MISMATCH`：
 * 服务端对非纯视频模板**不改行为**，仍是 HTTP 502 + 这句 message，
 * 推流端 `error-to-signal.ts` 靠 `/模板|template|纯视频/` 把它映射成 D2。
 */
export const E2E_TEMPLATE_MISMATCH_BODY = {
  code: 502,
  message: '频道模板不是纯视频，无法用于第三方推流，请在直播后台改为纯视频模板后重试',
} as const;

/**
 * `GET /api/health` 的可控开关（D38：预检必须真探网络 / D39：探测必须反映「外网可达」）。
 *
 * - 默认（不传 `healthControl`）= `'ok'`（200 + `polyv:'reachable'`），既有 e2e 一条都不受影响；
 * - `'upstream-down'` = **200 + `{ ok: true, polyv: 'unreachable' }`**：
 *   服务端进程活着、但 polyv 上游不可达时**旧实现**的形状。专测 D39 的核心误判：
 *   前端只判 `response.ok` 时会把这条当成「网络正常」（所以这条用例在旧实现上必须是红的）；
 * - `'offline'` = **503 + `{ ok: false, polyv: 'unreachable' }`**：D39 ① 的新契约形状
 *   （本进程存活 ≠ 外部可达，用 503 表达「我连不上外面」）；
 * - `'fail'` = route 直接 `abort('failed')`，等价浏览器层断网（fetch 抛 TypeError，不是 5xx）。
 *   这是 D38 用例在用的旧模式，**保留**以保证既有断言不改不弱化。
 *
 * 用例可以在中途改 `mode` 模拟「网络恢复」（route handler 每次请求都现读这个对象）。
 */
export type HealthMode = 'ok' | 'upstream-down' | 'offline' | 'fail';

export interface HealthControl {
  mode: HealthMode;
}

export function createHealthControl(mode: HealthMode = 'ok'): HealthControl {
  return { mode };
}

export interface MockServerOptions {
  liveStatus?: E2eLiveStatus;
  viewerCount?: number;
  channelId?: string;
  channelName?: string;
  /** 模拟「频道不存在」：两个频道接口都返回 404 + E2E_CHANNEL_NOT_FOUND_BODY */
  channelNotFound?: boolean;
  /**
   * 推流会话上报记录（POST /channels/:id/push-session）。
   * 传一个数组进来，mock 会按真实契约返回成功并把每次上报 append 进去，
   * e2e 据此断言「开播时真的上报过 started / 停止后上报 stopped / channelId 恒为开播频道」。
   */
  pushSessionLog?: PushSessionReport[];
  /**
   * 频道模板（24060 D2）。默认 `'alone'`（纯视频）；传别的值模拟「频道不是纯视频模板」。
   * 真实服务端历史上对非纯视频模板直接抛 502，24060 要求把 template 透出给前端预检 → 这里 mock 成 200 + template。
   */
  template?: string;
  /** 推流地址有效期（ISO）；不传则用 txTime 换算值；显式传 `null` 模拟「上游没给 txTime」 */
  pushExpiresAt?: string | null;
  /** 覆盖 txTime（hex 秒）：传 E2E_EXPIRED_TX_TIME_HEX 可造一条过期地址（D1） */
  txTimeHex?: string;
  /**
   * 只让 `GET /api/channels/:channelId` 失败（D29 真实口径：非纯视频模板 → 502 + 模板文案）。
   * `POST /api/channels`（新建频道）不受影响，所以「频道能建出来、取地址时才被服务端拒绝」这条真实链路可以复现。
   */
  channelGetFailure?: { status: number; body: unknown } | null;
  /** 诊断上报记录（POST /channels/:id/diagnostics），mock 会 append 到该数组 */
  diagnosticsLog?: DiagnosticReportPayload[];
  /** 预置的诊断历史（GET 时一起返回，用来测「抽屉有记录」而不必真命中一次规则） */
  diagnosticsSeed?: DiagnosticRecordPayload[];
  /**
   * 指标采样上报记录（POST /channels/:id/metrics，§十一 A / D34）。
   * 传数组进来，mock 会把每次上报 append 进去；GET 时按 at 升序返回，e2e 据此断言「采样真的有 2 条以上且升序」。
   */
  metricsLog?: MetricReportPayload[];
  /** 预置的指标采样（GET 时与上报合并返回；「导出 CSV」用例不必真等 10 秒攒采样） */
  metricsSeed?: MetricSamplePayload[];
  /**
   * D38/D39：`GET /api/health` 的可控开关。不传 = 一直成功（默认，保证既有 e2e 不回归）。
   * 断网用例传 `createHealthControl('fail')`（浏览器层断网）/ `'offline'`（503）/
   * `'upstream-down'`（旧实现的 200 + polyv unreachable），恢复时把 `mode` 改回 `'ok'`。
   */
  healthControl?: HealthControl;
}

/** 一次推流会话上报（服务端契约见 apps/server/src/channel/channel.controller.ts） */
export interface PushSessionReport {
  channelId: string;
  state: string;
  at: number;
}

/** 推流端上报的诊断（计划 §六 POST 体） */
export interface DiagnosticReportPayload {
  channelId: string;
  id: string;
  code: string;
  level: string;
  reason: string;
  measured: string;
  expected: string;
  at: string;
  /** D30：恢复上报带它（只标记恢复，不新增记录） */
  recoveredAt?: string | null;
  /** §十一 B（D35）：断流恢复时带的本次断流时长（毫秒） */
  outageMs?: number;
  /** §十一 C（D36）：会话设备快照（存在则挂到频道的「最近一次会话设备」上） */
  device?: DeviceSnapshotPayload | null;
}

/**
 * 一次指标采样（§十一 A / D34 的 POST 体；`at` 是 ISO 字符串）。
 * 与服务端 `GET /api/channels/:id/metrics` 的 items 同形，导出 CSV 的列就是 `at,kbps,fps,dropFps,connection`。
 */
export interface MetricSamplePayload {
  kbps: number;
  fps: number;
  dropFps?: number;
  connection: string;
  at: string;
}

/** mock 内部记的采样（带频道号，便于按频道隔离） */
export interface MetricReportPayload extends MetricSamplePayload {
  channelId: string;
}

/** §十一 C（D36）：会话设备快照（浏览器拿不到的字段是 null，不编造） */
export interface DeviceSnapshotPayload {
  ua: string | null;
  os: string | null;
  cpuCores: number | null;
  deviceMemoryGb: number | null;
  gpuRenderer: string | null;
  screen: string | null;
}

/** 诊断历史条目（计划 §六 GET 响应 item） */
export interface DiagnosticRecordPayload {
  id: string;
  code: string;
  level: string;
  reason: string;
  measured: string;
  expected: string;
  firstAt: string;
  lastAt: string;
  occurrences: number;
  recoveredAt?: string | null;
  /** §十一 B（D35）：这条断流持续了多少毫秒 */
  outageMs?: number | null;
}

export function channelPayload(options: MockServerOptions = {}) {
  const channelId = options.channelId ?? E2E_CHANNEL_ID;
  const name = options.channelName ?? E2E_CHANNEL_NAME;
  const stream = `${channelId}_${E2E_STREAM_SUFFIX}`;
  const txQuery =
    options.txTimeHex === undefined
      ? E2E_TX_QUERY
      : `txSecret=e2etxsecret&txTime=${options.txTimeHex}`;
  const expiresAt =
    options.pushExpiresAt === undefined
      ? options.txTimeHex === undefined
        ? E2E_TX_EXPIRES_AT
        : options.txTimeHex
          ? new Date(Number.parseInt(options.txTimeHex, 16) * 1000).toISOString()
          : null
      : options.pushExpiresAt;

  return {
    channelId,
    name,
    watchUrl: `http://127.0.0.1:5174/?channelId=${channelId}`,
    template: options.template ?? 'alone',
    push: {
      rtmpUrl: buildRtmpUrl(stream, txQuery),
      webrtcUrl: buildWebrtcUrl(stream, txQuery),
      expiresAt,
    },
    stream,
  };
}

/** 设备快照必须是对象（字段缺失允许，但整体不能是字符串 / 数组） */
function isDeviceSnapshot(value: unknown): value is DeviceSnapshotPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonBody(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

/** 拦截 /api/**：按 path + method 返回契约里的形状。 */
export async function mockServerApis(page: Page, options: MockServerOptions = {}): Promise<void> {
  const liveStatus = options.liveStatus ?? 'live';
  const viewerCount = options.viewerCount ?? 3;
  const channelNotFound = options.channelNotFound === true;
  const channelGetFailure = options.channelGetFailure ?? null;
  const diagnosticsLog = options.diagnosticsLog ?? [];
  const diagnosticsSeed = options.diagnosticsSeed ?? [];
  const metricsLog = options.metricsLog ?? [];
  const metricsSeed = options.metricsSeed ?? [];
  const healthControl = options.healthControl ?? createHealthControl('ok');
  /** 每个频道「最近一次会话设备」（§十一 C / D36）：只有带 device 的上报才更新，与真实服务端同口径 */
  const latestDevice = new Map<string, DeviceSnapshotPayload>();

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/$/, '');
    const method = request.method().toUpperCase();

    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
    }

    if (path === '/api/health') {
      // D38：断网场景直接让请求失败，模拟浏览器网络不可达（预检探测必须据此判「连不上服务器」）
      if (healthControl.mode === 'fail') return route.abort('failed');
      // D39 ①：上游不可达 → 503 + ok:false（本进程活着与外部可达分开表达）
      if (healthControl.mode === 'offline') {
        return jsonBody(route, { ok: false, polyv: 'unreachable' }, 503);
      }
      // D39：旧实现在上游不可达时回 200 + polyv:'unreachable'（前端只判 response.ok 会误判成正常）
      if (healthControl.mode === 'upstream-down') {
        return jsonBody(route, { ok: true, polyv: 'unreachable' });
      }
      return jsonBody(route, { ok: true, polyv: 'reachable' });
    }

    if (path === '/api/channels' && method === 'POST') {
      return jsonBody(route, channelPayload(options), 201);
    }

    // 推流会话上报：必须成功（评审 W5 —— 之前落到兜底 404，前端 catch 吞掉，e2e 永远是假绿）
    if (/^\/api\/channels\/[^/]+\/push-session$/.test(path) && method === 'POST') {
      const channelId = path.split('/')[3] ?? '';
      const rawBody = request.postData();
      let state: unknown;
      try {
        state = rawBody ? (JSON.parse(rawBody) as { state?: unknown }).state : undefined;
      } catch {
        state = undefined;
      }
      if (state !== 'started' && state !== 'stopped') {
        return jsonBody(route, { code: 400, message: '推流状态只能是 started 或 stopped' }, 400);
      }
      options.pushSessionLog?.push({ channelId, state, at: Date.now() });
      return jsonBody(route, { channelId, state, updatedAt: new Date().toISOString() }, 201);
    }

    // 诊断上报（24060 §六）：与真实服务端同口径校验 id 枚举
    if (/^\/api\/channels\/[^/]+\/diagnostics$/.test(path) && method === 'POST') {
      const channelId = path.split('/')[3] ?? '';
      const rawBody = request.postData();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      // §十一 C（D36）：设备快照是可选字段；只有真的带了才更新「最近一次会话设备」
      const device = isDeviceSnapshot(parsed.device) ? parsed.device : null;
      // 「只带 device、不带 id」的 POST 是会话设备上报（与真实服务端同口径）：不产生诊断记录
      if (parsed.id === undefined && device) {
        latestDevice.set(channelId, device);
        const total = diagnosticsLog.filter((item) => item.channelId === channelId).length;
        return jsonBody(route, { channelId, stored: true, total }, 201);
      }
      const id = parsed.id;
      if (typeof id !== 'string' || !(E2E_DIAGNOSTIC_IDS as readonly string[]).includes(id)) {
        return jsonBody(route, E2E_DIAGNOSTIC_INVALID_ID_BODY, 400);
      }
      if (device) latestDevice.set(channelId, device);
      const report: DiagnosticReportPayload = {
        channelId,
        id,
        code: String(parsed.code ?? ''),
        level: String(parsed.level ?? ''),
        reason: String(parsed.reason ?? ''),
        measured: String(parsed.measured ?? ''),
        expected: String(parsed.expected ?? ''),
        at: String(parsed.at ?? new Date().toISOString()),
        recoveredAt: typeof parsed.recoveredAt === 'string' ? parsed.recoveredAt : undefined,
        // §十一 B（D35）：断流时长只接受数字（脏值当没带，与真实服务端同口径）
        outageMs: typeof parsed.outageMs === 'number' ? parsed.outageMs : undefined,
        ...(device ? { device } : {}),
      };
      diagnosticsLog.push(report);
      const total = diagnosticsLog.filter((item) => item.channelId === channelId).length;
      return jsonBody(route, { channelId, stored: true, total }, 201);
    }

    if (/^\/api\/channels\/[^/]+\/diagnostics$/.test(path) && method === 'GET') {
      const channelId = path.split('/')[3] ?? '';
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 50);

      // mock 只做「读回来」：把 seed + 本次上报按 lastAt 倒序合并（真实合并在 apps/server 单测里锁）。
      // §十一 B：恢复上报（recoveredAt）只标记同 code / 同 id 最近一条未恢复记录，并把 outageMs 落到那条上。
      const fromLog: DiagnosticRecordPayload[] = [];
      for (const report of diagnosticsLog) {
        if (report.channelId !== channelId) continue;
        if (report.recoveredAt) {
          const target =
            fromLog.find((item) => item.code === report.code) ??
            [...fromLog].reverse().find((item) => item.id === report.id && !item.recoveredAt);
          if (target) {
            target.recoveredAt = report.recoveredAt;
            if (typeof report.outageMs === 'number') target.outageMs = report.outageMs;
          }
          continue;
        }
        const mergeable = fromLog.find(
          (item) => item.id === report.id && Date.parse(report.at) - Date.parse(item.lastAt) < 60_000,
        );
        if (mergeable) {
          mergeable.occurrences += 1;
          mergeable.lastAt = report.at;
          mergeable.measured = report.measured;
          mergeable.recoveredAt = null;
          continue;
        }
        fromLog.push({
          id: report.id,
          code: report.code,
          level: report.level,
          reason: report.reason,
          measured: report.measured,
          expected: report.expected,
          firstAt: report.at,
          lastAt: report.at,
          occurrences: 1,
          recoveredAt: null,
          outageMs: null,
        });
      }

      const items = [...fromLog, ...diagnosticsSeed]
        .sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt))
        .slice(0, limit);

      return jsonBody(route, { channelId, items, device: latestDevice.get(channelId) ?? null });
    }

    // 指标采样（§十一 A / D34）：POST 追加一条，GET 按 at 升序返回
    if (/^\/api\/channels\/[^/]+\/metrics$/.test(path) && method === 'POST') {
      const channelId = path.split('/')[3] ?? '';
      const rawBody = request.postData();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      const at = typeof parsed.at === 'string' ? Date.parse(parsed.at) : Number.NaN;
      if (typeof parsed.kbps !== 'number' || Number.isNaN(at)) {
        return jsonBody(route, E2E_METRICS_INVALID_BODY, 400);
      }
      const sample: MetricReportPayload = {
        channelId,
        kbps: parsed.kbps,
        fps: typeof parsed.fps === 'number' ? parsed.fps : 0,
        connection: String(parsed.connection ?? ''),
        at: new Date(at).toISOString(),
        ...(typeof parsed.dropFps === 'number' ? { dropFps: parsed.dropFps } : {}),
      };
      metricsLog.push(sample);
      const total = metricsLog.filter((item) => item.channelId === channelId).length;
      return jsonBody(route, { channelId, stored: true, total }, 201);
    }

    if (/^\/api\/channels\/[^/]+\/metrics$/.test(path) && method === 'GET') {
      const channelId = path.split('/')[3] ?? '';
      const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 300, 300);

      const fromLog: MetricSamplePayload[] = metricsLog
        .filter((item) => item.channelId === channelId)
        .map(({ channelId: _channelId, ...sample }) => sample);
      const ascending = [...fromLog, ...metricsSeed].sort(
        (left, right) => Date.parse(left.at) - Date.parse(right.at),
      );
      // limit 取「最近 limit 条」，但仍按 at 升序（画曲线 / 导 CSV 都按时间正序）
      const items = ascending.length > limit ? ascending.slice(ascending.length - limit) : ascending;

      return jsonBody(route, { channelId, items });
    }

    if (/^\/api\/channels\/[^/]+\/live-status$/.test(path)) {
      // 频道不存在时两个接口必须同口径（状态码与文案一致），否则前端会串出两套说法
      if (channelNotFound) return jsonBody(route, E2E_CHANNEL_NOT_FOUND_BODY, 404);
      return jsonBody(route, { liveStatus, viewerCount });
    }

    if (/^\/api\/channels\/[^/]+$/.test(path) && method === 'GET') {
      if (channelNotFound) return jsonBody(route, E2E_CHANNEL_NOT_FOUND_BODY, 404);
      // D29：真实服务端对非纯视频模板返回 502（模板文案），不是 200 + template
      if (channelGetFailure) {
        return jsonBody(route, channelGetFailure.body, channelGetFailure.status);
      }
      return jsonBody(route, channelPayload(options));
    }

    // 未约定的接口明确暴露出来，避免 e2e 悄悄依赖假数据
    return jsonBody(
      route,
      { code: 404, message: `e2e mock 未覆盖该接口：${method} ${path}` },
      404,
    );
  });
}

/**
 * 断掉一切真实外部依赖：polyv / videocc / 公共 CDN。
 * 故意不拦 qcloudecdn：TXLivePusher 的桩就是通过 route 命中该域名下发的
 * （Playwright 后注册的 route 优先匹配，这里再拦会盖掉桩）。
 * 未安装 TXLivePusher 桩的用例由 spec 自己断言（推流端必须命中桩）。
 */
export async function blockExternalNetwork(page: Page): Promise<void> {
  const external = [
    '**/*.polyv.cn/**',
    '**/*.polyv.net/**',
    '**/*.videocc.net/**',
    '**/unpkg.com/**',
    '**/cdn.jsdelivr.net/**',
  ];
  for (const pattern of external) {
    await page.route(pattern, async (route) => {
      await route.abort('failed');
    });
  }
}
