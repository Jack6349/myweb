// 股利總管 Web — 持股庫存成份股（成份股漲跌欄＋成份股彈窗）
// 清單：MoneyDJ/CMoney（沿用 trend.js fetchEtfConstituents），每日 localStorage 快取
// 台股成份股：Shioaji 批次快照輪詢（盤中 5 秒、彈窗開啟 3 秒）
// 美股等外市：GAS ?usquote= 批次（Yahoo spark，一次 UrlFetch 抓多檔），僅美股盤中每 5 分鐘一輪
//   ——切勿改回逐檔 ?url= 抓法：51+ 檔×5 分鐘×24h 會打爆 GAS 單日 20,000 次 UrlFetch 配額（2026/07 實際發生過）
// 不使用行情訂閱（保留 200 檔額度給既有功能）

var CONST_COVER_MIN = 35;  // 權重覆蓋率門檻%（已取得報價的權重合計 ≥35 才顯示）
var _constPxAt = null;     // 最近一次報價擷取完成時間（彈窗標籤顯示用）

// 發行商官網成份股 API：ETF 代號 → 安聯基金代碼（GAS ?allianz= 分支，每日快取）
// 官網資料最新（每日更新）；抓失敗自動退回下方 HOLDINGS_OVERRIDES 手動清單，下次進頁再重試官網
var ALLIANZ_FUNDS = { '00402A': 'E0003' };

// 手動成份股清單：境外/主動式 ETF CMoney 已將資料移到需登入 API、MoneyDJ 無收錄，
// 純前端/GAS 抓不到 → 手動維護。code 用 CMoney 原格式「XXX US」，會經 constituentSymbol→Yahoo。
// 00402A 已改走安聯官網 API（上方 ALLIANZ_FUNDS），此處清單降為官網抓失敗時的備援。
// 更新方式：CMoney 該檔「持股明細」頁複製，貼進下方（權重去 %）。
var HOLDINGS_OVERRIDES = {
  '00402A': { source: '手動(CMoney 2026/07/13)', holdings: [
    { code: 'NVDA US', name: 'NVIDIA Corp', weight: 8.70 },
    { code: 'AAPL US', name: 'Apple Inc', weight: 7.35 },
    { code: 'MU US', name: 'Micron Technology Inc', weight: 6.36 },
    { code: 'AMD US', name: 'Advanced Micro Devices Inc', weight: 5.65 },
    { code: 'AMZN US', name: 'Amazon.com Inc', weight: 3.97 },
    { code: 'LRCX US', name: 'Lam Research Corp', weight: 3.63 },
    { code: 'GOOG US', name: 'Alphabet Inc', weight: 3.46 },
    { code: 'GOOGL US', name: 'Alphabet Inc', weight: 3.42 },
    { code: 'MSFT US', name: 'Microsoft Corp', weight: 3.21 },
    { code: 'META US', name: 'Meta Platforms Inc', weight: 3.10 },
    { code: 'TXN US', name: 'Texas Instruments Inc', weight: 3.05 },
    { code: 'PANW US', name: 'Palo Alto Networks Inc', weight: 2.94 },
    { code: 'WDC US', name: 'Western Digital Corp', weight: 2.91 },
    { code: 'AVGO US', name: 'Broadcom Inc', weight: 2.52 },
    { code: 'KLAC US', name: 'KLA Corp', weight: 2.34 },
    { code: 'CDNS US', name: 'Cadence Design Systems Inc', weight: 1.92 },
    { code: 'ADI US', name: 'Analog Devices Inc', weight: 1.77 },
    { code: 'MCHP US', name: 'Microchip Technology Inc', weight: 1.65 },
    { code: 'TSM US', name: 'Taiwan Semiconductor Manufacturing Co Ltd', weight: 1.59 },
    { code: 'ASML US', name: 'ASML Holding NV', weight: 1.56 },
    { code: 'COHR US', name: 'Coherent Corp', weight: 1.51 },
    { code: 'MRVL US', name: 'Marvell Technology Inc', weight: 1.47 },
    { code: 'STX US', name: 'Seagate Technology Holdings PLC', weight: 1.40 },
    { code: 'LITE US', name: 'Lumentum Holdings Inc', weight: 1.29 },
    { code: 'CIEN US', name: 'Ciena Corp', weight: 1.28 },
    { code: 'INTC US', name: 'Intel Corp', weight: 1.27 },
    { code: 'PLTR US', name: 'Palantir Technologies Inc', weight: 1.26 },
    { code: 'NFLX US', name: 'Netflix Inc', weight: 1.25 },
    { code: 'NXPI US', name: 'NXP Semiconductors NV', weight: 1.24 },
    { code: 'CRWD US', name: 'Crowdstrike Holdings Inc', weight: 1.19 },
    { code: 'AXON US', name: 'Axon Enterprise Inc', weight: 1.15 },
    { code: 'ARM US', name: 'ARM Holdings PLC', weight: 1.09 },
    { code: 'V US', name: 'Visa Inc', weight: 1.01 },
    { code: 'CLS US', name: 'Celestica Inc', weight: 0.90 },
    { code: 'SIMO US', name: 'Silicon Motion Technology Corp', weight: 0.85 },
    { code: 'ANET US', name: 'Arista Networks Inc', weight: 0.82 },
    { code: 'BKNG US', name: 'Booking Holdings Inc', weight: 0.77 },
    { code: 'SNOW US', name: 'Snowflake Inc', weight: 0.76 },
    { code: 'SKHY US', name: 'SK hynix Inc', weight: 0.75 },
    { code: 'TER US', name: 'Teradyne Inc', weight: 0.75 },
    { code: 'TTWO US', name: 'Take-Two Interactive Software Inc', weight: 0.74 },
    { code: 'SHOP US', name: 'Shopify Inc', weight: 0.70 },
    { code: 'SPCX US', name: 'Space Exploration Technologies Corp', weight: 0.68 },
    { code: 'MDB US', name: 'MongoDB Inc', weight: 0.62 },
    { code: 'BABA US', name: 'Alibaba Group Holding Ltd', weight: 0.50 },
    { code: 'UBER US', name: 'Uber Technologies Inc', weight: 0.45 },
    { code: 'DASH US', name: 'DoorDash Inc', weight: 0.40 },
    { code: 'NOW US', name: 'ServiceNow Inc', weight: 0.38 },
    { code: 'SPOT US', name: 'Spotify Technology SA', weight: 0.37 },
    { code: 'FSLY US', name: 'Fastly Inc', weight: 0.28 },
    { code: 'ZS US', name: 'Zscaler Inc', weight: 0.14 }
  ] }
};
var _constMap = {};        // etf → {source, rows:[{code,name,weight,kind,ySym}], covW, est, eligible}
var _constPx = {};         // 'TW:2330' / 'YH:NVDA' → {chg, price}
var _constCtr = {};        // 台股成份股代號 → {exchange}（每日快取）
var _constTwTimer = null, _constUsTimer = null;
var _constPop = null;      // 彈窗中的 etf code
var _constInit = false;

