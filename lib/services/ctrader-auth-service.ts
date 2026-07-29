// lib/services/ctrader-auth-service.ts
import { getCTraderTokens, updateCTraderTokens } from '../repositories/system-setting-repository';

/**
 * 執行 cTrader Token 自動續命與資料庫覆寫
 */
export async function rotateCTraderTokens() {
  try {
    // 1. 從 DB 拿出目前的舊 Token
    const { refresh_token: currentRefreshToken } = await getCTraderTokens();

    const baseUrl = "https://openapi.ctrader.com/apps/token";
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
      client_id: process.env.CTRADER_CLIENT_ID!,
      client_secret: process.env.CTRADER_CLIENT_SECRET!
    });

    console.log("[Token 續命] 準備向 cTrader 發送換發請求...");
    
    // 2. 去 cTrader 換新護照
    const response = await fetch(`${baseUrl}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Token 更新被拒絕: ${errorData.description || response.statusText}`);
    }

    const data = await response.json();
    console.log("[Token 續命] 成功取得新世代 Token，準備覆寫資料庫...");

    // 3. 呼叫 Repo 寫入新護照
    await updateCTraderTokens(data.accessToken, data.refreshToken);

    console.log("[Token 續命] 🎉 護照更新完畢，獲得額外 30 天效期！");
    return { success: true, message: "Token rotated successfully" };

  } catch (error: any) {
    console.error("[Token 續命崩潰]", error);
    
    // 組裝超級錯誤包給外層
    const superError = new Error(`[rotateCTraderTokens] Token 續命失敗`);
    (superError as any).payload = { 發生環節: "自動換發 Token", 詳細死因: error.message };
    throw superError;
  }
}