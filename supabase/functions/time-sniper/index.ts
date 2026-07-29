import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// 🌟 引入你的通訊兵 (路徑與 news-sniper 一樣，直接往上一層找 _shared)
import { sendTelegramAlert, reportNonFatalError } from "../_shared/telegram.ts";
import { validateEmptyBody } from "../_shared/security.ts";

serve(async (req) => {

  // ==========================================
  // 第一道門：驗證 Method 與專屬通行證 (Fail-Fast)
  // ==========================================
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  
  const expectedEdgeSecret = Deno.env.get('EDGE_CRON_SECRET');
  const incomingSecret = req.headers.get('x-cron-secret');

  if (incomingSecret !== expectedEdgeSecret) {
    console.warn(`[資安攔截] 偵測到不明來源嘗試觸發 Edge Function！`);
    return new Response(JSON.stringify({ error: "Unauthorized access" }), { status: 401 });
  }

  // ==========================================
  // 第二道門：Zod 嚴格安檢 (確保 Body 是空的)
  // ==========================================
  const bodyError = await validateEmptyBody(req);
  if (bodyError) {
    return new Response(JSON.stringify({ error: bodyError }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // ==========================================
  // 核心業務邏輯：啟動時間核爆程序
  // ==========================================
  try {
    console.log("[Time Sniper] ⏰ 啟動時間核爆程序 (週末/尾盤清道夫)...");

    // 1. 準備發射參數
    const webhookUrl = Deno.env.get('VERCEL_WEBHOOK_URL') ?? '';
    const webhookSecret = Deno.env.get('WEBHOOK_SECRET') ?? ''; 
    const edgeSniperSecret = Deno.env.get('EDGE_SNIPER_SECRET') ?? '';

    if (!webhookUrl || !webhookSecret || !edgeSniperSecret) {
      throw new Error("Edge Function 遺失關鍵環境變數 (URL 或 Secrets)！");
    }

    // 2. 發射核彈
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-edge-sniper-secret': edgeSniperSecret // ✨ 放在 Header 給 IP 守門員看！
        },
        body: JSON.stringify({
          secret: webhookSecret, // ✨ 放在 Body 給 Zod 驗證！
          action: 'EXIT',
          symbol: 'ALL',
          trade_id: 'TIME_EMERGENCY_NUKE' // 給它一個專屬的 ID 方便你看 Log
        }),
      });

      if (!response.ok) {
        throw new Error(`Vercel 拒絕或無回應，HTTP 狀態碼: ${response.status}`);
      }
      
      console.log(`[發射成功] 🎯 成功呼叫 Vercel 核爆路由，強制平倉指令已送出！`);
      
      // 成功發射報喜 (週末/尾盤清倉成功，建議留著讓自己安心睡覺)
      //await sendTelegramAlert(`🎯 [Time Sniper] 週末/尾盤強制平倉核彈發射成功！`);

    } catch (fetchError: any) {
       console.error(`[發射失敗] 無法打通 Vercel`, fetchError);
       
       // 🚨 發送非致命錯誤警報，通知你 Vercel 沒接電話
       await reportNonFatalError(
         "Time Sniper 核彈發射失敗", 
         "無法打通 Vercel，請盡速手動打開 cTrader 檢查倉位！", 
         { error: fetchError.message || fetchError }
       );
       
       return new Response(JSON.stringify({ error: "發射失敗" }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ message: "Time Sniper 執行完畢" }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error: any) {
    console.error("[Time Sniper 系統崩潰]:", error);
    // 🚨 系統級崩潰，直接呼叫最高級別警報
    await sendTelegramAlert(`❌ [Time Sniper 總系統崩潰]\nEdge Function 執行中發生未預期錯誤！\n細節: ${error.message || JSON.stringify(error)}`);
    
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});