// lib/schemas/webhookSchema.ts
import { z } from 'zod';

export const webhookSchema = z.object({
  // 1. 安全防護
  secret: z.string().length(32).regex(/^[a-z0-9]+$/),
    
  // 2. 動作判定 (擴充為三種：進場、出場、撤單)
  action: z.enum(['ENTRY', 'EXIT', 'CANCEL'], { message: "無效的動作類型" }),
  
  // 3. 訂單身分證 (連接 TV 與 Binance 的關鍵)
  trade_id: z.string({ message: "缺少訂單 ID" }),
  symbol: z.string({ message: "缺少交易對" }).transform((val) => {
    let cleanSymbol = val.toUpperCase();
    
    // 如果字尾有 .P，直接切掉 (針對 TV 永續合約代號)
    if (cleanSymbol.endsWith(".P")) {
      cleanSymbol = cleanSymbol.replace(".P", "");
    }
    
    // 預防萬一，順便把可能出現的斜線或減號也清掉 (例如 BTC/USDT -> BTCUSDT)
    cleanSymbol = cleanSymbol.replace(/[^A-Z0-9]/g, "");
    
    return cleanSymbol;
  }),
  // ---------- ENTRY 專屬欄位 (使用 optional 因為 CANCEL 不會傳) ----------
  tag: z.string().optional(),
  direction: z.enum(['LONG', 'SHORT', 'buy', 'sell']).optional(),
  price: z.number().optional(),
  sl: z.number().optional(),
  tp: z.number().optional(),
  sl_distance: z.number().optional(),
  tp_distance: z.number().optional(),
  ote: z.number().optional(),
  riskPercent: z.number().optional(),  // 👈 給 Vercel 算倉用的風險 %
  zone_top: z.number().nullable().optional(),
  zone_bottom: z.number().nullable().optional(),
  tv_time: z.number().optional(),
});

export type WebhookPayload = z.infer<typeof webhookSchema>;

// 1. 先把大家都有的「共用欄位」抽出來
const baseFtmoSchema = z.object({
  secret: z.string().length(32).regex(/^[a-z0-9]+$/),
  trade_id: z.string({ message: "缺少訂單 ID" }),
  symbol: z.string({ message: "缺少交易對" }).transform((val) => {
    let cleanSymbol = val.toUpperCase();
    if (cleanSymbol.endsWith(".P")) cleanSymbol = cleanSymbol.replace(".P", "");
    return cleanSymbol.replace(/[^A-Z0-9]/g, "");
  }),
});

// 2. 使用 discriminatedUnion 根據 action 自動切換驗證規則
export const ftmoWebhookSchema = z.discriminatedUnion('action', [
  
  // 🟢 當 action 是 ENTRY 時，嚴格要求這些欄位
  baseFtmoSchema.extend({
    action: z.literal('ENTRY'),
    tag: z.string(),
    direction: z.enum(['LONG', 'SHORT', 'buy', 'sell']),
    sl_distance: z.number().positive("停損距離必須大於 0"),
    tp_distance: z.number().positive("止盈距離必須大於 0"),
    ote: z.number().positive(),
    riskPercent: z.number(),
    zone_top: z.number().nullable().optional(),
    zone_bottom: z.number().nullable().optional(),
    tv_time: z.number().optional(),
  }),

  // 🔴 當 action 是 CANCEL 時，就只需要基本欄位，不囉嗦
  baseFtmoSchema.extend({
    action: z.literal('CANCEL')
  }),

  //當action是EXIT
    baseFtmoSchema.extend({
    action: z.literal('EXIT')
  })
]);

export type FtmoWebhookPayload = z.infer<typeof ftmoWebhookSchema>;