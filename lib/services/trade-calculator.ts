// lib/trade-calculator.ts
import { RawBinanceIncome, RawBinanceTrade } from '@/lib/schemas/binanceSchema';

export interface CleanTrade {
  exchange_order_id: string;
  symbol: string;
  side: string;
  position_side: string;
  order_type: string;
  leverage: string;
  entry_price: number;
  executed_qty: number;
  commission_paid: number;
  rebate_earned: number;
  realized_pnl: number;
  true_net_pnl: number;
  executed_at: string;
}

//資金流水格式
export interface CleanIncome {
  income_id: string;
  symbol: string;
  income_type: string;
  amount: number;
  asset: string;
  info: string;
  trade_id: string;
  executed_at: string;
}

/**
 * 將 BingX 的原始訂單資料，清洗並計算成我們的資料庫格式
 */
export function processBingXOrder(rawOrder: any): CleanTrade | null {
  // 🚨 核心防衛：只處理「已完全成交」的訂單
  // 依據 BingX 文件，可能有 'FILLED' 或 'PARTIALLY_FILLED'
  if (rawOrder.status !== "FILLED" && rawOrder.status !== "PARTIALLY_FILLED") {
    return null; // 遇到取消單或掛單中，直接回傳 null，外面會把它過濾掉
  }

  // 1. 抓取真實量價 (使用 avgPrice 而不是 price)
  const entryPrice = parseFloat(rawOrder.avgPrice || "0");
  const executedQty = parseFloat(rawOrder.executedQty || "0");

  // 2. 算錢防呆
  const realizedPnl = parseFloat(rawOrder.profit || "0");
  const commission = Math.abs(parseFloat(rawOrder.commission || "0")); 
  
  const rebateEarned = commission * 0.25; // 25% 反佣
  const trueNetPnl = realizedPnl - commission + rebateEarned; // 真實淨利

  // 3. 組裝完美格式
  return {
    // 強制轉字串，防止 JS 超大整數精度遺失
    exchange_order_id: String(rawOrder.orderId), 
    symbol: rawOrder.symbol,
    side: rawOrder.side,               
    position_side: rawOrder.positionSide, 
    order_type: rawOrder.type,           // 儲存 LIMIT 或 MARKET
    leverage: String(rawOrder.leverage), // 儲存 104X
    entry_price: entryPrice,
    executed_qty: executedQty,
    commission_paid: commission,
    rebate_earned: rebateEarned,
    realized_pnl: realizedPnl,
    true_net_pnl: trueNetPnl,          
    // 使用 updateTime 作為真實成交時間，並轉為 ISO 格式
    executed_at: new Date(parseInt(rawOrder.updateTime)).toISOString(), 
  };
}

export function processBingXIncome(raw: any): CleanIncome {
  // 防呆：確保 tranId 是字串
  const tranIdString = String(raw.tranId); 

  return {
    income_id: tranIdString,
    symbol: raw.symbol,
    income_type: raw.incomeType, // ✨ 成功塞入抓取到的 PNL/COMMISSION
    amount: parseFloat(raw.income || "0"), 
    asset: raw.asset,
    info: raw.info,
    trade_id: String(raw.tradeId),
    executed_at: new Date(parseInt(raw.time)).toISOString(),
  };
}


export function processBinanceIncome(raw: RawBinanceIncome): CleanIncome | null {
  const tranIdString = String(raw.tranId); 

  return {
    income_id: tranIdString,
    symbol: raw.symbol || "", 
    income_type: raw.incomeType, // 🌟 綁定你的 Type
    amount: parseFloat(raw.income || "0"), 
    asset: raw.asset || "USDT",
    info: raw.info || "",
    trade_id: String(raw.tradeId || ""),
    executed_at: new Date(raw.time).toISOString(),
  };
}

/**
 * 處理幣安的「成交歷史 userTrades」(取代 allOrders，因為這樣才有 PNL 和手續費)
 */
export function processBinanceTrade(rawTrade: RawBinanceTrade): CleanTrade | null {
  // 幣安的 userTrades 預設就已經是「已成交」的紀錄，所以不需要像 order 一樣判斷 status
  
  const entryPrice = parseFloat(rawTrade.price || "0");
  const executedQty = parseFloat(rawTrade.qty || "0");
  
  // 幣安的手續費跟盈虧直接提供在這裡
  const realizedPnl = parseFloat(rawTrade.realizedPnl || "0");
  const commission = Math.abs(parseFloat(rawTrade.commission || "0")); 
  
  // 假設你幣安是 10% 返佣 (如果是用 BNB 抵扣，手續費本身就已經打折了，這裡可以視情況調整)
  const rebateEarned = commission * 0.1; 
  const trueNetPnl = realizedPnl - commission + rebateEarned; 

  return {
    exchange_order_id: String(rawTrade.orderId), 
    symbol: rawTrade.symbol,
    side: rawTrade.side, // BUY 或 SELL
    position_side: rawTrade.positionSide || "BOTH", // 單向持倉會給 BOTH，雙向持倉會給 LONG/SHORT
    order_type: "MARKET/LIMIT", // userTrades 不會回傳 orderType，可以用字串代替或去查 order API
    leverage: "0", // userTrades 不會回傳當下使用的槓桿倍數
    entry_price: entryPrice,
    executed_qty: executedQty,
    commission_paid: commission,
    rebate_earned: rebateEarned,
    realized_pnl: realizedPnl,
    true_net_pnl: trueNetPnl,          
    executed_at: new Date(rawTrade.time).toISOString(), 
  };
}