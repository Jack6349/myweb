// 股利總管 模組：dividends — 當月可領 / 年度已領（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ── MAIN: LOAD MONTH DIVIDENDS ──
// 邏輯：逐股查詢 TWTB4U 歷史除息紀錄，篩選上月除息 → 本月入帳
async function loadMonthDividends(forceRefresh) {
  if (portfolio.length === 0) {
    document.getElementById('month-result').innerHTML =
      '<div class="div-no-portfolio">' +
      '<div style="font-size:40px;margin-bottom:12px;opacity:.5">📋</div>' +
      '<div style="font-size:16px;color:var(--text2)">尚未建立持股資料</div>' +
      '<div style="font-size:13px;color:var(--text3);margin-top:6px">請先至「持股」頁面新增持股</div>' +
      '</div>';
    return;
  }

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth(); // 0-based
  // 上個月（發放日 = 除息日次月，故找上月除息）
  const prevDate = new Date(curYear, curMonth - 1, 1);
  const prevYear = prevDate.getFullYear();
  const prevMonth = prevDate.getMonth(); // 0-based

  document.getElementById('month-label').textContent =
    curYear + ' 年 ' + (curMonth+1) + ' 月（入帳月份）';

  const loading = document.getElementById('month-loading');
  const resultEl = document.getElementById('month-result');
  const refreshBtn = document.getElementById('month-refresh-btn');

  if (forceRefresh) {
    const cache = getDivCache();
    portfolio.forEach(s => delete cache['twtb4u_' + s.code]);
    setDivCache(cache);
  }

  loading.style.display = 'block';
  resultEl.innerHTML = '';
  const stickyArea = document.getElementById('month-total-sticky');
  if (stickyArea) stickyArea.style.display = 'none';
  refreshBtn.classList.add('spinning');

  // 更新 loading 文字顯示進度
  const loadingText = document.querySelector('.loading-text');

  try {
    const matches = [];
    const apiFailures = [];
    const apiNoData = [];
    for (let i = 0; i < portfolio.length; i++) {
      const stock = portfolio[i];
      if (loadingText) loadingText.textContent =
        '查詢中 (' + (i+1) + '/' + portfolio.length + ')：' + (stock.name || stock.code);
      try {
        if (stock.divFreqType === 'none') continue; // 不配息跳過
        // 手動設定優先
        if (stock.manualDiv && stock.manualDiv > 0) {
          const shares = parseFloat(stock.shares);
          const totalDiv = Math.round(stock.manualDiv * shares * 1000 * 100) / 100;
          console.log('[手動]', stock.code, 'div=$' + stock.manualDiv, 'total=$' + totalDiv);
          matches.push({
            code: stock.code,
            name: stock.name || stock.code,
            cashDiv: stock.manualDiv,
            shares, totalDiv,
            exDateStr: '手動設定',
            type: '手動',
            isManual: true,
            stock: stock,
            history: [],
          });
          continue; // 跳過 API 查詢
        }
        // API 查詢
        const history = await fetchStockDivHistory(stock.code);
        console.log('[API]', stock.code, '取得', history.length, '筆，篩選', prevYear + '/' + (prevMonth+1));
        let found = false;
        for (const rec of history) {
          if (!rec.exDate) continue;
          const payDate = exToPayDate(rec.exDate);
          if (!payDate) continue;
          const ry = payDate.getFullYear(), rm = payDate.getMonth();
          console.log(' ', rec.exDateStr, '→入帳', ry + '/' + (rm+1), '$' + rec.cashDiv,
            (ry === curYear && rm === curMonth) ? '✓' : '');
          if (ry !== curYear || rm !== curMonth) continue;
          const shares = parseFloat(stock.shares);
          const totalDiv = Math.round(rec.cashDiv * shares * 1000 * 100) / 100;
          const payStr = (payDate.getFullYear()) + '/' +
            String(payDate.getMonth()+1).padStart(2,'0') + '/' +
            String(payDate.getDate()).padStart(2,'0');
          matches.push({
            code: stock.code,
            name: rec.name || stock.name || stock.code,
            cashDiv: rec.cashDiv,
            shares, totalDiv,
            exDateStr: payStr,
            type: rec.type,
            isManual: false,
            stock: stock,
            history: history,
          });
          found = true;
        }
        if (!found) {
          console.log('[' + stock.code + '] 無符合上月除息紀錄');
          apiNoData.push(stock.code);
        }
      } catch (e) {
        console.warn('[' + stock.code + '] 查詢失敗：', e.message);
        apiFailures.push(stock.code);
      }
    }

    // 去除同一股票重複紀錄（保留金額最高的那筆）
    const dedupMap = new Map();
    for (const m of matches) {
      if (!dedupMap.has(m.code) || m.totalDiv > dedupMap.get(m.code).totalDiv) {
        dedupMap.set(m.code, m);
      }
    }
    const deduped = Array.from(dedupMap.values());
    deduped.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, {numeric:true}));
    const grandTotal = deduped.reduce((s, m) => s + m.totalDiv, 0);

    loading.style.display = 'none';
    renderMonthResult(deduped, grandTotal, curYear, curMonth, prevYear, prevMonth, apiFailures, apiNoData);
  } catch (err) {
    loading.style.display = 'none';
    resultEl.innerHTML = '<div class="div-empty"><div class="div-empty-icon">⚠</div>' +
      '<div style="color:var(--danger);font-size:15px;">查詢失敗</div>' +
      '<div style="font-size:13px;color:var(--text2);margin-top:8px">' + err.message + '</div>' +
      '<button class="btn-primary" style="margin-top:20px;max-width:200px" onclick="loadMonthDividends(true)">重試</button></div>';
  } finally {
    if (!document.getElementById('screen-home').classList.contains('active')) {
      refreshBtn.classList.remove('spinning');
    }
  }
}

