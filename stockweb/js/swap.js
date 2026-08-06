// 股利總管 Web — 換股試算（股利估算子頁籤）
// 賣出部分/全部張數 → 手動輸入各檔買入張數（上限為賣出淨額），試算下個月起未來 12 個月每月股利增減
// 純前端試算：不下單、不改持股、不寫 Firestore。配息資料與推估規則沿用 dividend-est.js。

var SWAP_SELL_FEE = 0.002265;  // 賣出成本率（＝1−0.997735，與總現值淨額同基準：手續費＋交易稅）
var SWAP_BUY_FEE = 0.001425;   // 買入手續費率
var SWAP_N = 12;               // 試算期數（下個月起 12 個月）
var SWAP_LS = 'swap_state_v2';   // v1→v2：舊版曾把買入張數夾成 0 存檔，遷移時丟棄該欄避免卡住不跟隨
var SWAP_LS_OLD = 'swap_state_v1';

var _swapState = null;   // {sells:{code:張}, buyMode, buyExist:[], buyCodes:[], buyLots:{code:張}}
var _swapPx = {};        // code → 鎖定的現價快照（進頁時取，按鈕才刷新）
var _swapCalc = null;    // 最近一次試算結果
var _swapNote = '';      // 指定代碼載入訊息
var _swapBusy = false;

function _swapDefault() {
  return { sells: {}, buyMode: 'exist', buyExist: [], buyCodes: [], buyLots: {} };
}
function _swapLoad() {
  try {
    var raw = localStorage.getItem(SWAP_LS), migrated = false;
    if (raw == null) { raw = localStorage.getItem(SWAP_LS_OLD); migrated = true; }   // 由 v1 遷移
    var s = JSON.parse(raw || 'null');
    if (s && typeof s === 'object') {
      if (migrated) delete s.buyLots;                    // 丟掉舊版殘留的買入張數覆寫
      var d = _swapDefault();
      Object.keys(d).forEach(function (k) { if (s[k] == null) s[k] = d[k]; });
      return s;
    }
  } catch (e) {}
  return _swapDefault();
}
function _swapSave() { try { localStorage.setItem(SWAP_LS, JSON.stringify(_swapState)); } catch (e) {} }

// ── 子頁籤切換（股利估算 / 換股試算 / 填息追蹤）──
var DIV_TABS = ['est', 'swap', 'refill'];
function divShowTab(tab) {
  if (DIV_TABS.indexOf(tab) < 0) tab = 'est';
  DIV_TABS.forEach(function (t) {
    var pane = document.getElementById('divest-tab-' + t);
    var btn = document.getElementById('divest-subtab-' + t);
    if (pane) pane.style.display = (t === tab) ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'swap') startSwap();
  else if (tab === 'refill' && typeof startRefill === 'function' &&
    !(typeof _rfResult !== 'undefined' && _rfResult)) startRefill();
}

// ── 期數/日期工具（ym = 年*12 + 月-1）──
function _swapYm(iso) { return (+iso.slice(0, 4)) * 12 + (+iso.slice(5, 7) - 1); }
function _swapYmLabel(ym) { return Math.floor(ym / 12) + '/' + ('0' + (ym % 12 + 1)).slice(-2); }
function _swapStartYm() { return _swapYm(_divTwDate().iso) + 1; }  // 下個月

// ── 配息事件序列（不含股數；股數由外層依除息日決定套舊或套新）──
// 三層來源：①已公告的真實紀錄 ②去年同月＋12 投影 ③依頻率補（新配息檔或投影未覆蓋的月份）
function _swapEvents(recs, startYm, n) {
  recs = (recs || []).filter(function (r) { return r.exDate; })
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
  if (!recs.length) return [];
  var lastAmt = 0;
  for (var i = recs.length - 1; i >= 0; i--) { if (recs[i].amount != null) { lastAmt = recs[i].amount; break; } }
  var payOf = function (r) { return r.payDate || _addMonths(r.exDate, 1); };
  var endYm = startYm + n - 1;
  var map = {};

  recs.forEach(function (r) {
    var pay = payOf(r); if (!pay) return;
    var ym = _swapYm(pay);
    if (ym < startYm || ym > endYm) return;
    map[ym] = { ym: ym, exDate: r.exDate, payDate: pay, perShare: r.amount != null ? r.amount : lastAmt };
  });
  recs.forEach(function (r) {
    var pay = payOf(r); if (!pay) return;
    var pj = _addMonths(pay, 12), ym = _swapYm(pj);
    if (ym < startYm || ym > endYm || map[ym]) return;
    map[ym] = { ym: ym, exDate: r.exDate ? _addMonths(r.exDate, 12) : null, payDate: pj, perShare: lastAmt };
  });
  var step = _divInferStep(recs);
  if (step > 0) {
    var ym2 = _swapYm(payOf(recs[recs.length - 1]));
    for (var k = 0; k < 40 && ym2 <= endYm; k++) {
      ym2 += step;
      if (ym2 < startYm || ym2 > endYm || map[ym2]) continue;
      var payIso = Math.floor(ym2 / 12) + '-' + ('0' + (ym2 % 12 + 1)).slice(-2) + '-15';
      map[ym2] = { ym: ym2, exDate: _addMonths(payIso, -1), payDate: payIso, perShare: lastAmt };
    }
  }
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.ym - b.ym; });
}

