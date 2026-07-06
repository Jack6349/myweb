// 股利總管 模組：estimate-value — 年度估算 / 當日損益 / 損益試算（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ══════════════ 股價快取（當日損益共用）══════════════
const PRICE_CACHE_KEY = 'price_cache_v2';
const PRICE_CACHE_TTL = 60 * 60 * 1000; // 1小時

// 今日日期字串（台灣時區），用於跨日強制失效
function todayStr() {
  var d = new Date();
  var tw = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return tw.getFullYear() + '-' + (tw.getMonth()+1) + '-' + tw.getDate();
}

function getPriceCache() {
  try { return JSON.parse(localStorage.getItem(PRICE_CACHE_KEY)) || {}; }
  catch { return {}; }
}
function setPriceCache(data) { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(data)); }

// 台股是否正在盤中（台灣時間 週一~五 09:00–13:35；不含國定假日，假日 API 會回前一交易日、屬無害重抓一次）
function isTwMarketOpen() {
  var tw = new Date(Date.now() + 8 * 3600000); // 以 UTC+8 檢視
  var dow = tw.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  var hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return hm >= 9 * 60 && hm < 13 * 60 + 35;
}
// 最近一次「已收盤結算」時間（UTC ms）：最近一個已過的 台灣時間 週一~五 13:35(=05:35 UTC)
function lastSettleTs() {
  var now = Date.now();
  for (var back = 0; back < 8; back++) {
    var base = now - back * 86400000;
    var d = new Date(base);
    var settle = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5, 35, 0); // 該 UTC 日的 13:35 台灣
    var twDow = new Date(settle + 8 * 3600000).getUTCDay();
    if (twDow === 0 || twDow === 6) continue;
    if (settle <= now) return settle;
  }
  return 0;
}

// ══════════════ 年度可領估算 ══════════════
// 邏輯：
//   已領月份（Jan ~ 上月）→ 用 API 實際金額
//   未來月份（本月 ~ 12月）→ 若該月在配息月份內，用最近一次配息金額估算

// 從歷史資料偵測每年預期配息月份
function switchEstTab(tab) {
  ['month','stock','chart','records'].forEach(t => {
    document.getElementById('est-tab-' + t).classList.toggle('active', t === tab);
    document.getElementById('est-pane-' + t).classList.toggle('active', t === tab);
  });
}

// 除息日 → 入帳日（次月）
function exToPayDate(exDate) {
  if (!exDate) return null;
  const d = new Date(exDate.getTime());
  d.setMonth(d.getMonth() + 1);
  return d;
}

// 從歷史資料偵測預期入帳月份，並根據頻率推斷補全
function detectExpectedMonths(history) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 18);
  const monthSet = new Set();
  for (const rec of history) {
    if (rec.exDate && rec.exDate >= cutoff) {
      const payDate = exToPayDate(rec.exDate);
      if (payDate) monthSet.add(payDate.getMonth() + 1);
    }
  }
  const months = Array.from(monthSet).sort((a,b) => a-b);
  if (months.length === 0) return [];
  // 月配：偵測到 >= 6 個月，或相鄰差值都為 1 → 補全 1-12
  if (months.length >= 6) return Array.from({length:12},(_,i)=>i+1);
  // 季配：偵測到 3-5 個，相鄰差值接近 3 → 推斷完整季配月份
  if (months.length >= 3 && months.length <= 5) {
    const gaps = [];
    for (let i = 1; i < months.length; i++) gaps.push(months[i] - months[i-1]);
    const avgGap = gaps.reduce((s,g)=>s+g,0) / gaps.length;
    if (avgGap >= 2.5 && avgGap <= 3.5) {
      // 推算起始月，往前補、往後補
      const startMonth = months[0];
      const quarterly = [];
      for (let m = startMonth; m <= 12; m += 3) quarterly.push(m);
      // 若起始月不是1,2,3其中一個，往前補
      for (let m = startMonth - 3; m >= 1; m -= 3) quarterly.push(m);
      return quarterly.sort((a,b)=>a-b);
    }
  }
  return months;
}

// 取最近一次實際配息的每股金額
function getLatestCashDiv(history) {
  const recent = [...history].filter(r => r.exDate).sort((a,b) => b.exDate - a.exDate);
  return recent.length > 0 ? recent[0].cashDiv : 0;
}

// 全年某間隔（step 月）對齊錨點月，補滿 1-12 月
function monthsAtStep(step, anchor) {
  if (step === 1) return Array.from({ length: 12 }, (_, i) => i + 1);
  let start = anchor; while (start - step >= 1) start -= step;
  const months = []; for (let m = start; m <= 12; m += step) months.push(m);
  return months;
}

