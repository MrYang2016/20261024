/** 推流时长 mm:ss / HH:mm:ss */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 码率只展示整数 kbps，未知时显示占位符而不是编数字 */
export function formatBitrate(kbps: number | null): string {
  return kbps === null ? '—' : `${Math.round(kbps)} kbps`;
}

export function formatFps(fps: number | null): string {
  return fps === null ? '—' : `${Math.round(fps)} fps`;
}

export function formatResolution(width: number | null, height: number | null): string {
  return width && height ? `${width}×${height}` : '—';
}
