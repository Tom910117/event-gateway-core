// lib/services/ctrader-order-service.ts
import { FtmoWebhookPayload } from '@/lib/schemas/webhookSchema';
import { CTraderClient } from '@/lib/exchanges/ctrader-client'; // 引入我們的機槍
import { reportNonFatalError } from '@/lib/clients/telegram';
import { updateSignalExecutionData, updateSignalStatus } from '@/lib/repositories/signalRepository'
import { calculateDynamicVolume } from '../utils/risk-calculator';
import { getStrictTodaySnapshot } from '../repositories/snapshot-repository';
import { calculateOteLimitPrice } from '../utils/ote-calculator';

const SymbolIdMapping: Record<string, number> = {
  "XAUUSD": 41,        
  "EURUSD": 1,         
  "NAS100": 275,     // 考試demo為335
  "NAS100USD": 275,     // 考試demo為335       
  "US100": 275,     // 考試demo為335       
  "US30": 283      //考試demo為327   
};

// ==========================================
// 🟢 執行進場邏輯
// ==========================================
export async function executeCTraderOrder(data: FtmoWebhookPayload) {
  if (data.action !== 'ENTRY') return;

  const symbol = data.symbol; 
  const symbolId = SymbolIdMapping[symbol];
  const isBuy = data.direction === 'LONG' || data.direction === 'buy';

  if (!symbolId) {
     throw new Error(`找不到 ${symbol} 對應的 cTrader Symbol ID，請檢查 Mapping 表`);
  }

  // 1. 拿起電話，準備撥號
  const client = new CTraderClient();

  try {
    // 2. 接通並雙重授權
    await client.connect();
    
    /*
    這裡先註解掉 之後要擴充成監控很多商品時 可以開確保每個掛單訊號進來時都沒有持倉也沒有掛單。外面的route.ts也要更改。
    // ==========================================
    // 🛡️ 新增：終極查崗 (單持倉與無掛單防禦)
    // ==========================================
    console.log(`[查崗請求] 檢查當前帳戶是否有持倉或掛單...`);
    const reconcileData: any = await client.sendRequest("ProtoOAReconcileReq", {
      ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!)
    });

    // cTrader 陣列如果是空的，可能會回傳 undefined，所以要加長度判斷
    const currentPositions = reconcileData.position || [];
    const currentOrders = reconcileData.order || [];

    if (currentPositions.length > 0 || currentOrders.length > 0) {
      console.log(`[系統阻斷] 偵測到已有持倉 (${currentPositions.length}) 或掛單 (${currentOrders.length})！`);
      console.log(`[系統阻斷] 為嚴格遵守單持倉模式，本次 ${symbol} 的進場訊號已捨棄，直接回傳 HTTP 200。`);
      
      // 直接 return，系統會自然跳到 finally 去執行 client.close() 掛斷連線
      return { status: "ignored", reason: "單持倉模式拒絕掛單" }; 
    }*/

    // 3. 查帳 (使用同一通電話)
    console.log(`[系統發射] 準備查詢餘額並計算動態風控...`);
    const balanceData = await client.sendRequest("ProtoOATraderReq", {
      ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!)
    });
    const rawBalanceInCents = balanceData.trader.balance;
    const liveEquityInCents = rawBalanceInCents;
    
    // ==========================================
    // FTMO 5% 當日熔斷防線 (初始資金絕對防禦版)
    // ==========================================
    // 注意：這裡請確保引入的是我們最後決定的 getStrictTodaySnapshot
    const startBalance = await getStrictTodaySnapshot();
    
    // 終極攔截：找不到基準線，直接拋出錯誤跳到大 catch，強迫拔除網線！
    if (!startBalance) {
      throw new Error(`[系統鎖死] 找不到今日(UTC)的帳戶快照基準線，懷疑 Cron 任務未跑或失敗！為避免觸發 FTMO 5% 違規，系統已強制拒絕開單。`);
    }

    // 1. 設定 FTMO 考試帳號的初始資金 (以 10 萬美金為例，轉為美分) 後續帳號初始資金變大 直接更改這裡就好。
    const INITIAL_ACCOUNT_BALANCE_CENTS = 100000 * 100;

    // 2. 設定拔插頭的「百分比」 (FTMO 官方是 5%，我們抓 3.5% 拔插頭，留 1.5% 給滑點)
    const MELTDOWN_PERCENTAGE = 0.035; 

    // 3. 自動計算絕對死線金額
    const MELTDOWN_THRESHOLD_CENTS = Math.round(INITIAL_ACCOUNT_BALANCE_CENTS * MELTDOWN_PERCENTAGE);
    const MELTDOWN_THRESHOLD_USD = MELTDOWN_THRESHOLD_CENTS / 100; // 留給 Log 用的

    // 4. 計算今日真實虧損金額 (起點 - 即時淨值)
    const dailyLossInCents = startBalance - liveEquityInCents;

    console.log(`[熔斷雷達] 今日起點: ${startBalance / 100}, 即時淨值: ${liveEquityInCents / 100}`);
    console.log(`[熔斷雷達] 目前當日虧損: ${dailyLossInCents / 100} USD (安全死線: $${MELTDOWN_THRESHOLD_USD.toFixed(2)})`);

    // 5. 如果虧損大於等於設定的美分門檻，直接拔網線！
    if (dailyLossInCents >= MELTDOWN_THRESHOLD_CENTS) {
      throw new Error(`[熔斷觸發] 當日虧損達 ${dailyLossInCents / 100} USD (安全死線: $${MELTDOWN_THRESHOLD_USD})。今日鎖死！`);
    }

    // TODO: 建立手數計算機函式，將 currentBalance, sl_distance 與商品規格轉換為 volumeInCents
    const calculatedVolume = calculateDynamicVolume({
      balanceInCents: rawBalanceInCents,
      riskPercent: data.riskPercent,    // 從 TV Webhook 傳來的 1%
      symbol: data.symbol,              // 例如 "EURUSD" 或 "XAUUSD"
      slPriceDistance: data.sl_distance // 從 TV 傳來的停損絕對距離
    });

    // 🚨 終極防呆：如果算出來的數量是 0，代表餘額不足或風險太小，直接終止任務！
    if (calculatedVolume === 0) {
      throw new Error(`[風控攔截] 計算出的下單單位為 0，已拒絕發送訂單。商品: ${data.symbol}`);
    }

    console.log(`[風控計算] 餘額: ${rawBalanceInCents / 100}, 算出手數: ${calculatedVolume}`);
    
    // ==========================================
    // 抓取 K 棒並計算 OTE 限價
    // ==========================================
    console.log(`[情報請求] 正在向 cTrader 獲取訊號 K 棒...`);
    
    // 將 TV 傳來的 ISO 或字串轉成精準毫秒
    // (假設 data.tv_time 是你 Webhook 傳來的，如果你是查 DB 就換成 DB 變數)
    const targetTimeMs = Number(data.tv_time)

    const klineResponse: any = await client.sendRequest("ProtoOAGetTrendbarsReq", {
      ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!),
      symbolId: symbolId,
      period: 5, // M5
      fromTimestamp: targetTimeMs,
      toTimestamp: targetTimeMs
    });

    const trendbar = klineResponse?.trendbar?.[0];
    if (!trendbar) {
      throw new Error(`[數據異常] cTrader 無法回傳 ${targetTimeMs} 的 K 棒資料，無法計算進場價！`);
    }

    // 防止 cTrader 發瘋吐出壞掉的 K 棒 (例如高低點一樣，或報價為 0)
    if (Number(trendbar.low) <= 0 || Number(trendbar.deltaHigh) < 0) {
      throw new Error(`[數據異常] cTrader 回傳了不合邏輯的 K 棒數據！Low: ${trendbar.low}, DeltaHigh: ${trendbar.deltaHigh}`);
    }

    // 呼叫 Utils 計算精準限價，如果 Webhook 沒傳 ote，預設使用 0.618
    const finalLimitPrice = calculateOteLimitPrice(trendbar, isBuy, data.ote || 0.618);
    
    // 最後的報價防呆，避免算出負數價格
    if (finalLimitPrice <= 0 || isNaN(finalLimitPrice)) {
       throw new Error(`[數學異常] 算出的限價單價格為無效數值: ${finalLimitPrice}`);
    }

    console.log(`[策略計算] 精準 FTMO 限價單價格算出了：${finalLimitPrice}`);
    
    // ==========================================
    // 組裝與發射
    // ==========================================
    console.log(`[系統發射] 準備送出 ${symbol} 訂單，方向: ${data.direction}，手數: ${calculatedVolume}`);
    
    // 確保 TV 傳來的是絕對正數距離 (例如 50)，乘以 100000 並轉為整數
    const formattedSL = Math.round(data.sl_distance * 100000);
    const formattedTP = Math.round(data.tp_distance * 100000);

    const orderPayload = {
      ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!),
      symbolId: symbolId, 
      orderType: 2, 
      tradeSide: isBuy ? 1 : 2, 
      volume: calculatedVolume,
      limitPrice: finalLimitPrice,
      relativeStopLoss: formattedSL,
      relativeTakeProfit: formattedTP,
      label: data.trade_id, 
      clientOrderId: data.trade_id
    };

    // 4. 下單 (繼續使用同一通電話！)
    const result: any = await client.sendRequest("ProtoOANewOrderReq", orderPayload);
    console.log(`[下單成功] cTrader 訂單已確認執行！`);

    // ==========================================
    // 🌟 核心防護網：攔截並回填戰果
    // ==========================================
    const officialOrderId = result?.order?.orderId?.toString() || null;
    const officialPositionId = result?.position?.positionId?.toString()|| null;
    const execPrice = result?.position?.price || 0;
    const actualSl = result?.position?.stopLoss || 0;
    const actualTp = result?.position?.takeProfit || 0;

    if (officialOrderId) {
      console.log(`[身分證核發] 取得官方 OrderID: ${officialOrderId}，準備回填資料庫...`);
      try {
        await updateSignalExecutionData(data.trade_id, {
           ctraderOrderId: officialOrderId,
           ctraderPositionId: officialPositionId,
           entryPrice: execPrice,
           sl: actualSl,
           tp: actualTp
        });
        console.log(`[回填成功] ${data.trade_id} 戰果已同步`);
      } catch (dbError: any) {
        reportNonFatalError("訂單戰果回填失敗", "未來撤單可能會抓不到單號", { trade_id: data.trade_id, error: dbError.message });
      }
    } else {
       reportNonFatalError("無法取得官方 OrderID", "回傳包內找不到 ID", { trade_id: data.trade_id, result_dump: result });
    }

    return result;

  } catch (error: any) {
    console.error(error);
    if (error.payload) throw error;
    // 保留你的完美 Telegram 錯誤拋出機制
    const superError = new Error(`[executeCTraderOrder] ENTRY 邏輯總崩潰`);
    (superError as any).payload = { 發生環節: "組裝訂單與發送", 傳入訊號: data, 原始錯誤包: error };
    throw superError;
  } finally {
    // 5. 確保任務結束或崩潰時，一定會掛斷電話！
    client.close();
  }
}