// ── 持股/報價小工具 ──
function _swapPos(code) {
  var out = null;
  (_positions || []).forEach(function (p) { if (String(p.code) === String(code)) out = p; });
  return out;
}
function _swapHeld(code) { return (_sharesMap && _sharesMap[String(code)]) || 0; }        // 總股數（含出借）
function _swapFree(code) {                                                                // 可直接賣（扣出借中）
  var p = _swapPos(code);
  return p ? Math.max(0, p.quantity - (p.lentShares || 0)) : _swapHeld(code);
}
// 每股成本均價（來自券商庫存 _positions[].price）
function _swapCostPx(code) {
  var p = _swapPos(code);
  return (p && p.price != null) ? p.price : null;
}
// 預估殖利率＝最近一次配息 × 配息期數 ÷ 現價 ×100
// 配息期數：年配1、半年配2、季配4、月配12（由 _divInferStep 推得的月間隔換算：12÷間隔）
function _swapYield(code) {
  var recs = (typeof _divRecMap !== 'undefined') && _divRecMap[code];
  var px = _swapPrice(code);
  if (!recs || !recs.length || !(px > 0)) return null;
  var today = (typeof _divTwDate === 'function') ? _divTwDate().iso : '9999-99-99';
  var sorted = recs.filter(function (r) { return r.amount != null && r.exDate; })
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
  if (!sorted.length) return null;
  var last = null;                                   // 最近一筆已發放（發放日已過）
  sorted.forEach(function (r) { if ((r.payDate || r.exDate) <= today) last = r; });
  if (!last) last = sorted[sorted.length - 1];        // 皆未發放（新檔）→ 取最近一筆
  var step = (typeof _divInferStep === 'function') ? _divInferStep(sorted) : 1;  // 月間隔 1/3/6/12
  var freq = 12 / step;                               // 配息期數 12/4/2/1
  return last.amount * freq / px * 100;
}
function _swapPrice(code) {
  code = String(code);
  if (_swapPx[code] != null) return _swapPx[code];
  var r = (typeof _rows !== 'undefined') && _rows[code];
  if (r && r.close != null) return r.close;
  var c = (typeof _contracts !== 'undefined') && _contracts[code];
  return (c && c.reference) || null;
}
function _swapName(code) {
  var c = (typeof _contracts !== 'undefined') && _contracts[code];
  return (c && c.name) || '';
}
function _swapCodes() {  // 持股代號（依代號排序）
  return Object.keys(_sharesMap || {}).filter(function (c) { return _sharesMap[c] > 0; })
    .sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });
}
function _swapLots(sh) { return (sh / 1000).toLocaleString('zh-TW', { maximumFractionDigits: 3 }); }
function _swapPlain(lots) { return String(Math.round(lots * 1000) / 1000); }  // 輸入框用純數字（無千分位）
function _swapSigned(v) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + fmtMoney(Math.abs(v)); }

