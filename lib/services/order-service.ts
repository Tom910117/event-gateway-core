// lib/services/order-service.ts
import { WebhookPayload } from '@/lib/schemas/webhookSchema';
import { binanceFetch } from '@/lib/exchanges/binance-client';

// 🛡️ 智能自動重試攔截器 (會判斷錯誤類型，幫你省 Fixie 額度)
async function fetchWithRetry(endpoint: string, method: any, data: any, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await binanceFetch(endpoint, method, data);
    } catch (error: any) {
      const errorMessage = error?.msg || error?.message || JSON.stringify(error);
      
      // 🛑 【省錢防護機制】如果錯誤代碼是 -2011 (未知訂單) 或 -2022 (減倉被拒) 等業務邏輯錯誤
      // 代表這不是網路問題，是訂單狀態不允許。重試也沒用，直接放棄並拋出錯誤！
      if (errorMessage.includes('-2011') || errorMessage.includes('-2022')) {
        console.warn(`[智能攔截] 檢測到不可挽回的業務錯誤 (${errorMessage})，放棄重試以節省 API 額度。`);
        const superError = new Error(`[fetchWithRetry] API 業務邏輯阻擋 (${endpoint})`);
        (superError as any).payload = {
          發生環節: "自動重試機制 - 遇到不可挽回錯誤",
          請求端點: endpoint,
          請求參數: data,
          詳細死因: errorMessage,
          原始錯誤包: error
        };
        throw superError; 
      }

      console.warn(`[API 警告] 請求失敗，準備第 ${i + 1} 次重試... 原因: ${errorMessage}`);
      
      // 最後一次還是失敗，拋出炸彈
      if (i === maxRetries - 1) {
        const superError = new Error(`[fetchWithRetry] API 請求重試達上限 (${maxRetries}次)`);
        (superError as any).payload = {
          發生環節: "自動重試機制 - 耗盡次數",
          請求端點: endpoint,
          請求參數: data,
          詳細死因: errorMessage,
          原始錯誤包: error
        };
        throw superError; 
      }

      // 指數退避等待：500ms, 1000ms...
      await new Promise(resolve => setTimeout(resolve, 500 * (i + 1))); 
    }
  }
}

