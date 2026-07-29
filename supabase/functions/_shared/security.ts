import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// 定義一個「絕對不允許有任何屬性」的嚴格空物件 Schema
const EmptyBodySchema = z.object({}).strict();

/**
 * 嚴格檢查 Request Body 是否為空
 * 如果裡面有任何多餘的 Payload，會回傳錯誤訊息；如果沒問題則回傳 null
 */
export async function validateEmptyBody(req: Request): Promise<string | null> {
  try {
    // 讀取傳進來的 raw text
    const text = await req.text();
    
    // 如果有內容，嘗試解析成 JSON 並用 Zod 檢查
    if (text && text.trim() !== "") {
      const parsed = JSON.parse(text);
      EmptyBodySchema.parse(parsed); // 如果 parsed 裡面有任何 key，這裡就會噴錯
    }
    
    return null; // 驗證通過，Body 是乾淨的
  } catch (error) {
    console.warn("🚨 [資安防護] 攔截到異常 Payload:", error);
    return "Bad Request: Body 必須完全為空，嚴禁攜帶任何 Payload。";
  }
}