async function renderMonthResult(items, total, year, month, prevYear, prevMonth, failList, noDataList) {
  const result = document.getElementById('month-result');
  const monthName = getMonthName(month);

  if (items.length === 0) {
    result.innerHTML =
      '<div class="div-empty">' +
      '<div class="div-empty-icon">💰</div>' +
      '<div style="font-size:16px;color:var(--text2)">本月無股利入帳</div>' +
      '<div style="font-size:13px;color:var(--text3);margin-top:6px">持股中本月無現金股利發放日</div>' +
      '</div>' +
      '<div class="api-note">查詢範圍：' + prevYear + ' 年 ' + getMonthName(prevMonth) +
      ' 除息紀錄（上市公司）。持股中無股票在上月除息，故本月無股利入帳。<br>' +
      '上櫃公司（如部分 ETF）資料另行規劃。</div>' +
      '<button class="btn-danger" style="margin-top:8px;max-width:240px" onclick="showDebugInfo()">API 除錯（查欄位結構）</button>';
    return;
  }

  // 合計卡片置於 sticky 區域（不隨明細捲動）
  const stickyEl = document.getElementById('month-total-sticky');
  if (stickyEl) {
    stickyEl.style.display = 'block';
    stickyEl.innerHTML = '<div class="div-total-card" style="margin-bottom:0">' +
      '<div class="div-total-label">本月入帳合計</div>' +
      '<div class="div-total-amount">$ ' + Math.round(total).toLocaleString('zh-TW') +
      '<span class="div-total-unit"> 元</span></div>' +
      '<div class="div-total-count">共 ' + items.length + ' 支股票配息</div>' +
      '</div>';
  }

  // Fetch prices for all items
  const priceCache = {};
  await Promise.all(items.map(async function(item) {
    try {
      var r = await fetch(GAS_URL + '?price=' + encodeURIComponent(item.code));
      var d = await r.json();
      if (d.stat === 'OK') priceCache[item.code] = d.price;
    } catch(e) {}
  }));

  let html =
    '<div style="overflow-x:auto;margin:8px 0 0">' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<thead>' +
    '<tr style="border-bottom:2px solid var(--border)">' +
    '<th style="text-align:left;padding:8px 10px;color:var(--text3);font-weight:600;white-space:nowrap">股票</th>' +
    '<th style="text-align:right;padding:8px 6px;color:var(--text3);font-weight:600;white-space:nowrap">持股(張)</th>' +
    '<th style="text-align:right;padding:8px 6px;color:var(--text3);font-weight:600;white-space:nowrap">每股配息</th>' +
    '<th style="text-align:right;padding:8px 6px;color:var(--text3);font-weight:600;white-space:nowrap">入帳日</th>' +
    '<th style="text-align:right;padding:8px 10px;color:var(--text3);font-weight:600;white-space:nowrap">金額</th>' +
    '</tr>' +
    '</thead>' +
    '<tbody>';

  for (const item of items) {
    const manualTag = item.isManual ? ' <span style="font-size:9px;background:rgba(110,198,240,.2);color:#6ec6f0;border-radius:4px;padding:1px 4px;vertical-align:middle">手動</span>' : '';
    const price = priceCache[item.code] || 0;
    const yieldData = price > 0 ? calcAnnualYieldM1(item.history||[], item.stock||{}, item.cashDiv, price) : null;
    const yieldStr = yieldData
      ? '<div style="font-size:10px;color:#f5d87a;margin-top:1px">' + yieldData.annualYield.toFixed(2) + '% 年估</div>'
      : '';
    html +=
      '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:10px 10px;max-width:120px">' +
        '<div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + item.code + manualTag + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">' + (item.name || item.code) + '</div>' +
        yieldStr +
      '</td>' +
      '<td style="text-align:right;padding:10px 6px;color:var(--text);white-space:nowrap">' + item.shares.toFixed(1) + '</td>' +
      '<td style="text-align:right;padding:10px 6px;color:var(--text2);white-space:nowrap">$' + item.cashDiv.toFixed(4) + '</td>' +
      '<td style="text-align:right;padding:10px 6px;color:var(--text2);white-space:nowrap;font-size:12px">' + item.exDateStr + '</td>' +
      '<td style="text-align:right;padding:10px 10px;font-weight:700;color:#f5d87a;white-space:nowrap">$' + Math.round(item.totalDiv).toLocaleString('zh-TW') + '</td>' +
      '</tr>';
  }

  html +=
    '<tr style="border-top:2px solid var(--border);background:rgba(255,255,255,.03)">' +
    '<td colspan="4" style="padding:10px 10px;font-size:13px;font-weight:700;color:var(--text2)">合計</td>' +
    '<td style="text-align:right;padding:10px 10px;font-size:16px;font-weight:800;color:#4caf82">$' + Math.round(total).toLocaleString('zh-TW') + '</td>' +
    '</tr>' +
    '</tbody></table></div>';

  html += '<div class="api-note" style="margin-top:10px">資料來源：台灣證交所 TWT49U（上市公司）。' +
    '顯示上月除息的持股，發放日為除息日次月。' +
    '<br>上櫃公司股利資料另行規劃。</div>';

  result.innerHTML = html;

  // Update home card
  document.getElementById('home-monthly').innerHTML =
    '$ <span style="font-weight:700">' + Math.round(total).toLocaleString('zh-TW') + '</span>' +
    '<span> 元</span>';
  var _cm=document.getElementById('card-monthly'); if(_cm) _cm.innerHTML=Math.round(total).toLocaleString('zh-TW')+'<span style="font-size:11px;margin-left:2px">元</span>';
}

