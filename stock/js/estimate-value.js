// 股利總管 模組：estimate-value — 年度估算 / 當日損益 / 損益試算（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ══════════════ 年度可領估算 ══════════════
// 邏輯：
//   已領月份（Jan ~ 上月）→ 用 API 實際金額
//   未來月份（本月 ~ 12月）→ 若該月在配息月份內，用最近一次配息金額估算

// 從歷史資料偵測每年預期配息月份
function switchEstTab(tab) {
  ['month','stock','chart'].forEach(t => {
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
function getPayDate(rec) {
  if (rec.payDate) return rec.payDate;
  return exToPayDate(rec.exDate);
}
function isPaid(rec) {
  if (!rec.payDate) return false;
  return rec.payDate <= new Date();
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

      const shares = parseFloat(stock.shares);

      // ── 手動設定 ──
      if (stock.manualDiv && stock.manualDiv > 0) {
        const freq = stock.divFreq || 'monthly';
        const allMonths = freq === 'monthly' ? Array.from({length:12},(_,i)=>i+1)
                        : freq === 'quarterly' ? [1,4,7,10]
                        : [6]; // annual 預設6月
        const divMonthsOverride = stock.divMonths ? parseDivMonths(stock.divMonths) : allMonths;
        const actualDivs = [], estDivs = [];
        for (const m of divMonthsOverride) {
          const totalDiv = Math.round(stock.manualDiv * shares * 1000 * 100) / 100;
          if (m - 1 <= lastReceivedIdx) {
            actualDivs.push({ month: m, cashDiv: stock.manualDiv, totalDiv, count: 1 });
            monthActualCodes[m-1].push(stock.code);
          } else {
            estDivs.push({ month: m, cashDiv: stock.manualDiv, totalDiv });
            monthEstCodes[m-1].push(stock.code);
          }
        }
        const total = [...actualDivs, ...estDivs].reduce((s,d) => s + d.totalDiv, 0);
        stockResults.push({ stock, actualDivs, estDivs, total, latestDiv: stock.manualDiv });
        continue;
      }

      // 不配息直接跳過
      if (stock.divFreqType === 'none') continue;

      // ── API 查詢 ──
      try {
        const history = await fetchStockDivHistory(stock.code);
        if (history.length === 0) continue;

        // 今年實際已入帳（入帳日 Jan ~ 上月，除息日在去年12月 ~ 今年上上月）
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
          if (!monthActualCodes[pm].includes(stock.code)) monthActualCodes[pm].push(stock.code);
        }
        const actualDivs = Array.from(actualMap.values()).sort((a,b) => a.month - b.month);

        // 以持股設定的配息月份為主，未設定則從 API 偵測（僅作備用）
        const expectedMonths = stock.divMonths && stock.divFreqType !== 'none'
          ? parseDivMonths(stock.divMonths)
          : (stock.divFreqType === 'none' ? [] : detectExpectedMonths(history));

        // 最近一次配息金額（用於估算）
        const latestDiv = getLatestCashDiv(history);

        // 未來入帳月份估算（本月 ~ 12月）
        const estDivs = [];
        for (const m of expectedMonths) {
          if (m - 1 < curMonthIdx) continue; // 已入帳月份不再估算
          const totalDiv = Math.round(latestDiv * shares * 1000 * 100) / 100;
          estDivs.push({ month: m, cashDiv: latestDiv, totalDiv });
          if (!monthEstCodes[m-1].includes(stock.code)) monthEstCodes[m-1].push(stock.code);
        }

        const total = [...actualDivs, ...estDivs].reduce((s,d) => s + d.totalDiv, 0);
        if (actualDivs.length > 0 || estDivs.length > 0) {
          stockResults.push({ stock, actualDivs, estDivs, total, latestDiv });
        }
      } catch(e) {
        console.warn('[EST]', stock.code, e.message);
      }
    }

    stockResults.sort((a,b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, {numeric:true}));
    const actualTotal = stockResults.reduce((s,r) =>
      s + r.actualDivs.reduce((ss,d) => ss + d.totalDiv, 0), 0);
    const estTotal = stockResults.reduce((s,r) =>
      s + r.estDivs.reduce((ss,d) => ss + d.totalDiv, 0), 0);
    const grandTotal = actualTotal + estTotal;

    loading.style.display = 'none';
    renderEstResult(stockResults, grandTotal, actualTotal, estTotal, curYear, curMonthIdx, monthActualCodes, monthEstCodes);
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

  // ── Tab 3：直條圖 ──
  const chartPane = document.getElementById('est-pane-chart');
  if (!chartPane) return;

  const PAD = { top:40, right:16, bottom:48, left:56 };
  const BAR_GAP = 6;
  const containerW = chartPane.clientWidth || (window.innerWidth - 32);
  const W = containerW;
  const H = 280;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const barW = Math.floor((chartW - BAR_GAP * 11) / 12);

  const maxVal = Math.max(...monthActual.map((a,i) => a + monthEst[i]), 1);
  // Y-axis nice scale
  const yMax = Math.ceil(maxVal / 10000) * 10000 || 10000;
  const yTicks = 4;

  let svgParts = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;overflow:visible">`];

  // Y gridlines + labels
  for (let t = 0; t <= yTicks; t++) {
    const val = Math.round(yMax * t / yTicks);
    const y = PAD.top + chartH - Math.round((val / yMax) * chartH);
    const label = val >= 10000 ? (val/10000).toFixed(0) + '萬' : val.toLocaleString();
    svgParts.push(`<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`);
    svgParts.push(`<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="rgba(143,163,184,0.8)">${label}</text>`);
  }

  // Bars + X labels
  for (let m = 0; m < 12; m++) {
    const actual = monthActual[m];
    const est = monthEst[m];
    const total = actual + est;
    const x = PAD.left + m * (barW + BAR_GAP);

    const hActual = actual > 0 ? Math.max(2, Math.round((actual / yMax) * chartH)) : 0;
    const hEst    = est > 0    ? Math.max(2, Math.round((est    / yMax) * chartH)) : 0;
    const hTotal  = hActual + hEst;

    const yBase = PAD.top + chartH;

    if (hEst > 0) {
      svgParts.push(`<rect x="${x}" y="${yBase - hTotal}" width="${barW}" height="${hEst}" rx="3" fill="#f0cc7a" opacity="0.85"/>`);
    }
    if (hActual > 0) {
      svgParts.push(`<rect x="${x}" y="${yBase - hActual}" width="${barW}" height="${hActual}" rx="${hEst > 0 ? 0 : 3}" fill="#4caf82"/>`);
      if (hEst > 0) {
        svgParts.push(`<rect x="${x}" y="${yBase - hActual}" width="${barW}" height="2" fill="#4caf82"/>`);
      }
    }

    // Amount label on top of bar
    if (total > 0) {
      const labelVal = total >= 10000 ? (total/10000).toFixed(1) + '萬' : Math.round(total).toLocaleString();
      svgParts.push(`<text x="${x + barW/2}" y="${yBase - hTotal - 5}" text-anchor="middle" font-size="9" fill="rgba(238,242,247,0.7)">${labelVal}</text>`);
    }

    // X label
    const xLabel = x + barW / 2;
    svgParts.push(`<text x="${xLabel}" y="${yBase + 16}" text-anchor="middle" font-size="11" fill="rgba(143,163,184,0.9)">${m+1}</text>`);
  }

  // X axis line
  svgParts.push(`<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${W - PAD.right}" y2="${PAD.top + chartH}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`);

  // Legend
  const ly = H - 8;
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

// ══════════════ 當日股票損益 ══════════════
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

async function fetchStockPrice(code) {
  const cache = getPriceCache();
  const now = Date.now();
  const today = todayStr();
  // 同一天內且未超過 TTL 才用快取；跨日強制重抓
  if (cache[code] && cache[code].day === today && (now - cache[code].ts) < PRICE_CACHE_TTL) return cache[code].data;
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
        rows.push({ stock, price, totalValue, date: priceData.date, latestExDate, change: priceData.change, changePct: priceData.changePct });
      } catch(e) {
        rows.push({ stock, price: null, totalValue: null, date: null, latestExDate: null, error: e.message });
      }
    }

    rows.sort((a,b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, {numeric:true}));
    const grandTotal = rows.reduce((s,r) => s + (r.totalValue||0), 0);

    loading.style.display = 'none';
    if (stickyEl) {
      stickyEl.style.display = 'block';
      stickyEl.innerHTML = '<div class="div-total-card" style="margin-bottom:0;padding:12px 14px">' +
        '<div style="display:flex;align-items:flex-start;gap:10px">' +
          '<div style="flex:1;min-width:0">' +
            '<div class="div-total-label" style="font-size:11px">持股總現値</div>' +
            '<div style="font-size:18px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;color:var(--accent2)">$' + grandTotal.toLocaleString('zh-TW') + '</div>' +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="div-total-label" style="color:#8ab4d4;font-size:11px">含稅費現値</div>' +
            '<div style="font-size:18px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;color:#8ab4d4">$' + Math.round(grandTotal * 0.997735).toLocaleString('zh-TW') + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:10px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px">' +
          '<div style="display:flex;align-items:flex-start;gap:24px;flex-wrap:wrap">' +
            '<div style="flex:0 0 auto">' +
              '<div class="div-total-label" style="color:#f5d87a;margin-bottom:4px">總付出成本</div>' +
              '<div style="display:flex;align-items:center;gap:6px">' +
                '<span style="color:var(--text2);font-size:14px">$</span>' +
                '<div style="display:flex;align-items:center;gap:6px">' +
                  '<input id="total-cost-input" type="text" inputmode="numeric" readonly' +
                  ' value="' + fmtCost() + '"' +
                  ' style="background:var(--bg4);border:1px solid var(--border2);border-radius:6px;color:#f5d87a;font-size:17px;font-weight:700;width:130px;padding:4px 8px;font-family:var(--font);text-align:right"' +
                  ' onkeydown="saveTotalCostConfirm(this,event)" placeholder="點編輯輸入"/>' +
                  '<button onclick="toggleCostEdit(this)" style="background:rgba(245,216,122,.15);border:1px solid rgba(245,216,122,.4);color:#f5d87a;font-size:12px;font-weight:600;padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;font-family:var(--font)">編輯</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div id="pnl-block" data-aftertax="' + Math.round(grandTotal * 0.997735) + '" style="flex:1;min-width:120px">' + calcPnlHtml(0.997735 * grandTotal) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="div-total-count">共 ' + rows.length + ' 支持股｜' +
        (latestDate ? '收盤日 ' + latestDate : '') + '</div>' +
        '</div>';
    }
    document.getElementById('value-date-label').textContent = latestDate ? '收盤日：' + latestDate : '';

    let html = '';
    for (const r of rows) {
      const hasData = r.price != null;
      html += '<div class="value-card">' +
        '<div class="value-card-top">' +
        '<div>' +
          '<div class="value-stock-name">' + r.stock.code + '</div>' +
          '<div class="value-stock-code">' + (r.stock.name || r.stock.code) + '</div>' +
        '</div>' +
        '<div class="value-total">' + (hasData ? '$ ' + r.totalValue.toLocaleString('zh-TW') : '—') + '</div>' +
        '</div>' +
        '<div class="value-meta" style="grid-template-columns:1fr">' +
        '<div class="value-meta-item"><div class="value-meta-label">收盤價</div>' +
          (function(){
            if (!hasData) return '<div class="value-meta-val">查詢失敗</div></div>';
            var up = r.change != null && r.change > 0;
            var down = r.change != null && r.change < 0;
            var priceCol = up ? '#ff5252' : (down ? '#26d962' : 'var(--text)');
            return '<div class="value-meta-val" style="color:' + priceCol + '">$ ' + r.price.toFixed(2) + changeHtml(r.change, r.changePct) + '</div></div>';
          })() +
        premiumHtml(r.price, r.stock.code) +
        '</div></div>';
    }
    resultEl.innerHTML = html || '<div class="div-empty">無資料</div>';
  } catch(err) {
    loading.style.display = 'none';
    resultEl.innerHTML = '<div class="div-empty"><div style="color:var(--danger)">' + err.message + '</div>' +
      '<button class="btn-primary" style="margin-top:16px;max-width:200px" onclick="loadStockValue(true)">重試</button></div>';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// ── PATCH showScreen to trigger month load ──

// ══════════════ 年度可領估算 ══════════════
// 邏輯：
//   已領月份（Jan ~ 上月）→ 用 API 實際金額
//   未來月份（本月 ~ 12月）→ 若該月在配息月份內，用最近一次配息金額估算

// 從歷史資料偵測每年預期配息月份
function switchEstTab(tab) {
  ['month','stock','chart'].forEach(t => {
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

      const shares = parseFloat(stock.shares);

      // ── 手動設定 ──
      if (stock.manualDiv && stock.manualDiv > 0) {
        const freq = stock.divFreq || 'monthly';
        const allMonths = freq === 'monthly' ? Array.from({length:12},(_,i)=>i+1)
                        : freq === 'quarterly' ? [1,4,7,10]
                        : [6]; // annual 預設6月
        const divMonthsOverride = stock.divMonths ? parseDivMonths(stock.divMonths) : allMonths;
        const actualDivs = [], estDivs = [];
        for (const m of divMonthsOverride) {
          const totalDiv = Math.round(stock.manualDiv * shares * 1000 * 100) / 100;
          if (m - 1 <= lastReceivedIdx) {
            actualDivs.push({ month: m, cashDiv: stock.manualDiv, totalDiv, count: 1 });
            monthActualCodes[m-1].push(stock.code);
          } else {
            estDivs.push({ month: m, cashDiv: stock.manualDiv, totalDiv });
            monthEstCodes[m-1].push(stock.code);
          }
        }
        const total = [...actualDivs, ...estDivs].reduce((s,d) => s + d.totalDiv, 0);
        stockResults.push({ stock, actualDivs, estDivs, total, latestDiv: stock.manualDiv });
        continue;
      }

      // 不配息直接跳過
      if (stock.divFreqType === 'none') continue;

      // ── API 查詢 ──
      try {
        const history = await fetchStockDivHistory(stock.code);
        if (history.length === 0) continue;

        // 今年實際已入帳（入帳日 Jan ~ 上月，除息日在去年12月 ~ 今年上上月）
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
          if (!monthActualCodes[pm].includes(stock.code)) monthActualCodes[pm].push(stock.code);
        }
        const actualDivs = Array.from(actualMap.values()).sort((a,b) => a.month - b.month);

        // 以持股設定的配息月份為主，未設定則從 API 偵測（僅作備用）
        const expectedMonths = stock.divMonths && stock.divFreqType !== 'none'
          ? parseDivMonths(stock.divMonths)
          : (stock.divFreqType === 'none' ? [] : detectExpectedMonths(history));

        // 最近一次配息金額（用於估算）
        const latestDiv = getLatestCashDiv(history);

        // 未來入帳月份估算（本月 ~ 12月）
        const estDivs = [];
        for (const m of expectedMonths) {
          if (m - 1 < curMonthIdx) continue; // 已入帳月份不再估算
          const totalDiv = Math.round(latestDiv * shares * 1000 * 100) / 100;
          estDivs.push({ month: m, cashDiv: latestDiv, totalDiv });
          if (!monthEstCodes[m-1].includes(stock.code)) monthEstCodes[m-1].push(stock.code);
        }

        const total = [...actualDivs, ...estDivs].reduce((s,d) => s + d.totalDiv, 0);
        if (actualDivs.length > 0 || estDivs.length > 0) {
          stockResults.push({ stock, actualDivs, estDivs, total, latestDiv });
        }
      } catch(e) {
        console.warn('[EST]', stock.code, e.message);
      }
    }

    stockResults.sort((a,b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, {numeric:true}));
    const actualTotal = stockResults.reduce((s,r) =>
      s + r.actualDivs.reduce((ss,d) => ss + d.totalDiv, 0), 0);
    const estTotal = stockResults.reduce((s,r) =>
      s + r.estDivs.reduce((ss,d) => ss + d.totalDiv, 0), 0);
    const grandTotal = actualTotal + estTotal;

    loading.style.display = 'none';
    renderEstResult(stockResults, grandTotal, actualTotal, estTotal, curYear, curMonthIdx, monthActualCodes, monthEstCodes);
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

  // ── Tab 3：直條圖 ──
  const chartPane = document.getElementById('est-pane-chart');
  if (!chartPane) return;

  const PAD = { top:40, right:16, bottom:48, left:56 };
  const BAR_GAP = 6;
  const containerW = chartPane.clientWidth || (window.innerWidth - 32);
  const W = containerW;
  const H = 280;
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const barW = Math.floor((chartW - BAR_GAP * 11) / 12);

  const maxVal = Math.max(...monthActual.map((a,i) => a + monthEst[i]), 1);
  // Y-axis nice scale
  const yMax = Math.ceil(maxVal / 10000) * 10000 || 10000;
  const yTicks = 4;

  let svgParts = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;overflow:visible">`];

  // Y gridlines + labels
  for (let t = 0; t <= yTicks; t++) {
    const val = Math.round(yMax * t / yTicks);
    const y = PAD.top + chartH - Math.round((val / yMax) * chartH);
    const label = val >= 10000 ? (val/10000).toFixed(0) + '萬' : val.toLocaleString();
    svgParts.push(`<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`);
    svgParts.push(`<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="rgba(143,163,184,0.8)">${label}</text>`);
  }

  // Bars + X labels
  for (let m = 0; m < 12; m++) {
    const actual = monthActual[m];
    const est = monthEst[m];
    const total = actual + est;
    const x = PAD.left + m * (barW + BAR_GAP);

    const hActual = actual > 0 ? Math.max(2, Math.round((actual / yMax) * chartH)) : 0;
    const hEst    = est > 0    ? Math.max(2, Math.round((est    / yMax) * chartH)) : 0;
    const hTotal  = hActual + hEst;

    const yBase = PAD.top + chartH;

    if (hEst > 0) {
      svgParts.push(`<rect x="${x}" y="${yBase - hTotal}" width="${barW}" height="${hEst}" rx="3" fill="#f0cc7a" opacity="0.85"/>`);
    }
    if (hActual > 0) {
      svgParts.push(`<rect x="${x}" y="${yBase - hActual}" width="${barW}" height="${hActual}" rx="${hEst > 0 ? 0 : 3}" fill="#4caf82"/>`);
      if (hEst > 0) {
        svgParts.push(`<rect x="${x}" y="${yBase - hActual}" width="${barW}" height="2" fill="#4caf82"/>`);
      }
    }

    // Amount label on top of bar
    if (total > 0) {
      const labelVal = total >= 10000 ? (total/10000).toFixed(1) + '萬' : Math.round(total).toLocaleString();
      svgParts.push(`<text x="${x + barW/2}" y="${yBase - hTotal - 5}" text-anchor="middle" font-size="9" fill="rgba(238,242,247,0.7)">${labelVal}</text>`);
    }

    // X label
    const xLabel = x + barW / 2;
    svgParts.push(`<text x="${xLabel}" y="${yBase + 16}" text-anchor="middle" font-size="11" fill="rgba(143,163,184,0.9)">${m+1}</text>`);
  }

  // X axis line
  svgParts.push(`<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${W - PAD.right}" y2="${PAD.top + chartH}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`);

  // Legend
  const ly = H - 8;
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

// ══════════════ 當日股票損益 ══════════════
async function fetchStockPrice(code) {
  const cache = getPriceCache();
  const now = Date.now();
  const today = todayStr();
  // 同一天內且未超過 TTL 才用快取；跨日強制重抓
  if (cache[code] && cache[code].day === today && (now - cache[code].ts) < PRICE_CACHE_TTL) return cache[code].data;
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
        rows.push({ stock, price, totalValue, date: priceData.date, latestExDate, change: priceData.change, changePct: priceData.changePct });
      } catch(e) {
        rows.push({ stock, price: null, totalValue: null, date: null, latestExDate: null, error: e.message });
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
    if (stickyEl) {
      stickyEl.style.display = 'block';
      stickyEl.innerHTML = '<div class="div-total-card" style="margin-bottom:0;padding:12px 14px">' +
        '<div style="display:flex;align-items:flex-start;gap:10px">' +
          '<div style="flex:1;min-width:0">' +
            '<div class="div-total-label" style="font-size:11px">持股總現値</div>' +
            '<div style="font-size:18px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;color:var(--accent2)">$' + grandTotal.toLocaleString('zh-TW') + '</div>' +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="div-total-label" style="color:#8ab4d4;font-size:11px">含稅費現値</div>' +
            '<div style="font-size:18px;font-weight:700;letter-spacing:-.5px;white-space:nowrap;color:#8ab4d4">$' + Math.round(grandTotal * 0.997735).toLocaleString('zh-TW') + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:10px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px">' +
          '<div style="display:flex;align-items:flex-start;gap:24px;flex-wrap:wrap">' +
            '<div style="flex:0 0 auto">' +
              '<div class="div-total-label" style="color:#f5d87a;margin-bottom:4px">總付出成本</div>' +
              '<div style="display:flex;align-items:center;gap:6px">' +
                '<span style="color:var(--text2);font-size:14px">$</span>' +
                '<span style="color:#f5d87a;font-size:17px;font-weight:700;white-space:nowrap">' + (fmtCost() || '—') + '</span>' +
              '</div>' +
              '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + costHint + '</div>' +
            '</div>' +
            '<div id="pnl-block2" data-aftertax="' + Math.round(grandTotal * 0.997735) + '" style="flex:1;min-width:120px">' + calcPnlHtml(0.997735 * grandTotal) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="div-total-count">共 ' + rows.length + ' 支持股｜' +
        (latestDate ? '收盤日 ' + latestDate : '') + '</div>' +
        '</div>';
    }
    document.getElementById('value-date-label').textContent = latestDate ? '收盤日：' + latestDate : '';

    let html = '';
    for (const r of rows) {
      const hasData = r.price != null;
      html += '<div class="value-card">' +
        '<div class="value-card-top">' +
        '<div>' +
          '<div class="value-stock-name">' + r.stock.code + '</div>' +
          '<div class="value-stock-code">' + (r.stock.name || r.stock.code) + '</div>' +
        '</div>' +
        '<div class="value-total">' + (hasData ? '$ ' + r.totalValue.toLocaleString('zh-TW') : '—') + '</div>' +
        '</div>' +
        '<div class="value-meta" style="grid-template-columns:1fr">' +
        '<div class="value-meta-item"><div class="value-meta-label">收盤價</div>' +
          (function(){
            if (!hasData) return '<div class="value-meta-val">查詢失敗</div></div>';
            var up = r.change != null && r.change > 0;
            var down = r.change != null && r.change < 0;
            var priceCol = up ? '#ff5252' : (down ? '#26d962' : 'var(--text)');
            return '<div class="value-meta-val" style="color:' + priceCol + '">$ ' + r.price.toFixed(2) + changeHtml(r.change, r.changePct) + '</div></div>';
          })() +
        premiumHtml(r.price, r.stock.code) +
        '</div></div>';
    }
    resultEl.innerHTML = html || '<div class="div-empty">無資料</div>';
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
function fmtCost() { var v = getTotalCost(); return v > 0 ? v.toLocaleString('zh-TW') : ''; }

// ── ETF 淨值（折溢價用）：透過 GAS 既有 ?url= 代理抓 TWSE 全 ETF 淨值表，建代號→淨值對照 ──
var _etfNavMap = null, _etfNavDay = null;
function _navTodayStr() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
async function ensureNavMap(force) {
  var today = _navTodayStr();
  if (!force && _etfNavMap && _etfNavDay === today) return _etfNavMap;
  if (!force) {
    try {
      var cached = JSON.parse(localStorage.getItem('etf_nav_map') || 'null');
      if (cached && cached.day === today) { _etfNavMap = cached.map; _etfNavDay = today; return _etfNavMap; }
    } catch (e) {}
  }
  var src = 'https://mis.twse.com.tw/stock/data/all_etf.txt';
  var res;
  for (var attempt = 0; attempt < 3; attempt++) {
    res = await fetch(GAS_URL + '?url=' + encodeURIComponent(src));
    if (res.ok) break;
    if (attempt < 2) await new Promise(function (rs) { setTimeout(rs, 500 * (attempt + 1)); });
  }
  if (!res.ok) throw new Error('NAV HTTP ' + res.status);
  var data = await res.json();
  var insts = data.a1 || (Array.isArray(data) ? data : []);
  var map = {};
  insts.forEach(function (inst) {
    (inst.msgArray || []).forEach(function (x) {
      if (!x.a) return;
      // 欄位：e=成交價(市價)、f=淨值、g=折溢價%(=(e-f)/f)、c=規模、i=日期
      var nav = parseFloat(x.f), prem = parseFloat(x.g);
      if (!isNaN(nav) && nav > 0) map[String(x.a).toUpperCase()] = { nav: nav, premium: isNaN(prem) ? null : prem, date: x.i };
    });
  });
  _etfNavMap = map; _etfNavDay = today;
  try { localStorage.setItem('etf_nav_map', JSON.stringify({ day: today, map: map })); } catch (e) {}
  return map;
}
function getEtfNav(code) { return (_etfNavMap && _etfNavMap[String(code).toUpperCase()]) || null; }
// 折溢價 HTML（溢價紅、折價綠）
function premiumHtml(price, code) {
  var n = getEtfNav(code);
  if (!n || price == null) return '';
  var prem = Math.round((price - n.nav) / n.nav * 10000) / 100;
  var col = prem > 0 ? '#ff5252' : (prem < 0 ? '#26d962' : 'var(--text3)');
  var label = prem > 0 ? '溢價' : (prem < 0 ? '折價' : '平價');
  var sign = prem > 0 ? '+' : '';
  return '<div class="value-meta-item" style="margin-top:6px"><div class="value-meta-label">淨值 / 折溢價</div>' +
    '<div class="value-meta-val">$ ' + n.nav.toFixed(2) +
    '<span style="font-size:13px;font-weight:600;color:' + col + ';margin-left:8px">' + label + ' ' + sign + prem.toFixed(2) + '%</span></div></div>';
}

function toggleCostEdit(btn) {
  // Find the input in the same container
  var input = btn.previousElementSibling;
  if (!input) return;
  if (input.readOnly) {
    // Enter edit mode
    input.readOnly = false;
    input.value = input.value.replace(/,/g, '');
    input.style.borderColor = '#f5d87a';
    btn.textContent = '確定';
    btn.style.background = 'rgba(123,237,159,.2)';
    btn.style.borderColor = 'rgba(123,237,159,.5)';
    btn.style.color = '#7bed9f';
    input.focus();
    input.select();
  } else {
    // Confirm
    confirmCostSave(input, btn);
  }
}

function saveTotalCostConfirm(input, event) {
  if (event && event.key === 'Enter') {
    var btn = input.nextElementSibling;
    confirmCostSave(input, btn);
  }
}

function confirmCostSave(input, btn) {
  var raw = input.value.replace(/[^0-9]/g, '');
  localStorage.setItem(COST_KEY, raw);
  var formatted = parseInt(raw||'0') > 0 ? parseInt(raw).toLocaleString('zh-TW') : '';
  input.value = formatted;
  input.readOnly = true;
  input.style.borderColor = '';
  if (btn) {
    btn.textContent = '編輯';
    btn.style.background = 'rgba(245,216,122,.15)';
    btn.style.borderColor = 'rgba(245,216,122,.4)';
    btn.style.color = '#f5d87a';
  }
  // Sync both inputs
  var other = input.id === 'total-cost-input'
    ? document.getElementById('total-cost-input2')
    : document.getElementById('total-cost-input');
  if (other) { other.value = formatted; other.readOnly = true; }
  // Recalculate PnL
  var pnlEl = document.getElementById('pnl-block') || document.getElementById('pnl-block2');
  var afterTax = pnlEl ? parseFloat(pnlEl.dataset.aftertax || 0) : 0;
  updatePnlDisplay(afterTax);
}

function saveTotalCost(input, event) {
  // Allow Enter key to trigger save
  if (event && event.type === 'keydown' && event.key !== 'Enter') return;
  var raw = input.value.replace(/[^0-9]/g, '');
  input.value = raw ? parseInt(raw).toLocaleString('zh-TW') : '';
  localStorage.setItem(COST_KEY, raw);
  // Read afterTax from data attribute
  var pnlEl = document.getElementById('pnl-block') || document.getElementById('pnl-block2');
  var afterTax = pnlEl ? parseFloat(pnlEl.dataset.aftertax || 0) : 0;
  if (!afterTax) {
    // Try to read from input2 block
    var pnlEl2 = document.getElementById('pnl-block2');
    if (pnlEl2) afterTax = parseFloat(pnlEl2.dataset.aftertax || 0);
  }
  updatePnlDisplay(afterTax);
}

// 漲跌顯示（紅漲綠跌）
function changeHtml(change, changePct) {
  if (change == null || changePct == null) return '';
  var up = change > 0, flat = change === 0;
  var col = flat ? 'var(--text3)' : (up ? '#ff5252' : '#26d962');
  var arrow = flat ? '—' : (up ? '▲' : '▼');
  var sign = up ? '+' : '';
  return '<span style="font-size:13px;font-weight:600;color:' + col + ';margin-left:8px">' +
    arrow + ' ' + sign + change.toFixed(2) + ' (' + sign + changePct.toFixed(2) + '%)</span>';
}

function calcPnlHtml(afterTaxValue) {
  var cost = getTotalCost();
  if (!cost || !afterTaxValue) return '<div style="color:var(--text3);font-size:12px;padding-top:18px">填入各持股成本後顯示</div>';
  var pnl = Math.round(afterTaxValue) - cost;
  var pnlPct = (pnl / cost * 100);
  // 台股慣例：正數（獲利）紅色，負數（虧損）綠色
  var pnlColor = pnl >= 0 ? '#ff5252' : '#26d962';
  var sign = pnl >= 0 ? '+' : '';
  return '<div style="display:flex;gap:16px;align-items:flex-start">' +
    '<div>' +
      '<div class="div-total-label" style="color:#a4b0be;font-size:11px">損益試算</div>' +
      '<div style="font-size:17px;font-weight:700;color:'+pnlColor+';white-space:nowrap">'+sign+pnl.toLocaleString('zh-TW')+'<span style="font-size:12px;font-weight:400"> 元</span></div>' +
    '</div>' +
    '<div>' +
      '<div class="div-total-label" style="color:#a4b0be;font-size:11px">獲利率</div>' +
      '<div style="font-size:17px;font-weight:700;color:'+pnlColor+';white-space:nowrap">'+sign+pnlPct.toFixed(2)+'%</div>' +
    '</div>' +
  '</div>';
}

function updatePnlDisplay(afterTaxValue) {
  var el1 = document.getElementById('pnl-block');
  var el2 = document.getElementById('pnl-block2');
  var html = calcPnlHtml(afterTaxValue);
  if (el1) el1.innerHTML = html;
  if (el2) el2.innerHTML = html;
}

