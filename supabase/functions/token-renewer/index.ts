import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
// 🌟 引入你的 Telegram 模組 (請確認路徑正確)
import { sendTelegramAlert, reportNonFatalError } from "../_shared/telegram.ts";
import { validateEmptyBody } from "../_shared/security.ts";

// 設定你要讀取的 Vault 金鑰名稱 (請改成你實際設定的名稱)
const TARGET_SECRET_NAME = "CTRADER_SMC_47907245";

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
  // 核心業務邏輯：啟動 Token 換發與金庫更新程序
  // ==========================================

  try {
    console.log("[Token Renewer] 🔄 開始執行 cTrader Token 定期續命任務...");

    // ==========================================
    // 👑 啟動最高權限客戶端 (Service Role)
    // ==========================================
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ==========================================
    // 🔑 步驟 1：從 Vault 拿出目前的舊 Token 與 Client 金鑰
    // ==========================================
    const { data: vaultData, error: readError } = await supabase.rpc("get_vault_secrets", {
      prefix: TARGET_SECRET_NAME
    });

    if (readError || !vaultData || vaultData.length === 0) {
      throw new Error(`無法從金庫讀取 ${TARGET_SECRET_NAME}，大門深鎖或資料不存在！`);
    }

    // 解析 Vault 裡的 JSON 字串
    const accountData = JSON.parse(vaultData[0].decrypted_secret);
    
    // ⚠️ 確保你的 JSON 裡面有這四個欄位 (名稱要對應)
    const currentRefreshToken = accountData.refreshToken;
    const clientId = accountData.clientId;
    const clientSecret = accountData.clientSecret;

    if (!currentRefreshToken || !clientId || !clientSecret) {
      throw new Error("金庫資料不完整，缺少 refreshToken, clientId 或 clientSecret！");
    }

    // ==========================================
    // 📡 步驟 2：去 cTrader 換新護照 (完美移植你的邏輯)
    // ==========================================
    const baseUrl = "https://openapi.ctrader.com/apps/token";
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
      client_id: clientId,
      client_secret: clientSecret
    });

    console.log("[Token 續命] 準備向 cTrader 發送換發請求...");
    
    const response = await fetch(`${baseUrl}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      // 嘗試解析 cTrader 回傳的錯誤訊息
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Token 更新被拒絕: ${errorData.description || response.statusText}`);
    }

    const data = await response.json();
    console.log("[Token 續命] 成功取得新世代 Token，準備覆寫資料庫...");

    // ==========================================
    // 🔐 步驟 3：呼叫 Vault RPC 寫入新護照
    // ==========================================
    const updatedAccountData = {
      ...accountData, // 保留 clientId, clientSecret 等不變的設定
      accessToken: data.accessToken,
      refreshToken: data.refreshToken
    };

    const { error: writeError } = await supabase.rpc("update_vault_secret", {
      p_name: TARGET_SECRET_NAME,
      p_new_secret: JSON.stringify(updatedAccountData)
    });

    if (writeError) throw new Error(`寫回金庫失敗: ${writeError.message}`);

    console.log("[Token 續命] 🎉 護照更新完畢，獲得額外 30 天效期！");

    // ==========================================
    // 🌟 報喜通知
    // ==========================================
    //await sendTelegramAlert("✅ [系統通知] cTrader Token 續命成功\nAccess Token 與 Refresh Token 已成功換發，並安全寫入 Supabase 百寶箱！");

    return new Response(JSON.stringify({ success: true, message: "Token rotated successfully" }), { 
      status: 200, 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (error: any) {
    console.error("[Token 續命崩潰]", error);
    
    // ==========================================
    // 🚨 報喪通知 (完美移植你的超級錯誤包邏輯)
    // ==========================================
    await reportNonFatalError(
      "⚠️ Token 自動續命失敗", 
      "請立刻手動登入 cTrader 更新 Token，否則系統即將斷線！", 
      { 發生環節: "Edge Function 自動換發 Token", 詳細死因: error.message }
    );
    
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
});