// ── 年化殖利率計算（方案一：已配實際 + 未配用最後一次估算）──
function calcAnnualYieldM1(history, stock, currentCashDiv, price) {
  if (!price || price <= 0) return { monthYield: 0, annualYield: 0 };
  var monthYield = currentCashDiv / price * 100;
  if (!history || history.length === 0) {
    // 無歷史資料：用當月金額 × 年頻率估算
    var freqMap = { monthly:12, quarterly:4, semiannual:2, annual:1 };
    var freq = freqMap[stock.divFreqType] || 4;
    return { monthYield: monthYield, annualYield: currentCashDiv * freq / price * 100 };
  }
  var curYear = new Date().getFullYear();
  var freqMap = { monthly:12, quarterly:4, semiannual:2, annual:1 };
  var freq = freqMap[stock.divFreqType] || 4;
  // 今年已發放的配息（以除息日判斷）
  var paidThisYear = history.filter(function(r) {
    return r.exDate && r.exDate.getFullYear() === curYear;
  });
  var paidTotal = paidThisYear.reduce(function(s,r){ return s + (r.cashDiv||0); }, 0);
  var paidCount = paidThisYear.length;
  // 最後一次配息金額（用於估算未來）
  var lastDiv = history.length > 0 ? history[history.length-1].cashDiv : currentCashDiv;
  // 剩餘預計次數
  var remaining = Math.max(freq - paidCount, 0);
  var estimatedTotal = paidTotal + remaining * lastDiv;
  return {
    monthYield: monthYield,
    annualYield: estimatedTotal / price * 100,
    paidCount: paidCount,
    paidTotal: paidTotal,
    remaining: remaining,
    lastDiv: lastDiv,
    freq: freq
  };
}

