import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
// 🌟 引入你的通訊兵
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
  // 核心業務邏輯：啟動新聞時間過濾並核爆
  // ==========================================
  try {
    // 1. 初始化 Supabase 客戶端
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2. 索敵：抓取所有尚未觸發的新聞
    const { data: newsList, error: fetchError } = await supabase
      .from('news_calendar')
      .select('*')
      .eq('is_triggered', false);

    if (fetchError) throw fetchError;
    if (!newsList || newsList.length === 0) {
      return new Response(JSON.stringify({ message: "雷達清晰，無待處理新聞" }), { status: 200 });
    }

    const now = new Date().getTime();
    const targetNews = [];

    // 3. 雙向護城河篩選：3 <= 差異時間 <= 12 分鐘
    for (const news of newsList) {
      const eventTime = new Date(news.event_time).getTime();
      const diffMinutes = (eventTime - now) / (1000 * 60);

      if (diffMinutes >= 3 && diffMinutes <= 12) {
        targetNews.push(news);
      }
    }

    if (targetNews.length === 0) {
       return new Response(JSON.stringify({ message: "目前無落在交戰區間 (3~12分) 的目標" }), { status: 200 });
    }

    // 4. 準備發射
    const webhookUrl = Deno.env.get('VERCEL_WEBHOOK_URL') ?? '';
    const webhookSecret = Deno.env.get('WEBHOOK_SECRET') ?? ''; 
    const edgeSniperSecret = Deno.env.get('EDGE_SNIPER_SECRET') ?? ''; // 🌟 讀取邊緣通行證

    for (const news of targetNews) {
      console.log(`[準備鎖定] 發現目標新聞 ID: ${news.id}, 距離發生還有 ${(new Date(news.event_time).getTime() - now) / 60000} 分鐘`);

      // A. 上膛鎖定：先改為 true
      const { error: lockError } = await supabase
        .from('news_calendar')
        .update({ is_triggered: true })
        .eq('id', news.id);

      if (lockError) {
         console.error(`[鎖定失敗] 無法更新新聞狀態: ${news.id}`, lockError);
         // 🚨 發送非致命錯誤警報
         await reportNonFatalError("Sniper 鎖定新聞失敗", `無法將新聞 ${news.id} 標記為已觸發，已跳過該次發射`, { error: lockError });
         continue; 
      }

      // B. 發射核彈
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
            trade_id: 'NEWS_EMERGENCY_NUKE'
          }),
        });

        if (!response.ok) {
          throw new Error(`Vercel 拒絕或無回應，HTTP 狀態碼: ${response.status}`);
        }
        
        console.log(`[發射成功] 成功呼叫 Vercel 核爆路由。新聞 ID: ${news.id}`);
        // 成功發射也可以報喜 (視你需求，怕吵可以拿掉)
        //await sendTelegramAlert(`🎯 [Sniper] 成功發射新聞核彈！(新聞 ID: ${news.id})`);

      } catch (fetchError: any) {
         // C. B 計畫 (死纏爛打)：發射失敗，退回 is_triggered = false
         console.error(`[發射失敗] 觸發 B 計畫，退回狀態。新聞 ID: ${news.id}`, fetchError);
         
         await supabase
           .from('news_calendar')
           .update({ is_triggered: false })
           .eq('id', news.id);

         // 🚨 發送非致命錯誤警報，通知你 Vercel 沒接電話
         await reportNonFatalError("Sniper 核彈發射失敗 (啟動 B 計畫)", `無法打通 Vercel，已將新聞狀態退回，將於下次 Cron 重試。`, { news_id: news.id, error: fetchError.message || fetchError });
      }
    }

    return new Response(JSON.stringify({ message: "核彈排程巡邏與執行完畢", processedCount: targetNews.length }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error: any) {
    console.error("[Sniper 系統崩潰]:", error);
    // 🚨 系統級崩潰，直接呼叫最高級別警報
    await sendTelegramAlert(`❌ [Sniper 總系統崩潰]\nEdge Function 執行中發生未預期錯誤！\n細節: ${error.message || JSON.stringify(error)}`);
    
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});