// ==========================================
// 🛡️ 常規撤單與核彈兜底邏輯
// ==========================================
export async function cancelCTraderOrder(orderIdToCancel: string, tradeId: string) {
  
  // 1. 拿起電話，準備撥號
  const client = new CTraderClient();

  try {
    console.log(`[撤單啟動] 準備撤銷 TV 訂單: ${tradeId}`);
    
    // 2. 確定有 ID 後，接通網路
    await client.connect();

    // 3. 發送常規撤單
    console.log(`[常規撤單] 轉換成功，發送撤單請求 (OrderID: ${orderIdToCancel})...`);
    await client.sendRequest("ProtoOACancelOrderReq", {
      ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!),
      orderId: parseInt(orderIdToCancel)
    });

    console.log(`[常規撤單成功] 訂單 ${orderIdToCancel} 已撤銷`);
    return { success: true, message: "常規撤單成功" };

  } catch (error: any) {
    // ==========================================
    // 🌟 神級防禦：判斷是不是「已經進場了」的報錯
    // ==========================================
    const errorCode = String(error?.errorCode || error?.message || "");
    
    if (errorCode.includes("NOT_FOUND") || errorCode.includes("ALREADY_FILLED") || errorCode.includes("INVALID_ORDER_STATE")) {
      console.log(`[撤單無效] 訂單 ${tradeId} 已經進場成交或已被取消！(cTrader 回應: ${errorCode})`);
      console.log(`[戰術執行] 系統不干預已進場部位，交由原始 SL/TP 處理。`);
      // 故意回傳 true，讓 Vercel 路由回覆 200 OK，不要讓外層 route.ts 以為系統壞掉狂叫
      return { success: true, status: "ALREADY_FILLED_OR_GONE" };
    }

    if (error.payload) throw error; 
    const superError = new Error(`[cancelCTraderOrder] 撤單系統崩潰`);
    (superError as any).payload = { 發生環節: "ctrader撤單控制", tradeId, 原始錯誤包: error };
    throw superError;

  } finally {
    // 掛斷電話
    client.close();
  }
}

