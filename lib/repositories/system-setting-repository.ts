// lib/repositories/system-setting-repository.ts
import { supabase } from '@/lib/supabase';

/**
 * 取得目前的 cTrader 憑證
 */
export async function getCTraderTokens() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('access_token, refresh_token')
    .eq('id', 'ctrader_tokens')
    .single();

  if (error || !data) {
    throw new Error(`無法取得 cTrader Tokens: ${error?.message}`);
  }
  return data;
}

/**
 * 覆寫更新 cTrader 憑證
 */
export async function updateCTraderTokens(newAccessToken: string, newRefreshToken: string) {
  const { error } = await supabase
    .from('system_settings')
    .update({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      updated_at: new Date().toISOString()
    })
    .eq('id', 'ctrader_tokens');

  if (error) {
    throw new Error(`Token 寫入資料庫失敗: ${error.message}`);
  }
  return true;
}