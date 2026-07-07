// 股利總管 模組：holdings — ETF 成分股查詢（首頁卡片）
// 資料來源：成分股經 GAS ?holdings= 代理 MoneyDJ 全量解析；ETF 清單沿用 GAS ?finmind_etflist=

// ── 快取：ETF 清單（代碼↔名稱）與成分股，皆 1 天 ──
const ETF_UNIVERSE_KEY = 'etf_universe_v3'; // v3：只快取含淨值的完整清單（淘汰舊的無淨值快取）
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
    // 只採用「當日且含淨值」的快取；無淨值（僅 finmind）則忽略、重新抓
    if (cached && cached.day === _todayKey() && Array.isArray(cached.list) &&
        cached.list.some(e => e && e.nav != null)) {
      _etfUniverse = cached.list;
      return _etfUniverse;
    }
  } catch (e) {}

  // all_etf.txt（含淨值）約半數回空；重試至多 5 次直到「上市清單成功」（＝有淨值資料）。
  // 注意：finmind 有時單獨就 >200 但無淨值，故完整性以 all_etf 是否成功（allEtfOk）為準，不可只看筆數。
  const byCode = new Map();
  let allEtfOk = false;
  for (let attempt = 0; attempt < 5 && !allEtfOk; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 400 + 300 * attempt));
    // 1) 上市 ETF（mis.twse all_etf.txt：a=代碼、b=名稱、e=市價、f=淨值、g=折溢價%）
    try {
      const r1 = await fetch(GAS_URL + '?url=' + encodeURIComponent('https://mis.twse.com.tw/stock/data/all_etf.txt'));
      const d1 = await r1.json();
      let added = 0;
      (d1.a1 || []).forEach(inst => (inst.msgArray || []).forEach(x => {
        if (x.a && !byCode.has(x.a)) {
          const nav = parseFloat(x.f), price = parseFloat(x.e), prem = parseFloat(x.g);
          byCode.set(x.a, {
            code: String(x.a), name: x.b || '', market: 'twse',
            nav: isNaN(nav) ? null : nav,
            price: isNaN(price) ? null : price,
            premium: isNaN(prem) ? null : prem
          });
          added++;
        }
      }));
      if (added > 0) allEtfOk = true;
    } catch (e) { /* 上市清單失敗則重試 */ }
    // 2) 上櫃 ETF（GAS finmind：補上櫃代碼/名稱，無淨值）
    try {
      const r2 = await fetch(GAS_URL + '?finmind_etflist=1');
      const d2 = await r2.json();
      (d2.list || []).forEach(e => {
        const c = String(e.code);
        if (!byCode.has(c)) byCode.set(c, { code: c, name: e.name || '', market: e.market || 'otc' });
      });
    } catch (e) { /* 上櫃清單失敗不阻斷 */ }
  }

  const list = Array.from(byCode.values());
  // 只有「上市清單成功（含淨值）」才視為完整並快取一整天；否則不快取、_etfUniverse 不設，供背景重試
  if (allEtfOk && list.length >= 200) {
    _etfUniverse = list;
    try { localStorage.setItem(ETF_UNIVERSE_KEY, JSON.stringify({ day: _todayKey(), list })); } catch (e) {}
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

  // 先試 MoneyDJ（?holdings=）；台股 ETF 有股數
  let data = null;
  try {
    const res = await fetch(GAS_URL + '?holdings=' + encodeURIComponent(code));
    const j = await res.json();
    if (j.stat === 'OK' && (j.holdings || []).length) data = Object.assign({ source: 'MoneyDJ' }, j);
  } catch (e) { /* 轉 fallback */ }

  // MoneyDJ 無資料（主動式/境外 ETF）→ fallback CMoney（?cmconstituent=，含代碼/名稱/權重，無股數）
  if (!data) {
    try {
      const res2 = await fetch(GAS_URL + '?cmconstituent=' + encodeURIComponent(code));
      const j2 = await res2.json();
      if (j2.stat === 'OK' && (j2.holdings || []).length) data = Object.assign({ source: 'CMoney' }, j2);
    } catch (e) { /* 兩來源皆無 */ }
  }

  if (!data) {
    const err = new Error('查無成分股');
    err.stat = 'NODATA';
    throw err;
  }
  cache[code] = { ts: Date.now(), data };
  try { localStorage.setItem(HOLDINGS_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
  return data;
}

// 由已載入的 ETF 清單取淨值資訊（上市 ETF 才有；上櫃無 NAV）
function getNavInfo(code) {
  const uni = _etfUniverse || [];
  const c = String(code).toUpperCase();
  const e = uni.find(x => x.code.toUpperCase() === c);
  return (e && e.nav != null) ? e : null;
}

// 淨值（橘黃）＋市價（依當日漲跌紅漲綠跌）＋折溢價（溢紅折綠），同行接在代碼/名稱右側。
// 數值取自 all_etf（淨值/市價/折溢價同一快照）；市價漲跌方向另取 GAS ?price=（與當日損益同源）。
async function buildNavLineHtml(code) {
  // 共用「當日損益」的淨值來源 getEtfNav（需先 ensureNavMap）；市價無 e 時由淨值×(1+折溢價%)反推
  const info = (typeof getEtfNav === 'function') ? getEtfNav(code) : null;
  if (!info || info.nav == null) return '';
  let changePct = null;
  try {
    const p = await fetchStockPrice(code);
    if (p && p.changePct != null) changePct = p.changePct;
  } catch (e) { /* 漲跌方向取不到就不上色 */ }

  const parts = ['<span style="color:var(--accent2)">淨值 ' + info.nav.toFixed(2) + '</span>'];
  const price = (info.price != null) ? info.price
    : (info.premium != null ? info.nav * (1 + info.premium / 100) : null);
  if (price != null) {
    const pc = changePct > 0 ? '#ff5252' : (changePct < 0 ? '#26d962' : 'var(--text2)');
    parts.push('<span style="color:' + pc + '">市價 ' + price.toFixed(2) + '</span>');
  }
  if (info.premium != null) {
    const col = info.premium > 0 ? '#ff5252' : (info.premium < 0 ? '#26d962' : 'var(--text3)');
    const label = info.premium > 0 ? '溢' : (info.premium < 0 ? '折' : '');
    parts.push('<span style="color:' + col + '">' + label + (info.premium > 0 ? '+' : '') + info.premium.toFixed(2) + '%</span>');
  }
  return '<span class="holdings-nav">' + parts.join('　') + '</span>';
}

// ── 卡片頁籤切換 ──
function switchHoldingsTab(tab) {
  ['held', 'chart', 'chips', 'flow', 'query'].forEach(t => {
    const btn = document.getElementById('holdings-tab-' + t);
    const pane = document.getElementById('holdings-pane-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pane) pane.classList.toggle('active', t === tab);
  });
  if (tab === 'chart') renderNavChart();
  if (tab === 'chips') renderChipsTab();
  if (tab === 'flow') renderFlowTab();
}

// ── 頁籤「淨值對比」：各持有 ETF 淨值 vs 市價 橫條圖 ──
async function renderNavChart(retryCount) {
  const pane = document.getElementById('holdings-pane-chart');
  if (!pane) return;
  if (!portfolio.length) { pane.innerHTML = '<span class="holdings-hint">尚無持股</span>'; return; }
  const held = portfolio
    .filter(s => /^0\d/.test(String(s.code)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  if (!held.length) { pane.innerHTML = '<span class="holdings-hint">持股中無 ETF</span>'; return; }

  pane.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">' + spin('載入淨值…') + '</div>';
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    try { await ensureNavMap(i > 0); } catch (e) {}
    ok = held.some(s => getEtfNav(String(s.code).toUpperCase()));
    if (!ok) await new Promise(r => setTimeout(r, 1200));
  }

  // 依折溢價分組排列：折價組在前（絕對值由大到小）、溢價組在後（絕對值由大到小），無折溢價者排最後
  const items = held.map(s => {
    const code = String(s.code).toUpperCase();
    const info = getEtfNav(code);
    if (!info || info.nav == null) return null;
    return { code, info };
  }).filter(Boolean);
  items.sort((a, b) => {
    const pa = a.info.premium, pb = b.info.premium;
    const ga = pa == null ? 2 : (pa < 0 ? 0 : (pa > 0 ? 1 : 2));
    const gb = pb == null ? 2 : (pb < 0 ? 0 : (pb > 0 ? 1 : 2));
    if (ga !== gb) return ga - gb;
    return Math.abs(pb || 0) - Math.abs(pa || 0);
  });

  const rows = items.map(({ code, info }) => {
    const nav = info.nav;
    const price = (info.price != null) ? info.price : (info.premium != null ? nav * (1 + info.premium / 100) : nav);
    const prem = info.premium;
    // 折溢價差距很小（多在 ±2% 內），等比例看不出來 → 放大差距（每 1% 縮 8%，最多縮 45%），較長者滿版
    const amp = Math.min(Math.abs(prem || 0) * 8, 45);
    let navW = 100, priceW = 100;
    if (prem > 0) navW = 100 - amp;        // 市價 > 淨值 → 市價較長
    else if (prem < 0) priceW = 100 - amp; // 市價 < 淨值 → 淨值較長
    // 統一配色：溢價(市價>淨值)綠、折價(市價<淨值)紅。股票代碼、市價長條、折溢價%、價差文字皆同色。
    const priceCol = prem == null ? 'var(--text2)' : (prem > 0 ? '#5cb85c' : '#c9302c');
    const premLabel = prem == null ? '' : (prem > 0 ? '溢' : (prem < 0 ? '折' : '')) + (prem > 0 ? '+' : '') + prem.toFixed(2) + '%';
    // 市價-淨值價差：靠左疊於淨值長條上；最前與正負號後各加一個空格；無價差則不顯示
    const diff = Math.round((price - nav) * 100) / 100;
    const diffCol = diff > 0 ? '#5cb85c' : (diff < 0 ? '#c9302c' : 'var(--text)');
    const diffLabel = diff === 0 ? '' : ' ' + (diff > 0 ? '+' : '-') + ' ' + Math.abs(diff).toFixed(2);
    return '<div class="navchart-row">' +
      '<div class="navchart-code" style="color:' + priceCol + '">' + code + '</div>' +
      '<div class="navchart-bars">' +
        '<div class="navchart-diff" style="color:' + diffCol + '">' + diffLabel + '</div>' +
        '<div class="navchart-bar" style="width:' + navW + '%;background:var(--accent2)"></div>' +
        '<div class="navchart-bar" style="width:' + priceW + '%;background:' + priceCol + '"></div>' +
      '</div>' +
      '<div class="navchart-vals">' +
        '<div class="navchart-vcol">' +
          '<div style="color:var(--accent2)">淨值 ' + nav.toFixed(2) + '</div>' +
          '<div><span style="color:' + priceCol + '">市價 ' + price.toFixed(2) + '</span></div>' +
        '</div>' +
        '<div class="navchart-pcol">' +
          '<div id="navchart-est-' + code + '">&nbsp;</div>' +
          '<div>' + (premLabel ? '<span style="color:' + priceCol + '">' + premLabel + '</span>' : '&nbsp;') + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).filter(Boolean).join('');

  if (!rows) {
    pane.innerHTML = '<div style="padding:20px;text-align:center"><span class="holdings-nav-status fail" onclick="renderNavChart()">淨值載入失敗，點此重試</span></div>';
    return;
  }
  pane.innerHTML =
    '<div class="navchart-legend"><span><i style="background:var(--accent2)"></i>淨值</span>' +
    '<span><i style="background:#5cb85c"></i>市價&gt;淨值(溢)</span><span><i style="background:#c9302c"></i>市價&lt;淨值(折)</span></div>' +
    rows;
  alignNavChartCols();

  // 背景填入估算漲跌（僅可估算者顯示，如境外/主動式；其餘留空）
  for (const s of held) {
    const code = String(s.code).toUpperCase();
    const el = document.getElementById('navchart-est-' + code);
    if (!el || !getEtfNav(code)) continue;
    const pct = await getEtfEstChange(code);
    if (pct == null) continue;
    const col = pct > 0 ? '#ff5252' : (pct < 0 ? '#26d962' : 'var(--text2)');
    const ar = pct > 0 ? '▲' : (pct < 0 ? '▼' : '—');
    el.innerHTML = '<span style="color:' + col + ';font-size:12px;font-weight:700">估算 ' +
      ar + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
    alignNavChartCols();
  }
}

// 統一「淨值對比」各欄寬度：每欄依該欄最寬內容自動撐開（欄內文字保持靠左）
function alignNavChartCols() {
  const pane = document.getElementById('holdings-pane-chart');
  if (!pane) return;
  ['navchart-code', 'navchart-vcol', 'navchart-pcol'].forEach(cls => {
    const els = pane.querySelectorAll('.' + cls);
    if (!els.length) return;
    els.forEach(el => { el.style.width = 'auto'; });
    let max = 0;
    els.forEach(el => { max = Math.max(max, el.getBoundingClientRect().width); });
    els.forEach(el => { el.style.width = Math.ceil(max) + 'px'; });
  });
}

// 取某 ETF 估算漲跌%（境外/主動式可報價者；否則 null）。沿用成分股/現價快取
async function getEtfEstChange(code) {
  try {
    const data = await fetchEtfHoldings(code);
    if (data.source !== 'CMoney' || !holdingsPriceable(data.holdings)) return null;
    try { await ensureNavMap(); } catch (e) {}
    const priceData = await fetchConstituentPrices((data.holdings || []).map(h => h.code));
    const est = computeEstNav(code, data.holdings, priceData);
    return est ? est.estChangePct : null;
  } catch (e) { return null; }
}

// 載入/重算單一持有 ETF 卡片的成分股與現價估算，寫入該卡片的 meta/body（供初次載入與單卡刷新共用）
async function renderOneHeldCard(code, force) {
  const meta = document.getElementById('hold-meta-' + code);
  const body = document.getElementById('hold-body-' + code);
  if (force) {
    try {
      const hc = JSON.parse(localStorage.getItem(HOLDINGS_CACHE_KEY) || '{}');
      delete hc[code];
      localStorage.setItem(HOLDINGS_CACHE_KEY, JSON.stringify(hc));
    } catch (e) {}
  }
  const data = await fetchEtfHoldings(code);
  // 境外/主動式（CMoney）且成分股為可報價股票：帶現價＋估算淨值（債券 ETF 成分股為債券，跳過）
  // 台股（MoneyDJ）成分股：直接帶現價＋漲跌幅
  let priceData = null, est = null;
  if (data.source === 'CMoney' && holdingsPriceable(data.holdings)) {
    if (meta) meta.innerHTML = spin('估算中…');
    try { await ensureNavMap(force); } catch (e) {}
    priceData = await fetchConstituentPrices((data.holdings || []).map(h => h.code), force);
    est = computeEstNav(code, data.holdings, priceData);
  } else if (data.source === 'MoneyDJ' && holdingsPriceable(data.holdings)) {
    if (meta) meta.innerHTML = spin('載入成分股現價中…');
    priceData = await fetchConstituentPricesTW((data.holdings || []).map(h => h.code), force);
    try { await ensureNavMap(force); } catch (e) {}
    est = computeEstNav(code, data.holdings, priceData);
  }
  let estTag = '';
  if (est) {
    const pc = est.estChangePct;
    const col = pc > 0 ? '#ff5252' : (pc < 0 ? '#26d962' : 'var(--text2)');
    const ar = pc > 0 ? '▲' : (pc < 0 ? '▼' : '—');
    estTag = '｜<span style="color:' + col + ';font-weight:700">估算 ' + ar + (pc > 0 ? '+' : '') + pc.toFixed(2) + '%</span>';
  }
  if (meta) meta.innerHTML = '共 ' + data.count + ' 檔成分股' + (data.date ? '｜資料日 ' + data.date : '') + estTag;
  if (body) body.innerHTML = holdingsTableHtml(data, priceData);
}

// 單卡刷新：強制重抓該檔成分股/現價/估算，不影響其他持有 ETF 卡片
async function refreshOneHeldEtf(code) {
  const btn = document.getElementById('hold-refresh-' + code);
  if (btn) btn.classList.add('spinning');
  try {
    await renderOneHeldCard(code, true);
    const navSlot = document.getElementById('hold-nav-' + code);
    if (navSlot) navSlot.innerHTML = await buildNavLineHtml(code);
  } catch (e) {
    const meta = document.getElementById('hold-meta-' + code);
    if (meta) meta.innerHTML = '<span style="color:var(--danger)">' + (e.stat === 'NODATA' ? '無成分股' : '載入失敗') + '</span>';
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

// ── 頁籤「持有」：持有 ETF 自動帶入成分股（快取、隔日更新），比照當日損益折疊卡片 ──
let _heldHoldingsLoading = false;
async function renderHeldEtfHoldings() {
  const wrap = document.getElementById('holdings-held-list');
  if (!wrap || _heldHoldingsLoading) return;
  const toggleAllBtn = document.getElementById('holdings-toggle-all');
  const hideToggle = () => { if (toggleAllBtn) toggleAllBtn.style.display = 'none'; };
  if (!portfolio.length) { wrap.innerHTML = '<span class="holdings-hint">尚無持股</span>'; hideToggle(); return; }

  // ETF 判定用代碼慣例（台股 ETF 代碼以 0 開頭；個股為 4 碼非 0 開頭），不依賴會抖動的清單來源
  const heldEtfs = portfolio
    .filter(s => /^0\d/.test(String(s.code)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  if (!heldEtfs.length) { wrap.innerHTML = '<span class="holdings-hint">持股中無 ETF</span>'; hideToggle(); return; }

  _heldHoldingsLoading = true;
  if (toggleAllBtn) toggleAllBtn.style.display = '';
  // 先畫出各檔骨架（成分股用可靠的 ?holdings=，先渲染；NAV 走會抖動的清單，背景補上）
  wrap.innerHTML = heldEtfs.map(s => {
    const code = String(s.code).toUpperCase();
    const name = s.name || '';
    return '<div class="vcard" style="margin-bottom:8px;position:relative" id="hold-card-' + code + '">' +
      '<button class="holdings-refresh-btn" id="hold-refresh-' + code + '" onclick="refreshOneHeldEtf(\'' + code + '\')" ' +
        'title="重新整理" aria-label="重新整理' + code + '">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
      '</button>' +
      '<div class="vcard-head" style="display:flex;align-items:baseline;gap:6px;white-space:nowrap;overflow:hidden;padding-right:20px">' +
        '<span class="vcard-code" style="flex-shrink:0">' + code + '</span>' +
        '<span class="vcard-name" id="hold-name-' + code + '" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">' + name + '</span>' +
        '<span class="holdings-nav-slot" id="hold-nav-' + code + '"><span class="holdings-nav-status">' + spin('淨值載入中…') + '</span></span></div>' +
      '<div class="holdings-item-summary" id="hold-meta-' + code + '" style="padding-right:20px">' + spin('載入中…') + '</div>' +
      '<div class="vcard-fold" id="hold-body-' + code + '"></div>' +
      '<button class="vcard-chev" id="hold-chev-' + code + '" onclick="toggleHeldItem(\'' + code + '\')">▼</button>' +
    '</div>';
  }).join('');

  for (const s of heldEtfs) {
    const code = String(s.code).toUpperCase();
    try {
      await renderOneHeldCard(code, false);
    } catch (e) {
      const meta = document.getElementById('hold-meta-' + code);
      const chev = document.getElementById('hold-chev-' + code);
      if (meta) meta.innerHTML = '<span style="color:var(--danger)">' + (e.stat === 'NODATA' ? '無成分股' : '載入失敗') + '</span>';
      if (chev) chev.style.display = 'none';
    }
  }
  _heldHoldingsLoading = false;
  applyCnameState();

  // 背景補上 NAV（淨值/市價/折溢價），含載入中／失敗重試提示
  _lastHeldEtfs = heldEtfs;
  loadHeldNav(heldEtfs);
  _syncHeldToggleLabel();
}

// 背景載入 ETF 清單 → 補 NAV。all_etf 來源約半數回空，多輪重試；成功補值、逾試顯示失敗可重試。
let _lastHeldEtfs = null;
async function loadHeldNav(heldEtfs) {
  const setStatus = html => heldEtfs.forEach(s => {
    const slot = document.getElementById('hold-nav-' + String(s.code).toUpperCase());
    if (slot) slot.innerHTML = html;
  });
  setStatus('<span class="holdings-nav-status">' + spin('淨值載入中…') + '</span>');

  // 用與「當日損益」相同的 getEtfNav/ensureNavMap（首輪吃快取，通常已由當日損益載好）
  for (let round = 0; round < 6; round++) {
    let ok = false;
    try { await ensureNavMap(round > 0); ok = true; } catch (e) { ok = false; }
    const ready = ok && heldEtfs.some(s => getEtfNav(String(s.code).toUpperCase()));
    if (ready) {
      for (const s of heldEtfs) {
        const code = String(s.code).toUpperCase();
        const navSlot = document.getElementById('hold-nav-' + code);
        if (navSlot) {
          const html = await buildNavLineHtml(code);
          navSlot.innerHTML = html || '<span class="holdings-nav-status">無淨值資料</span>';
        }
      }
      return;
    }
    if (round < 5) setStatus('<span class="holdings-nav-status">' + spin('淨值載入中…(' + (round + 2) + ')') + '</span>');
    await new Promise(r => setTimeout(r, 1200));
  }
  // 多輪仍失敗 → 提示可重試
  setStatus('<span class="holdings-nav-status fail" onclick="retryHeldNav()">淨值載入失敗，點此重試</span>');
}

function retryHeldNav() {
  if (_lastHeldEtfs) loadHeldNav(_lastHeldEtfs);
}

function toggleHeldItem(code) {
  const body = document.getElementById('hold-body-' + code);
  const chev = document.getElementById('hold-chev-' + code);
  if (!body) return;
  const open = !body.classList.contains('open');
  body.classList.toggle('open', open);
  if (chev) chev.textContent = open ? '▲' : '▼';
  _syncHeldToggleLabel();
}

function _heldFolds() {
  return Array.prototype.slice.call(document.querySelectorAll('#holdings-held-list .vcard-fold'));
}
function _syncHeldToggleLabel() {
  const btn = document.getElementById('holdings-toggle-all');
  if (!btn) return;
  const folds = _heldFolds();
  const anyClosed = folds.some(f => !f.classList.contains('open'));
  btn.textContent = anyClosed ? '全部展開' : '全部收合';
}
function toggleAllHeld(btn) {
  const folds = _heldFolds();
  if (!folds.length) return;
  const anyClosed = folds.some(f => !f.classList.contains('open'));
  folds.forEach(f => f.classList.toggle('open', anyClosed));
  document.querySelectorAll('#holdings-held-list .vcard-chev').forEach(b => { b.textContent = anyClosed ? '▲' : '▼'; });
  if (btn) btn.textContent = anyClosed ? '全部收合' : '全部展開';
}

// 成分股表格 HTML（持有折疊區與 modal 共用）。priceData 有值時（境外/CMoney）末欄改「現價」
function holdingsTableHtml(data, priceData) {
  const holdings = data.holdings || [];
  const hasShares = holdings.some(h => h.shares != null);
  // 末欄模式：有現價→現價；否則有股數→持股數；都無（如債券 ETF）→不顯示末欄
  const lastMode = priceData ? 'price' : (hasShares ? 'shares' : 'none');
  const lastLabel = lastMode === 'price' ? '現價' : (lastMode === 'shares' ? '持股數' : '');
  // 依權重由高至低排列（權重缺漏者排最後）
  const sorted = [...holdings].sort((a, b) =>
    (typeof b.weight === 'number' ? b.weight : -1) - (typeof a.weight === 'number' ? a.weight : -1));
  const rows = sorted.map((h, i) => {
    let lastCell = '';
    if (lastMode === 'price') {
      const sym = String(h.code).replace(/\s*US$/i, '').trim();
      const p = priceData.prices[sym];
      if (p && p.price != null) {
        const col = p.changePct > 0 ? '#ff5252' : (p.changePct < 0 ? '#26d962' : 'var(--text2)');
        const chgTxt = (p.changePct != null) ? (p.changePct > 0 ? '+' : '') + p.changePct.toFixed(2) + '%' : '';
        lastCell = '<div style="color:' + col + '">' + p.price.toFixed(2) + '</div>' +
          (chgTxt ? '<div style="font-size:10px;color:' + col + '">' + chgTxt + '</div>' : '');
      } else lastCell = '<span style="color:var(--text3)">—</span>';
    } else if (lastMode === 'shares') {
      lastCell = (h.shares != null ? h.shares.toLocaleString('zh-TW') : '—');
    }
    const nm = (h.name || '').replace(/"/g, '&quot;');
    return '<tr style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:6px 6px;color:var(--text3);text-align:right;width:28px">' + (i + 1) + '</td>' +
      '<td style="padding:6px 6px;white-space:nowrap">' +
        '<span style="font-weight:600" title="' + nm + '">' + h.code + '</span>' +
        '<span class="cname" style="color:var(--text2);margin-left:6px">' + h.name + '</span></td>' +
      '<td style="padding:6px 6px;text-align:right;color:var(--accent2);font-weight:600;white-space:nowrap">' + (typeof h.weight === 'number' ? h.weight.toFixed(2) + '%' : '—') + '</td>' +
      (lastMode === 'none' ? '' : '<td style="padding:6px 6px;text-align:right;color:var(--text2);white-space:nowrap">' + lastCell + '</td>') +
    '</tr>';
  }).join('');
  return '<div style="overflow-x:auto">' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    '<thead><tr style="border-bottom:2px solid var(--border)">' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:right">#</th>' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:left">成分股</th>' +
      '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:right">權重</th>' +
      (lastMode === 'none' ? '' : '<th style="padding:6px 6px;color:var(--text3);font-weight:600;text-align:right">' + lastLabel + '</th>') +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// 批次抓台股成分股現價（沿用 fetchStockPrice 既有快取/非盤中不重抓機制），分批呼叫避免尖峰
async function fetchConstituentPricesTW(codes, force) {
  const uniq = [...new Set((codes || []).map(c => String(c).trim()).filter(Boolean))];
  const prices = {};
  const batchSize = 5;
  for (let i = 0; i < uniq.length; i += batchSize) {
    const batch = uniq.slice(i, i + batchSize);
    await Promise.all(batch.map(async code => {
      try {
        const p = await fetchStockPrice(code, force);
        if (p && p.price != null) prices[code] = { price: p.price, changePct: p.changePct };
      } catch (e) { /* 單檔失敗不影響其他 */ }
    }));
  }
  return { prices, fx: null };
}

// 成分股是否為可報價的股票（美股 "XXX US" 或台股數字代碼）；債券 ISIN 等回 false
function holdingsPriceable(holdings) {
  const codes = (holdings || []).map(h => String(h.code || ''));
  if (!codes.length) return false;
  const isStock = c => /\sUS$/i.test(c) || /^\d{4,6}[A-Z]?$/.test(c);
  return codes.filter(isStock).length / codes.length >= 0.5;
}

// 動態圓圈 spinner + 文字
function spin(text) { return '<span class="mini-spinner"></span>' + (text || ''); }

// 成分股名稱顯示/隱藏（全域 CSS class 切換，隱藏後代碼 tooltip 仍可看名稱）
function applyCnameState() {
  const hide = localStorage.getItem('holdings_hide_cname') === '1';
  document.body.classList.toggle('hide-cnames', hide);
  document.querySelectorAll('.cname-toggle').forEach(b => { b.textContent = hide ? '顯示名稱' : '隱藏名稱'; });
}
function toggleConstituentNames() {
  const hide = localStorage.getItem('holdings_hide_cname') === '1';
  localStorage.setItem('holdings_hide_cname', hide ? '0' : '1');
  applyCnameState();
}

// 批次抓成分股現價（GAS ?usprices=，記憶體快取 15 分）；代碼去除 " US" 後綴
const USPRICE_TTL = 15 * 60 * 1000;
const _uspriceCache = {};
async function fetchConstituentPrices(codes, force) {
  const syms = [...new Set((codes || []).map(c => String(c).replace(/\s*US$/i, '').trim()).filter(Boolean))];
  if (!syms.length) return null;
  const key = syms.slice().sort().join(',');
  const hit = _uspriceCache[key];
  if (!force && hit && Date.now() - hit.ts < USPRICE_TTL) return hit;
  try {
    const r = await fetch(GAS_URL + '?usprices=' + encodeURIComponent(syms.join(',')));
    const j = await r.json();
    if (j.stat === 'OK') { const v = { ts: Date.now(), prices: j.prices || {}, fx: j.fx || null }; _uspriceCache[key] = v; return v; }
  } catch (e) {}
  return null;
}

// 估算淨值 = 最近官方淨值 ×(1 + Σ 權重×台幣漲跌)，台幣漲跌=(1+美元漲跌)(1+匯率漲跌)-1
function computeEstNav(etfCode, holdings, priceData) {
  const info = (typeof getEtfNav === 'function') ? getEtfNav(etfCode) : null;
  if (!info || info.nav == null || !priceData) return null;
  const fxR = (priceData.fx && priceData.fx.changePct != null) ? priceData.fx.changePct / 100 : 0;
  let wret = 0, covered = 0;
  (holdings || []).forEach(h => {
    if (typeof h.weight !== 'number') return;
    const sym = String(h.code).replace(/\s*US$/i, '').trim();
    const p = priceData.prices[sym];
    if (p && p.changePct != null) {
      const usdR = p.changePct / 100;
      const twdR = (1 + usdR) * (1 + fxR) - 1;
      wret += (h.weight / 100) * twdR;
      covered += h.weight;
    }
  });
  if (covered < 50) return null; // 覆蓋率太低不估
  return { estNav: info.nav * (1 + wret), officialNav: info.nav, estChangePct: wret * 100, coveredPct: Math.round(covered) };
}

// 估算表頭 HTML：估算漲跌幅為主（開盤前預估趨勢），估算/官方淨值為輔
function estNavHeaderHtml(est) {
  if (!est) return '';
  const pct = est.estChangePct;
  const col = pct > 0 ? '#ff5252' : (pct < 0 ? '#26d962' : 'var(--text2)');
  const arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '—');
  return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;padding:10px 12px;background:var(--bg4);border-radius:8px">' +
    '<div><div style="font-size:10px;color:var(--text3)">估算漲跌（開盤前預估）</div>' +
      '<div style="font-size:22px;font-weight:800;letter-spacing:-.5px;color:' + col + '">' + arrow + ' ' +
      (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</div></div>' +
    '<div style="text-align:right">' +
      '<div style="font-size:11px;color:' + col + '">估算淨值 ' + est.estNav.toFixed(2) + '</div>' +
      '<div style="font-size:11px;color:var(--text3)">官方淨值 ' + est.officialNav.toFixed(2) + '</div></div>' +
    '</div>';
}

// ── 查詢入口：直接帶代碼，或讀輸入框 ──
async function queryHoldings(codeOrInput) {
  const statusEl = document.getElementById('holdings-status');
  let input = codeOrInput;
  if (input == null) input = document.getElementById('holdings-input').value;
  input = String(input || '').trim();
  if (!input) { if (statusEl) statusEl.textContent = '請輸入代碼或名稱'; return; }

  if (statusEl) statusEl.innerHTML = spin('查詢中…');
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
    if (statusEl) statusEl.innerHTML = spin('載入 ' + etf.code + ' 成分股…');
    const data = await fetchEtfHoldings(etf.code);
    data.name = etf.name;
    try { await ensureNavMap(); } catch (e) { /* 無淨值不阻斷成分股 */ }
    const navHtml = await buildNavLineHtml(etf.code);
    // 境外/主動式（CMoney 來源）且成分股可報價：抓現價、算估算淨值（債券 ETF 跳過）
    let priceData = null, est = null;
    if (data.source === 'CMoney' && holdingsPriceable(data.holdings)) {
      if (statusEl) statusEl.innerHTML = spin('估算中…');
      priceData = await fetchConstituentPrices((data.holdings || []).map(h => h.code));
      est = computeEstNav(etf.code, data.holdings, priceData);
    }
    renderHoldingsModal(data, navHtml, priceData, est);
    if (statusEl) statusEl.textContent = '';
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger)">' + (e.message || '查詢失敗') + '</span>';
  }
}

function renderHoldingsModal(data, navHtml, priceData, est) {
  const titleEl = document.getElementById('modal-holdings-title');
  const bodyEl = document.getElementById('modal-holdings-body');
  if (!titleEl || !bodyEl) return;

  titleEl.style.display = 'flex';
  titleEl.style.flexWrap = 'nowrap';
  titleEl.style.alignItems = 'baseline';
  titleEl.style.gap = '6px';
  titleEl.style.overflow = 'hidden';
  titleEl.innerHTML = '<span style="flex-shrink:0">' + data.code + '</span>' +
    (data.name ? '<span style="font-size:13px;font-weight:400;color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + data.name + '</span>' : '') +
    (navHtml || '');

  bodyEl.innerHTML =
    estNavHeaderHtml(est) +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<span style="font-size:11px;color:var(--text3)">共 ' + (data.count || (data.holdings || []).length) +
      ' 檔成分股' + (data.date ? '｜資料日 ' + data.date : '') + '</span>' +
      '<button class="cname-toggle" onclick="toggleConstituentNames()">隱藏名稱</button>' +
    '</div>' +
    holdingsTableHtml(data, priceData) +
    '<div class="api-note" style="margin-top:10px">資料來源：' + (data.source === 'CMoney'
      ? (priceData ? 'CMoney（境外/主動式 ETF，僅權重無持股數）；估算淨值＝官方淨值×(1+Σ權重×漲跌×匯率)，僅供參考'
        : 'CMoney（債券/非股票成分股，無現價與估算淨值）')
      : 'MoneyDJ 理財網') + '。每日更新。</div>';

  openModal('modal-holdings');
  applyCnameState();
}

// 進入「ETF 成分股查詢」畫面時自動帶入持有 ETF 成分股（由 showScreen patch 觸發）
if (typeof showScreen === 'function') {
  const _origShowScreenHoldings = showScreen;
  showScreen = function (name) {
    _origShowScreenHoldings(name);
    if (name === 'holdings') {
      switchHoldingsTab('held');
      renderHeldEtfHoldings();
    }
  };
}