// ── 核心試算 ──
function swapCompute() {
  var todayIso = _divTwDate().iso;
  var startYm = _swapStartYm();
  var thisYear = _divTwDate().y;

  var oldShares = {}, newShares = {};
  _swapCodes().forEach(function (c) { oldShares[c] = _swapHeld(c); newShares[c] = _swapHeld(c); });

  // 賣出
  var sellNet = 0, sellGross = 0, sellRows = [], recallShares = 0;
  Object.keys(_swapState.sells).forEach(function (code) {
    var lots = parseFloat(_swapState.sells[code]);
    if (!(lots > 0)) return;
    var px = _swapPrice(code); if (px == null) return;
    var sh = Math.min(Math.round(lots * 1000), oldShares[code] || 0);
    if (!(sh > 0)) return;
    var gross = px * sh, net = gross * (1 - SWAP_SELL_FEE);
    sellGross += gross; sellNet += net;
    newShares[code] = (oldShares[code] || 0) - sh;
    var need = Math.max(0, sh - _swapFree(code));
    recallShares += need;
    sellRows.push({ code: code, sh: sh, px: px, gross: gross, net: net, recall: need });
  });

  // 買入標的
  var picks = (_swapState.buyMode === 'exist' ? _swapState.buyExist : _swapState.buyCodes)
    .filter(function (c) { return _swapPrice(c) != null; });

  // 買入張數改為完全手動輸入：無自動分配，未輸入即為 0
  // 買入總額以「賣出淨額」為硬上限：逐列用剩餘可用資金夾住，剩餘現金永不為負
  // capLots＝該列在剩餘資金下能買到的最大張數（手動輸入與上下鍵的天花板）
  var rowMap = {}, usedCash = 0;
  picks.forEach(function (code) {
    var px = _swapPrice(code), per = px * (1 + SWAP_BUY_FEE);
    var avail = Math.max(0, sellNet - usedCash);              // 這一列可動用的資金
    var capRaw = per > 0 ? avail / per : 0;
    var capSh = Math.floor(capRaw);
    var capLots = capSh / 1000;
    var ov = _swapState.buyLots[code];
    var lots = (ov != null && ov !== '') ? Math.max(0, Math.min(parseFloat(ov) || 0, capLots)) : 0;
    var sh = Math.min(Math.round(lots * 1000), capSh);
    var cost = sh * per;
    usedCash += cost;
    newShares[code] = (newShares[code] || 0) + sh;
    if (oldShares[code] == null) oldShares[code] = 0;
    rowMap[code] = { code: code, sh: sh, capLots: capLots, px: px, cost: cost };
  });
  var buyRows = picks.map(function (c) { return rowMap[c]; });  // 顯示順序仍依清單順序
  var cashLeft = Math.max(0, sellNet - usedCash);

  // 月度序列：涵蓋全部持股＋買入標的（未變動者前後相同，仍計入月現金流總額）
  var all = {};
  Object.keys(oldShares).forEach(function (c) { all[c] = true; });
  Object.keys(newShares).forEach(function (c) { all[c] = true; });

  var before = [], after = [];
  for (var i = 0; i < SWAP_N; i++) { before.push(0); after.push(0); }
  var beforeYear = 0, afterYear = 0;   // 今年剩餘月份小計
  var perCode = [];

  Object.keys(all).forEach(function (code) {
    var recs = (typeof _divRecMap !== 'undefined') && _divRecMap[code];
    var o = oldShares[code] || 0, nw = newShares[code] || 0;
    if (!recs || !recs.length) {
      if (o !== nw) perCode.push({ code: code, oldSh: o, newSh: nw, before: 0, after: 0, nodata: true });
      return;
    }
    var evs = _swapEvents(recs, startYm, SWAP_N);
    var bSum = 0, aSum = 0;
    evs.forEach(function (e) {
      var idx = e.ym - startYm;
      if (idx < 0 || idx >= SWAP_N) return;
      // 已除息未發放者仍歸原持有人 → 該期套「舊股數」；未除息才套「新股數」
      var past = e.exDate && e.exDate <= todayIso;
      var vb = e.perShare * o, va = e.perShare * (past ? o : nw);
      before[idx] += vb; after[idx] += va;
      bSum += vb; aSum += va;
      if (Math.floor(e.ym / 12) === thisYear) { beforeYear += vb; afterYear += va; }
    });
    if (o !== nw || bSum || aSum) perCode.push({ code: code, oldSh: o, newSh: nw, before: bSum, after: aSum });
  });

  perCode.sort(function (a, b) { return (b.after - b.before) - (a.after - a.before); });

  var annBefore = before.reduce(function (a, b) { return a + b; }, 0);
  var annAfter = after.reduce(function (a, b) { return a + b; }, 0);

  // 殖利率（以總現值為分母；換股後總市值＝原市值−賣出毛額＋買入成本＋剩餘現金）
  var totalVal = 0;
  _swapCodes().forEach(function (c) { var px = _swapPrice(c); if (px != null) totalVal += px * _swapHeld(c); });

  _swapCalc = {
    startYm: startYm, before: before, after: after, perCode: perCode,
    sellRows: sellRows, buyRows: buyRows, sellNet: sellNet, sellGross: sellGross,
    usedCash: usedCash, cashLeft: cashLeft, recallShares: recallShares,
    annBefore: annBefore, annAfter: annAfter, beforeYear: beforeYear, afterYear: afterYear,
    totalVal: totalVal
  };
  return _swapCalc;
}

