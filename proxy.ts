import { NextResponse, type NextRequest } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// TV Webhook 專用限流器 (10秒內最多 5 次)
const tvWebhookRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "10 s"),
  ephemeralCache: process.env.NODE_ENV === "production" ? new Map() : undefined,
});

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // 👮‍♂️ 只攔截 TradingView 的 Webhook 路由
  if (path.startsWith("/api/webhook")) {
    const forwardedFor = request.headers.get("x-forwarded-for");
    const ip = forwardedFor ? forwardedFor.split(',')[0].trim() : "127.0.0.1";
    
    const edgeSniperSecret = request.headers.get('x-edge-sniper-secret');
    // ==========================================
    // 🛡️ 第一道防線：IP 白名單 (0毫秒邊緣攔截，不耗資源)
    // ==========================================
    const allowedIpsString = process.env.TV_ALLOWED_IPS || "";
    const allowedIps = allowedIpsString.split(",").map(i => i.trim());
    const isVipPass = edgeSniperSecret === process.env.EDGE_SNIPER_SECRET;

    if (!allowedIps.includes(ip) && !isVipPass) {
      console.warn(`[邊緣防火牆] 拒絕未經授權的 IP: ${ip}`);
      return NextResponse.json(
        { error: "Access Denied." },
        { status: 403 }
      );
    }
    
    // 💡 採用你的最佳實踐：加上明確的 Bucket 前綴
    const { success, limit, remaining } = await tvWebhookRatelimit.limit(`tv_webhook_${ip}`);

    if (!success) {
      console.warn(`[Webhook 防禦] IP: ${ip} 觸發限流攔截`);
      return NextResponse.json(
        { success: false, message: "請求過於頻繁 (Too Many Requests)" },
        { status: 429 }
      );
    }

    // 將限流資訊塞入 Header 傳遞給後端 API 路由
    const response = NextResponse.next();
    response.headers.set('X-RateLimit-Limit', limit.toString());
    response.headers.set('X-RateLimit-Remaining', remaining.toString());
    return response;
  }

  // 其他前端頁面或 Cron Job 直接放行，不消耗 Edge 資源
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};