// ==========================================
// 💣 核彈快照清洗 (接收上層傳來的通話中 Client)
// ==========================================
async function executeNuclearFallback(symbolId: number, client: CTraderClient) {
  try {
    const accountId = parseInt(process.env.CTRADER_ACCOUNT_ID!);

    // 1. 索取快照 (沿用電話)
    const snapshot: any = await client.sendRequest("ProtoOAReconcileReq", {
      ctidTraderAccountId: accountId
    });

    console.log(`[核彈鎖定] 成功取得快照，準備過濾 Symbol ID: ${symbolId} 的目標...`);

    const cancelPromises = [];

    // 2. 第一路：清空掛單
    const pendingOrders = snapshot.order?.filter((o: any) => o.tradeData.symbolId === symbolId) || [];
    for (const order of pendingOrders) {
      console.log(`[核彈執行] 準備撤銷掛單: ${order.orderId}`);
      cancelPromises.push(
        client.sendRequest("ProtoOACancelOrderReq", {
          ctidTraderAccountId: accountId,
          orderId: order.orderId
        }).catch(e => {
          console.error(`撤單失敗 (ID: ${order.orderId})`, e);
          // 🚨 加上這行，把啞彈的資訊偷偷用 Telegram 報給你，但絕不中斷迴圈！
          reportNonFatalError("核彈撤單單筆失敗", `掛單 ${order.orderId} 撤銷異常`, { error: e.message || e });
        })
      );
    }

    // 3. 第二路：平倉持倉
    const openPositions = snapshot.position?.filter((p: any) => p.tradeData.symbolId === symbolId) || [];
    for (const pos of openPositions) {
      console.log(`[核彈執行] 準備強制平倉: ${pos.positionId}, 數量: ${pos.tradeData.volume}`);
      cancelPromises.push(
        client.sendRequest("ProtoOAClosePositionReq", {
          ctidTraderAccountId: accountId,
          positionId: pos.positionId,
          volume: pos.tradeData.volume
        }).catch(e => {
          console.error(`平倉失敗 (ID: ${pos.positionId})`, e);
          reportNonFatalError("核彈平倉單筆失敗",`持倉 ${pos.positionId} 強平異常`,{ error: e.message || e });
        })
       );
    }

    // 4. 等待所有轟炸完成
    if (cancelPromises.length > 0) {
      // 🚀 這裡就是極速發射的奧義：所有指令同時塞進同一通電話裡丟出去，瞬間轟炸！
      await Promise.all(cancelPromises);
      console.log(`[核彈結束] 總計抹除了 ${pendingOrders.length} 筆掛單與 ${openPositions.length} 筆持倉。`);
    } else {
      console.log(`[核彈結束] 該商品目前為空倉，無需操作。`);
    }

  } catch (error: any) {
    const superError = new Error(`[executeNuclearFallback] 核彈協議執行失敗`);
    (superError as any).payload = { 發生環節: "強制快照清洗", 目標商品: symbolId, 原始錯誤包: error };
    throw superError; // 往上丟，會被 cancelCTraderOrder 的 catch 攔截並送到 Telegram
  }
}