// 1. 🧹 終極大掃除：同時清除普通單與條件單
export async function cancelAllOpenBinanceOrders(symbol: string) {
  try {
    console.log(`[大掃除] 準備清空 ${symbol} 的所有掛單與條件單...`);
    // 清除普通掛單 (LIMIT 等)
    await binanceFetch('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
    // 清除條件單 (STOP, TAKE_PROFIT, STOP_MARKET 等)
    await binanceFetch('/fapi/v1/algoOpenOrders', 'DELETE', { symbol });
    console.log(`[大掃除完畢] ${symbol} 戰場已徹底清理乾淨！`);
  } catch (error: any) {    
    const errorMessage = error?.msg || error?.message || JSON.stringify(error);
    console.error(`[大掃除失敗] 無法清除 ${symbol} 的掛單:`, errorMessage);

    const superError = new Error(`[cancelAllOpenBinanceOrders] 大掃除執行失敗 (${symbol})`);
    (superError as any).payload = {
      發生環節: "取消所有掛單與條件單",
      交易標的: symbol,
      詳細死因: errorMessage,
      底層原始報錯: error
    };
    
    throw superError;
  }
}

export async function executeBinanceOrder(data: WebhookPayload) {
  if (!data.price || !data.sl || !data.tp || !data.riskPercent) {
    const superError = new Error(`[executeBinanceOrder] 拒絕發射：下單參數不足`);
    (superError as any).payload = { 發生環節: "入參檢查", 傳入訊號: data, 詳細死因: "缺少 price, sl, tp 或 riskPercent" };
    throw superError;
  }

  const symbol = data.symbol;
  const side = (data.direction === 'LONG' || data.direction === 'buy') ? 'BUY' : 'SELL';
  const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';

  try {
    // === 第零階段：持倉熔斷機制 (Position Circuit Breaker) ===
    console.log(`[防線檢測] 正在檢查 ${symbol} 是否已有持倉...`);
    const positionData = await binanceFetch('/fapi/v2/positionRisk', 'GET', { symbol });
    // API 通常回傳陣列，找到對應幣種的倉位
    const position = positionData.find((p: any) => p.symbol === symbol); 
    
    if (position && parseFloat(position.positionAmt) !== 0) {
      const alertMsg = `[熔斷觸發] 🚨 ${symbol} 目前已有持倉 (${position.positionAmt})！拒絕執行新進場單，請人工介入檢查。`;
      console.error(alertMsg);
      const superError = new Error(`[executeBinanceOrder] 熔斷機制觸發 (${symbol})`);
      (superError as any).payload = { 發生環節: "進場前防線檢測", 傳入訊號: data, 實際持倉數量: position.positionAmt, 處置: alertMsg };
      throw superError;
    }

    console.log(`[防線通過] ${symbol} 目前為空手，允許進場。`);

    // === 執行大掃除：因為已經確認空手，安全清空所有舊掛單 ===
    await cancelAllOpenBinanceOrders(symbol);

    // === 第一階段：算倉 ===
    const accountData = await binanceFetch('/fapi/v2/account', 'GET');
    const usdtAsset = accountData.assets.find((a: any) => a.asset === 'USDT');
    const availableBalance = parseFloat(usdtAsset?.availableBalance || '0');

    if (availableBalance <= 0) {
      const superError = new Error(`[executeBinanceOrder] 算倉失敗：帳戶餘額不足 (${symbol})`);
      (superError as any).payload = { 發生環節: "讀取 USDT 餘額", 可用餘額: availableBalance, 傳入訊號: data };
      throw superError;
    }

    const riskAmount = availableBalance * (data.riskPercent / 100);
    const slDistance = Math.abs(data.price - data.sl);
    if (slDistance === 0) {
      const superError = new Error(`[executeBinanceOrder] 算倉失敗：止損距離為零 (${symbol})`);
      (superError as any).payload = { 發生環節: "計算進場數量", 傳入訊號: data, 停損距離: slDistance };
      throw superError;
    }

    const rawQty = riskAmount / slDistance;
    const qty = Math.floor(rawQty * 1000) / 1000; 
    const priceStr = data.price.toFixed(1);
    const slStr = data.sl.toFixed(1);
    const tpStr = data.tp.toFixed(1);

    console.log(`[算倉完畢] 餘額: ${availableBalance}U | 風險金: ${riskAmount}U | 下單量: ${qty} BTC`);

    // === 第二階段：依序發送訂單 (重試與回滾升級版) ===
    console.log(`[系統發射] 準備送出 ${symbol} 獨立訂單群...`);
    
    // ⚔️ 1. 先送進場單 (使用原本的 binanceFetch 即可，因為這步失敗就直接中斷了)
    const entryResult = await binanceFetch('/fapi/v1/order', 'POST', {
      symbol: symbol,
      side: side,
      type: 'LIMIT',
      timeInForce: 'GTX',
      quantity: qty.toString(),
      price: priceStr,
      newClientOrderId: data.trade_id
    });
    console.log("[進場單成功]", entryResult.orderId);

    // 🛡️ 2. 並發掛出止損與止盈 (使用 fetchWithRetry)
    try {
      await Promise.all([
        // 🔴 止損單 (保命盾牌) - 加入自動重試
        fetchWithRetry('/fapi/v1/algoOrder', 'POST', {
          symbol: symbol,
          side: oppositeSide,
          type: 'STOP_MARKET',
          algoType: 'CONDITIONAL',
          triggerPrice: slStr,
          quantity: qty.toString(),
          reduceOnly: 'true',
          clientAlgoId: `${data.trade_id}_SL`
        }),
        
        // 🟢 止盈單 (天才戰術) - 加入自動重試
        fetchWithRetry('/fapi/v1/algoOrder', 'POST', {
          symbol: symbol,
          side: oppositeSide,
          type: 'STOP', 
          algoType: 'CONDITIONAL',
          triggerPrice: priceStr, 
          price: tpStr,           
          quantity: qty.toString(),
          reduceOnly: 'true',
          clientAlgoId: `${data.trade_id}_TP` 
        })
      ]);
      console.log("[止盈止損建立成功] 止損與止盈單已雙雙上線！");

    } catch (shieldError: any) {
      // 🚨 終極警報：護城河失敗，進行情報收集與緊急回滾
      const shieldErrorMsg = shieldError?.msg || shieldError?.message || JSON.stringify(shieldError);
      console.error(`[致命異常] 止盈止損建立失敗！啟動緊急撤單！原因:`, shieldErrorMsg);
      
      let rollbackStatus = "未執行";
      let rollbackErrorDetails = "無";

      try {
        await binanceFetch('/fapi/v1/order', 'DELETE', { symbol: symbol, origClientOrderId: data.trade_id });
        rollbackStatus = "成功";
        console.log(`[緊急撤單成功] 已安全撤銷孤立的進場單 ${data.trade_id}`);
      } catch (rollbackError: any) {
        rollbackStatus = "失敗";
        rollbackErrorDetails = rollbackError?.msg || rollbackError?.message || JSON.stringify(rollbackError);
        console.error(`[撤單失敗] 無法撤銷進場單，請手動處理！`, rollbackErrorDetails);
      }

      const superError = new Error(`[executeBinanceOrder] 止盈止損掛單失敗，已啟動緊急回滾 (${rollbackStatus})`);
      (superError as any).payload = {
        發生環節: "掛載止損/止盈單 (包含撤單結果)",
        撤單狀態: rollbackStatus,
        撤單失敗死因: rollbackErrorDetails,
        止盈止損失敗原因: shieldErrorMsg,
        止盈止損錯誤: shieldError,
        處置建議: rollbackStatus === "失敗" ? "緊急！請立即開啟幣安 APP 手動撤銷進場單！" : "進場單已安全撤銷，系統已阻斷交易。"
      };
      throw superError;
    }

    return entryResult;

  } catch (error: any) {
    // 💡 神級技巧：穿透檢測
    // 如果 catch 抓到的 error 已經帶有 payload (代表是從內部如大掃除或熔斷機制丟出來的超級炸彈)
    // 我們就直接把它丟出去，不要再包裝一次！
    if (error.payload) {
      throw error;
    }

    // 如果是沒見過的野生錯誤 (例如網路斷線、未捕捉的異常)，我們在此統一包裝
    const errorMessage = error?.msg || error?.message || JSON.stringify(error);
    console.error("[自動下單總崩潰]", errorMessage);
    
    const superError = new Error(`[executeBinanceOrder] 訂單執行總崩潰 (${symbol})`);
    (superError as any).payload = {
      發生環節: "自動下單主流程",
      傳入訊號: data,
      詳細死因: errorMessage,
      原始錯誤包: error
    };
    throw superError;
  }
}

// 3. ⏳ expireBinanceOrder：過期撤單與防線熔斷
export async function expireBinanceOrder(tradeId: string, symbol: string) {
  try {
    console.log(`[過期撤單] 收到 TV 過期指令，準備檢查 ${symbol} 持倉狀態...`);

    // 1. 檢查是否有持倉
    const positionData = await binanceFetch('/fapi/v2/positionRisk', 'GET', { symbol });
    const position = positionData.find((p: any) => p.symbol === symbol); 

    if (position && parseFloat(position.positionAmt) !== 0) {
      // 🚨 致命脫鉤：TV 發送過期，但幣安卻有持倉！
      const alertMsg = `[嚴重異常] 🚨 TV 發送了過期撤單，但 ${symbol} 目前竟有持倉 (${position.positionAmt})！系統脫鉤，拒絕撤單，請立即人工介入！`;
      console.error(alertMsg);
      
      const superError = new Error(`[expireBinanceOrder] 嚴重異常：系統脫鉤 (${symbol})`);
      (superError as any).payload = {
        發生環節: "過期撤單前的持倉檢查",
        TV傳入的TradeID: tradeId,
        實際持倉數量: position.positionAmt,
        處置建議: "非常危險！請立即登入幣安 APP 人工確認持倉狀態與未平倉訂單！"
      };
      throw superError;
    }

    // 2. 確認無持倉，執行全數清空 
    // (依你所說「沒持倉就全部都清空」，直接呼叫大掃除最乾淨俐落)
    console.log(`[過期撤單執行] 確認無持倉，開始清空 ${symbol} 所有未成交訂單...`);
    await cancelAllOpenBinanceOrders(symbol);
    
    console.log(`[幣安過期撤單成功] 關聯訂單群已清空`);
    return { status: 'CANCELLED' };

  } catch (error: any) {
    // 💡 穿透檢測
    if (error.payload) throw error;

    const errorMessage = error?.msg || error?.message || JSON.stringify(error);
    console.error(`[撤單系統總崩潰] ${tradeId}:`, errorMessage);
    
    const superError = new Error(`[expireBinanceOrder] 撤單系統總崩潰 (${symbol})`);
    (superError as any).payload = {
      發生環節: "過期撤單總流程",
      TV傳入的TradeID: tradeId,
      詳細死因: errorMessage,
      原始錯誤包: error
    };
    throw superError; 
  }
}