function _constDay() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }
function _twMarketLive() { // 台股盤中（週一~五 09:00–13:35 台灣時間）
  var tw = new Date(Date.now() + 8 * 3600000), d = tw.getUTCDay();
  if (d === 0 || d === 6) return false;
  var hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  return hm >= 540 && hm < 815;
}
function _invVisible() {
  var v = document.getElementById('inv-view');
  return v && v.style.display !== 'none';
}

// 成份股分類：純數字（可含字母尾碼）＝台股走快照；其餘（US ticker / "000660 KS" 國別碼）走 Yahoo
function _classify(rawCode) {
  var code = String(rawCode).trim();
  if (/^\d+[A-Z]?$/.test(code)) return { kind: 'TW', key: 'TW:' + code, twCode: code };
  var sym = constituentSymbol(code); // trend.js：外資碼 → Yahoo symbol
  return { kind: 'YH', key: 'YH:' + sym, ySym: sym };
}

async function initConstituents() {
  if (_constInit) { _constEnsureTimers(); return; }
  _constInit = true;
  try {
    // 1) 成份股清單（每日快取）
    var lsKey = 'const_list_v1';
    var cache = null;
    try { cache = JSON.parse(localStorage.getItem(lsKey) || 'null'); } catch (e) {}
    if (!cache || cache.day !== _constDay()) cache = { day: _constDay(), map: {} };
    var etfs = (_positions || []).map(function (p) { return String(p.code); }).filter(isEtfCode);
    for (var i = 0; i < etfs.length; i++) {
      var code = etfs[i];
      // 發行商官網 API 優先（每日快取；失敗退回手動清單，下次進頁自動重試官網）
      if (ALLIANZ_FUNDS[code]) {
        var cur = cache.map[code];
        if (!cur || !(cur.holdings || []).length || !/安聯官網/.test(cur.source || '')) {
          try {
            var aj = await (await fetch(NEWS_GAS_URL + '?allianz=' + ALLIANZ_FUNDS[code])).json();
            if (aj && (aj.holdings || []).length) cache.map[code] = aj;
            else console.warn('[const allianz]', code, (aj && aj.error) || 'no holdings');
          } catch (e) { console.warn('[const allianz]', code, e); }
        }
        if (!cache.map[code] || !(cache.map[code].holdings || []).length) {
          cache.map[code] = HOLDINGS_OVERRIDES[code] || { source: null, holdings: [] };
        }
        continue;
      }
      // 手動清單（境外/主動 ETF 抓不到、又無官網 API 者）：永遠採用、不進網路、不受每日快取影響
      if (HOLDINGS_OVERRIDES[code]) { cache.map[code] = HOLDINGS_OVERRIDES[code]; continue; }
      // 空結果不視為有效快取：來源暫時故障（如 CMoney 403）復原後，重新進頁即可補抓
      if (!cache.map[code] || !(cache.map[code].holdings || []).length) {
        try { cache.map[code] = await fetchEtfConstituents(code); }
        catch (e) { cache.map[code] = { source: null, holdings: [] }; }
      }
    }
    try { localStorage.setItem(lsKey, JSON.stringify(cache)); } catch (e) {}

    // 2) 正規化
    etfs.forEach(function (code) {
      var d = cache.map[code] || { source: null, holdings: [] };
      var rows = (d.holdings || []).map(function (h) {
        var w = parseFloat(h.weight);
        if (isNaN(w) || w <= 0) return null;
        return Object.assign({ code: String(h.code).trim(), name: h.name || '', weight: w }, _classify(h.code));
      }).filter(Boolean);
      var rawW = 0; rows.forEach(function (r) { rawW += r.weight; });
      _constMap[code] = { source: d.source, rows: rows, rawW: rawW, covW: 0, est: null, eligible: false };
    });

    // 3) 台股成份股合約（取 exchange 供快照用；每日快取）
    var ctrKey = 'const_ctr_v1';
    var cc = null;
    try { cc = JSON.parse(localStorage.getItem(ctrKey) || 'null'); } catch (e) {}
    if (!cc || cc.day !== _constDay()) cc = { day: _constDay(), map: {} };
    var twCodes = {};
    Object.keys(_constMap).forEach(function (etf) {
      _constMap[etf].rows.forEach(function (r) { if (r.kind === 'TW') twCodes[r.twCode] = true; });
    });
    for (var tc in twCodes) {
      if (cc.map[tc] === undefined) {
        try { var c = await fetchContract(tc); cc.map[tc] = { exchange: c.exchange }; }
        catch (e) { cc.map[tc] = null; } // 查無合約（如已下市）→ 不列入覆蓋
      }
    }
    try { localStorage.setItem(ctrKey, JSON.stringify(cc)); } catch (e) {}
    _constCtr = cc.map;

    // 4) 首輪抓價（開盤與否都抓一次，收盤後顯示最後一盤漲跌）＋ 啟動輪詢
    await Promise.allSettled([pollTwConst(true), pollUsConst(true)]);
    _constEnsureTimers();
  } catch (e) { console.warn('[constituents]', e); }
}

