import { supabase } from '@/lib/supabase';
import { HighImpactNews } from '@/lib/clients/news-client';

// ==========================================
// 📥 寫入/更新新聞 (給 Vercel 每日排程用)
// ==========================================
export async function upsertNews(newsList: HighImpactNews[]) {
  if (!newsList || newsList.length === 0) return [];

  // 🛡️ 再加一層保險：在丟給 Supabase 前，確保陣列內部沒有重複的 ID
  const cleanNewsList = Array.from(
    new Map(newsList.map(item => [item.id, { ...item, is_triggered: false }])).values()
  );

  // 使用 upsert，如果 ID 衝突就更新 (完美解決重複抓取的問題)
  const { data, error } = await supabase
    .from('news_calendar')
    .upsert(cleanNewsList, { onConflict: 'id', ignoreDuplicates: true }) 
    .select();

  if (error) {
    console.error("寫入 news_calendar 失敗:", error);
    throw error;
  }

  return data;
}

/**
 * 檢查當前時間是否落在重大新聞的前後 15 分鐘管制區間內
 * @returns {Promise<boolean>} 如果在管制區間內回傳 true (應阻擋)，否則回傳 false
 */
export async function checkUpcomingNewsBlock(): Promise<boolean> {
  const NEWS_BUFFER_MINUTES = 15;
  const now = new Date();
  
  // 計算管制區間的絕對時間 (UTC)
  const bufferStart = new Date(now.getTime() - NEWS_BUFFER_MINUTES * 60000).toISOString();
  const bufferEnd = new Date(now.getTime() + NEWS_BUFFER_MINUTES * 60000).toISOString();

  const { data: upcomingNews, error } = await supabase
    .from('news_calendar')
    .select('id, event_time, title')
    .gte('event_time', bufferStart)
    .lte('event_time', bufferEnd);

  // 🚨 遇到資料庫錯誤，直接組裝 superError 往外砸！
  if (error) {
    const errorMessage = error?.message || error?.details || JSON.stringify(error);
    console.error("[新聞防禦查詢崩潰]", errorMessage);

    const superError = new Error(`[checkUpcomingNewsBlock] 資料庫查詢新聞防禦區間失敗`);
    
    // 貼上情報標籤，讓外層的大 catch 和 Telegram 能完美解析
    (superError as any).payload = {
      發生環節: "Supabase 查詢新聞管制區",
      查詢區間: `${bufferStart} ~ ${bufferEnd}`,
      詳細死因: errorMessage,
      原始錯誤包: error
    };
    
    throw superError;
  }

  // 如果陣列裡面有東西，代表踩到雷區！
  if (upcomingNews && upcomingNews.length > 0) {
    const targetNews = upcomingNews[0];
    console.warn(`[風控攔截] 距新聞 "${targetNews.title}" 過近 (${targetNews.event_time})，觸發進場封鎖！`);
    return true; // 觸發封鎖
  }

  return false; // 雷達清晰，放行
}