import { Injectable } from '@nestjs/common';
import {
  METRICS_HISTORY_LIMIT,
  type MetricSample,
  type MetricStoreResult,
} from '@live1024/shared/diagnostics';

/** 缺省 / 上限：一次最多读回环形缓冲里的全部 300 条 */
const DEFAULT_LIMIT = METRICS_HISTORY_LIMIT;

/**
 * 指标时间序列留痕（D34，回应国开客户函第①条「推流帧率、码率等客观数据」）。
 *
 * 与诊断留痕一样只在内存里（沿用 D10 / D23，不引数据库），服务端重启即清空。
 * 每频道环形 **300 条**（5 秒一条 ≈ 25 分钟），足够覆盖一次断流前后的证据窗口；
 * 读取按 `at` **升序**返回，画曲线与导 CSV 都不用再排。
 */
@Injectable()
export class MetricsService {
  /** channelId → 采样（写入按时间追加，超出 300 条淘汰最旧） */
  private readonly store = new Map<string, MetricSample[]>();

  /** 记录一条采样；返回该频道当前总条数 */
  record(channelId: string, sample: MetricSample): MetricStoreResult {
    const items = this.store.get(channelId) ?? [];
    items.push(sample);
    // 环形缓冲：只留最近 300 条（淘汰最早那条）
    while (items.length > METRICS_HISTORY_LIMIT) items.shift();
    this.store.set(channelId, items);
    return { channelId, stored: true, total: items.length };
  }

  /**
   * 按 `at` 升序返回最近的 limit 条（缺省 / 上限都是 300）。
   * 取「最近 N 条」而不是「最早 N 条」：客户要的证据是刚发生的那次断流。
   */
  list(channelId: string, limit?: number | string): MetricSample[] {
    const items = this.store.get(channelId) ?? [];
    const size = normalizeLimit(limit);
    return [...items]
      .sort((left, right) => (toMillis(left.at) ?? 0) - (toMillis(right.at) ?? 0))
      .slice(-size);
  }
}

/** 查询串里的 limit 是字符串（?limit=3），缺省 / 非正数 / 非数字都回落默认值 */
function normalizeLimit(limit?: number | string): number {
  const parsed = typeof limit === 'string' ? Number.parseInt(limit, 10) : limit;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), DEFAULT_LIMIT);
}

function toMillis(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
