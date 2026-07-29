// lib/schemas/binanceSchema.ts
import { z } from 'zod';

// 1. 定義單筆資金流水 (Income) 的格式
export const binanceIncomeSchema = z.object({
  symbol: z.string().optional().catch(""), // 有些流水(如劃轉)沒 symbol，給預設空字串
  incomeType: z.string(),
  income: z.string(), // 幣安金額通常回傳字串，以保持精度
  asset: z.string(),
  info: z.string().optional().catch(""),
  time: z.coerce.number(),
  tranId: z.union([z.number(), z.string()]), // 預防幣安有時傳數字有時傳字串
  tradeId: z.string().optional().catch(""),
});

// 2. 定義單筆歷史成交 (UserTrade) 的格式
export const binanceTradeSchema = z.object({
  buyer: z.boolean(),
  commission: z.string(),
  commissionAsset: z.string(),
  id: z.number(),
  maker: z.boolean(),
  orderId: z.number(),
  price: z.string(),
  qty: z.string(),
  quoteQty: z.string(),
  realizedPnl: z.string(),
  side: z.string(),
  positionSide: z.string().optional().catch("BOTH"), 
  symbol: z.string(),
  time: z.coerce.number(),
});

// 定義陣列格式 (如果未來你想一次驗證整包)
export const binanceIncomeArraySchema = z.array(binanceIncomeSchema);
export const binanceTradeArraySchema = z.array(binanceTradeSchema);

// 導出 TypeScript 型別給 Calculator 用
export type RawBinanceIncome = z.infer<typeof binanceIncomeSchema>;
export type RawBinanceTrade = z.infer<typeof binanceTradeSchema>;