// 股利總管 Web — 換股試算（股利估算子頁籤）
// 賣出部分/全部張數 → 賣出淨額全數買入「現有持股」或「指定代碼」，試算下個月起未來 12 個月每月股利增減
// 純前端試算：不下單、不改持股、不寫 Firestore。配息資料與推估規則沿用 dividend-est.js。

var SWAP_SELL_FEE = 0.002265;  // 賣出成本率（＝1−0.997735，與總現值淨額同基準：手續費＋交易稅）
var SWAP_BUY_FEE = 0.001425;   // 買入手續費率
var SWAP_N = 12;               // 試算期數（下個月起 12 個月）
var SWAP_LS = 'swap_state_v1';

var _swapState = null;   // {sells:{code:張}, buyMode, buyExist:[], buyCodes:[], alloc, allocPct:{}, wholeLot}
var _swapPx = {};        // code → 鎖定的現價快照（進頁時取，按鈕才刷新）
var _swapCalc = null;    // 最近一次試算結果
var _swapNote = '';      // 指定代碼載入訊息
var _swapBusy = false;

function _swapDefault() {
  return { sells: {}, buyMode: 'exist', buyExist: [], buyCodes: [], alloc: 'even', allocPct: {}, wholeLot: false };
}
function _swapLoad() {
  try {
    var s = JSON.parse(localStorage.getItem(SWAP_LS) || 'null');
    if (s && typeof s === 'object') {
      var d = _swapDefault();
      Object.keys(d).forEach(function (k) { if (s[k] == null) s[k] = d[k]; });
      return s;
    }
  } catch (e) {}
  return _swapDefault();
}
function _swapSave() { try { localStorage.setItem(SWAP_LS, JSON.stringify(_swapState)); } catch (e) {} }