// ==========================================
// 全域/單一商品 緊急核爆平倉與資料庫狀態焦土更新
// ==========================================
export async function emergencyCloseCTrader(targetSymbol: string) {
  // 1. 拿起專屬核彈熱線
  const client = new CTraderClient();

  try {
    console.log(`[核爆啟動] 準備對 ${targetSymbol} 執行焦土政策！`);
    await client.connect();
    
    const accountId = parseInt(process.env.CTRADER_ACCOUNT_ID!);

    // 2. 索取全域快照
    const snapshot: any = await client.sendRequest("ProtoOAReconcileReq", {
      ctidTraderAccountId: accountId
    });

    const allOrders = snapshot.order || [];
    const allPositions = snapshot.position || [];

    // 3. 篩選轟炸目標 (支援 'ALL' 或特定商品)
    let targetOrders = allOrders;
    let targetPositions = allPositions;

    if (targetSymbol !== 'ALL') {
      const targetSymbolId = SymbolIdMapping[targetSymbol];
      if (!targetSymbolId) throw new Error(`核爆失敗：找不到商品 ${targetSymbol} 的 ID`);
      targetOrders = allOrders.filter((o: any) => o.tradeData.symbolId === targetSymbolId);
      targetPositions = allPositions.filter((p: any) => p.tradeData.symbolId === targetSymbolId);
    }

    const actionPromises = [];

    // ==========================================
    // 💥 第一路：清空掛單並更新 DB
    // ==========================================
    for (const order of targetOrders) {
      // 💡 撕下狗牌：從快照中抓回我們當初塞進去的 trade_id
      const tradeId = order.tradeData?.label || order.clientOrderId;

      console.log(`[核爆執行] 準備撤銷掛單: ${order.orderId} (TradeID: ${tradeId || '未知'})`);
      
      const p = client.sendRequest("ProtoOACancelOrderReq", {
        ctidTraderAccountId: accountId,
        orderId: order.orderId
      })
      .then(() => {
         // 撤單成功後，順手把資料庫的狀態改掉！
         if (tradeId) {
           return updateSignalStatus(tradeId, 'emergency_closed')
             .catch(e => console.error(`[核爆後勤] 資料庫狀態更新失敗: ${tradeId}`, e));
         }
      })
      .catch(e => {
        reportNonFatalError("核彈撤單單筆失敗", `掛單 ${order.orderId} 撤銷異常`, { error: e.message || e });
      });

      actionPromises.push(p);
    }

    // ==========================================
    // 💥 第二路：平倉持倉並更新 DB
    // ==========================================
    for (const pos of targetPositions) {
      // 💡 撕下狗牌：從快照中抓回我們當初塞進去的 trade_id
      const tradeId = pos.tradeData?.label;

      console.log(`[核爆執行] 準備強制平倉: ${pos.positionId} (TradeID: ${tradeId || '未知'})`);
      
      const p = client.sendRequest("ProtoOAClosePositionReq", {
        ctidTraderAccountId: accountId,
        positionId: pos.positionId,
        volume: pos.tradeData.volume
      })
      .then(() => {
         // 平倉成功後，順手把資料庫的狀態改掉！
         if (tradeId) {
           return updateSignalStatus(tradeId, 'emergency_closed')
             .catch(e => console.error(`[核爆後勤] 資料庫狀態更新失敗: ${tradeId}`, e));
         }
      })
      .catch(e => {
        reportNonFatalError("核彈平倉單筆失敗", `持倉 ${pos.positionId} 強平異常`, { error: e.message || e });
      });

      actionPromises.push(p);
    }

    // 4. 等待所有飛彈落地與資料庫更新完畢
    if (actionPromises.length > 0) {
      await Promise.all(actionPromises);
      console.log(`[核爆結束] 總計抹除了 ${targetOrders.length} 筆掛單與 ${targetPositions.length} 筆持倉，並同步更新了資料庫狀態。`);
    } else {
      console.log(`[核爆結束] 雷達上沒有發現 ${targetSymbol} 的目標，安全下莊。`);
    }

    return { success: true, message: `核彈平倉協議完成 (${targetSymbol})` };

  } catch (error: any) {
    const superError = new Error(`[emergencyCloseCTrader] 核彈平倉協議總崩潰`);
    (superError as any).payload = { 發生環節: "強制快照清洗與資料庫更新", 目標商品: targetSymbol, 原始錯誤包: error };
    throw superError;
  } finally {
    // 5. 無論如何，掛斷電話
    client.close();
  }
}

