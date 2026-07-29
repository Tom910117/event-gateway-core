// lib/utils/risk-guard.ts

// 🚨 這裡設定各品種的最低止損距離
const SYMBOL_MIN_SL_MAP: Record<string, number> = {
  "NAS100USD": 20, 
  "US100": 20,
};

/**
 * 檢查並強制執行最低止損距離
 */
export function enforceMinimumStopLoss(symbol: string, currentSl: number): number {
  const minSl = SYMBOL_MIN_SL_MAP[symbol] ?? 0;
  
  if (currentSl < minSl) {
    console.warn(`[風控防禦] ${symbol} 收到過窄止損 ${currentSl}，強制放大至底線 ${minSl}`);
    return minSl;
  }
  
  return currentSl;
}