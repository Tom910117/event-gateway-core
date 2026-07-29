// lib/binance-client.ts
import crypto from 'crypto';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API_KEY = process.env.BINANCE_API_KEY!;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY!;
const BASE_URL = 'https://fapi.binance.com'; // 注意：這是幣安 U本位合約專屬的 Base URL

const proxyUrl = process.env.FIXIE_URL;
// 防呆機制：如果本地開發沒設定 FIXIE_URL，就不用代理（直連）
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
/**
 * 通用的 Binance 請求函數 (支援 GET 與 POST)
 */
export async function binanceFetch(endpoint: string, method: 'GET' | 'POST' | 'DELETE', params: Record<string, any> = {}) {
  // 1. 幣安要求 timestamp 必須精準
  const timestamp = Date.now().toString();
  
  // 加入 timestamp 與 recvWindow (防延遲機制，設定 10000 毫秒)
  const fullParams: Record<string, any> = { 
    ...params, 
    timestamp,
    recvWindow: 10000 
  };
  
  // 2. 組裝 Query String (幣安不強制按字母排序，但 URL 編碼是好習慣)
  const queryString = Object.keys(fullParams)
    .map(key => `${key}=${encodeURIComponent(fullParams[key])}`)
    .join('&');

  // 3. 產生 HMAC-SHA256 簽名
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(queryString)
    .digest('hex');

  // 4. 發送請求
  // 對於幣安來說，無論 GET 或 POST，參數通常都放在 URL 上
  const url = `${BASE_URL}${endpoint}?${queryString}&signature=${signature}`;
  
  try {
    const response = await fetch(url, {
      method: method,
      headers: { 
        'X-MBX-APIKEY': API_KEY, // 幣安專屬標頭
        'Content-Type': 'application/json'
      },
      agent: agent,
    });

    const result = await response.json();

    // 幣安如果報錯，通常會回傳 code (非 0 或非 200) 和 msg
    if (result.code && result.code !== 200) {
      throw new Error(`Binance API 錯誤 (${result.code}): ${result.msg}`);
    }

    return result; // 幣安的資料層通常直接在第一層，不像 BingX 包在 data 裡面
  } catch (error) {
    console.error('Binance Fetch 失敗:', error);
    throw error;
  }
}