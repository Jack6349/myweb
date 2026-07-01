// 股利總管 模組：holdings — ETF 成分股查詢（首頁卡片）
// 資料來源：成分股經 GAS ?holdings= 代理 MoneyDJ 全量解析；ETF 清單沿用 GAS ?finmind_etflist=

// ── 快取：ETF 清單（代碼↔名稱）與成分股，皆 1 天 ──
const ETF_UNIVERSE_KEY = 'etf_universe_v1';
const HOLDINGS_CACHE_KEY = 'etf_holdings_v1';
const HOLDINGS_TTL = 24 * 60 * 60 * 1000; // 1 天

let _etfUniverse = null; // [{code,name,market}]

function _todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

// 取得全台 ETF 清單（代碼/名稱），快取 1 天。
// 合併兩來源：上市用 mis.twse all_etf.txt（含 0050/00900…約 340+ 檔）、上櫃用 GAS finmind_etflist。
async function loadEtfUniverse() {
  if (_etfUniverse) return _etfUniverse;
  try {
    const cached = JSON.parse(localStorage.getItem(ETF_UNIVERSE_KEY) || 'null');
    if (cached && cached.day === _todayKey() && Array.isArray(cached.list) && cached.list.length) {
      _etfUniverse = cached.list;
      return _etfUniverse;
    }
  } catch (e) {}

  const byCode = new Map();
  // 1) 上市 ETF（mis.twse all_etf.txt：a=代碼、b=名稱）
  try {
    const r1 = await fetch(GAS_URL + '?url=' + encodeURIComponent('https://mis.twse.com.tw/stock/data/all_etf.txt'));
    const d1 = await r1.json();
    (d1.a1 || []).forEach(inst => (inst.msgArray || []).forEach(x => {
      if (x.a && !byCode.has(x.a)) byCode.set(x.a, { code: String(x.a), name: x.b || '', market: 'twse' });
    }));
  } catch (e) { /* 上市清單失敗不阻斷上櫃 */ }
  // 2) 上櫃 ETF（GAS finmind）
  try {
    const r2 = await fetch(GAS_URL + '?finmind_etflist=1');
    const d2 = await r2.json();
    (d2.list || []).forEach(e => {
      const c = String(e.code);
      if (!byCode.has(c)) byCode.set(c, { code: c, name: e.name || '', market: e.market || 'otc' });
    });
  } catch (e) { /* 上櫃清單失敗不阻斷 */ }

  const list = Array.from(byCode.values());
  _etfUniverse = list;
  // 兩來源回傳偶有抖動（部分為空），清單過小不寫快取，避免凍結不完整清單一整天
  if (list.length >= 200) {
    try { localStorage.setItem(ETF_UNIVERSE_KEY, JSON.stringify({ day: _todayKey(), list })); } catch (e) {}
  } else {
    _etfUniverse = null; // 下次重抓
  }
  return list;
}

// 比對輸入（代碼或名稱關鍵字）→ ETF 候選清單
async function resolveHoldingsQuery(input) {
  const q = String(input || '').trim();
  if (!q) return [];
  const uni = await loadEtfUniverse();
  const qUpper = q.toUpperCase();
  // 代碼完全相符優先
  const exact = uni.filter(e => e.code.toUpperCase() === qUpper);
  if (exact.length) return exact;
  // 代碼前綴 + 名稱關鍵字
  return uni.filter(e =>
    e.code.toUpperCase().indexOf(qUpper) === 0 ||
    e.name.indexOf(q) >= 0
  ).slice(0, 20);
}

