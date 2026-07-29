import { NextResponse } from 'next/server';
import { binanceFetch } from '@/lib/exchanges/binance-client';
import { processBinanceTrade, processBinanceIncome } from '@/lib/services/trade-calculator';
import { upsertTrades, pingDatabase } from '@/lib/repositories/trade-repository';
import { upsertIncomes } from '@/lib/repositories/income-repository';
import { upsertNews } from '@/lib/repositories/news-repository';
import { binanceTradeSchema, binanceIncomeSchema } from '@/lib/schemas/binanceSchema';
import { reportNonFatalError, sendTelegramAlert } from '@/lib/clients/telegram';
import { fetchAndParseHighImpactNews } from '@/lib/clients/news-client';
import { fetchDailySnapshotBalance } from '@/lib/services/ctrader-order-service';
import { upsertDailySnapshot } from '@/lib/repositories/snapshot-repository';

export async function GET(request: Request) {
  // 1. 最高級別的安全防護：CRON_SECRET 驗證
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 戰況報告書 (記錄每個子任務的執行結果)
  const report = {
    ping: "未執行",
    news: "未執行", 
    ctrader_snapshot: "未執行", // 🌟 新增：每日帳戶防禦基準
    orders: "未執行",
    income: "未執行"
  };
  
  const targetSymbol = 'BTCUSDT';
  
  // 🌟 時間窗格設定：鎖定過去 24 小時 (86,400,000 毫秒)
  const endTime = Date.now();
  const startTime = endTime - (24 * 60 * 60 * 1000); 

  // ==========================================
  // 任務零：防休眠 Ping Supabase
  // ==========================================
  try {
    console.log(`[排程啟動] 執行 Supabase 防休眠 Ping...`);
    await pingDatabase();
    report.ping = "✅ 成功";
  } catch (error: any) {
    const errMsg = error.message || "未知錯誤";
    reportNonFatalError("防休眠 Ping", "喚醒 Supabase 失敗", { error: errMsg });
    report.ping = `❌ 失敗: ${errMsg}`;
  }

  // ==========================================
  // 任務一：同步 Forex Factory 新聞
  // ==========================================
  let testNewsData: any[] = []; // 用來存抓到的新聞，準備丟給 Postman
  
  try {
    console.log(`[排程進度] 開始獲取本週高影響力新聞...`);
    
    // 直接呼叫我們寫好的 Client
    testNewsData = await fetchAndParseHighImpactNews();
    
    if (testNewsData.length > 0) {
        // 把新聞資料送進資料庫
        await upsertNews(testNewsData);
        report.news = `✅ 成功獲取 ${testNewsData.length} 筆新聞`;
    } else {
        report.news = `✅ 成功 (本週無 USD 高影響力新聞)`;
    }
  } catch (error: any) {
    const errMsg = error.message || "未知錯誤";
    // 一樣套用 Telegram 防彈報錯
    reportNonFatalError("新聞同步測試", "抓取或解析 FF 新聞失敗", { error: errMsg });
    report.news = `❌ 失敗: ${errMsg}`;
  }

  // ==========================================
  // 任務二：cTrader 每日餘額快照 (防禦 5% 熔斷核心)
  // 戰略意義：極度重要，必須排在 Binance 同步之前執行
  // ==========================================
  try {
    console.log(`[排程進度] 開始獲取 cTrader 帳戶快照...`);
    
    // 1. 呼叫 Service 取得美分餘額
    const balanceInCents = await fetchDailySnapshotBalance();
    
    // 2. 寫入 Supabase (我們剛剛確認過，內部用的是 UTC Date)
    await upsertDailySnapshot(balanceInCents);

    report.ctrader_snapshot = `✅ 成功 (鎖定今日基準線: ${balanceInCents / 100})`;
  } catch (error: any) {
    const errMsg = error.message || "未知錯誤";
    // 小 try-catch 攔截，回報 Telegram 但絕不中斷排程
    reportNonFatalError("cTrader 快照同步", "獲取或寫入每日基準線失敗，今日熔斷保護可能失效！", { error: errMsg });
    report.ctrader_snapshot = `❌ 失敗: ${errMsg}`;
  }
  
  /*
  // ==========================================
  // 任務三：同步合約歷史訂單 (過去 24 小時)
  // ==========================================
  try {
    console.log(`[排程啟動] 開始同步 ${targetSymbol} 過去 24 小時訂單...`);
    
    // 改用 startTime 和 endTime 精準打擊
    const tradeData = await binanceFetch('/fapi/v1/userTrades', 'GET', { 
        symbol: targetSymbol,
        startTime,
        endTime
    });

    const cleanTrades = (tradeData || [])
      .reduce((acc: any[], rawItem: any) => {
        const parsed = binanceTradeSchema.safeParse(rawItem);
        if (parsed.success) {
          const processed = processBinanceTrade(parsed.data);
          if (processed) acc.push(processed);
        } else {
          console.warn("[Zod 攔截] 發現異常訂單格式，已捨棄:", parsed.error.message);
        }
        return acc;
      }, []);

    if (cleanTrades.length > 0) {
        // 注意：這裡的 upsertTrades 裡面應該已經實作了我們討論過的 Map 去重邏輯！
        const savedTrades = await upsertTrades(cleanTrades);
        report.orders = `✅ 成功更新 ${savedTrades.length} 筆`;
    } else {
        report.orders = `✅ 成功 (無新資料)`;
    }
  } catch (error: any) {
    const errMsg = error.message || "未知錯誤";
    reportNonFatalError("Binance 訂單同步", "抓取或寫入歷史訂單失敗", { error: errMsg, symbol: targetSymbol });
    report.orders = `❌ 失敗: ${errMsg}`;
  }

  // ==========================================
  // 任務四：同步合約資金流水 (過去 24 小時)
  // ==========================================
  try {
    console.log(`[排程進度] 開始同步 ${targetSymbol} 資金流水...`);
    
    // 改用 startTime 和 endTime
    const incomeData = await binanceFetch('/fapi/v1/income', 'GET', { 
        symbol: targetSymbol, 
        startTime,
        endTime
    });

    const targetIncomeTypes = ['REALIZED_PNL', 'FUNDING_FEE', 'COMMISSION', 'COMMISSION_REBATE'];

    const cleanIncomes = (incomeData || []).reduce((acc: any[], rawItem: any) => {
        if (!targetIncomeTypes.includes(rawItem.incomeType)) return acc;

        const parsed = binanceIncomeSchema.safeParse(rawItem);
        if (parsed.success) {
            const processed = processBinanceIncome(parsed.data);
            if (processed) acc.push(processed);
        } else {
            console.warn(`[Zod 攔截] 異常流水格式 (ID: ${rawItem.tranId}):`, parsed.error.message);
        }
        return acc;
    }, []);

    if (cleanIncomes.length > 0) {
        // 注意：這裡的 upsertIncomes 裡面應該已經實作了我們討論過的 Map 去重邏輯！
        const savedIncomes = await upsertIncomes(cleanIncomes);
        report.income = `✅ 成功更新 ${savedIncomes.length} 筆`;
    } else {
        report.income = `✅ 成功 (無新資料)`;
    }
  } catch (error: any) {
    const errMsg = error.message || "未知錯誤";
    reportNonFatalError("Binance 流水同步", "抓取或寫入資金流水失敗", { error: errMsg, symbol: targetSymbol });
    report.income = `❌ 失敗: ${errMsg}`;
  }
  */

  // ==========================================
  // 總結算與回報
  // ==========================================
  // 檢查戰報中是否有任何失敗
  const hasError = Object.values(report).some(status => status.includes("❌"));

  if (hasError) {
    // 雖然不中斷 Vercel，但我們發送一個總結報告，讓你知道哪些環節出錯了
    await sendTelegramAlert(
      "🚨 Cron 任務部分失敗",
      "排程中有些小模組崩潰了，但其他模組已順利執行完畢，請確認戰報。",
      { 戰況報告: report }
    );
    // 回傳 207 代表 Multi-Status (部分成功，部分失敗)，這能安撫 Vercel 不會把它當成徹底死機
    return NextResponse.json({ message: "任務完成，但有部分異常", report, test_news_payload: testNewsData }, { status: 207 });
  }

  console.log(`[排程結束] 所有任務圓滿完成。`);
  return NextResponse.json({ success: true, message: "所有排程任務同步完成！", report, test_news_payload: testNewsData });
}