import { NextResponse } from 'next/server';
import { webhookSchema } from '@/lib/schemas/webhookSchema';
import { insertStrategySignal, updateSignalStatus } from '@/lib/repositories/signalRepository';
import { executeBinanceOrder, expireBinanceOrder } from '@/lib/services/order-service';
import { sendTelegramAlert } from '@/lib/clients/telegram';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // 1. Zod 盤查：確保格式完全正確，過濾掉不合法的請求
    const parseResult = webhookSchema.safeParse(body);
    if (!parseResult.success) {
      console.warn("[Webhook 格式錯誤]", parseResult.error.issues);
      const safeBody = { ...body, secret: '***已隱藏***' };
      // 🚨 新增：TV 參數設定錯誤警報
      await sendTelegramAlert(
        "Webhook 格式檢驗失敗", 
        "TradingView 傳來的 JSON 格式不符合 Zod 規範，請檢查 TV 警報設定！", 
        { 錯誤細節: parseResult.error.issues, 原始傳入資料: safeBody }
      );

      return NextResponse.json({ error: "無效的數據格式" }, { status: 400 });
    }

    const data = parseResult.data;

    // 2. 身分驗證：比對 Webhook Secret，防範惡意攻擊
    if (data.secret !== process.env.WEBHOOK_SECRET) {
      console.error(`[Webhook 阻擋] 密碼錯誤，拒絕存取！`);

      // 🚨 新增：防駭客入侵警報
      await sendTelegramAlert(
        "Webhook 安全攔截", 
        "收到無效的 Secret Token，已阻擋該次請求！", 
        { 嘗試的Token: data.secret, 訊號標的: data.symbol }
      );

      return NextResponse.json({ error: "未授權的訪問" }, { status: 401 });
    }

    // =====================================================================
    // 3. 業務邏輯總機：根據 action 進行分流 (Dispatch)
    // =====================================================================
    if (data.action === 'ENTRY') {
      

      // A. 將進場訊號寫入 Supabase 資料庫 (預設 status 會是 'confirmed')
      await insertStrategySignal(data);
      
      // [進場動作]
      // B. TODO: 呼叫幣安 API，三單齊發 (Maker進場 + 市價止損 + Maker止盈)
      await executeBinanceOrder(data);


      console.log(`[Webhook 成功] 收到並儲存 ${data.symbol} ${data.direction} 進場訊號`);
      return NextResponse.json({ success: true, message: "進場訊號已確認並儲存" }, { status: 200 });

    } 
    else if (data.action === 'CANCEL') {
      
      // [撤單動作]
      // A. TODO: 呼叫幣安 API，根據 trade_id 撤銷掛單
      await expireBinanceOrder(data.trade_id, data.symbol);

      // B. 去資料庫把這筆訂單的 status 改成 'cancelled'
      await updateSignalStatus(data.trade_id, 'cancelled');
      

      console.log(`[Webhook 成功] 收到撤單訊號，狀態已更新為 cancelled: ${data.trade_id}`);
      return NextResponse.json({ success: true, message: "撤單訊號已確認並更新" }, { status: 200 });

    } 
    else if (data.action === 'EXIT') {
      
      // [出場動作] 
      // (保留擴充用：例如打到 TV 的止盈止損時，傳訊號來更新資料庫狀態為 'filled')
      console.log(`[Webhook 成功] 收到出場訊號: ${data.trade_id}`);
      return NextResponse.json({ success: true, message: "出場訊號已確認" }, { status: 200 });

    } 
    else {
      
      // [防呆機制] 雖然 Zod 已經擋過了，但維持後端嚴謹性
      return NextResponse.json({ error: "未知的動作類型" }, { status: 400 });
      
    }

  } catch (error: any) {
    // 關鍵攔截點：判斷是否為 Supabase 的 Unique Constraint 違反錯誤
    // PostgreSQL 的 unique_violation 錯誤代碼通常是 '23505'
    if (error?.code === '23505') {
      console.log(`[攔截成功] 捕捉到重複的進場訊號 (trade_id 已存在)，安全忽略。`);
      
      // ⚠️ 非常重要：雖然我們視為錯誤，但必須回傳 HTTP 200 給 TradingView
      // 如果回傳 400 或 500，TradingView 可能會判定發送失敗（有時會亮紅燈）
      return NextResponse.json(
        { success: true, message: "重複訊號，已安全忽略不執行開單" }, 
        { status: 200 }
      );
    }

    // 🚨 攔截點 2：終極停機坪，對接我們精心設計的 Super Error！
    const errorTitle = error.message || "Webhook 發生未知系統錯誤";
    
    // 💡 這裡完美接住 order-service 丟出來的 superError.payload
    const errorDetails = error.payload || error; 

    console.error(`[系統錯誤] Webhook 處理失敗:`, errorTitle);
    
    // 呼叫通訊兵，把情報送達你的手機
    await sendTelegramAlert(
      "Webhook 總路由崩潰", 
      errorTitle, 
      errorDetails
    );

    // 回傳 500，但絕不把 payload 曝露給外部，保持資安嚴謹
    return NextResponse.json(
      { success: false, error: "伺服器內部錯誤" }, 
      { status: 500 }
    );
  }
}