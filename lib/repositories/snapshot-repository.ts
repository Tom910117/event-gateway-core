// lib/repositories/snapshot-repository.ts
import { supabase } from '@/lib/supabase';

export async function upsertDailySnapshot(balance: number) {
  // 取得今天的日期字串 (YYYY-MM-DD) 都用UTC時間。
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('daily_snapshots')
    .upsert({ 
      date: today, 
      start_balance: balance 
    }, { 
      onConflict: 'date' // 如果今天已經有紀錄，就更新它 (防呆)
    })
    .select();

  if (error) throw error;
  return data;
}

/**
 * 嚴格讀取「今天 (UTC)」的帳戶快照基準線
 * @returns {Promise<number | null>} 今天的 start_balance (美分)，若無資料則回傳 null (代表排程失敗)
 */
export async function getStrictTodaySnapshot(): Promise<number | null> {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('daily_snapshots')
    .select('start_balance')
    .eq('date', today)
    .maybeSingle(); // 使用 maybeSingle，找不到就回傳 null，不會拋出奇怪的 PGRST 錯誤

  if (error) {
    console.error("[快照讀取錯誤] 資料庫查詢失敗", error);
    return null;
  }

  if (!data) {
    // 🚨 這裡就是你說的：找不到就是 Cron 沒跑，這是一個嚴重的風控盲區！
    console.warn(`[風控警告] 資料庫中找不到日期為 ${today} 的快照！`);
    return null;
  }
  
  return Number(data.start_balance);
}