// 抓 ETF 成分股（GAS ?holdings=），快取 1 天
async function fetchEtfHoldings(code) {
  code = String(code).toUpperCase().replace(/\.TW$/, '');
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(HOLDINGS_CACHE_KEY) || '{}'); } catch (e) {}
  const hit = cache[code];
  if (hit && (Date.now() - hit.ts) < HOLDINGS_TTL) return hit.data;

  const res = await fetch(GAS_URL + '?holdings=' + encodeURIComponent(code));
  const data = await res.json();
  if (data.stat !== 'OK') {
    const err = new Error(data.error || (data.stat === 'NODATA' ? '查無成分股' : '查詢失敗'));
    err.stat = data.stat;
    throw err;
  }
  cache[code] = { ts: Date.now(), data };
  try { localStorage.setItem(HOLDINGS_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  return data;
}

// ── 首頁卡片：持有 ETF 自動帶入成分股（快取、隔日更新），可折疊 ──
let _heldHoldingsLoading = false;
async function renderHeldEtfHoldings() {
  const wrap = document.getElementById('holdings-held-list');
  if (!wrap || _heldHoldingsLoading) return;
  if (!portfolio.length) { wrap.innerHTML = '<span class="holdings-hint">尚無持股</span>'; return; }

  let uni;
  try { uni = await loadEtfUniverse(); } catch (e) { wrap.innerHTML = '<span class="holdings-hint">ETF 清單載入失敗</span>'; return; }
  const etfCodes = new Set(uni.map(e => e.code.toUpperCase()));
  const nameByCode = {};
  uni.forEach(e => { nameByCode[e.code.toUpperCase()] = e.name; });
  const heldEtfs = portfolio
    .filter(s => etfCodes.has(String(s.code).toUpperCase()))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  if (!heldEtfs.length) { wrap.innerHTML = '<span class="holdings-hint">持股中無 ETF</span>'; return; }

  _heldHoldingsLoading = true;
  // 先畫出各檔骨架（載入中），再逐檔補上資料
  wrap.innerHTML = heldEtfs.map(s => {
    const code = String(s.code).toUpperCase();
    const name = s.name || nameByCode[code] || '';
    return '<div class="holdings-item" id="hold-item-' + code + '">' +
      '<button class="holdings-item-head" onclick="toggleHeldItem(\'' + code + '\')">' +
        '<span class="holdings-item-code">' + code +
          '<span class="holdings-chip-name">' + name + '</span></span>' +
        '<span class="holdings-item-meta" id="hold-meta-' + code + '">載入中…</span>' +
        '<span class="holdings-item-chev" id="hold-chev-' + code + '">▼</span>' +
      '</button>' +
      '<div class="holdings-item-body" id="hold-body-' + code + '"></div>' +
    '</div>';
  }).join('');

  for (const s of heldEtfs) {
    const code = String(s.code).toUpperCase();
    try {
      const data = await fetchEtfHoldings(code);
      const meta = document.getElementById('hold-meta-' + code);
      const body = document.getElementById('hold-body-' + code);
      if (meta) meta.textContent = '共 ' + data.count + ' 檔' + (data.date ? '｜' + data.date : '');
      if (body) body.innerHTML = holdingsTableHtml(data);
    } catch (e) {
      const meta = document.getElementById('hold-meta-' + code);
      if (meta) meta.innerHTML = '<span style="color:var(--danger)">' + (e.stat === 'NODATA' ? '無成分股' : '載入失敗') + '</span>';
    }
  }
  _heldHoldingsLoading = false;
}

function toggleHeldItem(code) {
  const body = document.getElementById('hold-body-' + code);
  const chev = document.getElementById('hold-chev-' + code);
  if (!body) return;
  const open = !body.classList.contains('open');
  body.classList.toggle('open', open);
  if (chev) chev.textContent = open ? '▲' : '▼';
}

// 成分股表格 HTML（持有折疊區與 modal 共用）
function holdingsTableHtml(data) {
  const rows = (data.holdings || []).map((h, i) =>
    '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:6px 6px;color:var(--text3);text-align:right;width:28px">' + (i + 1) + '</td>' +
      '<td style="padding:6px 6px;white-space:nowrap">' +
        '<span style="font-weight:600">' + h.code + '</span>' +
        '<span style="color:var(--text2);margin-left:6px">' + h.name + '</span></td>' +
      '<td style="padding:6px 6px;text-align:right;color:var(--accent2);font-weight:600;white-space:nowrap">' + h.weight.toFixed(2) + '%</td>' +
      '<td style="padding:6px 6px;text-align:right;color:var(--text2);white-space:nowrap">' + h.shares.toLocaleString('zh-TW') + '</td>' +
    '</tr>'
  ).join('');
  return '<div style="overflow-x:auto">' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<thead><tr style="border-bottom:2px solid var(--border)">' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:right">#</th>' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:left">成分股</th>' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:right">權重</th>' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:right">持股數</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── 查詢入口：直接帶代碼，或讀輸入框 ──
async function queryHoldings(codeOrInput) {
  const statusEl = document.getElementById('holdings-status');
  let input = codeOrInput;
  if (input == null) input = document.getElementById('holdings-input').value;
  input = String(input || '').trim();
  if (!input) { if (statusEl) statusEl.textContent = '請輸入代碼或名稱'; return; }

  if (statusEl) statusEl.textContent = '查詢中…';
  try {
    const matches = await resolveHoldingsQuery(input);
    if (matches.length === 0) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text2)">查無此 ETF（個股無成分股）</span>';
      return;
    }
    if (matches.length > 1) {
      // 多筆候選 → 顯示選單
      if (statusEl) statusEl.innerHTML = '請選擇：<div class="holdings-cands">' +
        matches.map(e => '<button class="holdings-chip" onclick="queryHoldings(\'' + e.code + '\')">' +
          e.code + '<span class="holdings-chip-name">' + e.name + '</span></button>').join('') + '</div>';
      return;
    }
    const etf = matches[0];
    if (statusEl) statusEl.textContent = '載入 ' + etf.code + ' 成分股…';
    const data = await fetchEtfHoldings(etf.code);
    data.name = etf.name;
    renderHoldingsModal(data);
    if (statusEl) statusEl.textContent = '';
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + (e.message || '查詢失敗') + '</span>';
  }
}

function renderHoldingsModal(data) {
  const titleEl = document.getElementById('modal-holdings-title');
  const bodyEl = document.getElementById('modal-holdings-body');
  if (!titleEl || !bodyEl) return;

  titleEl.innerHTML = data.code +
    (data.name ? ' <span style="font-size:13px;font-weight:400;color:var(--text2)">' + data.name + '</span>' : '');

  bodyEl.innerHTML =
    '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">共 ' + (data.count || (data.holdings || []).length) +
      ' 檔成分股' + (data.date ? '｜資料日 ' + data.date : '') + '</div>' +
    holdingsTableHtml(data) +
    '<div class="api-note" style="margin-top:10px">資料來源：MoneyDJ 理財網。權重與持股數每日更新。</div>';

  openModal('modal-holdings');
}

// 首頁顯示時刷新持有 ETF chips（由 showScreen patch 觸發）
if (typeof showScreen === 'function') {
  const _origShowScreenHoldings = showScreen;
  showScreen = function (name) {
    _origShowScreenHoldings(name);
    if (name === 'home') { renderHeldEtfHoldings(); }
  };
}