// ── 顯示 API 除錯資訊（協助排查欄位問題） ──
async function showDebugInfo() {
  const now = new Date();
  const result = document.getElementById('month-result');
  result.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">讀取除錯資訊…</div></div>';
  try {
    let debugHtml = '<div style="font-size:12px;line-height:1.8;word-break:break-all;">';
    // 取第一支持股做除錯查詢
    const testCode = portfolio.length > 0 ? portfolio[0].code : '2330';
    const gasUrl = GAS_URL + '?code=' + encodeURIComponent(testCode);
    const res = await fetch(gasUrl);
    const json = await res.json();
    const divs = json.dividends || [];
    debugHtml += '<div style="background:var(--bg4);border-radius:8px;padding:10px 12px;margin-bottom:10px;">';
    debugHtml += '<strong>Yahoo Finance 測試：' + testCode + '</strong> — stat: ' + json.stat + '，共 ' + divs.length + ' 筆配息<br>';
    if (json.error) debugHtml += '<span style="color:var(--danger)">錯誤：' + json.error + '</span><br>';
    if (divs.length > 0) {
      const last5 = divs.slice(-5);
      last5.forEach(d => {
        const dt = new Date(d.date * 1000);
        debugHtml += '<span style="color:var(--accent)">' + dt.toLocaleDateString('zh-TW') + ' — $' + d.amount + '</span><br>';
      });
    }
    debugHtml += '</div>';
    debugHtml += '</div>';
    result.innerHTML = debugHtml +
      '<button class="btn-primary" style="margin-top:8px" onclick="loadMonthDividends(true)">← 返回正常顯示</button>';
  } catch(e) {
    result.innerHTML = '<div style="color:var(--danger)">除錯失敗：' + e.message + '</div>';
  }
}