// 由配息歷史的除息日間隔推斷頻率（回傳 step 月數 1/3/6/12，或 null）。
// 比「月份數量」可靠：新上市 ETF 只有 2 筆連續月配，count 法會誤判成半年配，gap 法可正確判月配。
function inferStepFromHistory(history) {
  const ex = (history || []).filter(r => r.exDate).map(r => r.exDate).sort((a, b) => a - b);
  if (ex.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < ex.length; i++) {
    const g = (ex[i].getFullYear() - ex[i-1].getFullYear()) * 12 + (ex[i].getMonth() - ex[i-1].getMonth());
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  return med <= 1 ? 1 : (med <= 4 ? 3 : (med <= 8 ? 6 : 12));
}

// 全年配息月份（殖利率用，依頻率列出整年）。以歷史除息間隔優先（最準），錨點為最近一次入帳月；
// 無足夠歷史才回退持股設定 divMonths / divFreq；再不行回退歷史月份偵測。
function cadenceMonths(stock, history) {
  const histStep = inferStepFromHistory(history);
  if (histStep) {
    let anchor = 1;
    const s = history.filter(r => r.exDate).sort((a, b) => b.exDate - a.exDate);
    if (s.length) { const pd = exToPayDate(s[0].exDate); if (pd) anchor = pd.getMonth() + 1; }
    return monthsAtStep(histStep, anchor);
  }
  if (stock.divMonths) return parseDivMonths(stock.divMonths);
  const step = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[stock.divFreq || stock.divFreqType];
  if (!step) return detectExpectedMonths(history || []);
  return monthsAtStep(step, 6);
}

// 逐檔年度配息估算（已領實際＋未領用最近一次估算）。估算頁與當日損益卡片共用，確保數字一致。
// 回傳 { actualDivs, estDivs, total, latestDiv, annualPerShare, annualProjected } 或 null（不配息/無資料）。
//   total＝今年可領金額（含股數，給估算頁）；annualPerShare＝今年可領每股加總；
//   annualProjected＝全年逐月填補每股加總（殖利率用：全年每個配息月有實際用實際、無則用最近一次）。
function computeStockAnnual(stock, history, now) {
  now = now || new Date();
  const curYear = now.getFullYear();
  const curMonthIdx = now.getMonth();      // 0-based 本月
  const lastReceivedIdx = curMonthIdx - 1; // 0-based 上月（已入帳）
  const shares = parseFloat(stock.shares);
  const actualDivs = [], estDivs = [];
  let latestDiv = 0;

  if (stock.manualDiv && stock.manualDiv > 0) {
    // ── 手動設定 ──
    const freq = stock.divFreq || 'monthly';
    const allMonths = freq === 'monthly' ? Array.from({length:12},(_,i)=>i+1)
                    : freq === 'quarterly' ? [1,4,7,10] : [6];
    const months = stock.divMonths ? parseDivMonths(stock.divMonths) : allMonths;
    for (const m of months) {
      const totalDiv = Math.round(stock.manualDiv * shares * 1000 * 100) / 100;
      if (m - 1 <= lastReceivedIdx) actualDivs.push({ month: m, cashDiv: stock.manualDiv, totalDiv, count: 1 });
      else estDivs.push({ month: m, cashDiv: stock.manualDiv, totalDiv });
    }
    latestDiv = stock.manualDiv;
  } else {
    // ── API 歷史 ──
    if (stock.divFreqType === 'none') return null;
    if (!history || history.length === 0) return null;
    const actualMap = new Map();
    for (const rec of history) {
      if (!rec.exDate) continue;
      const payDate = exToPayDate(rec.exDate);
      if (!payDate) continue;
      if (payDate.getFullYear() !== curYear) continue;
      const pm = payDate.getMonth(); // 0-based 入帳月
      if (pm > lastReceivedIdx) continue;
      const totalDiv = Math.round(rec.cashDiv * shares * 1000 * 100) / 100;
      if (actualMap.has(pm)) {
        const ex = actualMap.get(pm);
        actualMap.set(pm, { month: pm+1, cashDiv: ex.cashDiv + rec.cashDiv,
          totalDiv: ex.totalDiv + totalDiv, count: ex.count + 1 });
      } else {
        actualMap.set(pm, { month: pm+1, cashDiv: rec.cashDiv, totalDiv, count: 1 });
      }
    }
    Array.from(actualMap.values()).sort((a,b) => a.month - b.month).forEach(d => actualDivs.push(d));
    const expectedMonths = stock.divMonths && stock.divFreqType !== 'none'
      ? parseDivMonths(stock.divMonths)
      : detectExpectedMonths(history);
    latestDiv = getLatestCashDiv(history);
    for (const m of expectedMonths) {
      if (m - 1 < curMonthIdx) continue; // 已入帳月份不再估算
      const totalDiv = Math.round(latestDiv * shares * 1000 * 100) / 100;
      estDivs.push({ month: m, cashDiv: latestDiv, totalDiv });
    }
    if (actualDivs.length === 0 && estDivs.length === 0) return null;
  }
  const total = [...actualDivs, ...estDivs].reduce((s,d) => s + d.totalDiv, 0);
  const annualPerShare = [...actualDivs, ...estDivs].reduce((s,d) => s + d.cashDiv, 0);

  // 全年逐月填補（殖利率用）：依頻率列出全年配息月，每月有今年實際用實際、否則用最近一次
  let annualProjected = 0;
  const cad = cadenceMonths(stock, history);
  if (cad.length) {
    const actualByMonth = {};
    (history || []).forEach(rec => {
      if (!rec.exDate) return;
      const pd = exToPayDate(rec.exDate);
      if (!pd || pd.getFullYear() !== curYear) return;
      const m = pd.getMonth() + 1;
      actualByMonth[m] = (actualByMonth[m] || 0) + rec.cashDiv;
    });
    const fill = (stock.manualDiv && stock.manualDiv > 0) ? stock.manualDiv : latestDiv;
    cad.forEach(m => { annualProjected += (actualByMonth[m] != null ? actualByMonth[m] : fill); });
  }

  // 最近兩次配息差距（殖利率失真警示）：|最近 − 前次| / 前次 × 100 > 10% → 標記
  let lastTwoDiffPct = null, divWarn = false;
  if (history && history.length >= 2) {
    const sd = history.filter(r => r.exDate && r.cashDiv > 0).sort((a, b) => b.exDate - a.exDate);
    if (sd.length >= 2 && sd[1].cashDiv > 0) {
      lastTwoDiffPct = Math.abs(sd[0].cashDiv - sd[1].cashDiv) / sd[1].cashDiv * 100;
      divWarn = lastTwoDiffPct > 10;
    }
  }

  return { actualDivs, estDivs, total, latestDiv, annualPerShare, annualProjected, divWarn, lastTwoDiffPct };
}

async function loadEstDividends(forceRefresh) {
  if (portfolio.length === 0) {
    document.getElementById('est-result').innerHTML =
      '<div class="div-no-portfolio"><div style="font-size:40px;margin-bottom:12px;opacity:.5">📋</div>' +
      '<div style="font-size:16px;color:var(--text2)">尚未建立持股資料</div>' +
      '<div style="font-size:13px;color:var(--text3);margin-top:6px">請先至「持股」頁面新增持股</div></div>';
    return;
  }

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonthIdx = now.getMonth(); // 0-based，本月
  const lastReceivedIdx = curMonthIdx - 1; // 0-based，上月（已入帳）

  document.getElementById('est-label').textContent =
    curYear + ' 年全年估算（1 月～12 月）';

  const loading = document.getElementById('est-loading');
  const stickyEl = document.getElementById('est-total-sticky');
  const refreshBtn = document.getElementById('est-refresh-btn');
  const loadingText = document.querySelector('#est-loading .loading-text');

  if (forceRefresh) {
    const cache = getDivCache();
    portfolio.forEach(s => delete cache['yf_' + s.code]);
    setDivCache(cache);
  }

  const isHomeRefreshEst = document.getElementById('screen-home').classList.contains('active');
  if (!isHomeRefreshEst) {
    loading.style.display = 'block';
    const mp = document.getElementById('est-pane-month');
    const sp = document.getElementById('est-pane-stock');
    const cp = document.getElementById('est-pane-chart');
    if (mp) mp.innerHTML = '';
    if (sp) sp.innerHTML = '';
    if (cp) cp.innerHTML = '';
    if (stickyEl) stickyEl.style.display = 'none';
    refreshBtn.classList.add('spinning');
  }

  try {
    const stockResults = [];
    const monthActualCodes = Array.from({length:12}, () => []);
    const monthEstCodes    = Array.from({length:12}, () => []);

    for (let i = 0; i < portfolio.length; i++) {
      const stock = portfolio[i];
      if (loadingText) loadingText.textContent =
        '查詢中 (' + (i+1) + '/' + portfolio.length + ')：' + (stock.name || stock.code);

      // 手動設定免查歷史；其餘走 API（不配息跳過）
      let history = null;
      if (!(stock.manualDiv && stock.manualDiv > 0)) {
        if (stock.divFreqType === 'none') continue;
        try {
          history = await fetchStockDivHistory(stock.code);
        } catch(e) {
          console.warn('[EST]', stock.code, e.message);
          continue;
        }
      }

      const res = computeStockAnnual(stock, history, now);
      if (!res) continue;

      res.actualDivs.forEach(d => { if (!monthActualCodes[d.month-1].includes(stock.code)) monthActualCodes[d.month-1].push(stock.code); });
      res.estDivs.forEach(d => { if (!monthEstCodes[d.month-1].includes(stock.code)) monthEstCodes[d.month-1].push(stock.code); });
      stockResults.push({ stock, actualDivs: res.actualDivs, estDivs: res.estDivs, total: res.total, latestDiv: res.latestDiv, history: history });
    }

    stockResults.sort((a,b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, {numeric:true}));
    const actualTotal = stockResults.reduce((s,r) =>
      s + r.actualDivs.reduce((ss,d) => ss + d.totalDiv, 0), 0);
    const estTotal = stockResults.reduce((s,r) =>
      s + r.estDivs.reduce((ss,d) => ss + d.totalDiv, 0), 0);
    const grandTotal = actualTotal + estTotal;

    loading.style.display = 'none';
    renderEstResult(stockResults, grandTotal, actualTotal, estTotal, curYear, curMonthIdx, monthActualCodes, monthEstCodes);
    renderRecordsTab(stockResults);
  } catch(err) {
    loading.style.display = 'none';
    const ep = document.getElementById('est-pane-month');
    if (ep) ep.innerHTML = '<div class="div-empty"><div class="div-empty-icon">⚠</div>' +
      '<div style="color:var(--danger)">' + err.message + '</div>' +
      '<button class="btn-primary" style="margin-top:16px;max-width:200px" onclick="loadEstDividends(true)">重試</button></div>';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

function renderEstResult(stockResults, grandTotal, actualTotal, estTotal, year, curMonthIdx, monthActualCodes, monthEstCodes) {
  const monthPane = document.getElementById('est-pane-month');
  const stockPane = document.getElementById('est-pane-stock');
  const stickyEl = document.getElementById('est-total-sticky');

  // 合計列（精簡單行，保留捲動空間）
  if (stickyEl) {
    stickyEl.style.display = 'block';
    const monthlyAvg = Math.round(grandTotal / 12);
    stickyEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px 6px;border-bottom:1px solid var(--border)">' +
      '<div>' +
        '<div style="font-size:10px;color:var(--text3)">' + year + ' 年估算</div>' +
        '<div style="font-size:18px;font-weight:700;color:var(--accent)">$ ' + Math.round(grandTotal).toLocaleString('zh-TW') + '<span style="font-size:12px;font-weight:400;color:var(--text2)"> 元</span></div>' +
      '</div>' +
      '<div style="display:flex;gap:16px;text-align:right">' +
        '<div><div style="font-size:10px;color:var(--success)">已入帳</div><div style="font-size:13px;font-weight:600;color:var(--success)">$ ' + Math.round(actualTotal).toLocaleString('zh-TW') + '</div></div>' +
        '<div><div style="font-size:10px;color:var(--accent2)">月均</div><div style="font-size:13px;font-weight:600;color:var(--accent2)">$ ' + monthlyAvg.toLocaleString('zh-TW') + '</div></div>' +
      '</div>' +
      '</div>';
  }

  if (stockResults.length === 0) {
    const emptyHtml = '<div class="div-empty"><div class="div-empty-icon" style="font-size:40px">💰</div>' +
      '<div style="font-size:16px;color:var(--text2)">無估算資料</div></div>';
    monthPane.innerHTML = emptyHtml;
    stockPane.innerHTML = emptyHtml;
    return;
  }

  // ── Tab 1：月份總覽 ──
  // 彙總每月全投資組合的已領 + 估算
  const monthActual = new Array(12).fill(0);
  const monthEst = new Array(12).fill(0);
  for (const { actualDivs, estDivs } of stockResults) {
    for (const d of actualDivs) monthActual[d.month - 1] += d.totalDiv;
    for (const d of estDivs)   monthEst[d.month - 1]   += d.totalDiv;
  }
  const maxAmount = Math.max(...monthActual.map((a,i) => a + monthEst[i]), 1);

  let monthHtml = '<div class="month-grid">';
  for (let m = 0; m < 12; m++) {
    const actual = monthActual[m];
    const est    = monthEst[m];
    const total  = actual + est;
    const isPast = m < curMonthIdx;    // 已過月份
    const isCur  = m === curMonthIdx;  // 本月
    const hasDividend = total > 0;

    let rowClass = 'month-row';
    let barClass, tagLabel, tagClass, amountColor;

    if (actual > 0) {
      rowClass += ' received';
      barClass = 'received'; tagLabel = '已領'; tagClass = 'received';
      amountColor = 'var(--success)';
    } else if (est > 0) {
      rowClass += ' estimated';
      barClass = 'estimated'; tagLabel = '估算'; tagClass = 'estimated';
      amountColor = 'var(--accent2)';
    } else {
      rowClass += ' empty';
      barClass = ''; tagLabel = ''; tagClass = '';
      amountColor = 'var(--text3)';
    }

    const barWidth = hasDividend ? Math.max(4, Math.round((total / maxAmount) * 100)) : 0;
    const amountStr = hasDividend ? '$ ' + Math.round(total).toLocaleString('zh-TW') : '—';

    const codes = [...(monthActualCodes[m]||[]), ...(monthEstCodes[m]||[])];
    const uniqueCodes = [...new Set(codes)];
    const codesStr = uniqueCodes.length > 0 ? uniqueCodes.join(', ') : '';
    monthHtml += '<div class="' + rowClass + '">' +
      '<div class="month-label">' + (m+1) + '月</div>' +
      '<div class="month-bar-wrap">' +
        (hasDividend ? '<div class="month-bar ' + barClass + '" style="width:' + barWidth + '%"></div>' : '') +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:2px">' +
        (tagLabel ? '<span class="month-tag ' + tagClass + '">' + tagLabel + '</span>' : '') +
        (codesStr ? '<span style="font-size:11px;color:var(--text3)">' + codesStr + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="month-amount" style="color:' + amountColor + '">' + amountStr + '</div>' +
      '</div>';
  }
  monthHtml += '</div>';
  monthPane.innerHTML = monthHtml;

  // ── Tab 2：個股明細 ──
  let html = '<div class="div-section-title" style="margin-top:12px">個股明細</div>';

  for (const { stock, actualDivs, estDivs, total, latestDiv } of stockResults) {
    const isManual = stock.manualDiv && stock.manualDiv > 0;
    const manualTag = isManual ? '<span class="manual-badge">手動</span>' : '';

    const actualMonthStr = actualDivs.length > 0
      ? actualDivs.map(d => d.month + (d.count > 1 ? '(' + d.count + ')' : '')).join(', ') + ' 月'
      : '—';
    const estMonthStr = estDivs.length > 0
      ? estDivs.map(d => d.month).join(', ') + ' 月'
      : '—';

    const stockActual = actualDivs.reduce((s,d) => s + d.totalDiv, 0);
    const stockEst = estDivs.reduce((s,d) => s + d.totalDiv, 0);

    html += '<div class="div-row">' +
      '<div class="div-row-top">' +
      '<div>' +
        '<div class="div-row-name">' + stock.code + manualTag + '</div>' +
        '<div class="div-row-code">' + (stock.name || stock.code) +
          ' <span style="font-size:11px;color:var(--text3)">每股 $' + (latestDiv||0).toFixed(4) + '</span></div>' +
      '</div>' +
      '</div>' +
      '<div class="div-row-meta">' +
      '<div class="div-meta-item" style="grid-column:span 2">' +
        '<div class="div-meta-label">已入帳月份</div>' +
        '<div class="div-meta-val" style="color:var(--success)">' + actualMonthStr + '</div>' +
      '</div>' +
      '<div class="div-meta-item"><div class="div-meta-label">已入帳</div>' +
        '<div class="div-meta-val" style="color:var(--success)">$ ' + Math.round(stockActual).toLocaleString('zh-TW') + '</div></div>' +
      '<div class="div-meta-item" style="grid-column:span 2">' +
        '<div class="div-meta-label">估算月份</div>' +
        '<div class="div-meta-val" style="color:var(--accent)">' + estMonthStr + '</div>' +
      '</div>' +
      '<div class="div-meta-item accent"><div class="div-meta-label">估算剩餘</div>' +
        '<div class="div-meta-val gold">$ ' + Math.round(stockEst).toLocaleString('zh-TW') + '</div></div>' +
      '</div></div>';
  }

  html += '<div class="api-note">估算月份以最近一次配息金額 × 預期月份計算，僅供參考。</div>';
  stockPane.innerHTML = html;

  // ── Tab 3：水平橫條圖 ──
  const chartPane = document.getElementById('est-pane-chart');
  if (!chartPane) return;

  const PAD = { top:8, right:48, bottom:36, left:36 };
  const ROW_H = 18;
  const ROW_GAP = 8;
  const containerW = chartPane.clientWidth || (window.innerWidth - 32);
  const W = containerW;
  const chartH = 12 * ROW_H + 11 * ROW_GAP;
  const H = chartH + PAD.top + PAD.bottom;
  const chartW = W - PAD.left - PAD.right;

  const maxVal = Math.max(...monthActual.map((a,i) => a + monthEst[i]), 1);
  // X-axis nice scale
  const xMax = Math.ceil(maxVal / 10000) * 10000 || 10000;
  const xTicks = 4;

  let svgParts = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;overflow:visible">`];

  // X gridlines + labels (沿底部)
  const yBottom = PAD.top + chartH;
  for (let t = 0; t <= xTicks; t++) {
    const val = Math.round(xMax * t / xTicks);
    const x = PAD.left + Math.round((val / xMax) * chartW);
    const label = val >= 10000 ? (val/10000).toFixed(0) + '萬' : val.toLocaleString();
    svgParts.push(`<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${yBottom}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`);
    svgParts.push(`<text x="${x}" y="${yBottom + 14}" text-anchor="middle" font-size="10" fill="rgba(143,163,184,0.8)">${label}</text>`);
  }

  // Bars + 月份標籤
  for (let m = 0; m < 12; m++) {
    const actual = monthActual[m];
    const est = monthEst[m];
    const total = actual + est;
    const y = PAD.top + m * (ROW_H + ROW_GAP);

    const wActual = actual > 0 ? Math.max(2, Math.round((actual / xMax) * chartW)) : 0;
    const wEst    = est > 0    ? Math.max(2, Math.round((est    / xMax) * chartW)) : 0;
    const wTotal  = wActual + wEst;

    if (wActual > 0) {
      svgParts.push(`<rect x="${PAD.left}" y="${y}" width="${wActual}" height="${ROW_H}" rx="${wEst > 0 ? 0 : 3}" fill="#4caf82"/>`);
    }
    if (wEst > 0) {
      svgParts.push(`<rect x="${PAD.left + wActual}" y="${y}" width="${wEst}" height="${ROW_H}" rx="3" fill="#f0cc7a" opacity="0.85"/>`);
      if (wActual > 0) {
        svgParts.push(`<rect x="${PAD.left + wActual}" y="${y}" width="2" height="${ROW_H}" fill="#4caf82"/>`);
      }
    }

    // 月份標籤（左側）
    svgParts.push(`<text x="${PAD.left - 6}" y="${y + ROW_H/2 + 4}" text-anchor="end" font-size="11" fill="rgba(143,163,184,0.9)">${m+1}月</text>`);

    // 金額標籤（條右側）
    if (total > 0) {
      const labelVal = total >= 10000 ? (total/10000).toFixed(1) + '萬' : Math.round(total).toLocaleString();
      svgParts.push(`<text x="${PAD.left + wTotal + 5}" y="${y + ROW_H/2 + 4}" text-anchor="start" font-size="10" fill="rgba(238,242,247,0.7)">${labelVal}</text>`);
    }
  }

  // Y axis line
  svgParts.push(`<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${yBottom}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`);

  // Legend
  const ly = H - 6;
  svgParts.push(`<rect x="${PAD.left}" y="${ly - 8}" width="10" height="10" rx="2" fill="#4caf82"/>`);
  svgParts.push(`<text x="${PAD.left + 14}" y="${ly}" font-size="11" fill="rgba(143,163,184,0.9)">已入帳</text>`);
  svgParts.push(`<rect x="${PAD.left + 68}" y="${ly - 8}" width="10" height="10" rx="2" fill="#f0cc7a"/>`);
  svgParts.push(`<text x="${PAD.left + 82}" y="${ly}" font-size="11" fill="rgba(143,163,184,0.9)">估算</text>`);

  svgParts.push('</svg>');

  chartPane.innerHTML = '<div style="padding:16px 8px 8px">' + svgParts.join('') + '</div>' +
    '<div class="api-note" style="margin:0 16px 16px">估算月份以最近一次配息金額計算，僅供參考。</div>';
  // 更新首頁
  const estEl = document.getElementById('home-est');
  if (estEl) estEl.innerHTML = Math.round(grandTotal).toLocaleString('zh-TW') + '<span style="font-size:10px;color:var(--text2);margin-left:1px;">元</span>';
  var _ce=document.getElementById('card-est'); if(_ce) _ce.innerHTML=Math.round(grandTotal).toLocaleString('zh-TW')+'<span style="font-size:11px;font-weight:400;margin-left:2px">元</span>';
}

// ── Tab 4：配息紀錄（依頻率取最近 N 筆，左右兩欄，左欄較舊／右欄較新）──
function recordCountForStock(stock, hist) {
  const freqMap = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1 };
  if (stock.divFreqType && freqMap[stock.divFreqType] != null) return freqMap[stock.divFreqType];
  const step = inferStepFromHistory(hist);
  const stepMap = { 1: 12, 3: 4, 6: 2, 12: 1 };
  return stepMap[step] || 4;
}

async function renderRecordsTab(stockResults) {
  const pane = document.getElementById('est-pane-records');
  if (!pane) return;

  const withHistory = stockResults.filter(r => r.history && r.history.some(h => h.exDate));
  if (withHistory.length === 0) {
    pane.innerHTML = '<div class="div-empty"><div class="div-empty-icon" style="font-size:40px">💰</div>' +
      '<div style="font-size:16px;color:var(--text2)">無配息紀錄</div></div>';
    return;
  }

  let html = '<div class="div-section-title" style="margin-top:12px">配息紀錄</div>';
  for (const r of withHistory) {
    const stock = r.stock;
    const hist = r.history.filter(h => h.exDate).sort((a, b) => a.exDate - b.exDate);
    const count = recordCountForStock(stock, hist);
    const recent = hist.slice(-count).reverse(); // 最近一期在前，往後排
    const half = Math.ceil(recent.length / 2);
    const left = recent.slice(0, half);
    const right = recent.slice(half);
    const cost = parseFloat(stock.cost);
    const shares = parseFloat(stock.shares);
    const avgCost = (!isNaN(cost) && cost > 0 && !isNaN(shares) && shares > 0) ? cost / (shares * 1000) : null;
    const curYear = new Date().getFullYear();
    const annualCashDiv = hist.filter(h => h.exDate.getFullYear() === curYear)
      .reduce((s, h) => s + h.cashDiv, 0);
    const annualPct = avgCost ? (annualCashDiv / avgCost * 100) : null;

    const entryHtml = h => {
      const yld = avgCost ? (h.cashDiv / avgCost * 100) : null;
      return '<div style="display:flex;justify-content:space-between;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">' +
        '<span style="color:var(--text3)">' + h.exDateStr + '</span>' +
        '<span style="color:var(--text2)">$' + h.cashDiv.toFixed(3) + '</span>' +
        '<span style="color:var(--accent2)">' + (yld != null ? yld.toFixed(2) + '%' : '—') + '</span>' +
        '</div>';
    };

    html += '<div class="div-row">' +
      '<div class="div-row-top" style="display:flex;justify-content:space-between;align-items:baseline">' +
        '<div><div class="div-row-name">' + stock.code + ' <span class="div-row-code" style="font-weight:400">' + (stock.name || stock.code) + '</span></div></div>' +
        '<div style="font-size:13px;font-weight:700;color:var(--accent2);white-space:nowrap">' + (annualPct != null ? curYear + ' 年累積 ' + annualPct.toFixed(2) + '%' : '—') + '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:8px">' +
        '<div>' + left.map(entryHtml).join('') + '</div>' +
        '<div>' + right.map(entryHtml).join('') + '</div>' +
      '</div></div>';
  }
  html += '<div class="api-note">殖利率＝該筆配息金額 ÷ 該股平均成本（未填成本者顯示 —），僅供單次配息參考，非年化值。</div>';
  pane.innerHTML = html;
}

// ══════════════ 當日股票損益 ══════════════
async function fetchStockPrice(code) {
  const cache = getPriceCache();
  const now = Date.now();
  const today = todayStr();
  const c = cache[code];
  if (c) {
    if (!isTwMarketOpen()) {
      // 非盤中（收盤後/盤前/週末/假日）：股價不再變動；只要快取是在最近一次收盤結算之後抓的，
      // 代表已握有最新收盤價，直接沿用（跨日也適用），不重複呼叫 API
      if (c.ts >= lastSettleTs()) return c.data;
    } else {
      // 盤中：價格會變動，沿用同日 + TTL 週期更新
      if (c.day === today && (now - c.ts) < PRICE_CACHE_TTL) return c.data;
    }
  }
  const res = await fetch(GAS_URL + '?price=' + encodeURIComponent(code));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const raw = await res.json();
  const norm = normalizePriceResp(raw);
  if (!norm) throw new Error('查無股價');
  cache[code] = { ts: now, day: today, data: norm };
  setPriceCache(cache);
  return norm;
}

// 相容 GAS 正式格式(stat:OK,price,prevClose)與診斷格式(stat:DEBUG,regularMarketPrice/rows)
// 注意：chartPreviousClose 是「整段範圍前」的基準（非昨收），不可拿來算漲跌；
//       昨收要取 rows 倒數第二天的收盤（前一交易日）。
function normalizePriceResp(j) {
  if (!j) return null;
  var rows = (j.rows && j.rows.length) ? j.rows : null;
  // rows 內偶有 close:null（當天資料尚未寫入），往前找最近一筆有效收盤
  var lastIdx = -1;
  if (rows) {
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].close != null) { lastIdx = i; break; }
    }
  }
  var price = (j.price != null) ? j.price
    : (j.regularMarketPrice != null ? j.regularMarketPrice
    : (lastIdx >= 0 ? rows[lastIdx].close : null));
  if (price == null) return null;
  var prevClose = null;
  if (j.prevClose != null) {
    prevClose = j.prevClose;
  } else if (rows && lastIdx > 0) {
    for (var k = lastIdx - 1; k >= 0; k--) {
      if (rows[k].close != null) { prevClose = rows[k].close; break; }
    }
  }
  var date = j.date || (lastIdx >= 0 ? rows[lastIdx].date : '');
  var change = null, changePct = null;
  if (prevClose != null && prevClose !== 0) {
    change = Math.round((price - prevClose) * 100) / 100;
    changePct = Math.round((price - prevClose) / prevClose * 10000) / 100;
  }
  return { stat: 'OK', code: j.code, price: price, date: date, change: change, changePct: changePct, prevClose: prevClose };
}

