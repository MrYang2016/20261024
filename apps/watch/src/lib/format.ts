/** 观看数展示：过万用「万」并保留一位小数，其余原样 */
export function formatViewerCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 10000) return String(Math.round(count));
  return `${(count / 10000).toFixed(1)} 万`;
}