// ══════════════ 年度已領股利 ══════════════
async function loadYtdDividends(forceRefresh) {
  if (portfolio.length === 0) {
    document.getElementById('ytd-result').innerHTML =
      '<div class="div-no-portfolio"><div style="font-size:40px;margin-bottom:12px;opacity:.5">📋</div>' +
      '<div style="font-size:16px;color:var(--text2)">尚未建立持股資料</div>' +
      '<div style="font-size:13px;color:var(--text3);margin-top:6px">請先至「持股」頁面新增持股</div></div>';
    return;
  }
  const now = new Date();
  const curYear = now.getFullYear();
  // 已領：1月到上個月（本月尚未入帳）
  const lastReceivedMonth = now.getMonth() - 1; // 0-based，-1 表示上月

  document.getElementById('ytd-label').textContent = curYear + ' 年 1 月 ～ ' + now.getMonth() + ' 月入帳';

  const loading = document.getElementById('ytd-loading');
  const resultEl = document.getElementById('ytd-result');
  const refreshBtn = document.getElementById('ytd-refresh-btn');
  const stickyEl = document.getElementById('ytd-total-sticky');
  const loadingText = document.querySelector('#ytd-loading .loading-text');

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
    const stockResults = []; // [{ stock, dividends:[{month,cashDiv,totalDiv}], total }]

    for (let i = 0; i < portfolio.length; i++) {
      const stock = portfolio[i];
      if (loadingText) loadingText.textContent = '查詢中 (' + (i+1) + '/' + portfolio.length + ')：' + (stock.name || stock.code);

      if (stock.manualDiv && stock.manualDiv > 0) {
        // 手動：1月到上月每月各算一次
        const divs = [];
        for (let m = 0; m <= lastReceivedMonth; m++) {
          const shares = parseFloat(stock.shares);
          divs.push({ month: m + 1, cashDiv: stock.manualDiv,
            totalDiv: Math.round(stock.manualDiv * shares * 1000 * 100) / 100, count: 1, isManual: true });
        }
        const total = divs.reduce((s, d) => s + d.totalDiv, 0);
        stockResults.push({ stock, divs, total });
        continue;
      }

      if (stock.divFreqType === 'none') continue;
      try {
        const history = await fetchStockDivHistory(stock.code);
        const shares = parseFloat(stock.shares);
        // 篩選：入帳日（除息日+1月）落在今年 1月~上月
        const monthMap = new Map();
        for (const rec of history) {
          if (!rec.exDate) continue;
          const payDate = exToPayDate(rec.exDate);
          if (!payDate) continue;
          if (payDate.getFullYear() !== curYear) continue;
          const payMonth = payDate.getMonth(); // 0-based 入帳月
          if (payMonth > lastReceivedMonth) continue;
          const totalDiv = Math.round(rec.cashDiv * shares * 1000 * 100) / 100;
          if (monthMap.has(payMonth)) {
            const ex = monthMap.get(payMonth);
            monthMap.set(payMonth, {
              month: payMonth + 1,
              cashDiv: Math.round((ex.cashDiv + rec.cashDiv) * 10000) / 10000,
              totalDiv: Math.round((ex.totalDiv + totalDiv) * 100) / 100,
              count: ex.count + 1,
              isManual: false,
            });
          } else {
            monthMap.set(payMonth, { month: payMonth + 1, cashDiv: rec.cashDiv, totalDiv, count: 1, isManual: false });
          }
        }
        const dedupDivs = Array.from(monthMap.values()).sort((a,b) => a.month - b.month);
        const total = dedupDivs.reduce((s,d) => s + d.totalDiv, 0);
        if (dedupDivs.length > 0) stockResults.push({ stock, divs: dedupDivs, total });
      } catch(e) {
        console.warn('[YTD]', stock.code, e.message);
      }
    }

    stockResults.sort((a, b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, {numeric:true}));
    const grandTotal = stockResults.reduce((s, r) => s + r.total, 0);

    loading.style.display = 'none';
    renderYtdResult(stockResults, grandTotal, curYear, lastReceivedMonth);
  } catch(err) {
    loading.style.display = 'none';
    resultEl.innerHTML = '<div class="div-empty"><div class="div-empty-icon">⚠</div>' +
      '<div style="color:var(--danger)">' + err.message + '</div>' +
      '<button class="btn-primary" style="margin-top:16px;max-width:200px" onclick="loadYtdDividends(true)">重試</button></div>';
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

function renderYtdResult(stockResults, grandTotal, year, lastMonth) {
  const resultEl = document.getElementById('ytd-result');
  const stickyEl = document.getElementById('ytd-total-sticky');

  // 合計卡片（固定不捲動）
  if (stickyEl) {
    stickyEl.style.display = 'block';
    stickyEl.innerHTML = '<div class="div-total-card" style="margin-bottom:0">' +
      '<div class="div-total-label">' + year + ' 年入帳合計（1～' + (lastMonth+1) + ' 月）</div>' +
      '<div class="div-total-amount">$ ' + Math.round(grandTotal).toLocaleString('zh-TW') +
      '<span class="div-total-unit"> 元</span></div>' +
      '<div class="div-total-count">共 ' + stockResults.length + ' 支股票有配息紀錄</div>' +
      '</div>';
  }

  if (stockResults.length === 0) {
    resultEl.innerHTML = '<div class="div-empty"><div class="div-empty-icon" style="font-size:40px">💰</div>' +
      '<div style="font-size:16px;color:var(--text2)">今年尚無股利入帳</div></div>';
    return;
  }

  let html = '<div class="div-section-title" style="margin-top:12px">個股明細</div>';

  for (const { stock, divs, total } of stockResults) {
    // 除息月份：逗號分隔，例如 1, 3, 7 月
    const monthStr = divs.map(d => d.month + (d.count > 1 ? '(' + d.count + ')' : '')).join(', ') + ' 月';
    const isManual = divs.some(d => d.isManual);
    const manualTag = isManual ? '<span class="manual-badge">手動</span>' : '';

    html += '<div class="div-row">' +
      '<div class="div-row-top">' +
      '<div>' +
        '<div class="div-row-name">' + stock.code + manualTag + '</div>' +
        '<div class="div-row-code">' + (stock.name || stock.code) + '</div>' +
      '</div>' +
      '</div>' +
      '<div class="div-row-meta">' +
      '<div class="div-meta-item"><div class="div-meta-label">持股</div><div class="div-meta-val">' + parseFloat(stock.shares).toFixed(3) + ' 張</div></div>' +
      '<div class="div-meta-item" style="grid-column:span 2"><div class="div-meta-label">配息月份</div><div class="div-meta-val">' + monthStr + '</div></div>' +
      '<div class="div-meta-item accent"><div class="div-meta-label">年度合計</div><div class="div-meta-val gold">$ ' + Math.round(total).toLocaleString('zh-TW') + '</div></div>' +
      '</div></div>';
  }

  html += '<div class="api-note">資料來源：Yahoo Finance / FinMind。僅顯示 API 確認之實際入帳金額。</div>';
  resultEl.innerHTML = html;
  // 更新首頁
  const ytdEl = document.getElementById('home-ytd');
  if (ytdEl) ytdEl.innerHTML = Math.round(grandTotal).toLocaleString('zh-TW') + '<span style="font-size:10px;color:var(--text2);margin-left:1px;">元</span>';
  var _cy=document.getElementById('card-ytd'); if(_cy) _cy.innerHTML=Math.round(grandTotal).toLocaleString('zh-TW')+'<span style="font-size:11px;font-weight:400;margin-left:2px">元</span>';
}