// ── 進入頁面 ──
async function startSwap() {
  var wrap = document.getElementById('swap-wrap');
  var info = document.getElementById('swap-info');
  if (_swapBusy) return;
  _swapBusy = true;
  try {
    if (!_divEstResult) {
      wrap.innerHTML = '<div class="modal-loading">載入持股與配息資料…</div>';
      try { await startDividendEst(); } catch (e) {}
    }
    if (!_divEstResult) {
      wrap.innerHTML = '<div class="modal-loading">尚無配息資料，請先切到「股利估算」頁載入成功後再試。</div>';
      return;
    }
    _swapState = _swapLoad();
    _swapSnapPrices();
    // 指定代碼：補合約/報價/配息（重進頁沿用 localStorage 的清單）
    for (var i = 0; i < _swapState.buyCodes.length; i++) {
      await _swapEnsureCode(_swapState.buyCodes[i]);
    }
    if (info) info.textContent = _swapYmLabel(_swapStartYm()) + ' 起 12 個月';
    renderSwap();
  } finally { _swapBusy = false; }
}

// 鎖定現價快照（進頁時取一次；之後只有按「刷新現價」才更新，避免試算結果隨 tick 跳動）
function _swapSnapPrices() {
  _swapCodes().forEach(function (c) {
    var r = (typeof _rows !== 'undefined') && _rows[c];
    if (r && r.close != null) _swapPx[c] = r.close;
    else if (_swapPx[c] == null) {
      var ct = _contracts[c];
      if (ct && ct.reference) _swapPx[c] = ct.reference;
    }
  });
}

// 指定代碼：查合約 → 快照 → 配息紀錄（皆有每日快取／失敗容忍）
async function _swapEnsureCode(code) {
  code = String(code);
  if (!_contracts[code]) {
    try { _contracts[code] = await fetchContract(code); } catch (e) {}
  }
  if (!_contracts[code]) return false;
  if (_swapPx[code] == null) {
    try {
      var snaps = await fetchSnapshots([_contracts[code]]);
      (snaps || []).forEach(function (s) { if (s.close != null) _swapPx[String(s.code)] = s.close; });
    } catch (e) {}
    if (_swapPx[code] == null && _contracts[code].reference) _swapPx[code] = _contracts[code].reference;
  }
  if (typeof _divGetRecs === 'function' && !(_divRecMap[code] && _divRecMap[code].length)) {
    try { await _divGetRecs(code); } catch (e) {}
  }
  return true;
}

// ── 事件處理 ──
async function swapRefreshPrices() {
  var info = document.getElementById('swap-info');
  if (info) info.textContent = '刷新現價…';
  try {
    var codes = _swapCodes().concat(_swapState ? _swapState.buyCodes : []);
    var cons = codes.map(function (c) { return _contracts[c]; }).filter(Boolean);
    if (cons.length) {
      var snaps = await fetchSnapshots(cons);
      snaps.forEach(function (s) {
        if (s.close != null) { _swapPx[String(s.code)] = s.close; _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) }; }
      });
    }
  } catch (e) { console.warn('[swap refresh px]', e); }
  if (info) info.textContent = _swapYmLabel(_swapStartYm()) + ' 起 12 個月';
  renderSwap();
}

function swapReset() {
  _swapState = _swapDefault();
  _swapNote = '';
  _swapSave();
  renderSwap();
}

// 買入張數為使用者手動輸入，除非該標的被移出清單，否則不清除；金額上限由 swapUpdate 依剩餘資金夾住
function _swapClearBuyLots(code) {
  if (code == null) _swapState.buyLots = {};
  else delete _swapState.buyLots[code];
}

