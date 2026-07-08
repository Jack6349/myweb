// 股利總管 模組：realtime-price — 即時股價（輕量：僅現價/漲跌，不含配息/淨值/成本等附屬查詢）
// 目的：比「當日股票損益」快很多——只呼叫 fetchStockPrice，平行抓取，不查配息歷史/淨值折溢價/年估殖利率。

let _rtpRows = []; // 保存目前資料，供單檔刷新查找/更新

// 產生單一持股的精簡卡片 HTML（含右上角單獨刷新鈕）
function buildRtpCardHtml(r) {
  const code = r.stock.code;
  const hasData = r.price != null;
  const isLimitUp = hasData && r.changePct != null && r.changePct >= 9.9;
  const isLimitDown = hasData && r.changePct != null && r.changePct <= -9.9;
  const limitClass = isLimitUp ? ' limit-up' : (isLimitDown ? ' limit-down' : '');
  const priceCol = (isLimitUp || isLimitDown) ? '#fff'
    : (hasData && r.change > 0) ? '#ff5252' : ((hasData && r.change < 0) ? '#26d962' : 'var(--text)');

  let chgTxt = '';
  if (hasData && r.change != null) {
    const arrow = r.change > 0 ? '▲' : (r.change < 0 ? '▼' : '—');
    const pctArrow = r.changePct > 0 ? '▲' : (r.changePct < 0 ? '▼' : '');
    chgTxt = arrow + ' ' + (r.change > 0 ? '+' : '') + r.change.toFixed(2) +
      '　' + pctArrow + Math.abs(r.changePct).toFixed(2) + '%';
  }

  const refreshBtnHtml =
    '<button class="holdings-refresh-btn" id="rtp-refresh-' + code + '" onclick="event.stopPropagation();refreshOneRtpStock(\'' + code + '\')" ' +
      'title="重新整理此檔" aria-label="重新整理' + code + '" style="color:' + ((isLimitUp || isLimitDown) ? '#fff' : 'var(--text2)') + '">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
    '</button>';

  const priceBlock = hasData
    ? '<div class="vcard-priceline"><span class="vcard-price" style="color:' + priceCol + '">' + r.price.toFixed(2) + '</span></div>' +
      '<div class="vcard-chg" style="color:' + priceCol + '">' + (chgTxt || '&nbsp;') + '</div>'
    : '<div class="vcard-price" style="color:var(--text3);font-size:16px">查詢失敗</div>';

  return '<div class="vcard' + limitClass + '" style="position:relative" data-code="' + code + '">' +
    refreshBtnHtml +
    '<div class="vcard-head" style="padding-right:20px"><span class="vcard-code">' + code + '</span>' +
      '<span class="vcard-name">' + (r.stock.name || '') + '</span></div>' +
    priceBlock +
  '</div>';
}

function rtpUpdateSticky(rows) {
  const stickyEl = document.getElementById('rtp-total-sticky');
  if (!stickyEl) return;
  const latestDate = rows.reduce((s, r) => (r.date && r.date > s) ? r.date : s, '');
  const okCount = rows.filter(r => r.price != null).length;
  stickyEl.style.display = 'block';
  stickyEl.innerHTML = '<div class="div-total-card" style="margin-bottom:0;padding:10px 14px">' +
    '<div class="div-total-count" style="margin:0">共 ' + rows.length + ' 支持股' +
    (okCount < rows.length ? '（' + (rows.length - okCount) + ' 檔查詢失敗）' : '') +
    (latestDate ? '｜收盤日 ' + latestDate : '') + '</div>' +
    '</div>';
  const dateLabel = document.getElementById('rtp-date-label');
  if (dateLabel) dateLabel.textContent = latestDate ? '收盤日：' + latestDate : '';
}

async function fetchRtpRow(stock, force) {
  try {
    const p = await fetchStockPrice(stock.code, force);
    return { stock, price: p.price, date: p.date, change: p.change, changePct: p.changePct };
  } catch (e) {
    return { stock, price: null, date: null, change: null, changePct: null, error: e.message };
  }
}

async function loadRealtimePrices(forceRefresh) {
  if (!portfolio.length) {
    document.getElementById('rtp-result').innerHTML =
      '<div class="div-no-portfolio"><div style="font-size:40px;margin-bottom:12px;opacity:.5">📋</div>' +
      '<div style="font-size:16px;color:var(--text2)">尚未建立持股資料</div></div>';
    return;
  }
  const loading = document.getElementById('rtp-loading');
  const resultEl = document.getElementById('rtp-result');
  const stickyEl = document.getElementById('rtp-total-sticky');
  const refreshBtn = document.getElementById('rtp-refresh-btn');

  loading.style.display = 'block';
  resultEl.innerHTML = '';
  if (stickyEl) stickyEl.style.display = 'none';
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    // 平行抓取（不像當日損益要序列查配息等附屬資料，純股價可以全部同時打）
    const rows = await Promise.all(portfolio.map(stock => fetchRtpRow(stock, forceRefresh)));
    rows.sort((a, b) => String(a.stock.code).localeCompare(String(b.stock.code), undefined, { numeric: true }));
    _rtpRows = rows;

    loading.style.display = 'none';
    rtpUpdateSticky(rows);
    resultEl.innerHTML = rows.length
      ? '<div class="value-grid">' + rows.map(buildRtpCardHtml).join('') + '</div>'
      : '<div class="div-empty">無資料</div>';
  } catch (err) {
    loading.style.display = 'none';
    resultEl.innerHTML = '<div class="div-empty"><div style="color:var(--danger)">' + err.message + '</div>' +
      '<button class="btn-primary" style="margin-top:16px;max-width:200px" onclick="loadRealtimePrices(true)">重試</button></div>';
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

// 單檔刷新：只重抓該檔股價，不影響其他持股
async function refreshOneRtpStock(code) {
  const idx = _rtpRows.findIndex(r => String(r.stock.code) === String(code));
  if (idx < 0) return;
  const btn = document.getElementById('rtp-refresh-' + code);
  if (btn) btn.classList.add('spinning');
  try {
    const newRow = await fetchRtpRow(_rtpRows[idx].stock, true);
    _rtpRows[idx] = newRow;
    const cardEl = document.querySelector('#rtp-result .vcard[data-code="' + code + '"]');
    if (cardEl) {
      const tmp = document.createElement('div');
      tmp.innerHTML = buildRtpCardHtml(newRow);
      cardEl.replaceWith(tmp.firstElementChild);
    }
    rtpUpdateSticky(_rtpRows);
  } catch (e) { /* 單檔刷新失敗不影響其他持股 */ }
  finally {
    const btnAfter = document.getElementById('rtp-refresh-' + code);
    if (btnAfter) btnAfter.classList.remove('spinning');
  }
}

// 進入畫面時自動載入（沿用快取，非強制）
if (typeof showScreen === 'function') {
  const _origShowScreenRtp = showScreen;
  showScreen = function (name) {
    _origShowScreenRtp(name);
    if (name === 'realtime-price') loadRealtimePrices(false);
  };
}
