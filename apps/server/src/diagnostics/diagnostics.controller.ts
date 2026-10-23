import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { ApiErrorBody } from '@live1024/shared';
import {
  DIAGNOSTIC_IDS,
  DIAGNOSTIC_META,
  type DeviceSnapshot,
  type DiagnosticId,
  type DiagnosticLevel,
  type DiagnosticRecord,
  type DiagnosticReport,
  type DiagnosticStoreResult,
} from '@live1024/shared/diagnostics';
import { DiagnosticsService } from './diagnostics.service';

/** 频道号口径与 channel.controller.ts 的 assertChannelId 一致（`/^\d{4,20}$/`） */
const CHANNEL_ID_PATTERN = /^\d{4,20}$/;
const INVALID_CHANNEL_ID: ApiErrorBody = { code: 400, message: '频道号格式不正确' };
const INVALID_DIAGNOSTIC_ID: ApiErrorBody = { code: 400, message: '诊断项不合法' };
const INVALID_DEVICE: ApiErrorBody = { code: 400, message: '设备信息不合法' };
const LEVELS: readonly DiagnosticLevel[] = ['danger', 'warning'];

/** POST 体：客户端上报一条诊断（字段与 packages/shared 的 DiagnosticReport 对齐，这里按脏数据处理） */
interface DiagnosticReportBody {
  id?: unknown;
  code?: unknown;
  level?: unknown;
  reason?: unknown;
  measured?: unknown;
  expected?: unknown;
  at?: unknown;
  recoveredAt?: unknown;
  /** 断流时长（毫秒，D35）：只对恢复上报有意义 */
  outageMs?: unknown;
  /** 会话设备快照（D36）：会话开始时随上报带一次 */
  device?: unknown;
}

/**
 * 诊断留痕接口（D23 / 计划 §六）：
 *   POST /api/channels/:channelId/diagnostics → 201 `{ channelId, stored, total }`
 *   GET  /api/channels/:channelId/diagnostics?limit=50 → `{ channelId, items, device }`
 * 只做内存留痕，不引数据库；错误体走统一的 ApiErrorBody（客户向一句话）。
 *
 * 24060 增补（计划 §十一 B/C）：
 * - 上报体可带 `outageMs`（断流时长）与 `device`（设备快照）；
 * - **只带 `device` 不带 `id`** 的 POST 是合法的「会话设备上报」（不新增诊断枚举、不产生诊断记录）。
 */
@Controller('channels/:channelId/diagnostics')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {
    // 控制器方法常被当作引用传递（回调 / 直接取方法调用），构造时绑定 this，避免调用时丢上下文
    this.report = this.report.bind(this);
    this.list = this.list.bind(this);
  }

  @Post()
  report(@Param('channelId') channelId: string, @Body() body: DiagnosticReportBody | undefined): DiagnosticStoreResult {
    const id = assertChannelId(channelId);
    const device = toDevice(body?.device);
    // 只上报设备（会话开始、还没有任何故障可报）：不产生诊断记录
    if (body?.id === undefined && device !== null) {
      return this.diagnostics.record(id, null, device);
    }
    return this.diagnostics.record(id, toReport(body), device);
  }

  @Get()
  list(
    @Param('channelId') channelId: string,
    @Query('limit') limit?: string,
  ): { channelId: string; items: DiagnosticRecord[]; device: DeviceSnapshot | null } {
    const id = assertChannelId(channelId);
    return {
      channelId: id,
      items: this.diagnostics.list(id, limit),
      device: this.diagnostics.getDevice(id),
    };
  }
}

function assertChannelId(channelId: string): string {
  if (!CHANNEL_ID_PATTERN.test(channelId ?? '')) {
    throw new BadRequestException(INVALID_CHANNEL_ID);
  }
  return channelId;
}

/**
 * 校验 + 归一上报体。
 * 诊断 id 必须是共享枚举里的一期 7 条之一：脏数据不进内存缓冲（否则历史抽屉会渲染出未知诊断项）。
 */
function toReport(body: DiagnosticReportBody | undefined): DiagnosticReport {
  const id = body?.id;
  if (typeof id !== 'string' || !(DIAGNOSTIC_IDS as readonly string[]).includes(id)) {
    throw new BadRequestException(INVALID_DIAGNOSTIC_ID);
  }
  const diagnosticId = id as DiagnosticId;
  const meta = DIAGNOSTIC_META[diagnosticId];
  const at = toIsoString(body?.at) ?? new Date().toISOString();
  const level = LEVELS.find((candidate) => candidate === body?.level) ?? meta.level;

  return {
    id: diagnosticId,
    level,
    at,
    code: asText(body?.code) ?? `DIAG-${diagnosticId}-${at.slice(0, 19).replace(/[-:T]/g, '')}`,
    reason: asText(body?.reason) ?? meta.reason,
    measured: asText(body?.measured) ?? '—',
    expected: asText(body?.expected) ?? meta.expected,
    recoveredAt: toIsoString(body?.recoveredAt) ?? undefined,
    outageMs: toDuration(body?.outageMs) ?? undefined,
  };
}

/** 毫秒时长：非负有限数才收，其余当作没带 */
function toDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * 设备快照（D36）：字段逐个白名单化。
 * 缺失 / 类型不对的字段写 null（浏览器拿不到就说未知），但 `device` 本身存在时必须是个对象。
 */
function toDevice(value: unknown): DeviceSnapshot | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new BadRequestException(INVALID_DEVICE);
  const source = value as Record<string, unknown>;
  return {
    ua: asText(source.ua),
    os: asText(source.os),
    cpuCores: toCount(source.cpuCores),
    deviceMemoryGb: toAmount(source.deviceMemoryGb),
    gpuRenderer: asText(source.gpuRenderer),
    screen: asText(source.screen),
  };
}

function toCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function toAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toIsoString(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
