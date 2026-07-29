// utils/ote-calculator.ts

export function calculateOteLimitPrice(trendbar: any, isBuy: boolean, oteLevel: number = 0.618): number {
  const lowRaw = Number(trendbar.low);
  const deltaHigh = Number(trendbar.deltaHigh);
  const highRaw = lowRaw + deltaHigh;

  let oteRawPrice;
  if (isBuy) {
    oteRawPrice = highRaw - (highRaw - lowRaw) * oteLevel;
  } else {
    oteRawPrice = lowRaw + (highRaw - lowRaw) * oteLevel;
  }

  // 1. 先轉換回 cTrader 的真實價格 (這時候可能會有 5 位小數)
  const realPrice = Math.round(oteRawPrice) / 100000;

  // 2. 針對 NAS100 這種只吃 2 位小數的商品，強制鎖死小數位數
  return Number(realPrice.toFixed(2));
}