// ── 子頁籤切換（股利估算 / 換股試算）──
function divShowTab(tab) {
  var est = tab === 'est';
  document.getElementById('divest-tab-est').style.display = est ? '' : 'none';
  document.getElementById('divest-tab-swap').style.display = est ? 'none' : '';
  document.getElementById('divest-subtab-est').classList.toggle('active', est);
  document.getElementById('divest-subtab-swap').classList.toggle('active', !est);
  if (!est) startSwap();
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

  // 資金分配
  var amt = {};
  if (picks.length) {
    if (_swapState.alloc === 'even') {
      picks.forEach(function (c) { amt[c] = sellNet / picks.length; });
    } else {
      var sum = 0;
      picks.forEach(function (c) { var v = parseFloat(_swapState.allocPct[c]); sum += (v > 0 ? v : 0); });
      picks.forEach(function (c) {
        var v = parseFloat(_swapState.allocPct[c]); v = v > 0 ? v : 0;
        amt[c] = sum > 0 ? sellNet * v / sum : 0;
      });
    }
  }

  // 可買股數（整張模式取整到 1000 股，否則以股為單位無條件捨去）
  var buyRows = [], usedCash = 0;
  picks.forEach(function (code) {
    var px = _swapPrice(code), per = px * (1 + SWAP_BUY_FEE);
    var raw = per > 0 ? (amt[code] || 0) / per : 0;
    var sh = _swapState.wholeLot ? Math.floor(raw / 1000) * 1000 : Math.floor(raw);
    var cost = sh * per;
    usedCash += cost;
    newShares[code] = (newShares[code] || 0) + sh;
    if (oldShares[code] == null) oldShares[code] = 0;
    buyRows.push({ code: code, sh: sh, px: px, amt: amt[code] || 0, cost: cost });
  });
  var cashLeft = sellNet - usedCash;

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
    totalVal: totalVal, amt: amt
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

function swapSellInput(code, el) {
  var v = parseFloat(el.value);
  if (!(v > 0)) delete _swapState.sells[code]; else _swapState.sells[code] = v;
  _swapSave();
  swapUpdate();
}
function swapSellAll(code) {
  _swapState.sells[code] = _swapHeld(code) / 1000;
  _swapSave();
  renderSwap();
}
function swapSetMode(mode) { _swapState.buyMode = mode; _swapSave(); renderSwap(); }
function swapSetAlloc(a) { _swapState.alloc = a; _swapSave(); renderSwap(); }
function swapToggleWhole(el) { _swapState.wholeLot = !!el.checked; _swapSave(); renderSwap(); }
function swapToggleBuy(code, el) {
  var i = _swapState.buyExist.indexOf(code);
  if (el.checked) { if (i < 0) _swapState.buyExist.push(code); }
  else if (i >= 0) _swapState.buyExist.splice(i, 1);
  _swapSave();
  renderSwap();
}
function swapPctInput(code, el) {
  var v = parseFloat(el.value);
  if (!(v > 0)) delete _swapState.allocPct[code]; else _swapState.allocPct[code] = v;
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
  var recs = _divRecMap[code];
  _swapNote = (recs && recs.length) ? '' : code + '（' + (_swapName(code) || '—') + '）查無配息紀錄，將以 0 計';
  _swapSave();
  renderSwap();
}
function swapDelCode(code) {
  var i = _swapState.buyCodes.indexOf(code);
  if (i >= 0) _swapState.buyCodes.splice(i, 1);
  delete _swapState.allocPct[code];
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
    '<th>代號</th><th>名稱</th><th class="num">現價</th><th class="num">持有(張)</th>' +
    '<th class="num">可賣(張)</th><th class="num">市值</th><th class="num">年配息</th>' +
    '<th class="num">賣出張數</th><th></th><th class="num">賣出淨額</th></tr></thead><tbody>';
  codes.forEach(function (code) {
    var px = _swapPrice(code), held = _swapHeld(code), free = _swapFree(code);
    var val = px != null ? px * held : null;
    var v = _swapState.sells[code];
    h += '<tr>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + code + '\')">' + code + '</span></td>' +
      '<td class="inv-name">' + _swapName(code) + '</td>' +
      '<td class="num">' + (px != null ? px.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + _swapLots(held) + '</td>' +
      '<td class="num' + (free < held ? ' swap-warn' : '') + '">' + _swapLots(free) + '</td>' +
      '<td class="num">' + (val != null ? fmtMoney(val) : '—') + '</td>' +
      '<td class="num" id="swap-base-' + code + '">—</td>' +
      '<td class="num"><input class="sbl-inp swap-inp" type="number" min="0" step="0.001" value="' + (v != null ? v : '') + '"' +
        ' oninput="swapSellInput(\'' + code + '\',this)"></td>' +
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
      '<span class="sbl-sep">｜</span>分配：' +
      '<label class="swap-radio"><input type="radio" name="swapalloc"' + (_swapState.alloc === 'even' ? ' checked' : '') + ' onchange="swapSetAlloc(\'even\')"> 平均</label>' +
      '<label class="swap-radio"><input type="radio" name="swapalloc"' + (_swapState.alloc === 'manual' ? ' checked' : '') + ' onchange="swapSetAlloc(\'manual\')"> 手動比例</label>' +
      '<span class="sbl-sep">｜</span>' +
      '<label class="swap-radio"><input type="checkbox"' + (_swapState.wholeLot ? ' checked' : '') + ' onchange="swapToggleWhole(this)"> 只買整張</label>' +
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
      (_swapState.alloc === 'manual' ? '<th class="num">比例(%)</th>' : '') +
      '<th class="num">分配金額</th><th class="num">可買股數</th><th class="num">＝張</th>' +
      '<th class="num">年配息(新增)</th></tr></thead><tbody>';
    picks.forEach(function (code) {
      var px = _swapPrice(code);
      h += '<tr>' +
        '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + code + '\')">' + code + '</span></td>' +
        '<td class="inv-name">' + _swapName(code) + '</td>' +
        '<td class="num">' + (px != null ? px.toFixed(2) : '—') + '</td>' +
        (_swapState.alloc === 'manual'
          ? '<td class="num"><input class="sbl-inp swap-inp" type="number" min="0" step="1" value="' +
            (_swapState.allocPct[code] != null ? _swapState.allocPct[code] : '') + '" oninput="swapPctInput(\'' + code + '\',this)"></td>'
          : '') +
        '<td class="num" id="swap-amt-' + code + '">—</td>' +
        '<td class="num" id="swap-sh-' + code + '">—</td>' +
        '<td class="num" id="swap-lot-' + code + '">—</td>' +
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

  // 買入列
  c.buyRows.forEach(function (r) {
    var pc = baseMap[r.code];
    set('swap-amt-' + r.code, fmtMoney(r.amt));
    set('swap-sh-' + r.code, r.sh.toLocaleString('zh-TW'));
    set('swap-lot-' + r.code, _swapLots(r.sh));
    var inc = pc ? pc.after - pc.before : 0;
    set('swap-div-' + r.code, (inc ? '<span class="' + colorClass(inc) + '">' + fmtMoney(inc) + '</span>' : '—'));
  });
  set('swap-buy-total', fmtMoney(c.usedCash));
  set('swap-cash', fmtMoney(c.cashLeft));

  set('swap-result', _swapResultHtml(c));
}

function _swapResultHtml(c) {
  if (!c.sellRows.length) {
    return '<div class="tx-box"><div class="modal-loading">在「賣出」區輸入張數後即可看到試算結果。</div></div>';
  }
  var diff = c.annAfter - c.annBefore;
  var diffYear = c.afterYear - c.beforeYear;
  var yBefore = c.totalVal ? c.annBefore / c.totalVal * 100 : null;
  var yAfter = c.totalVal ? c.annAfter / c.totalVal * 100 : null;

  var sp = function (lb, v, color) {
    return '<span class="divest-sp"><span class="divest-sp-lb">' + lb + '</span>' +
      '<span class="divest-sp-v"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></span>';
  };
  var cv = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--text3)' };
  var h = '<div class="tx-box"><div class="tx-box-head"><span class="tx-box-title">試算結果</span>' +
    '<span class="swap-hint">' + _swapYmLabel(c.startYm) + ' ～ ' + _swapYmLabel(c.startYm + SWAP_N - 1) + '（未來 12 個月）</span></div>' +
    '<div class="swap-sum">' +
      sp('年配息（前）', fmtMoney(c.annBefore), 'var(--text2)') +
      sp('年配息（後）', fmtMoney(c.annAfter), 'var(--accent2)') +
      sp('增減', _swapSigned(diff), cv[colorClass(diff)]) +
      sp('殖利率', (yBefore != null ? yBefore.toFixed(2) + '% → ' + yAfter.toFixed(2) + '%' : '—'), 'var(--text)') +
      sp('今年剩餘增減', _swapSigned(diffYear), cv[colorClass(diffYear)]) +
    '</div>';

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