/**
 * 獲取 cTrader 當前帳戶餘額 (用於每日快照)
 * @returns {Promise<number>} 回傳帳戶餘額 (美分 BIGINT 格式)
 */
export async function fetchDailySnapshotBalance(): Promise<number> {
  const client = new CTraderClient();
  
  try {
    console.log(`[快照啟動] 準備連接 cTrader 獲取帳戶基準線 (UTC)...`);
    
    // 1. 建立連線
    await client.connect();
    
    // 2. 請求帳戶資訊
    const response = await client.sendRequest("ProtoOATraderReq", {
       ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!) 
    });

    // 3. 提取餘額
    const balanceInCents = response.trader.balance;
    
    if (balanceInCents === undefined || balanceInCents === null) {
        throw new Error("cTrader 回傳的餘額為空值或未定義");
    }

    console.log(`[快照成功] 獲取當前餘額: ${Number(balanceInCents) / 100} USD`);
    return Number(balanceInCents);
    
  } catch (error: any) {
    console.error("[cTrader 快照服務崩潰]", error);
    
    // 🚨 完美組裝 superError 往外砸！
    const superError = new Error(`[fetchDailySnapshotBalance] 獲取帳戶快照失敗`);
    (superError as any).payload = { 
        發生環節: "cTrader 獲取每日基準線", 
        發生時間_UTC: new Date().toISOString(), // 統一標註 UTC 時間
        詳細死因: error.message || error,
        原始錯誤包: error 
    };
    throw superError;
    
  } finally {
    // 4. 絕對要掛斷電話
    client.close();
  }
}