function getLatestExDate(code) {
  const cache = getDivCache();
  const key = 'yf_' + code;
  if (!cache[key]) return null;
  const history = cache[key].data || [];
  if (history.length === 0) return null;
  const sorted = [...history].filter(r => r.exDateStr).sort((a,b) => {
    const da = new Date(a.exDate || 0), db = new Date(b.exDate || 0);
    return db - da;
  });
  return sorted.length > 0 ? sorted[0].exDateStr : null;
}

async function loadStockValue(forceRefresh) {
  if (portfolio.length === 0) {
    document.getElementById('value-result').innerHTML =
      '<div class="div-no-portfolio"><div style="font-size:40px;margin-bottom:12px;opacity:.5">📋</div>' +
      '<div style="font-size:16px;color:var(--text2)">尚未建立持股資料</div></div>';
    return;
  }
  const loading = document.getElementById('value-loading');
  const resultEl = document.getElementById('value-result');
  const stickyEl = document.getElementById('value-total-sticky');
  const refreshBtn = document.getElementById('value-refresh-btn');
  const loadingText = document.querySelector('#value-loading .loading-text');

  if (forceRefresh) {
    const cache = getPriceCache();
    portfolio.forEach(s => delete cache[s.code]);
    setPriceCache(cache);
  }

  loading.style.display = 'block';
  resultEl.innerHTML = '';
  if (stickyEl) stickyEl.style.display = 'none';
  refreshBtn.classList.add('spinning');

  try {
    const rows = [];
    let latestDate = '';
    for (let i = 0; i < portfolio.length; i++) {
      const stock = portfolio[i];
      if (loadingText) loadingText.textContent = '查詢中 (' + (i+1) + '/' + portfolio.length + ')：' + (stock.name || stock.code);
      try {
        const priceData = await fetchStockPrice(stock.code);
        const shares = parseFloat(stock.shares);
        const price = priceData.price;
        const totalValue = Math.round(price * shares * 1000);
        if (priceData.date && priceData.date > latestDate) latestDate = priceData.date;
        // 最近除息日從快取取
        const latestExDate = getLatestExDate(stock.code);
        // 預估年殖利率：年度可領估算（已領＋未領用最近一次）每股加總 ÷ 收盤價
        let estYield = null, divWarn = false, divDiffPct = null;
        if (stock.divFreqType !== 'none' && price > 0) {
          try {
            const hist = (stock.manualDiv && stock.manualDiv > 0) ? null : await fetchStockDivHistory(stock.code);
            const annual = computeStockAnnual(stock, hist, new Date());
            if (annual && annual.annualProjected > 0) {
              estYield = annual.annualProjected / price * 100;
              divWarn = annual.divWarn; divDiffPct = annual.lastTwoDiffPct;
            }
          } catch(e) { /* 配息查詢失敗不影響股價顯示 */ }
        }
        rows.push({ stock, price, totalValue, date: priceData.date, latestExDate, change: priceData.change, changePct: priceData.changePct, estYield, divWarn, divDiffPct });
      } catch(e) {
        rows.push({ stock, price: null, totalValue: null, date: null, latestExDate: null, error: e.message, estYield: null });
      }
    }

    rows.sort((a,b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, {numeric:true}));
    const grandTotal = rows.reduce((s,r) => s + (r.totalValue||0), 0);
    var _cv=document.getElementById('card-value'); if(_cv) _cv.innerHTML='$ '+Math.round(grandTotal*0.997735).toLocaleString('zh-TW')+'<span style="font-size:11px;font-weight:400;margin-left:2px">元</span>';

    // 逐檔成本填寫進度提示（P1）
    var _costFilled = countCostFilled(), _costN = (typeof portfolio !== 'undefined' ? portfolio.length : 0);
    var costHint = _costFilled === 0
      ? '沿用舊總成本，可在各持股編輯填入'
      : (_costFilled < _costN ? '各持股成本加總（已填 ' + _costFilled + '/' + _costN + ' 檔）' : '各持股成本加總');

    try { await ensureNavMap(); } catch (e) { /* 淨值非必要（每日快取），失敗就不顯示折溢價 */ }

    loading.style.display = 'none';
    const pnlCol = (v) => v > 0 ? '#ff5252' : (v < 0 ? '#26d962' : 'var(--text3)');
    const fmtN = (n) => Math.round(n).toLocaleString('zh-TW');

    if (stickyEl) {
      const afterTax = Math.round(grandTotal * 0.997735);
      const tcost = getTotalCost();
      const tprofit = tcost ? afterTax - tcost : null;
      const tprate = tcost ? tprofit / tcost * 100 : null;
      stickyEl.style.display = 'block';
      stickyEl.innerHTML = '<div class="div-total-card" style="margin-bottom:0;padding:12px 14px">' +
        '<div style="display:flex;justify-content:flex-end;margin-bottom:6px">' +
          '<button id="value-toggle-all" onclick="toggleAllValueRows(this)" style="background:rgba(240,204,122,.12);border:1px solid rgba(240,204,122,.35);color:var(--accent2);font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer;font-family:var(--font)">全部展開</button>' +
        '</div>' +
        '<div style="display:flex;align-items:flex-start;gap:10px">' +
          '<div style="flex:1;min-width:0">' +
            '<div class="div-total-label" style="font-size:11px">持股總現值</div>' +
            '<div style="font-size:18px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;color:var(--accent2)">$' + grandTotal.toLocaleString('zh-TW') + '</div>' +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="div-total-label" style="color:#8ab4d4;font-size:11px">含稅費現值</div>' +
            '<div style="font-size:18px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;color:#8ab4d4">$' + afterTax.toLocaleString('zh-TW') + '</div>' +
          '</div>' +
        '</div>' +
        '<div id="value-top-fold" class="vtop-fold">' +
          '<div class="vtop-row"><span class="vtop-label">總付出成本</span>' +
            '<span class="vtop-val" style="color:#f5d87a">' + (tcost ? '$' + tcost.toLocaleString('zh-TW') : '—') + '</span></div>' +
          '<div style="font-size:10px;color:var(--text3);text-align:right;margin:-3px 0 6px">' + costHint + '</div>' +
          '<div class="vtop-row"><span class="vtop-label">損益試算</span>' +
            '<span class="vtop-val" style="color:' + (tprofit == null ? 'var(--text3)' : pnlCol(tprofit)) + '">' +
            (tprofit == null ? '—' : (tprofit >= 0 ? '+' : '') + tprofit.toLocaleString('zh-TW') + ' 元') + '</span></div>' +
          '<div class="vtop-row"><span class="vtop-label">獲利率</span>' +
            '<span class="vtop-val" style="color:' + (tprate == null ? 'var(--text3)' : pnlCol(tprate)) + '">' +
            (tprate == null ? '—' : (tprate > 0 ? '+' : '') + tprate.toFixed(2) + '%') + '</span></div>' +
        '</div>' +
        '<div class="div-total-count">共 ' + rows.length + ' 支持股｜' +
        (latestDate ? '收盤日 ' + latestDate : '') + '</div>' +
        '</div>';
    }
    document.getElementById('value-date-label').textContent = latestDate ? '收盤日：' + latestDate : '';
    const vrow = (label, valHtml) => '<div class="vfold-row"><span class="vfold-label">' + label + '</span>' + valHtml + '</div>';

    let cards = '';
    rows.forEach((r, idx) => {
      const rowIdx = Math.floor(idx / 2);
      const hasData = r.price != null;
      // 漲停/跌停（台股上下限 ±10%）：整張卡片套色，漲停紅底、跌停綠底、白字
      const isLimitUp = hasData && r.changePct != null && r.changePct >= 9.9;
      const isLimitDown = hasData && r.changePct != null && r.changePct <= -9.9;
      const isLimit = isLimitUp || isLimitDown;
      const limitClass = isLimitUp ? ' limit-up' : (isLimitDown ? ' limit-down' : '');
      const priceCol = isLimit ? '#fff'
        : (hasData && r.change > 0) ? '#ff5252' : ((hasData && r.change < 0) ? '#26d962' : 'var(--text)');

      // 漲跌（與現價同色，常駐顯示）
      let chgTxt = '';
      if (hasData && r.change != null) {
        const arrow = r.change > 0 ? '▲' : (r.change < 0 ? '▼' : '—');
        chgTxt = arrow + ' ' + (r.change > 0 ? '+' : '') + r.change.toFixed(2) +
          '　' + (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2) + '%';
      }

      // 折/溢價（僅 ETF 有淨值）
      const nav = getEtfNav(r.stock.code);
      let premVal = '<span class="vfold-val" style="color:var(--text3)">—</span>';
      if (nav && hasData) {
        const prem = Math.round((r.price - nav.nav) / nav.nav * 10000) / 100;
        const plabel = prem > 0 ? '溢價 ' : (prem < 0 ? '折價 ' : '');
        premVal = '<span class="vfold-val" style="color:' + pnlCol(prem) + '">' + plabel + (prem > 0 ? '+' : '') + prem.toFixed(2) + '%</span>';
      }

      // 成本 / 獲利
      const cost = parseFloat(r.stock.cost);
      const hasCost = !isNaN(cost) && cost > 0;
      let profit = null, prate = null;
      if (hasCost && hasData) { profit = Math.round(r.totalValue * 0.997735) - cost; prate = profit / cost * 100; }

      // 成本均價 = 成本 / 持有股數（股數＝張數×1000）
      const shares = parseFloat(r.stock.shares);
      const avgCost = (hasCost && !isNaN(shares) && shares > 0) ? cost / (shares * 1000) : null;

      // 持有張數（零股以小數表示，整張不顯示多餘的 0）
      const sharesStr = (!isNaN(shares) && shares > 0)
        ? shares.toFixed(3).replace(/\.?0+$/, '') : null;

      const dash = '<span class="vfold-val" style="color:var(--text3)">—</span>';
      const sharesVal = sharesStr == null ? dash
        : '<span class="vfold-val" style="color:var(--text)">' + sharesStr + ' 張</span>';
      const costVal = hasCost ? '<span class="vfold-val" style="color:var(--accent2)">$' + fmtN(cost) + '</span>' : dash;
      const avgCostVal = avgCost == null ? dash
        : '<span class="vfold-val" style="color:var(--accent2)">$' + avgCost.toFixed(2) + '</span>';
      const valueVal = hasData ? '<span class="vfold-val" style="color:#8ab4d4">$' + fmtN(r.totalValue) + '</span>' : dash;
      const profitVal = profit == null ? dash
        : '<span class="vfold-val" style="color:' + pnlCol(profit) + '">' + (profit < 0 ? '-$' : '+$') + fmtN(Math.abs(profit)) + '</span>';
      const prateVal = prate == null ? dash
        : '<span class="vfold-val" style="color:' + pnlCol(prate) + '">' + (prate > 0 ? '+' : '') + prate.toFixed(2) + '%</span>';

      const yieldHtml = (r.estYield != null)
        ? '<span class="vcard-yield"' + (r.divWarn ? ' title="最近兩次配息差距 ' + Math.round(r.divDiffPct) + '%，年估可能失真"' : '') + '>' +
          (r.divWarn ? '⚠️ ' : '') + '年估 ' + r.estYield.toFixed(2) + '%</span>' : '';
      const priceBlock = hasData
        ? '<div class="vcard-priceline"><span class="vcard-price" style="color:' + priceCol + '">' + r.price.toFixed(2) + '</span>' + yieldHtml + '</div>' +
          '<div class="vcard-chg" style="color:' + priceCol + '">' + (chgTxt || '&nbsp;') + '</div>'
        : '<div class="vcard-price" style="color:var(--text3);font-size:16px">查詢失敗</div>';

      // 卡片面板獲利：最下面一整行，獲利率(左)、獲利金額(右)；固定桃紅色。折疊區資料不變。
      const profitFace = (profit == null) ? '' :
        '<div class="vcard-pnlrow">' +
          '<span style="color:#ff1493">' + (prate > 0 ? '+' : '') + prate.toFixed(2) + '%</span>' +
          '<span style="color:#ff1493">' + (profit < 0 ? '-$' : '+$') + fmtN(Math.abs(profit)) + '</span>' +
        '</div>';

      cards += '<div class="vcard' + limitClass + '" data-row="' + rowIdx + '">' +
        '<div class="vcard-head"><span class="vcard-code">' + r.stock.code + '</span>' +
          '<span class="vcard-name">' + (r.stock.name || '') + '</span></div>' +
        priceBlock + profitFace +
        '<div class="vcard-fold" data-row="' + rowIdx + '">' +
          vrow('折/溢價', premVal) + vrow('持有張數', sharesVal) + vrow('成本', costVal) + vrow('成本均價', avgCostVal) + vrow('現值', valueVal) +
          vrow('獲利金額', profitVal) + vrow('獲利率', prateVal) +
        '</div>' +
        '<button class="vcard-chev" data-row="' + rowIdx + '" onclick="toggleValueRow(' + rowIdx + ')" aria-label="展開明細">▼</button>' +
      '</div>';
    });

    resultEl.innerHTML = rows.length
      ? '<div class="value-grid">' + cards + '</div>'
      : '<div class="div-empty">無資料</div>';
  } catch(err) {
    loading.style.display = 'none';
    resultEl.innerHTML = '<div class="div-empty"><div style="color:var(--danger)">' + err.message + '</div>' +
      '<button class="btn-primary" style="margin-top:16px;max-width:200px" onclick="loadStockValue(true)">重試</button></div>';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// ── PATCH showScreen to trigger month load ──
const _origShowScreen = showScreen;
showScreen = function(name) {
  _origShowScreen(name);
  if (name === 'etf-screener') { loadEtfCache(); }
  if (name === 'etf-new') { renderEtfNew(); }
  if (name === 'etf-zone') { console.log('[ETF] showing etf-zone screen'); }
  if (name === 'dividends-month') {
    loadMonthDividends(false);
  }
  if (name === 'dividends-ytd') {
    loadYtdDividends(false);
  }
  if (name === 'dividends-est') {
    loadEstDividends(false);
  }
  if (name === 'stock-value') {
    loadStockValue(false);
  }
};

// ── 持股損益試算 ──
var COST_KEY = 'stock_total_cost';

// 逐檔成本加總（P1）：任一持股填了 cost 就用各持股加總；都沒填則回退舊的單一總成本
function getTotalCost() {
  var sum = 0, filled = 0;
  if (typeof portfolio !== 'undefined' && Array.isArray(portfolio)) {
    portfolio.forEach(function (s) {
      var c = parseFloat(s.cost);
      if (!isNaN(c) && c > 0) { sum += c; filled++; }
    });
  }
  if (filled > 0) return Math.round(sum);
  return parseInt(localStorage.getItem(COST_KEY) || '0') || 0; // 回退舊單一總成本
}
// 已填成本的持股數（供損益頁顯示填寫進度）
function countCostFilled() {
  if (typeof portfolio === 'undefined' || !Array.isArray(portfolio)) return 0;
  return portfolio.filter(function (s) { return parseFloat(s.cost) > 0; }).length;
}

// ── ETF 淨值（折溢價用）：透過 GAS 既有 ?url= 代理抓 TWSE 全 ETF 淨值表，建代號→淨值對照 ──
var _etfNavMap = null, _etfNavDay = null;
function _navTodayStr() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
// 專用端點：GAS ?etfnav= 伺服器端重試＋解析，回 {stat:'OK', map:{CODE:{nav,price,premium,date}}}
async function _fetchNavViaEndpoint() {
  try {
    var res = await fetch(GAS_URL + '?etfnav=1');
    if (!res.ok) return null;
    var j = await res.json();
    if (j && j.stat === 'OK' && j.map && Object.keys(j.map).length) return j.map;
  } catch (e) {}
  return null; // 未部署或回失敗 → 交給回退
}

// 回退：直接經 ?url= 抓 all_etf.txt 解析（約半數回空，重試至多 5 次、不快取空表）
async function _fetchNavViaUrl() {
  var src = 'https://mis.twse.com.tw/stock/data/all_etf.txt';
  var map = {};
  for (var attempt = 0; attempt < 5 && Object.keys(map).length === 0; attempt++) {
    if (attempt > 0) await new Promise(function (rs) { setTimeout(rs, 400 + 300 * attempt); });
    try {
      var res = await fetch(GAS_URL + '?url=' + encodeURIComponent(src));
      if (!res.ok) continue;
      var data = await res.json();
      var insts = data.a1 || (Array.isArray(data) ? data : []);
      insts.forEach(function (inst) {
        (inst.msgArray || []).forEach(function (x) {
          if (!x.a) return;
          // 欄位：e=成交價(市價)、f=淨值、g=折溢價%(=(e-f)/f)、c=規模、i=日期
          var nav = parseFloat(x.f), prem = parseFloat(x.g), price = parseFloat(x.e);
          if (!isNaN(nav) && nav > 0) map[String(x.a).toUpperCase()] = {
            nav: nav, premium: isNaN(prem) ? null : prem, price: isNaN(price) ? null : price, date: x.i
          };
        });
      });
    } catch (e) { /* 重試 */ }
  }
  return map;
}

async function ensureNavMap(force) {
  var today = _navTodayStr();
  // 僅在「非空」時採用記憶體/localStorage 快取（避免沿用抖動回空的空表）
  if (!force && _etfNavMap && _etfNavDay === today && Object.keys(_etfNavMap).length) return _etfNavMap;
  if (!force) {
    try {
      var cached = JSON.parse(localStorage.getItem('etf_nav_map') || 'null');
      if (cached && cached.day === today && cached.map && Object.keys(cached.map).length) {
        _etfNavMap = cached.map; _etfNavDay = today; return _etfNavMap;
      }
    } catch (e) {}
  }
  // 優先走專用端點 ?etfnav=（GAS 伺服器端重試＋解析，穩定）；未部署或失敗再回退 ?url= 直抓解析
  var map = await _fetchNavViaEndpoint();
  if (!map || !Object.keys(map).length) map = await _fetchNavViaUrl();
  if (!map || Object.keys(map).length === 0) throw new Error('NAV 取得失敗');
  _etfNavMap = map; _etfNavDay = today;
  try { localStorage.setItem('etf_nav_map', JSON.stringify({ day: today, map: map })); } catch (e) {}
  return map;
}
function getEtfNav(code) { return (_etfNavMap && _etfNavMap[String(code).toUpperCase()]) || null; }

// 當日損益折疊：頂部合計卡與所有個股卡共用「全部展開/收合」；個股卡 ▼ 可同列左右單獨切換
function _allValueFolds() {
  var folds = Array.prototype.slice.call(document.querySelectorAll('#value-result .vcard-fold'));
  var topFold = document.getElementById('value-top-fold');
  if (topFold) folds.push(topFold);
  return folds;
}
function _syncValueMasterLabel() {
  var btn = document.getElementById('value-toggle-all');
  if (!btn) return;
  var folds = _allValueFolds();
  var anyClosed = folds.some(function (f) { return !f.classList.contains('open'); });
  btn.textContent = anyClosed ? '全部展開' : '全部收合';
}
function toggleValueRow(row) {
  var folds = document.querySelectorAll('#value-result .vcard-fold[data-row="' + row + '"]');
  if (!folds.length) return;
  var open = !folds[0].classList.contains('open');
  folds.forEach(function (f) { f.classList.toggle('open', open); });
  document.querySelectorAll('#value-result .vcard-chev[data-row="' + row + '"]').forEach(function (b) { b.textContent = open ? '▲' : '▼'; });
  _syncValueMasterLabel();
}
function toggleAllValueRows(btn) {
  var folds = _allValueFolds();
  if (!folds.length) return;
  var anyClosed = folds.some(function (f) { return !f.classList.contains('open'); });
  folds.forEach(function (f) { f.classList.toggle('open', anyClosed); });
  document.querySelectorAll('#value-result .vcard-chev').forEach(function (b) { b.textContent = anyClosed ? '▲' : '▼'; });
  if (btn) btn.textContent = anyClosed ? '全部收合' : '全部展開';
}