function _constEnsureTimers() {
  var twMs = _constPop ? 3000 : 5000;
  if (_constTwTimer) clearInterval(_constTwTimer);
  _constTwTimer = setInterval(function () {
    if (_twMarketLive() && _invVisible()) pollTwConst(false);
  }, twMs);
  if (!_constUsTimer) {
    _constUsTimer = setInterval(function () {
      if (_invVisible() && _usMarketLive()) pollUsConst(false); // 僅美股盤中輪詢（收盤價不會變，盤外輪詢純耗 GAS 配額）
    }, 300000); // 美股延遲報價，5 分鐘一輪
  }
}

// ── 台股成份股：批次快照（一次請求全部，≤500 檔） ──
async function pollTwConst(force) {
  var contracts = [], seen = {};
  Object.keys(_constMap).forEach(function (etf) {
    _constMap[etf].rows.forEach(function (r) {
      if (r.kind !== 'TW' || seen[r.twCode]) return;
      var c = _constCtr[r.twCode];
      if (c && c.exchange) { seen[r.twCode] = true; contracts.push({ security_type: 'STK', exchange: c.exchange, code: r.twCode }); }
    });
  });
  if (!contracts.length) return;
  try {
    var r = await fetch(API + '/api/v1/data/snapshots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contracts: contracts })
    });
    if (!r.ok) throw new Error('snapshots HTTP ' + r.status);
    var snaps = await r.json();
    snaps.forEach(function (s) {
      if (s.close != null) _constPx['TW:' + s.code] = { chg: s.change_rate, price: s.close };
    });
    _constRecompute();
  } catch (e) { if (force) console.warn('[const snapshots]', e); }
}

