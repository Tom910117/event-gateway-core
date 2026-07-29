import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import protobuf from 'protobufjs';
import path from 'path';
import crypto from 'crypto';

// 1. 保留你的完美字典載入邏輯 (放在檔案頂端，確保只載入一次)
const PROTO_DIR = path.resolve(process.cwd(), 'lib/proto');
const root = protobuf.loadSync([
  path.join(PROTO_DIR, 'OpenApiCommonModelMessages.proto'),
  path.join(PROTO_DIR, 'OpenApiCommonMessages.proto'),
  path.join(PROTO_DIR, 'OpenApiModelMessages.proto'),
  path.join(PROTO_DIR, 'OpenApiMessages.proto')
]);

const ProtoMessage = root.lookupType("ProtoMessage");

// 保留你的對照表
const PayloadTypeMap: Record<string, number> = {
  "ProtoOANewOrderReq": 2106,
  "ProtoOACancelOrderReq": 2108,
  "ProtoOAClosePositionReq": 2111,
  "ProtoOAReconcileReq": 2124,
  "ProtoOASymbolsListReq": 2114,
  "ProtoOAApplicationAuthReq": 2100, // 補上授權代碼
  "ProtoOAAccountAuthReq": 2102,
  "ProtoOATraderReq": 2121, // 補上查帳代碼
  "ProtoOAGetTrendbarsReq": 2137,  // 補上獲取歷史 K 棒的請求代碼
  "ProtoOASymbolByIdReq" : 2116
};

export class CTraderClient {
  private ws: WebSocket | null = null;
  // 🌟 核心：號碼牌字典 (追蹤碼 -> 包含 resolve 和 reject 的物件)
  private pendingRequests = new Map<string, { resolve: (data: any) => void, reject: (error: any) => void }>();

