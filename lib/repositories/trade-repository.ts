// lib/trade-repository.ts
import { supabase } from '../supabase';
import { CleanTrade } from '../services/trade-calculator';

export async function upsertTrades(trades: CleanTrade[]) {
  if (trades.length === 0) return [];

  // 使用 upsert，如果 exchange_order_id 已存在則更新，不存在則新增
  const { data, error } = await supabase
    .from('trades')
    .upsert(trades, { onConflict: 'exchange_order_id' })
    .select();

  if (error) {
    console.error('資料庫存取失敗:', error.message);
    throw error;
  }

  return data;
}

export async function pingDatabase() {
  const { data, error } = await supabase
    .from('trades')
    .select('id')
    .limit(1);

  if (error) {
    throw new Error(`Supabase 防休眠查詢失敗: ${error.message}`);
  }
  return data;
}