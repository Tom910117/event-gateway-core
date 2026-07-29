import { NextResponse } from 'next/server';
import { ftmoWebhookSchema } from '@/lib/schemas/webhookSchema';
import { insertStrategySignal, updateSignalStatus, getSignalRecord } from '@/lib/repositories/signalRepository';
import { checkUpcomingNewsBlock } from '@/lib/repositories/news-repository';
import { sendTelegramAlert } from '@/lib/clients/telegram';
import { executeCTraderOrder, cancelCTraderOrder, emergencyCloseCTrader } from '@/lib/services/ctrader-order-service';
import { formatDistancePrecision } from '@/lib/utils/precision';
import { enforceMinimumStopLoss } from '@/lib/utils/risk-guard';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // 1. Zod 盤查：外匯規格檢查
    const parseResult = ftmoWebhookSchema.safeParse(body);
    if (!parseResult.success) {
      console.warn("[cTrader Webhook 格式錯誤]", parseResult.error.issues);

      await sendTelegramAlert(
        "cTrader Webhook 格式檢驗失敗", 
        "TradingView 傳來的外匯 JSON 格式不符合 Zod 規範！", 
        { 錯誤細節: parseResult.error.issues, 原始傳入資料: body }
      );
      return NextResponse.json({ error: "無效的數據格式" }, { status: 400 });
    }

    const data = parseResult.data;

    // 2. 身分驗證
    if (data.secret !== process.env.WEBHOOK_SECRET) {
      console.error(`[cTrader Webhook 阻擋] 密碼錯誤！`);
      await sendTelegramAlert(
        "cTrader Webhook 安全攔截", 
        "收到無效的 Secret Token，已阻擋該次外匯請求！", 
        { 嘗試的Token: data.secret, 訊號標的: data.symbol }
      );
      return NextResponse.json({ error: "未授權的訪問" }, { status: 401 });
    }

    // =====================================================================
    // 3. 業務邏輯總機
    // =====================================================================
    if (data.action === 'ENTRY') {
      
      // A. 查詢 news_calendar 資料表，當進場訊號在新聞期間內直接拒絕開單 [cite: 34, 43, 44]
      const isNewsBlocked = await checkUpcomingNewsBlock();
      if (isNewsBlocked) {

        // 🌟 新增：給這筆被擋下的訂單立個墓碑
        // 這樣 CANCEL 來的時候才知道它是被新聞殺掉的，而不是系統出錯
        await insertStrategySignal(data, 'blocked_by_news');
        
        // 關鍵：回傳 200 OK 騙過 TV，同時 return 終止後續的 DB 寫入與下單邏輯 [cite: 34, 46]
        return NextResponse.json(
          { success: true, message: "已攔截：落在新聞管制區間內，放棄本次進場訊號。" }, 
          { status: 200 }
        );
      }

      // 精度清洗：在進入核心戰場前，先洗乾淨！
      const cleanData = {
        ...data,
        sl_distance: formatDistancePrecision(data.symbol, data.sl_distance),
        tp_distance: formatDistancePrecision(data.symbol, data.tp_distance),
      };

      // 2. 止損底線防禦：檢查洗乾淨的 SL 有沒有低於 20 點
      cleanData.sl_distance = enforceMinimumStopLoss(cleanData.symbol, cleanData.sl_distance);

      // B. 將進場訊號寫入 Supabase 資料庫 (完美沿用 23505 擋重複開單機制)
      await insertStrategySignal(cleanData, 'confirmed');
      
      // C. [核心戰場]：下週一要對接的 cTrader WebSocket 呼叫點
      await executeCTraderOrder(cleanData);

      console.log(`[cTrader Webhook 成功] 收到並儲存 ${data.symbol} ${data.direction} 進場訊號`);
      return NextResponse.json({ success: true, message: "cTrader 進場訊號已確認並儲存" }, { status: 200 });

    } 
    else if (data.action === 'CANCEL') {
      
      // 🌟 將資料庫檢查搬到路由層：先查明這筆訂單的生死狀態
      const signalRecord = await getSignalRecord(data.trade_id); // 假設你寫了這個去查 supabase 的函式
      
      if (!signalRecord) {
        // 💡 情況 A：資料庫完全沒有這筆 trade_id。這才是真正的異常寫入失敗！
        console.warn(`[資料庫脫鉤] 找不到 ${data.trade_id} 的紀錄！`);
        throw new Error(`[資料庫脫鉤] Supabase 找不到 ${data.trade_id} 的紀錄，可能是 ENTRY 寫入崩潰！`); 
      }

      if (signalRecord.status === 'blocked_by_news') {
        // 💡 情況 B：找到紀錄，且明確知道它被新聞攔截了
        console.log(`[撤單略過] 訂單 ${data.trade_id} 已在進場時被新聞防護盾攔截，無須向 cTrader 撤單。`);
        // 完美靜音！不連線、不報錯，直接回傳 200 結束回合！
        return NextResponse.json({ success: true, message: "此單已被新聞攔截，略過撤單" }, { status: 200 });
      }

      const orderIdToCancel = signalRecord.ctrader_order_id;
      if (!orderIdToCancel) {
         throw new Error(`[資料庫異常] 訂單 ${data.trade_id} 存在，但缺少 cTrader 官方訂單號！`);
      }

      // [撤單動作]
      // TODO: 呼叫 cTrader API，傳送 ProtoOACancelOrderReq 撤銷掛單
      await cancelCTraderOrder(orderIdToCancel, data.trade_id);
      
      // B. 去資料庫把這筆訂單的 status 改成 'cancelled'
      await updateSignalStatus(data.trade_id, 'cancelled');
      
      console.log(`[cTrader Webhook 成功] 收到撤單訊號: ${data.trade_id}`);
      return NextResponse.json({ success: true, message: "cTrader 撤單訊號已確認" }, { status: 200 });

    }
    else if (data.action === 'EXIT'){

      //[強制平倉動作]
      await emergencyCloseCTrader(data.symbol);

      console.log(`[cTrader Webhook 成功] 收到並執行緊急平倉訊號`);
      return NextResponse.json({ success: true, message: "cTrader 緊急平倉與 DB 清洗已執行" }, { status: 200 });
    } 
    else {
      return NextResponse.json({ error: "未知的動作類型" }, { status: 400 });
    }

  } catch (error: any) {
    // 完美接住 Supabase 併發防禦
    if (error?.code === '23505') {
      console.log(`[cTrader 攔截成功] 捕捉到重複的外匯進場訊號 (trade_id 已存在)，安全忽略。`);
      return NextResponse.json(
        { success: true, message: "重複訊號，已安全忽略不執行 cTrader 開單" }, 
        { status: 200 }
      );
    }

    const errorTitle = error.message || "cTrader Webhook 發生未知系統錯誤";
    const errorDetails = error.payload || error; 

    console.error(`[cTrader 系統錯誤] 處理失敗:`, errorTitle);
    
    await sendTelegramAlert(
      "cTrader Webhook 總路由崩潰", 
      errorTitle, 
      errorDetails
    );

    return NextResponse.json({ success: false, error: "伺服器內部錯誤" }, { status: 500 });
  }
}