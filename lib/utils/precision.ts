// lib/utils/precision.ts

const SYMBOL_PRECISION_MAP: Record<string, number> = {
  "XAUUSD": 2,
  "EURUSD": 5,
  "NAS100USD": 1,
  "NAS100": 1,
  "US100": 1,
  "US30": 1,
};

/**
 * 根據交易品種，修剪止損與止盈的價格距離精度
 */
// 🚨 把這裡的 | undefined 全部拿掉！
export function formatDistancePrecision(symbol: string, distance: number): number {
  // 因為傳進來的絕對是數字，連 if (distance === undefined) 的防呆都可以刪了
  const precision = SYMBOL_PRECISION_MAP[symbol] ?? 1;
  return +(distance.toFixed(precision));
}