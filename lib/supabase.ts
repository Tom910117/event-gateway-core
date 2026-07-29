// lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

// 抓取環境變數
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// 檢查是否有遺漏環境變數
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('遺失 Supabase 環境變數設定');
}

// 建立並匯出具備「上帝權限」的 Supabase Client
// ⚠️ 注意：這個 supabase 實例只能在後端 (如 app/api/.../route.ts) 使用
export const supabase = createClient(supabaseUrl, supabaseServiceKey);