// ── 外市成份股：GAS ?usquote= 批次（Yahoo spark 5d 日K 末兩收盤算漲跌，避開 chartPreviousClose 陷阱） ──
// 美股是否盤中：美東平日 9:30–16:00（用 Intl 轉紐約時區，夏令/冬令自動處理；含收盤後 10 分鐘補最後一盤）
function _usMarketLive() {
  try {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    var o = {};
    parts.forEach(function (x) { o[x.type] = x.value; });
    if (o.weekday === 'Sat' || o.weekday === 'Sun') return false;
    var m = (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10);
    return m >= 570 && m <= 970; // 9:30–16:10
  } catch (e) { return true; } // 時區 API 異常時寧可照舊輪詢
}
// 批次抓報價：每 20 檔一包（Yahoo spark 單次上限 20 檔，超過整包 400；每包＝GAS 端 1 次 UrlFetch）
// 包內只要有一檔 Yahoo 查無的代號整包 404 → 失敗的包二分拆包定位壞代號，只跳過壞代號其餘照抓；
// 壞代號記在 _usBadSyms（本場次不再重試）。配額類錯誤（單日次數過多）則直接中止，避免拆包爆量重試。
var _usBadSyms = {};
// Yahoo 可查的股票代號才送：純字母（可帶 .X/-X 後綴，如 BRK.B）。
// 排除債券 CUSIP/ISIN（含數字，如 US031921AC31、XS2826815446）——債券 ETF 的持債 Yahoo 沒有，
// 事先濾掉才不會靠二分拆包一個個試（那會產生大量 GAS 呼叫、可能燒爆配額）。
function _isUsTicker(sym) { return /^[A-Z]{1,6}([.\-][A-Z]{1,3})?$/.test(sym); }
async function _usQuoteBatch(list) {
  var out = {};
  var todo = list.filter(function (s) { return _isUsTicker(s) && !_usBadSyms[s]; });
  for (var i = 0; i < todo.length; i += 20) {
    await _usQuoteChunk(todo.slice(i, i + 20), out);
  }
  return out;
}
async function _usQuoteChunk(part, out) {
  if (!part.length) return;
  try {
    var r = await fetch(NEWS_GAS_URL + '?usquote=' + encodeURIComponent(part.join(',')));
    var j = await r.json();
    if (j && j.error) throw new Error(j.error);
    if (j) Object.assign(out, j);
  } catch (e) {
    if (/單日|quota/i.test(e.message || '')) throw e; // 配額爆掉：整批中止，別再打了
    if (part.length === 1) {
      _usBadSyms[part[0]] = true;
      console.warn('[const usquote] 跳過 Yahoo 查無代號：' + part[0]);
      return;
    }
    var mid = Math.ceil(part.length / 2);
    await _usQuoteChunk(part.slice(0, mid), out);
    await _usQuoteChunk(part.slice(mid), out);
  }
}
async function pollUsConst(force) {
  var syms = {};
  Object.keys(_constMap).forEach(function (etf) {
    _constMap[etf].rows.forEach(function (r) { if (r.kind === 'YH') syms[r.ySym] = true; });
  });
  var list = Object.keys(syms);
  if (!list.length) return;
  try {
    var q = await _usQuoteBatch(list);
    list.forEach(function (sym) {
      var v = q[sym];
      if (v && v.price != null && v.chg != null) _constPx['YH:' + sym] = { chg: v.chg, price: v.price };
    });
  } catch (e) { if (force) console.warn('[const usquote]', e); }
  _constRecompute();
}

// ── 加權估算與重繪 ──
function _constRecompute() {
  _constPxAt = new Date();
  Object.keys(_constMap).forEach(function (etf) {
    var m = _constMap[etf], covW = 0, wsum = 0;
    m.rows.forEach(function (r) {
      var px = _constPx[r.key];
      if (px && px.chg != null) { covW += r.weight; wsum += r.weight * px.chg; }
    });
    m.covW = covW;
    m.eligible = covW >= CONST_COVER_MIN;
    m.est = m.eligible ? wsum / covW : null;
  });
  if (_invVisible() && typeof renderInvTable === 'function') renderInvTable();
  if (_constPop) renderConstPop();
}

