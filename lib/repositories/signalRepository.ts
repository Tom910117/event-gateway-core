import { supabase } from '@/lib/supabase';
import type { WebhookPayload } from '@/lib/schemas/webhookSchema';

export async function insertStrategySignal(data: WebhookPayload, customStatus?: string) {
  try {
    const { error } = await supabase
      .from('strategy_signals')
      .insert([{
        trade_id: data.trade_id, // 🛡️ 這次記得塞進去了
        symbol: data.symbol,
        direction: data.direction,
        entry_price: data.price,
        strategy_tag: data.tag,
        risk_percent: data.riskPercent,
        tp: data.tp,
        sl: data.sl,
        signal_sl_distance: data.sl_distance,
        signal_tp_distance: data.tp_distance,
        zone_top: data.zone_top,
        zone_bottom: data.zone_bottom,
        timestamp: data.tv_time ? new Date(data.tv_time).toISOString() : new Date().toISOString(),
        status: customStatus || 'confirmed',
        ote: data.ote
      }]);

    if (error) {
      throw error;
    }
    return true;

} catch(error: any) {
  
  if (error?.code === '23505') {
    throw error;
}
  const errorMessage = error?.message || error?.details || JSON.stringify(error);
    console.error("[資料庫寫入總崩潰]", errorMessage);

    const superError = new Error(`[insertStrategySignal] 資料庫寫入失敗 (${data.trade_id})`);
    
    // 貼上情報標籤，讓外層的大 catch 和 Telegram 能完美解析
    (superError as any).payload = {
      發生環節: "Supabase 寫入進場訊號",
      傳入訊號: data,
      詳細死因: errorMessage,
      原始錯誤包: error
    };
    
    throw superError;
  }
}

// 2. 新增取消函數 (你幫它取的名字很直覺！)
export async function updateSignalStatus(tradeId: string, newStatus: string) {
  try {  
    const {data, error } = await supabase
      .from('strategy_signals')
      .update({ status: newStatus }) // 標註為已取消
      .eq('trade_id', tradeId) // 根據 TV 傳來的唯一 ID 鎖定目標
      .select(); // 加上 select() 才能讓 Supabase 回傳更新後的結果給我們檢查
      
    if (error) {
      console.error(`[DB 錯誤] 無法更新訊號狀態 ${tradeId}:`, error);
      throw error;
    }
  // 🛡️ 防呆 2：沒報錯，但回傳的陣列是空的，代表資料庫裡根本沒有這個 trade_id！
    if (!data || data.length === 0) {
      const notFoundError = new Error(`資料庫中找不到對應的 trade_id，無法撤單`);
      (notFoundError as any).details = "Update 影響的行數為 0";
      throw notFoundError;
    }

    console.log(`[資料庫更新成功] 訂單 ${tradeId} 狀態已確實變更為 ${newStatus}。`);
    return true;

  } catch (error: any) {
    const errorMessage = error?.message || error?.details || JSON.stringify(error);
    console.error(`[資料庫更新失敗] 撤單狀態寫入崩潰:`, errorMessage);

    // 🌟 組裝超級炸彈
    const superError = new Error(`[updateSignalStatus] 撤單狀態更新失敗 (${tradeId} -> ${newStatus})`);
    
    // 📦 貼上案發現場 Payload 標籤，完美對接 route.ts 的大 catch 與 Telegram 通訊兵！
    (superError as any).payload = {
      發生環節: `Supabase 修改訂單狀態為 ${newStatus}`,
      目標TradeID: tradeId,
      詳細死因: errorMessage,
      原始錯誤包: error
    };

    throw superError;
  }
}

// 3. 新增：取得完整訂單狀態的函式，回傳的是一個 Object
export async function getSignalRecord(tradeId: string) {
  try {
    const { data, error } = await supabase
      .from('strategy_signals')
      .select('status, ctrader_order_id') // 抓出需要的這兩個欄位
      .eq('trade_id', tradeId)
      .single(); // single 確保回傳單一物件，而不是陣列

    if (error) {
      if (error.code === 'PGRST116') return null; // 找不到資料的標準代碼
      throw error;
    }

    return data; // 回傳的會是 { status: '...', ctrader_order_id: '...' }
  } catch (err) {
    console.error(`[DB Error] getSignalRecord 失敗:`, err);
    throw err;
  }
}

// 4. 新增/升級：cTrader 實際戰果回填函式 (第二階段 UPDATE)
export async function updateSignalExecutionData(
  tradeId: string, 
  executionData: {
    ctraderOrderId: string;
    ctraderPositionId: string;
    entryPrice: number;
    sl: number;
    tp: number;
  }
) {
  const { error } = await supabase
    .from('strategy_signals')
    .update({ 
      ctrader_order_id: executionData.ctraderOrderId,
      ctrader_position_id: executionData.ctraderPositionId,
      entry_price: executionData.entryPrice,
      sl: executionData.sl,
      tp: executionData.tp,
      status: 'executed' // 順便把狀態從 CONFIRMED 轉成 EXECUTED，資料庫超乾淨！
    })
    .eq('trade_id', tradeId);

  if (error) {
    throw new Error(`Supabase 戰果回填失敗: ${error.message}`);
  }
}