function swapSellInput(code, el) {
  var v = parseFloat(el.value);
  var maxLots = _swapHeld(code) / 1000;        // 上限＝持有張數（含出借）
  if (v > maxLots) { v = maxLots; el.value = v; }
  if (!(v > 0)) delete _swapState.sells[code]; else _swapState.sells[code] = v;
  _swapSave();
  swapUpdate();                                 // 賣出淨額變 → 買入張數保留，僅上限重算
}
function swapSellAll(code) {
  _swapState.sells[code] = _swapHeld(code) / 1000;
  _swapSave();
  renderSwap();
}
function swapSetMode(mode) { _swapState.buyMode = mode; _swapSave(); renderSwap(); }
function swapToggleBuy(code, el) {
  var i = _swapState.buyExist.indexOf(code);
  if (el.checked) { if (i < 0) _swapState.buyExist.push(code); }
  else if (i >= 0) { _swapState.buyExist.splice(i, 1); _swapClearBuyLots(code); }  // 移出清單才清該檔
  _swapSave();
  renderSwap();
}
// 手動買入張數：空值＝不買；上限夾回於 swapUpdate 處理
function swapBuyLotsInput(code, el) {
  var v = el.value;
  if (v === '' || parseFloat(v) < 0) delete _swapState.buyLots[code];
  else _swapState.buyLots[code] = parseFloat(v);
  _swapSave();
  swapUpdate();
}
async function swapAddCode() {
  var inp = document.getElementById('swap-code-inp');
  if (!inp) return;
  var code = (inp.value || '').trim().toUpperCase();
  if (!code) return;
  if (_swapState.buyCodes.indexOf(code) >= 0) { _swapNote = code + ' 已在清單中'; renderSwap(); return; }
  _swapNote = code + ' 載入中…';
  renderSwap();
  var ok = await _swapEnsureCode(code);
  if (!ok) { _swapNote = '查無代碼 ' + code; renderSwap(); return; }
  _swapState.buyCodes.push(code);
  _swapClearBuyLots();
  var recs = _divRecMap[code];
  _swapNote = (recs && recs.length) ? '' : code + '（' + (_swapName(code) || '—') + '）查無配息紀錄，將以 0 計';
  _swapSave();
  renderSwap();
}
function swapDelCode(code) {
  var i = _swapState.buyCodes.indexOf(code);
  if (i >= 0) _swapState.buyCodes.splice(i, 1);
  _swapClearBuyLots();
  delete _swapState.buyLots[code];
  _swapSave();
  renderSwap();
}

// ── 渲染 ──
// 結構區（賣出/買入清單）只在增刪標的、切換模式時重繪；輸入數字時只更新衍生數字與結果區，避免游標跳掉
function renderSwap() {
  var wrap = document.getElementById('swap-wrap');
  if (!wrap || !_swapState) return;
  wrap.innerHTML = _swapSellHtml() + _swapBuyHtml() + '<div id="swap-result"></div>';
  swapUpdate();
}

