// lib/utils/risk-calculator.ts

export interface CalculateVolumeParams {
  balanceInCents: number;   // 從 cTrader 查回來的原始餘額 (美分)
  riskPercent: number;      // Webhook 傳來的 % 數 (例如 1 代表 1%)[cite: 12]
  symbol: string;           // 交易商品[cite: 12]
  slPriceDistance: number;  // 停損的「絕對價格差距」(例如 EURUSD 是 0.0020，黃金是 10)[cite: 12]
}

// ==========================================
// 📊 商品最小下單單位對照表 (Volume Step)[cite: 12]
// 🌟 修正：這裡定義「手數(Lots)」的最小進位級距
// ==========================================
const SYMBOL_VOLUME_STEPS: Record<string, number> = {
  "EURUSD": 0.01, // 最小下單量 0.01 手
  "XAUUSD": 0.01, // 最小下單量 0.01 手
  "NAS100USD": 0.01,
  "NAS100": 0.01,    
  "US100":  0.01, // FTMO 指數通常允許 0.01 手起跳
  "US30":   0.01
};

// ==========================================
// ✨ 新增：商品合約大小對照表 (Lot Size)
// 將我們算好的「手數」，乘上這個倍數，轉成 cTrader 看得懂的 Units
// ==========================================
const SYMBOL_LOT_SIZE: Record<string, number> = {
  "EURUSD": 10000000, // 1 標準手 = 100,000 單位
  "XAUUSD": 10000,    // 1 標準手 = 100 單位 (盎司)
  "NAS100USD": 100,
  "NAS100": 100,    
  "US100":  100,    // 從 API 查到的真實數據：1 手 = 100 單位
  "US30":   100     // (視券商而定，FTMO 通常也是 100)
};

// 🛡️ 最大下單單位天花板 (Volume Hard Cap)[cite: 12]
// 這裡的單位為「手數 (Lots)」
const SYMBOL_MAX_VOLUME: Record<string, number> = {
  "NAS100USD": 200, // 極限防呆：200 手[cite: 12]
  "US100": 200, //[cite: 12]
};

// 單筆交易金額上限 後續初始帳號變大時 可根據初始資金的5%最大回撤調整 (美金)
const MAX_RISK_USD = 1200;

export function calculateDynamicVolume({
  balanceInCents, //[cite: 12]
  riskPercent, //[cite: 12]
  symbol, //[cite: 12]
  slPriceDistance //[cite: 12]
}: CalculateVolumeParams): number {
  
  // 1. 還原真實餘額 (美金)[cite: 12]
  const actualBalance = balanceInCents / 100; //[cite: 12]

  // 2. 計算這筆訂單的絕對風控金額 (美金)[cite: 12]
  let riskAmount = actualBalance * (riskPercent / 100); //[cite: 12]

  // ==========================================
  // 資金考級特化防呆：限制單筆最大風險美金上限
  // ==========================================
  if (riskAmount > MAX_RISK_USD) {
    console.warn(`[風控啟動] 計算風險金額 ($${riskAmount.toFixed(2)}) 超過考級帳號安全上限，已強制降為 $${MAX_RISK_USD}。`);
    riskAmount = MAX_RISK_USD;
  }

  // 3. 終極防呆[cite: 12]
  if (slPriceDistance <= 0) { //[cite: 12]
    throw new Error(`[風控攔截] 停損距離必須大於 0 (收到: ${slPriceDistance})`); //[cite: 12]
  }

  // 4. 計算原始手數需求 (Lots)[cite: 12]
  // 例如: 1000 美金風險 / 35.15 點停損 = 28.449 手
  const rawVolume = riskAmount / slPriceDistance; //[cite: 12]

  // 5. 根據商品的最小跳動手數進行「向下取整」[cite: 12]
  const step = SYMBOL_VOLUME_STEPS[symbol]; //[cite: 12]
  if (!step) { //[cite: 12]
    throw new Error(`[風控攔截] 找不到 ${symbol} 的合約規格，請更新對照表`); //[cite: 12]
  }
  
  // 例如 28.449 / 0.01 = 2844.9 -> floor 取 2844 -> 乘 0.01 = 28.44 手
  let safeVolumeInLots = Math.floor(rawVolume / step) * step; //[cite: 12]

  // 6. 如果算出來的手數小於平台的最低限制，強制歸零[cite: 12]
  if (safeVolumeInLots < step) { //[cite: 12]
    console.warn(`[風控警告] ${symbol} 計算出的單位 (${rawVolume.toFixed(2)}) 低於平台最小允許單位 (${step})，已強制歸零。`); //[cite: 12]
    return 0;  //[cite: 12]
  }
  
  // 7. 終極防線：套用最大天花板限制[cite: 12]
  const maxVolume = SYMBOL_MAX_VOLUME[symbol]; //[cite: 12]
  if (maxVolume && safeVolumeInLots > maxVolume) { //[cite: 12]
    console.warn(`[風控啟動] ${symbol} 計算手數 (${safeVolumeInLots}) 超過極限天花板，已強制降為 ${maxVolume} 手。`); //[cite: 12]
    safeVolumeInLots = maxVolume;
  }

  // ==========================================
  // ✨ 8. 最終轉換：將「手數」轉為 cTrader API 要求的「單位 (Units)」
  // ==========================================
  const lotSize = SYMBOL_LOT_SIZE[symbol];
  if (!lotSize) {
    throw new Error(`[風控攔截] 找不到 ${symbol} 的 Lot Size，無法轉換為 API 單位`);
  }

  // 例如：28.44 手 * 100 (US100的LotSize) = 2844 單位
  const apiUnits = safeVolumeInLots * lotSize;

  // 🛡️ 再套一層 Math.round() 防止 JavaScript 浮點數精度導致小數點尾數 (例如 2844.00000000001)
  return Math.round(apiUnits);
}