// 給 inventory.js 用：該檔的估算欄與按鈕資格
function constEst(code) {
  var m = _constMap[String(code)];
  return (m && m.eligible) ? m : null;
}

// ── 成份股彈窗 ──
function openConstituents(code) {
  _constPop = String(code);
  _constEnsureTimers(); // 盤中彈窗加密到 3 秒
  document.getElementById('detail-modal').style.display = 'flex';
  renderConstPop();
  refreshConstMissing(code); // 開窗即補抓該檔仍缺的報價（美股首載偶被限流漏抓）
}

// 補抓某 ETF 仍缺報價的成份股（美股走 Yahoo、台股走快照），完成後重繪彈窗/表格
async function refreshConstMissing(code) {
  var m = _constMap[String(code)];
  if (!m) return;
  var usSyms = [], hasTwMissing = false;
  m.rows.forEach(function (r) {
    var px = _constPx[r.key];
    if (px && px.chg != null) return;
    if (r.kind === 'YH') usSyms.push(r.ySym);
    else hasTwMissing = true;
  });
  var jobs = [];
  if (usSyms.length) jobs.push((async function () {
    try {
      var q = await _usQuoteBatch(usSyms);
      usSyms.forEach(function (sym) {
        var v = q[sym];
        if (v && v.price != null && v.chg != null) _constPx['YH:' + sym] = { chg: v.chg, price: v.price };
      });
    } catch (e) { console.warn('[const usquote missing]', e); }
  })());
  if (hasTwMissing && _twMarketLive()) jobs.push(pollTwConst(false));
  if (!jobs.length) return;
  await Promise.allSettled(jobs);
  _constRecompute();
}
function renderConstPop() {
  var m = _constMap[_constPop];
  if (!m) return;
  var title = document.getElementById('detail-title');
  var body = document.getElementById('detail-body');
  var c = (typeof _contracts !== 'undefined' && _contracts[_constPop]) || null;
  title.textContent = _constPop + ' ' + ((c && c.name) || '') + ' — 成份股現價與漲跌';
  var rows = m.rows.slice().sort(function (a, b) { return b.weight - a.weight; });
  var _p2 = function (n) { return String(n).padStart(2, '0'); };
  var when = _constPxAt
    ? _p2(_constPxAt.getMonth() + 1) + '/' + _p2(_constPxAt.getDate()) + ' ' + _p2(_constPxAt.getHours()) + ':' + _p2(_constPxAt.getMinutes()) + ':' + _p2(_constPxAt.getSeconds())
    : '—';
  var estCls = m.est == null ? '' : colorClass(m.est);
  var html = '<div class="detail-note" style="margin:0 0 8px">來源：' + (m.source || '—') +
    '（共 ' + rows.length + ' 檔）｜報價擷取 ' + when +
    '｜報價覆蓋率 <span class="const-cov">' + m.covW.toFixed(1) + '%</span>｜加權漲跌 ' +
    (m.est == null ? '—' : '<span class="' + estCls + '">' + (m.est >= 0 ? '+' : '') + m.est.toFixed(2) + '%</span>') + '</div>' +
    '<div class="detail-scroll"><table class="detail-table"><thead><tr>' +
    '<th>成份股</th><th class="num">權重</th><th class="num">現價</th><th class="num">漲跌％</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var px = _constPx[r.key];
    var cls = (!px || px.chg == null) ? 'flat' : colorClass(px.chg);
    html += '<tr><td>' + r.code + ' ' + (r.name || '') + '</td>' +
      '<td class="num">' + r.weight.toFixed(2) + '%</td>' +
      '<td class="num">' + (px && px.price != null ? (px.price >= 100 ? px.price.toFixed(1) : px.price.toFixed(2)) : '—') + '</td>' +
      '<td class="num ' + cls + '">' + (px && px.chg != null ? fmtPct(px.chg) : '—') + '</td></tr>';
  });
  html += '</tbody></table></div>' +
    '<div class="detail-note">台股盤中每 5 秒更新（本視窗開啟時 3 秒）；美股等外市為 Yahoo 延遲報價，僅美股盤中（台北約 21:30–04:00）每 5 分鐘更新，收盤後顯示最後一盤。</div>';
  body.innerHTML = html;
}
function closeConstPop() { // 由 closeDetailModal 呼叫
  if (_constPop) { _constPop = null; _constEnsureTimers(); }
}