function _swapSellHtml() {
  var codes = _swapCodes();
  var h = '<div class="tx-box"><div class="tx-box-head"><span class="tx-box-title">賣出</span>' +
    '<span class="swap-hint">輸入張數或按「全部」；零股可輸入小數（0.5＝500 股）</span></div>' +
    '<div class="inv-table-wrap swap-tw"><table class="inv-table swap-table"><thead><tr>' +
    '<th>代號</th><th>名稱</th><th class="num">現價</th>' +
    '<th class="num" title="最近一次配息 × 配息期數 ÷ 現價（月配12、季配4、半年2、年配1）">預估殖利率</th>' +
    '<th class="num" title="每股成本均價（券商庫存）">成本</th>' +
    '<th class="num">持有(張)</th>' +
    '<th class="num">可賣(張)</th><th class="num">市值</th><th class="num">年配息</th>' +
    '<th class="num">賣出張數</th><th></th><th class="num">賣出淨額</th></tr></thead><tbody>';
  codes.forEach(function (code) {
    var px = _swapPrice(code), held = _swapHeld(code), free = _swapFree(code);
    var val = px != null ? px * held : null;
    var v = _swapState.sells[code];
    var cost = _swapCostPx(code);
    var yld = _swapYield(code);
    h += '<tr>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + code + '\')">' + code + '</span></td>' +
      '<td class="inv-name">' + _swapName(code) + '</td>' +
      '<td class="num">' + (px != null ? px.toFixed(2) : '—') + '</td>' +
      '<td class="num swap-yield">' + (yld != null ? yld.toFixed(2) + '%' : '—') + '</td>' +
      '<td class="num swap-cost">' + (cost != null ? cost.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + _swapLots(held) + '</td>' +
      '<td class="num' + (free < held ? ' swap-warn' : '') + '">' + _swapLots(free) + '</td>' +
      '<td class="num">' + (val != null ? fmtMoney(val) : '—') + '</td>' +
      '<td class="num" id="swap-base-' + code + '">—</td>' +
      '<td class="num"><input class="sbl-inp swap-inp" type="number" min="0" max="' + (held / 1000) + '" step="1" value="' + (v != null ? v : '') + '"' +
        ' title="上下鍵每次 ±1 張；上限為持有 ' + _swapLots(held) + ' 張；零股請手動輸入小數（0.5＝500 股）" oninput="swapSellInput(\'' + code + '\',this)"></td>' +
      '<td><button class="swap-mini" onclick="swapSellAll(\'' + code + '\')">全部</button></td>' +
      '<td class="num" id="swap-sell-' + code + '">—</td>' +
    '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="swap-foot">賣出總淨額 <b id="swap-sell-total">$0</b>' +
    '<span class="swap-dim">（已扣 ' + (SWAP_SELL_FEE * 100).toFixed(4) + '% 手續費＋交易稅）</span>' +
    '<span id="swap-recall" class="swap-warn"></span></div></div>';
  return h;
}

function _swapBuyHtml() {
  var exist = _swapState.buyMode === 'exist';
  var h = '<div class="tx-box"><div class="tx-box-head"><span class="tx-box-title">買入</span>' +
    '<span class="swap-hint">賣出所得全數買入</span></div>' +
    '<div class="swap-opts">' +
      '<label class="swap-radio"><input type="radio" name="swapmode"' + (exist ? ' checked' : '') + ' onchange="swapSetMode(\'exist\')"> 現有持股</label>' +
      '<label class="swap-radio"><input type="radio" name="swapmode"' + (!exist ? ' checked' : '') + ' onchange="swapSetMode(\'code\')"> 指定代碼</label>' +
    '</div>';

  if (exist) {
    var codes = _swapCodes();
    h += '<div class="swap-picks">';
    codes.forEach(function (code) {
      var on = _swapState.buyExist.indexOf(code) >= 0;
      var nm = _swapName(code);
      h += '<label class="swap-chip' + (on ? ' on' : '') + '" title="' + code + ' ' + nm + '"><input type="checkbox"' + (on ? ' checked' : '') +
        ' onchange="swapToggleBuy(\'' + code + '\',this)"><span class="swap-chip-c">' + code + '</span>' +
        '<span class="swap-dim swap-chip-n">' + nm + '</span></label>';
    });
    h += '</div>';
  } else {
    h += '<div class="swap-opts"><input id="swap-code-inp" class="sbl-inp swap-code-inp" type="text" placeholder="股票代碼" ' +
      'onkeydown="if(event.key===\'Enter\')swapAddCode()">' +
      '<button class="btn-query" onclick="swapAddCode()">＋ 加入</button>' +
      (_swapNote ? '<span class="swap-warn">' + _swapNote + '</span>' : '') + '</div>';
    h += '<div class="swap-picks">';
    _swapState.buyCodes.forEach(function (code) {
      var nm = _swapName(code);
      h += '<span class="swap-chip on" title="' + code + ' ' + nm + '"><span class="swap-chip-c">' + code + '</span>' +
        '<span class="swap-dim swap-chip-n">' + nm + '</span>' +
        '<button class="swap-x" title="移除" onclick="swapDelCode(\'' + code + '\')">×</button></span>';
    });
    h += '</div>';
  }

  var picks = (exist ? _swapState.buyExist : _swapState.buyCodes);
  if (picks.length) {
    h += '<div class="inv-table-wrap swap-tw"><table class="inv-table swap-table"><thead><tr>' +
      '<th>代號</th><th>名稱</th><th class="num">現價</th>' +
      '<th class="num" title="最近一次配息 × 配息期數 ÷ 現價（月配12、季配4、半年2、年配1）">預估殖利率</th>' +
      '<th class="num">買入張數</th><th class="num">年配息(新增)</th></tr></thead><tbody>';
    picks.forEach(function (code) {
      var px = _swapPrice(code);
      var bov = _swapState.buyLots[code];
      var yld = _swapYield(code);
      h += '<tr>' +
        '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + code + '\')">' + code + '</span></td>' +
        '<td class="inv-name">' + _swapName(code) + '</td>' +
        '<td class="num">' + (px != null ? px.toFixed(2) : '—') + '</td>' +
        '<td class="num swap-yield">' + (yld != null ? yld.toFixed(2) + '%' : '—') + '</td>' +
        '<td class="num"><input class="sbl-inp swap-inp swap-buylots" id="swap-buylots-' + code + '" type="number" min="0" step="1" value="' +
          (bov != null ? bov : '') + '" title="手動輸入買入張數；上限為剩餘可用資金買得起的張數，不會超過賣出總額" oninput="swapBuyLotsInput(\'' + code + '\',this)"></td>' +
        '<td class="num" id="swap-div-' + code + '">—</td>' +
      '</tr>';
    });
    h += '</tbody></table></div>';
  }
  h += '<div class="swap-foot">買入總額 <b id="swap-buy-total">$0</b>' +
    '<span class="swap-dim">（含 ' + (SWAP_BUY_FEE * 100).toFixed(4) + '% 手續費）</span>' +
    '　剩餘現金 <b id="swap-cash">$0</b></div></div>';
  return h;
}

// 只更新衍生數字＋結果區（不動輸入元素，游標不跳）
function swapUpdate() {
  var c = swapCompute();
  var set = function (id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; };

  // 賣出列：年配息（基準）與該列賣出淨額
  var baseMap = {};
  c.perCode.forEach(function (r) { baseMap[r.code] = r; });
  _swapCodes().forEach(function (code) {
    var b = baseMap[code];
    set('swap-base-' + code, b && b.before ? fmtMoney(b.before) : '—');
    set('swap-sell-' + code, '—');
  });
  c.sellRows.forEach(function (r) {
    set('swap-sell-' + r.code, fmtMoney(r.net));
  });
  set('swap-sell-total', fmtMoney(c.sellNet));
  set('swap-recall', c.recallShares > 0 ? '　需先召回出借中 ' + _swapLots(c.recallShares) + ' 張' : '');

  // 買入列：買入張數為手動輸入，超過剩餘可用資金自動夾回；年配息依實際買入計算
  c.buyRows.forEach(function (r) {
    var pc = baseMap[r.code];
    var binp = document.getElementById('swap-buylots-' + r.code);
    if (binp) {
      var ov = _swapState.buyLots[r.code];
      // 超過剩餘可用資金買得起的張數 → 夾回上限（買入總額不會超過賣出淨額）
      if (ov != null && ov !== '' && parseFloat(ov) > r.capLots) {
        _swapState.buyLots[r.code] = r.capLots; binp.value = _swapPlain(r.capLots); _swapSave();
      }
      binp.setAttribute('max', _swapPlain(r.capLots));
    }
    var inc = pc ? pc.after - pc.before : 0;
    set('swap-div-' + r.code, (inc ? '<span class="' + colorClass(inc) + '">' + fmtMoney(inc) + '</span>' : '—'));
  });
  set('swap-buy-total', fmtMoney(c.usedCash));
  set('swap-cash', fmtMoney(c.cashLeft));

  // 頂部摘要條（清空試算下方）：有賣出才顯示，隨賣出調整即時重算
  set('swap-sumbar', c.sellRows.length ? _swapSumPairs(c) : '');

  set('swap-result', _swapResultHtml(c));
}

// 摘要 5 項（年配息前/後、增減、殖利率、今年剩餘增減）；結果區與頂部摘要條共用，隨賣出即時重算
function _swapSumPairs(c) {
  var diff = c.annAfter - c.annBefore;
  var diffYear = c.afterYear - c.beforeYear;
  var yBefore = c.totalVal ? c.annBefore / c.totalVal * 100 : null;
  var yAfter = c.totalVal ? c.annAfter / c.totalVal * 100 : null;
  var sp = function (lb, v, color) {
    return '<span class="divest-sp"><span class="divest-sp-lb">' + lb + '</span>' +
      '<span class="divest-sp-v"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></span>';
  };
  var cv = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--text3)' };
  return sp('年配息（前）', fmtMoney(c.annBefore), 'var(--text2)') +
    sp('年配息（後）', fmtMoney(c.annAfter), 'var(--accent2)') +
    sp('增減', _swapSigned(diff), cv[colorClass(diff)]) +
    sp('殖利率', (yBefore != null ? yBefore.toFixed(2) + '% → ' + yAfter.toFixed(2) + '%' : '—'), 'var(--text)') +
    sp('今年剩餘增減', _swapSigned(diffYear), cv[colorClass(diffYear)]);
}

function _swapResultHtml(c) {
  if (!c.sellRows.length) {
    return '<div class="tx-box"><div class="modal-loading">在「賣出」區輸入張數後即可看到試算結果。</div></div>';
  }
  var h = '<div class="tx-box"><div class="tx-box-head"><span class="tx-box-title">試算結果</span>' +
    '<span class="swap-hint">' + _swapYmLabel(c.startYm) + ' ～ ' + _swapYmLabel(c.startYm + SWAP_N - 1) + '（未來 12 個月）</span></div>' +
    '<div class="swap-sum">' + _swapSumPairs(c) + '</div>';

  // 月度對照
  var maxV = 1;
  for (var i = 0; i < SWAP_N; i++) maxV = Math.max(maxV, c.before[i], c.after[i]);
  h += '<div class="divest-sec-title">每月股利對照</div><div class="swap-months">';
  for (var m = 0; m < SWAP_N; m++) {
    var b = c.before[m], a = c.after[m], d = a - b;
    h += '<div class="swap-mrow">' +
      '<span class="swap-mlabel">' + _swapYmLabel(c.startYm + m) + '</span>' +
      '<span class="swap-mval">' + (b ? fmtMoney(b) : '—') + '</span>' +
      '<span class="swap-marrow">→</span>' +
      '<span class="swap-mval swap-mafter">' + (a ? fmtMoney(a) : '—') + '</span>' +
      '<span class="swap-mdiff ' + colorClass(d) + '">' + (d ? _swapSigned(d) : '—') + '</span>' +
      '<span class="swap-track"><span class="swap-bar-b" style="width:' + Math.round(b / maxV * 100) + '%"></span>' +
        '<span class="swap-bar-a" style="width:' + Math.round(a / maxV * 100) + '%"></span></span>' +
    '</div>';
  }
  h += '</div>';

  // 逐檔明細（僅列股數有變動者）
  var chg = c.perCode.filter(function (r) { return r.oldSh !== r.newSh; });
  if (chg.length) {
    h += '<div class="divest-divider"></div><div class="divest-sec-title">逐檔明細</div>' +
      '<div class="inv-table-wrap swap-tw"><table class="inv-table swap-table"><thead><tr>' +
      '<th>代號</th><th>名稱</th><th class="num">股數（前）</th><th class="num">股數（後）</th>' +
      '<th class="num">年配息（前）</th><th class="num">年配息（後）</th><th class="num">增減</th></tr></thead><tbody>';
    chg.forEach(function (r) {
      var d = r.after - r.before;
      h += '<tr>' +
        '<td class="inv-code"><span class="code-link" onclick="openChartPop(\'' + r.code + '\')">' + r.code + '</span></td>' +
        '<td class="inv-name">' + _swapName(r.code) + (r.nodata ? ' <span class="swap-warn">無配息資料</span>' : '') + '</td>' +
        '<td class="num">' + r.oldSh.toLocaleString('zh-TW') + '</td>' +
        '<td class="num swap-mafter">' + r.newSh.toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + fmtMoney(r.before) + '</td>' +
        '<td class="num">' + fmtMoney(r.after) + '</td>' +
        '<td class="num ' + colorClass(d) + '">' + (d ? _swapSigned(d) : '—') + '</td>' +
      '</tr>';
    });
    h += '</tbody></table></div>';
  }

  h += '<div class="tx-note">期間為<b>下個月起 12 個月</b>，配息推估沿用股利估算頁規則（已公告用實際金額，未公告以「去年同月＋12」投影、金額取最近一次）。' +
    '「已除息、尚未發放」的配息仍歸原持有人，故該期一律以<b>換股前股數</b>計——賣出仍領得到、新買進領不到。' +
    '賣出成本 ' + (SWAP_SELL_FEE * 100).toFixed(4) + '%（手續費＋交易稅）、買入手續費 ' + (SWAP_BUY_FEE * 100).toFixed(4) + '%。' +
    '現價為進頁快照（按「刷新現價」更新），不隨盤中跳動。殖利率分母為換股前總持股現值。' +
    '<b>本頁純為試算，不下單、不改動任何持股資料，亦不構成投資建議</b>；未計入賣出的已實現損益與稅務、除息前後價差、流動性與召回限制。</div></div>';
  return h;
}
