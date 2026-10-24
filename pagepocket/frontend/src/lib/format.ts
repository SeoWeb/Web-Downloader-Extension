/**
 * Shared byte formatter (storage-usage-display, design D5). One utility
 * renders every storage value — meter usage, meter limit, and card badges —
 * so equivalent values read identically everywhere.
 *
 * 1024 base; units B/KB/MB/GB; one decimal below 10, whole numbers at or
 * above; a trailing ".0" is trimmed ("0 B", "512 KB", "2.4 MB", "50 MB").
 */
const UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `0 ${UNITS[0]}`;
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals).replace(/\.0$/, "")} ${UNITS[unit]}`;
}
