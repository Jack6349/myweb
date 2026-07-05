// 股利總管 模組：api — GAS 代理：股利歷史（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ── Google Apps Script 中間層 ──
// 負責轉發 TWSE API 請求，解決 file:// CORS 問題
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz8j18olygkPUIsqXEUptyrt7XwDQWEwOcoz81nrLvHCE3HJrDindFnCZ4344o4QT8N1w/exec';

async function fetchWithCORS(url) {
  if (location.protocol !== 'file:') {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  }
  // file:// → 透過 GAS 轉發（用於股票名稱查詢等）
  const gasRes = await fetch(GAS_URL + '?url=' + encodeURIComponent(url));
  if (!gasRes.ok) throw new Error('GAS HTTP ' + gasRes.status);
  const data = await gasRes.json();
  return { ok: true, json: async () => data };
}

// ── FETCH 股利歷史（Yahoo Finance via GAS）──
// GAS 回傳格式：{ stat:'OK', code:'00900', dividends:[{date:unix, amount:0.5},...] }
// date = Unix timestamp（秒），為除息日
async function fetchStockDivHistory(code) {
  const cacheKey = 'yf_' + code;
  const cache = getDivCache();
  const now = Date.now();
  if (cache[cacheKey] && (now - cache[cacheKey].ts) < DIV_CACHE_TTL) {
    // 從 localStorage 讀回時 Date 物件變成字串，需重新轉換
    return cache[cacheKey].data.map(r => ({
      ...r, exDate: r.exDate ? new Date(r.exDate) : null
    }));
  }
  const gasTarget = GAS_URL + '?code=' + encodeURIComponent(code);
  // GAS 在多檔同時查詢的尖峰下偶發 404/429/5xx，重試數次（含退避）
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(gasTarget);
    if (res.ok) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res.ok) throw new Error('GAS HTTP ' + res.status);
  const json = await res.json();
  // 查無配息資料（如主動型 ETF）也要快取空結果，否則每次都重抓
  if (json.stat !== 'OK') {
    cache[cacheKey] = { ts: now, data: [] };
    setDivCache(cache);
    return [];
  }
  const divs = json.dividends || [];
  const result = divs.map(d => {
    const exDate = new Date(d.date * 1000);
    const y = exDate.getFullYear();
    const m = String(exDate.getMonth() + 1).padStart(2, '0');
    const dy = String(exDate.getDate()).padStart(2, '0');
    const payDate = d.payDate ? new Date(d.payDate * 1000) : null;
    return {
      exDateStr: y + '/' + m + '/' + dy,
      code,
      name: '',
      cashDiv: d.amount || 0,
      type: '息',
      exDate,
      payDate,
    };
  }).filter(r => r.cashDiv > 0);
  cache[cacheKey] = { ts: now, data: result };
  setDivCache(cache);
  return result;
}

// parseROCDate 已在 fetchTWT49U 上方定義

