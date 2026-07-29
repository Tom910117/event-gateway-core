import { XMLParser } from 'fast-xml-parser';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';

// 啟用 dayjs 插件
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export interface HighImpactNews {
  id: string;
  title: string;
  country: string;
  impact: string;
  event_time: string; // 給 Supabase 的 UTC ISO 字串
}

export async function fetchAndParseHighImpactNews(): Promise<HighImpactNews[]> {
  try {
    console.log("[News Client] 開始向 Forex Factory 獲取本週財經日曆...");
    
    const response = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.xml', { 
      cache: 'no-store' 
    });
    
    if (!response.ok) throw new Error(`獲取 FF 新聞失敗，狀態碼: ${response.status}`);

    const xmlData = await response.text();
    const parser = new XMLParser();
    const jsonObj = parser.parse(xmlData);

    const events: any[] = [].concat(jsonObj?.weeklyevents?.event || []);
    if (events.length === 0) return [];

    const filteredNews = events.filter(e => e.impact === 'High' && e.country === 'USD');

    const cleanNewsData: HighImpactNews[] = filteredNews.map(e => {
      const timeStr = e.time ? e.time.toLowerCase() : "";
      let isoDateString = "";

      // 🌟 核心時區轉換邏輯：FF 時間 (美東) -> UTC
      if (timeStr && timeStr !== "all day" && timeStr !== "tentative") {
         // 例如：e.date="07-04-2026" (MM-DD-YYYY), e.time="8:30am"
         const dateTimeStr = `${e.date} ${e.time}`;
         // 修正關鍵：不再轉換時區！直接將字串宣告為 UTC，轉成 ISO
         isoDateString = dayjs.utc(dateTimeStr, "MM-DD-YYYY h:mma").toISOString();
      } else {
         // 全天事件
         isoDateString = dayjs.utc(e.date, "MM-DD-YYYY").startOf('day').toISOString();
      }

      return {
        id: Buffer.from(`${e.title}-${e.date}-${e.time}`).toString('base64'),
        title: e.title,
        country: e.country,
        impact: e.impact,
        event_time: isoDateString
      };
    });

    console.log(`[News Client] 成功過濾出 ${cleanNewsData.length} 筆 USD 高影響力新聞。`);
    return cleanNewsData;

  } catch (error) {
    console.error("❌ [News Client] 抓取或解析新聞失敗:", error);
    throw error; 
  }
}