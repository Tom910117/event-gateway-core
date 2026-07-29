export async function sendTelegramAlert(stage: string, message: string, payload?: any) {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID') ?? '';

  // 1. 防禦性檢查：確保環境變數有正常載入
  if (!token || !chatId) {
    console.error("🚨 [Telegram Monitor] 失敗：缺少環境變數 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID");
    return;
  }

  // 2. 組裝 HTML 格式的訊息內容
  let text = `🚨 <b>SMC Quant Lab 警報</b> 🚨\n\n`;
  text += `📍 <b>錯誤節點：</b> <code>${stage}</code>\n`;
  text += `📝 <b>錯誤訊息：</b> ${message}\n`;

  // 3. 處理附加的 Payload 資料
  if (payload) {
    try {
      const payloadStr = JSON.stringify(payload, null, 2);
      
      // ⚠️ 安全防護：Telegram 限制單則訊息上限為 4096 個字元
      // 如果大數據或幣安丟回來的錯誤太長，在此處進行安全截斷
      if (payloadStr.length > 1000) {
        text += `📦 <b>Payload 詳情 (已截斷)：</b>\n<pre>${payloadStr.substring(0, 1000)}\n...內容過長已截斷</pre>`;
      } else {
        text += `📦 <b>Payload 詳情：</b>\n<pre>${payloadStr}</pre>`;
      }
    } catch (e) {
      text += `📦 <b>Payload 詳情：</b>\n<pre>資料無法序列化為 JSON</pre>`;
    }
  }

  // 4. 打向 Telegram 官方伺服器
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML', // 開啟 HTML 模式，讓 <b> 和 <pre> 標籤生效
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("🚨 [Telegram Monitor] 官方伺服器回報錯誤：", errorData);
    }
  } catch (error) {
    console.error("🚨 [Telegram Monitor] 網路連線失敗，無法發送通知：", error);
  }
}
/**
 * 發送非致命錯誤警告 (背景執行，不阻塞主程式)
 * 用於：資料庫寫入失敗、次要功能異常，但不影響核心交易時。
 */
export function reportNonFatalError(stage: string, message: string, payload?: any) {
  // 1. 本地端先留個底 (Vercel Log)，確保 Telegram 掛掉時還有紀錄
  console.warn(`⚠️ [背景警告 - ${stage}] ${message}`, payload || '');

  // 2. 呼叫原本的發送函式，但【故意不加 await】
  // 3. 在屁股後面接上 .catch()，就算 Telegram 發送失敗，也不會炸毀外層的主程式
  sendTelegramAlert(`⚠️ [非致命警告] ${stage}`, message, payload)
    .catch(e => console.error("🚨 [Telegram Monitor] 背景發送警告本身發生失敗：", e));
}