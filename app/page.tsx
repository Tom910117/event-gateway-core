"use client";

import { useState } from "react";

export default function Home() {
  // 狀態管理：儲存 API 回傳的資料與載入狀態
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  // 觸發前端去呼叫我們自己寫的 Next.js API 路由
  const fetchBingXData = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("", {
        method: 'POST', 
      });

      if (!response.ok) {
      // 如果不是 200 OK，把後端真實的錯誤訊息印出來，而不是硬轉 json
      const errorText = await response.text(); 
      throw new Error(`伺服器錯誤 ${response.status}: ${errorText}`);
    }
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error("呼叫 API 失敗:", error);
      setData({ error: "無法取得資料，請檢查終端機的錯誤訊息" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 p-8 font-mono">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* 標題與操作區塊 */}
        <header className="border-b border-neutral-800 pb-6">
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">
            量化交易戰情室 <span className="text-neutral-500 text-sm ml-2">v0.1.0 MVP</span>
          </h1>
          <p className="text-neutral-400 mb-6">
            測試管線：Browser ➔ Next.js API ➔ BingX OpenAPI ➔ 回傳顯示
          </p>
          <button
            onClick={fetchBingXData}
            disabled={isLoading}
            className={`px-6 py-2 font-bold rounded text-neutral-950 transition-all ${
              isLoading
                ? "bg-neutral-600 cursor-not-allowed"
                : "bg-white hover:bg-neutral-200 active:scale-95"
            }`}
          >
            {isLoading ? "資料載入中 (Fetching...)" : "發送測試請求"}
          </button>
        </header>

        {/* 數據顯示區塊 */}
        <main>
          {data ? (
            <div className="space-y-2">
              <h2 className="text-lg font-semibold text-neutral-300">Raw Data (原始 JSON)</h2>
              {/* 使用 <pre> 標籤能完美保留 JSON 的縮排與換行 */}
              <pre className="bg-neutral-900 p-6 rounded-lg overflow-x-auto border border-neutral-800 text-sm text-green-400 shadow-inner">
                <code>{JSON.stringify(data, null, 2)}</code>
              </pre>
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center border border-dashed border-neutral-800 rounded-lg text-neutral-600">
              點擊上方按鈕以擷取 BingX 帳戶資料
            </div>
          )}
        </main>

      </div>
    </div>
  );
}