  // ==========================================
  // 1. 開啟通道並自動完成雙重授權
  // ==========================================
  public connect(): Promise<void> {
    return new Promise((resolveConnect, rejectConnect) => {
      
      // ==========================================
      // 💣 1. 佈署 10 秒連線超時炸彈
      // ==========================================
      const connectTimeout = setTimeout(() => {
        if (this.ws) {
          this.ws.close(); // 時間到！直接把半殘的連線切斷
        }
        rejectConnect(new Error("[Timeout] 建立 WebSocket 連線與雙重授權超過 10 秒，強制中斷"));
      }, 10000);

      try {
        // 掛上你的 Fixie Proxy 邏輯
        const fixieUrl = process.env.FIXIE_URL;
        const proxyAgent = new HttpsProxyAgent(fixieUrl!);
        
        console.log("🔌 [WS] 嘗試連線至 wss://live.ctraderapi.com:5035...");
        this.ws = new WebSocket('wss://live.ctraderapi.com:5035', { agent: proxyAgent });

        // 佈署背景哨兵
        this.setupMessageListener();

        this.ws.on('open', async () => {
          console.log("✅ [WS] 通道成功開啟！準備執行雙重授權...");
          try {
            // 利用我們寫好的 sendRequest，直接發送授權！
            await this.sendRequest("ProtoOAApplicationAuthReq", {
              clientId: process.env.CTRADER_CLIENT_ID,
              clientSecret: process.env.CTRADER_CLIENT_SECRET
            });
            console.log("✅ App 授權成功！");

            await this.sendRequest("ProtoOAAccountAuthReq", {
              ctidTraderAccountId: parseInt(process.env.CTRADER_ACCOUNT_ID!),
              accessToken: process.env.CTRADER_ACCESS_TOKEN
            });
            console.log("✅ Account 授權成功！通道全面就緒。");
            
            // ==========================================
            // ✂️ 2. 授權全過，第一時間剪斷連線炸彈！
            // ==========================================
            clearTimeout(connectTimeout); 
            resolveConnect(); // 解除外層 Service 的 await client.connect()

          } catch (authError) {
            clearTimeout(connectTimeout); // ✂️ 授權出錯，拆掉炸彈並往外丟錯誤
            rejectConnect(authError);
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log(`🚪 [WS] 通道關閉。代碼: ${code}, 原因: ${reason.toString() || '無'}`);
          this.pendingRequests.clear();
          rejectConnect(new Error(`WebSocket 通道意外關閉 (代碼: ${code})`));
        });

        this.ws.on('error', (err) => {
          console.error("❌ [WS] 連線異常", err);
          clearTimeout(connectTimeout); // ✂️ 網路層異常，拆掉炸彈並往外丟錯誤
          rejectConnect(err);
        });

      } catch (err) {
        clearTimeout(connectTimeout); // ✂️ 初始化異常，拆掉炸彈
        rejectConnect(err);
      }
    });
  }

  // ==========================================
  // 2. 萬用發射台 (發放號碼牌，打包並發送)
  // ==========================================
  public sendRequest(payloadTypeString: string, payloadData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket 未連線或已關閉"));
      }

      const payloadId = PayloadTypeMap[payloadTypeString];
      if (!payloadId) return reject(new Error(`找不到 ${payloadTypeString} 的 ID`));

      // 1. 產生 UUID 號碼牌
      const msgId = crypto.randomUUID();

      // ==========================================
      // 💣 2. 啟動定時炸彈 (10秒後引爆)
      // ==========================================
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(msgId); // 銷毀過期的號碼牌
        reject(new Error(`[Timeout] 伺服器在 10 秒內未回應指令: ${payloadTypeString}`));
      }, 10000);

      // ==========================================
      // 🛡️ 3. 打造「自帶拆彈功能」的超級鑰匙
      // ==========================================
      const resolveWithClearTimeout = (data: any) => {
        clearTimeout(timeout); // 成功收到包裹，第一件事：剪斷炸彈引線！
        resolve(data);         // 解開外面的 await
      };

      const rejectWithClearTimeout = (error: any) => {
        clearTimeout(timeout); // 遇到報錯，也要把超時炸彈剪斷！
        reject(error);         // 解開 await 並丟給 catch
      };

      // 4. 把「超級鑰匙」存進字典
      this.pendingRequests.set(msgId, { 
        resolve: resolveWithClearTimeout, 
        reject: rejectWithClearTimeout 
      });

      // 5. 壓縮與發射邏輯 (保持原樣)
      try {
        const TargetProtoMsg = root.lookupType(payloadTypeString);
        const targetMsg = TargetProtoMsg.create(payloadData);
        const targetBuffer = TargetProtoMsg.encode(targetMsg).finish();

        const wrapper = ProtoMessage.create({ 
          payloadType: payloadId, 
          payload: targetBuffer,
          clientMsgId: msgId 
        });

        this.ws.send(Buffer.from(ProtoMessage.encode(wrapper).finish()));
      } catch (err) {
        clearTimeout(timeout); // 送都送不出去，當場拆炸彈
        this.pendingRequests.delete(msgId);
        reject(err);
      }
    });
  }

  // ==========================================
  // 3. 背景神經中樞 (攔截、解碼、對號碼牌)
  // ==========================================
  private setupMessageListener() {
    this.ws!.on('message', (buffer: Buffer) => {
      try {
        const decodedMsg = ProtoMessage.decode(buffer);
        const msgId = decodedMsg.clientMsgId; // 抓取信封上的號碼牌

        // 🚨 統一錯誤攔截區塊
        const errorTypeName = this.getErrorResponseTypeName(decodedMsg.payloadType);
        if (errorTypeName) {
          const ErrorType = root.lookupType(errorTypeName);
          const errorDetail: any = ErrorType.decode(decodedMsg.payload as Uint8Array);
          console.error(`❌ [伺服器拒絕] ${errorTypeName}:`, errorDetail);
          
          if (msgId && this.pendingRequests.has(msgId)) {
            this.pendingRequests.get(msgId)!.reject(errorDetail);
            this.pendingRequests.delete(msgId);
          }
          return; // 錯誤處理完畢，直接跳出
        }

        // ✅ 正常封包處理
        if (msgId && this.pendingRequests.has(msgId)) {
          // 動態尋找回傳的型別名稱 (把 Req 換成 Res / Event)
          let responseTypeName = this.getResponseTypeName(decodedMsg.payloadType);
          
          // 🛡️ 新增裝甲：如果連成功字典都查不到，這是一個我們看不懂的幽靈封包！
          if (!responseTypeName) {
            console.error(`❌ [嚴重異常] 收到未知或未註冊的封包 ID: ${decodedMsg.payloadType}`);
            // 直接當作錯誤處理，主動 reject 並附上理由
            this.pendingRequests.get(msgId)!.reject(new Error(`未知的伺服器回傳封包 ID: ${decodedMsg.payloadType}`));
            this.pendingRequests.delete(msgId);
            return; // 蓋完駁回印章，走出辦公室！
          }

          let innerData: any = {};
          if (decodedMsg.payload) {
             const ResponseType = root.lookupType(responseTypeName);
             innerData = ResponseType.decode(decodedMsg.payload as Uint8Array);
          }
          
          // 🌟 魔法核心：針對「訂單執行事件 (ProtoOAExecutionEvent)」進行特殊攔截
          if (responseTypeName === "ProtoOAExecutionEvent") {
            const execType = innerData.executionType;

            // 從事件中抓出這張單是什麼類型的 (1=MARKET, 2=LIMIT, 3=STOP)
            const orderType = innerData.order?.orderType;

            if (execType === 2) { // 2 = ORDER_ACCEPTED (受理)
              if (orderType === 2 || orderType === 3) {
                    // ✅ 綠色通道：這是限價單 (Limit) 或停損單 (Stop)
                    // 只要掛上去就算成功，不需要等成交！立刻解開 Promise！
                    console.log(`✅ [限價/停損單受理] 訂單已成功掛在簿子上，放行！`);
                    this.pendingRequests.get(msgId)!.resolve(innerData);
                    this.pendingRequests.delete(msgId);
                    return;
                  } else {
                    // ⏳ 一般通道：這是市價單 (Market)
                    // 必須等下一個 FILLED 封包，所以保留號碼牌繼續等
                    console.log(`⏳ [市價單受理] 伺服器已接收，等待市場搓合中... (不銷毀號碼牌)`);
                    return; 
                  }
            }

            if (execType === 4) { // 4 = ORDER_REJECTED (搓合失敗，例如流動性不足)
              console.error(`❌ [訂單駁回] 搓合階段失敗:`, innerData);
              this.pendingRequests.get(msgId)!.reject(new Error("訂單在搓合階段被券商駁回"));
              this.pendingRequests.delete(msgId);
              return;
            }

            if (execType === 3) { // 3 = ORDER_FILLED (成交！)
              console.log(`✅ [訂單成交] 搓合完成！成功捕獲真實價格與絕對止損/止盈。`);
              // 只有確定成交，才把這個包含真實數據的封包 resolve 出去！
              this.pendingRequests.get(msgId)!.resolve(innerData);
              this.pendingRequests.delete(msgId);
              return;
            }
          }

          // 如果是查帳等其他正常的封包，照舊直接 resolve
          this.pendingRequests.get(msgId)!.resolve(innerData);
          this.pendingRequests.delete(msgId); // 銷毀號碼牌
        }
      } catch (err) {
        console.error("❌ 解碼封包失敗", err);
      }
    });
  }

  // 小工具：根據 payloadType 回推應該用哪個字典解碼 (可以依照需求擴充)
  private getResponseTypeName(payloadType: number): string | null {
    switch (payloadType) {
      case 2101: return "ProtoOAApplicationAuthRes";
      case 2103: return "ProtoOAAccountAuthRes";
      case 2122: return "ProtoOATraderRes"; // 查帳結果
      case 2126: return "ProtoOAExecutionEvent"; // 下單結果
      case 2125: return "ProtoOAReconcileRes";
      case 2115: return "ProtoOASymbolsListRes";
      case 2138: return "ProtoOAGetTrendbarsRes"; // 補上歷史 K 棒的回傳解析代碼
      case 2117: return "ProtoOASymbolByIdRes";
      default: return null;
    }
  }

  //負責處理錯誤訊息的解碼工具 回推應該用哪個字典解碼
  private getErrorResponseTypeName(payloadType: number): string | null {
  switch (payloadType) {
    case 50:   return "ProtoErrorRes";
    case 2142: return "ProtoOAErrorRes";
    case 2132: return "ProtoOAOrderErrorEvent";
    default:   return null;
  }
}

  // ==========================================
  // 4. 優雅關門
  // ==========================================
  public close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}