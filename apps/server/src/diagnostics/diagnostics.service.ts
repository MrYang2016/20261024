import { Injectable } from '@nestjs/common';
import {
  DIAGNOSTIC_DEDUPE_WINDOW_MS,
  DIAGNOSTIC_HISTORY_LIMIT,
  type DeviceSnapshot,
  type DiagnosticRecord,
  type DiagnosticReport,
  type DiagnosticStoreResult,
} from '@live1024/shared/diagnostics';

/** GET 缺省条数 / 上限（计划 §六：limit 缺省 50、上限 50） */
const DEFAULT_LIMIT = DIAGNOSTIC_HISTORY_LIMIT;

/**
 * 诊断留痕（D23：每频道环形缓冲 50 条，只在内存里，服务端重启即清空，不引数据库）。
 *
 * 写入策略（计划 §五 5.2）：同 `id` 且距上一条的 `lastAt` < 60 秒 → 合并（occurrences+1、更新 lastAt / measured），
 * 否则新增一条；超过 50 条淘汰最旧的一条。带 `recoveredAt` 的上报只标记恢复，不计次数。
 *
 * 24060 增补（计划 §十一 B/C）：
 * - 恢复上报可带 `outageMs`（断流持续时长）：只写到被恢复的那条记录上，供客户追问「断了几秒」；
 * - 会话设备快照（D36）与诊断记录分开存：每频道只保留**最近一次会话**的设备，`report` 为 null 时
 *   表示「这次只上报设备」（会话开始还没有任何故障可报）。
 */
@Injectable()
export class DiagnosticsService {
  private readonly store = new Map<string, DiagnosticRecord[]>();
  /** channelId → 最近一次会话的设备快照（D36） */
  private readonly devices = new Map<string, DeviceSnapshot>();

  /**
   * 记录一条诊断（或只记设备）；返回该频道当前总条数（合并进已有条目时 total 不变）。
   * `report === null` = 只存设备，不产生诊断记录。
   */
  record(
    channelId: string,
    report: DiagnosticReport | null,
    device?: DeviceSnapshot | null,
  ): DiagnosticStoreResult {
    // 设备快照可以随任意一条上报带上来（POST 体的可选字段），也可以单独上报（report 为 null）
    const snapshot = device ?? report?.device ?? null;
    if (snapshot) this.devices.set(channelId, snapshot);
    const items = this.store.get(channelId) ?? [];
    if (!report) return { channelId, stored: Boolean(snapshot), total: items.length };
    const at = toMillis(report.at) ?? Date.now();
    const atIso = new Date(at).toISOString();

    if (report.recoveredAt) {
      /**
       * 恢复只能标记**最近那条还没恢复的**同 id 记录。
       * 同一诊断在不同会话里会有多条记录（中间隔了 > 60 秒），按数组顺序取第一条会把上次会话的
       * 旧记录又标一次「已恢复」，而当前这条永远停在未恢复——讲师看到的历史就是对不上的。
       */
      const sameId = items.filter((item) => item.id === report.id);
      // 上报体带了 code（DIAG-xx-时间戳，一次故障一个），能唯一命中就最准
      const existing =
        items.find((item) => item.id === report.id && item.code === report.code) ??
        latestBy(sameId.filter((item) => !item.recoveredAt)) ??
        latestBy(sameId);
      if (existing) {
        existing.recoveredAt = toIso(report.recoveredAt) ?? atIso;
        // 恢复不动 lastAt：历史里那一行的时间是「最后一次出问题」的时间，不是恢复时间
        // 断流时长（D35）：只有恢复上报带了才算数，没带就保持 null（不猜）
        if (typeof report.outageMs === 'number' && Number.isFinite(report.outageMs)) {
          existing.outageMs = Math.max(0, Math.round(report.outageMs));
        }
      }
      this.store.set(channelId, items);
      return { channelId, stored: Boolean(existing), total: items.length };
    }

    const mergeable = items.find(
      (item) =>
        item.id === report.id &&
        at - (toMillis(item.lastAt) ?? at) < DIAGNOSTIC_DEDUPE_WINDOW_MS,
    );

    if (mergeable) {
      mergeable.occurrences += 1;
      mergeable.lastAt = atIso;
      mergeable.code = report.code;
      mergeable.level = report.level;
      mergeable.reason = report.reason;
      mergeable.measured = report.measured;
      mergeable.expected = report.expected;
      // 又出问题了：之前的恢复标记要撤掉，否则历史里会显示「已恢复」却还在发生
      mergeable.recoveredAt = null;
    } else {
      items.push({
        id: report.id,
        code: report.code,
        level: report.level,
        reason: report.reason,
        measured: report.measured,
        expected: report.expected,
        firstAt: atIso,
        lastAt: atIso,
        occurrences: 1,
        recoveredAt: null,
        outageMs: null,
      });
      // 环形缓冲：只留最近 50 条，淘汰最旧（先写入的那条）
      while (items.length > DIAGNOSTIC_HISTORY_LIMIT) items.shift();
    }

    this.store.set(channelId, items);
    return { channelId, stored: true, total: items.length };
  }

  /** 该频道最近一次会话的设备快照（D36）；从没上报过就是 null */
  getDevice(channelId: string): DeviceSnapshot | null {
    return this.devices.get(channelId) ?? null;
  }

  /** 按 lastAt 倒序返回该频道的最近 limit 条（缺省 / 非法值都按 50 处理） */
  list(channelId: string, limit?: number | string): DiagnosticRecord[] {
    const items = this.store.get(channelId) ?? [];
    const size = normalizeLimit(limit);
    return [...items]
      .sort((left, right) => (toMillis(right.lastAt) ?? 0) - (toMillis(left.lastAt) ?? 0))
      .slice(0, size);
  }
}

/** 查询串里的 limit 是字符串（?limit=3），缺省 / 非正数 / 非数字都回落默认值 */
function normalizeLimit(limit?: number | string): number {
  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : limit;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), DEFAULT_LIMIT);
}

/** 取 lastAt 最新的那条（并列时取后写入的，保证「当前会话」优先） */
function latestBy(items: DiagnosticRecord[]): DiagnosticRecord | undefined {
  let latest: DiagnosticRecord | undefined;
  for (const item of items) {
    if (!latest) {
      latest = item;
      continue;
    }
    if ((toMillis(item.lastAt) ?? 0) >= (toMillis(latest.lastAt) ?? 0)) latest = item;
  }
  return latest;
}

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toIso(value: string): string | null {
  const parsed = toMillis(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}
