// 股利總管 Web — 關注股票「ETF 評比」頁籤：全市場 ETF 依多項指標打分，各類取前 20 名
//
// 資料來源（全部經 GAS 代理，完全不用券商 API → 不佔永豐查詢流量）：
//   1) TWSE MIS all_etf.txt：全市場 ETF（上市＋上櫃約 360 檔）的受益權單位數、預估淨值、成交價、折溢價 → 規模＝單位數×淨值
//   2) 收盤價：TWSE MI_INDEX(type=0099P, ETF)＋TPEx 上櫃收盤行情，只抓「今天附近、半年前、一年前」三個日期 → 成長率
//   3) 除息：TWSE TWT49U＋TPEx exDailyQ（除權息計算結果表，含除息前收盤價＝填息基準價），近 12 個月
//   4) 填息率：只對第一輪篩出的前 30 名抓 Yahoo 一年日線（每檔 1 次，當日快取）
//   5) 內扣費用：沿用配息資料頁的官方 ETF 規格（div-meta.js，30 天快取），同樣只查前 30 名
//
// 評分：各指標在同類別內換算成百分位（0–100，越好越高；費用越低越好），依權重加權平均。
//   第一輪（全部）：一年含息 25、近 12 月殖利率 25、一年價格成長 15、規模 10
//   第二輪（前 30）：再加上 填息率 20、內扣費用 5 → 取前 20 名顯示
// 排除：槓桿／反向（L、R 尾碼或名稱含正向、反向、倍）、期貨／商品等其他型（U 尾碼）、上市未滿一年（缺一年前收盤）。
var ES_LS = 'etf_screen_v1';          // { day, base }：第一輪基本資料（每日一次）
var ES_FILL_LS = 'etf_screen_fill_v1'; // { day, map: { code: {n, filled, days} } }：填息結果（每日一次）
var ES_SORT_LS = 'etf_screen_sort_v1';
var ES_TOP1 = 30, ES_TOP = 20;
var ES_W1 = { tr12: 25, y12: 25, g12: 15, size: 10 };
var ES_W2 = { tr12: 25, y12: 25, g12: 15, size: 10, fill: 20, fee: 5 };
var ES_GROUPS = [
  { key: 'hy', label: '高股息', cats: ['高息型', '主動高息'] },
  { key: 'mkt', label: '市值型', cats: ['市值型', '主動市值'] },
  { key: 'bond', label: '債券', test: function (c) { return /債$/.test(c); } }
];
var ES_HY_EXTRA = /優息|股利|收益|股息/;   // category.js 的高息關鍵字之外，常見的高息命名（00929 優息、00701 股利、00927 收益）

var ES_GROUP_LS = 'etf_screen_group_v1';   // 分類頁籤（高股息／市值型／債券）也記住
var _esBase = null, _esFill = {}, _esBusy = false, _esMsg = '', _esFillBusy = {};
var _esGroup = (function () { try { var g = localStorage.getItem(ES_GROUP_LS); return /^(hy|mkt|bond)$/.test(g || '') ? g : 'hy'; } catch (e) { return 'hy'; } })();
var _esSort = (function () {
  try { var v = localStorage.getItem(ES_SORT_LS); if (/^(score|code|px|y1|yEst|y12|fill|fillDays|g6|g12|tr6|tr12|size|fee|prem)(Asc|Desc)$/.test(v || '')) return v; } catch (e) {}
  return 'scoreDesc';
})();

function _esVia(u, ms) {
  return _divFetchT(NEWS_GAS_URL + '?url=' + encodeURIComponent(u), ms || 40000).then(function (r) { return r.text(); })
    .then(function (t) {
      var j;
      try { j = JSON.parse(t); }
      catch (e) { throw new Error('代理服務暫時無回應（回傳錯誤網頁）'); }   // GAS 忙碌／配額用完時回 HTML
      if (j && j.error) throw new Error(j.error);
      return j;
    });
}
function _esNum(x) { var v = parseFloat(String(x == null ? '' : x).replace(/,/g, '')); return isNaN(v) ? null : v; }
function _esIso(t) { return new Date(t).toISOString().slice(0, 10); }
function _esRocToIso(txt) {
  var m = String(txt || '').match(/(\d{2,3})\D(\d{1,2})\D(\d{1,2})/);
  return m ? (+m[1] + 1911) + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
}

// 某日（遇假日往前找，最多 7 天）全部 ETF 收盤：{ code: {c, n, mkt} }
async function _esClosesNear(iso) {
  var t = Date.parse(iso);
  var tries = async function (fn) { for (var a = 0; a < 3; a++) { try { var v = await fn(); if (v) return v; } catch (e) {} } return null; };
  for (var k = 0; k < 7; k++) {
    var d = new Date(t - k * 86400000), ymd = _esIso(d).replace(/-/g, '');
    var roc = (d.getUTCFullYear() - 1911) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + d.getUTCDate()).slice(-2);
    // 上市：回 null＝抓取失敗（重試）、{}＝當天無資料（假日）
    var tse = await tries(async function () {
      var j = await _esVia('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=' + ymd + '&type=0099P&response=json');
      if (!j || (!j.tables && !j.stat)) return null;
      var o = {};
      (j.tables || []).forEach(function (tb) {
        if (!tb || !tb.fields || tb.fields[0] !== '證券代號') return;
        (tb.data || []).forEach(function (x) { var c = _esNum(x[8]); if (c) o[x[0]] = { c: c, n: x[1], mkt: 'TSE' }; });
      });
      return o;
    });
    if (!tse || !Object.keys(tse).length) continue;          // 假日或上市抓不到 → 往前一天
    var otc = await tries(async function () {
      var k2 = await _esVia('https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d=' + roc + '&se=EW&o=json');
      var tb2 = k2 && k2.tables && k2.tables[0];
      if (!tb2 || !(tb2.data || []).length) return null;    // 上市當天有交易，上櫃不可能是空的 → 視為失敗重試
      var o = {};
      tb2.data.forEach(function (x) { if (/^00/.test(x[0])) { var c = _esNum(x[2]); if (c) o[x[0]] = { c: c, n: String(x[1]).trim(), mkt: 'OTC' }; } });
      return o;
    }) || {};
    return { day: _esIso(d), map: Object.assign({}, tse, otc), otcOk: Object.keys(otc).length > 0 };
  }
  return { day: null, map: {} };
}

// 近 12 個月除息（官方計算結果表，含除息前收盤＝填息基準）：{ code: [{ex, amt, base}] }，由舊到新
async function _esDivs(todayIso) {
  var t = Date.parse(todayIso), DAY = 86400000, map = {};
  var spans = [[t - 365 * DAY, t - 183 * DAY], [t - 182 * DAY, t]];
  var roc = function (ms) { var d = new Date(ms); return (d.getUTCFullYear() - 1911) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + d.getUTCDate()).slice(-2); };
  var ymd = function (ms) { return _esIso(ms).replace(/-/g, ''); };
  var add = function (code, iso, amt, base) {
    code = String(code).trim();
    if (!/^00/.test(code) || !iso || !(amt > 0)) return;
    (map[code] = map[code] || []).push({ ex: iso, amt: amt, base: base });
  };
  var ok = 0;
  await Promise.all(spans.map(async function (sp) {
    for (var a = 0; a < 2; a++) {
      try {
        var j = await _esVia('https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=' + roc(sp[0]) + '&endDate=' + roc(sp[1]) + '&response=json');
        var tb = j && j.tables && j.tables[0];
        if (tb) { ok++; (tb.data || []).forEach(function (x) { add(x[1], _esRocToIso(x[0]), _esNum(x[6]), _esNum(x[3])); }); return; }
      } catch (e) {}
    }
  }).concat(spans.map(async function (sp) {
    for (var a = 0; a < 2; a++) {
      try {
        var j = await _esVia('https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=' + ymd(sp[0]) + '&endDate=' + ymd(sp[1]) + '&response=json');
        var rows = j && (j.data || (j.tables && j.tables[0] && j.tables[0].data));
        if (rows) { ok++; rows.forEach(function (x) { if (/息/.test(x[6]) && !/權/.test(x[6])) add(x[1], _esRocToIso(x[0]), _esNum(x[5]), _esNum(x[3])); }); return; }
      } catch (e) {}
    }
  })));
  Object.keys(map).forEach(function (c) {
    var seen = {};
    map[c] = map[c].filter(function (r) { if (seen[r.ex]) return false; seen[r.ex] = 1; return true; })
      .sort(function (a, b) { return a.ex < b.ex ? -1 : 1; });
  });
  return { ok: ok === 4, map: map };
}

// 第一輪：全市場基本資料（每日快取）
async function _esLoadBase(force) {
  var today = _divTwDate().iso;
  if (!force) {
    try { var c = JSON.parse(localStorage.getItem(ES_LS) || 'null'); if (c && c.day === today && c.base) return c.base; } catch (e) {}
  }
  _esMsg = '讀取全市場 ETF 規模與淨值…'; renderEtfScreen();
  // GAS 偶發「無法開啟網址」→ 重試 3 次（間隔 2 秒）
  var mis = null, misErr = null;
  var WAITS = [2000, 4000, 8000, 8000];              // 共 5 次、最多多等約 22 秒；最後一次失敗不再等
  for (var a = 0; a <= WAITS.length && !mis; a++) {
    try { mis = await _esVia('https://mis.twse.com.tw/stock/data/all_etf.txt'); }
    catch (e) {
      misErr = e;
      if (a === WAITS.length) break;
      _esMsg = '讀取全市場 ETF 規模與淨值…（代理服務忙碌，' + (WAITS[a] / 1000) + ' 秒後第 ' + (a + 2) + ' 次嘗試）'; renderEtfScreen();
      await new Promise(function (r) { setTimeout(r, WAITS[a]); });
    }
  }
  if (!mis) throw misErr || new Error('MIS 讀取失敗');
  var list = {};
  (mis.a1 || []).forEach(function (g) {
    (g.msgArray || []).forEach(function (x) {
      list[x.a] = { code: x.a, full: x.b, units: _esNum(x.c), nav: _esNum(x.f), px: _esNum(x.e), prem: _esNum(x.g) };
    });
  });
  var t = Date.parse(today), DAY = 86400000;
  _esMsg = '讀取收盤價（今天、半年前、一年前）…'; renderEtfScreen();
  var now = await _esClosesNear(today);
  var m6 = await _esClosesNear(_esIso(t - 182 * DAY));
  var m12 = await _esClosesNear(_esIso(t - 365 * DAY));
  _esMsg = '讀取近 12 個月除息紀錄…'; renderEtfScreen();
  var dv = await _esDivs(today);
  var base = { day: today, d0: now.day, d6: m6.day, d12: m12.day, list: list, c0: now.map, c6: m6.map, c12: m12.map, divs: dv.map };
  if (dv.ok && now.otcOk && m6.otcOk && m12.otcOk) {
    try { localStorage.setItem(ES_LS, JSON.stringify({ day: today, base: base })); } catch (e) {}
  }
  return base;
}

function _esGroupOf(code, name, full) {
  full = String(full || '').replace(/[（(].*$/, '');        // 去掉配息警語（內含「收益」會誤判成高息）
  if (/[LR]$/.test(code) || /正向|反向|槓桿|\d倍/.test(full)) return null;
  var nm = name + ' ' + full;
  // 4 碼的早期 ETF（0050、0056…）在 getCategory 會被當成個股，這裡直接依名稱判定
  var cat = /^00\d{2}$/.test(code) ? ((CAT_HY.test(nm) || ES_HY_EXTRA.test(nm)) ? '高息型' : '市值型') : getCategory(code, nm);
  if (cat === '市值型' && ES_HY_EXTRA.test(nm)) cat = '高息型';
  if (cat === '主動市值' && ES_HY_EXTRA.test(nm)) cat = '主動高息';
  for (var i = 0; i < ES_GROUPS.length; i++) {
    var g = ES_GROUPS[i];
    if (g.cats ? g.cats.indexOf(cat) >= 0 : g.test(cat)) return { key: g.key, cat: cat };
  }
  return null;
}

// 計算各檔指標（不含填息／費用）
function _esMetrics(base) {
  var today = base.day, t = Date.parse(today), DAY = 86400000;
  var d6 = _esIso(t - 182 * DAY), d12 = _esIso(t - 365 * DAY);
  var rows = [];
  Object.keys(base.list).forEach(function (code) {
    var L = base.list[code], c0 = base.c0[code], c12 = base.c12[code], c6 = base.c6[code];
    var name = (c0 && c0.n) || L.full;
    var g = _esGroupOf(code, name, L.full);
    if (!g) return;
    var px = (L.px > 0 ? L.px : null) || (c0 && c0.c);
    if (!px) return;
    var divs = base.divs[code] || [];
    var d12s = divs.filter(function (r) { return r.ex > d12 && r.ex <= today; });
    var d6s = divs.filter(function (r) { return r.ex > d6 && r.ex <= today; });
    var sum = function (a) { return a.reduce(function (s, r) { return s + r.amt; }, 0); };
    var last = divs[divs.length - 1];
    var step = null;
    if (divs.length) { try { step = _divInferStep(divs.map(function (r) { return { code: code, exDate: r.ex, amount: r.amt }; })); } catch (e) { step = null; } }
    var r = {
      code: code, name: name, grp: g.key, cat: g.cat, mkt: (c0 && c0.mkt) || ((c12 && c12.mkt) || 'TSE'),
      size: (L.units && L.nav) ? L.units * L.nav / 1e8 : null, nav: L.nav, prem0: L.prem,
      lastAmt: last ? last.amt : null, step: step, sum6: sum(d6s), sum12: sum(d12s), n12: d12s.length,
      c6: c6 ? c6.c : null, c12: c12 ? c12.c : null,
      young: !c12, events: d12s
    };
    _esDerive(r, px, true);
    rows.push(r);
  });
  return rows;
}

// 與價格有關的指標（現價變動時重算；排名用開頁時的價格，避免盤中每 30 秒名次跳動）
function _esDerive(r, px, init) {
  r.px = px;
  r.y1 = r.lastAmt ? r.lastAmt / px * 100 : null;
  r.yEst = (r.lastAmt && r.step) ? r.lastAmt * (12 / r.step) / px * 100 : null;
  r.y12 = r.n12 ? r.sum12 / px * 100 : 0;
  r.g6 = r.c6 ? (px / r.c6 - 1) * 100 : null;
  r.g12 = r.c12 ? (px / r.c12 - 1) * 100 : null;
  r.tr6 = r.c6 ? ((px + r.sum6) / r.c6 - 1) * 100 : null;
  r.tr12 = r.c12 ? ((px + r.sum12) / r.c12 - 1) * 100 : null;
  // 折溢價：開頁時用 MIS 給的值；即時價則以前一營業日淨值（MIS 預估淨值）換算
  r.prem = init ? r.prem0 : (r.nav ? (px / r.nav - 1) * 100 : r.prem0);
  r.live = !init;
  return r;
}

// 同組內百分位（0–100）：dir=1 越大越好、-1 越小越好；缺值者不計分（權重自動重新分配）
function _esPct(rows, key, dir) {
  var vals = rows.filter(function (r) { return r[key] != null; }).map(function (r) { return r[key]; }).sort(function (a, b) { return a - b; });
  var n = vals.length;
  rows.forEach(function (r) {
    if (r[key] == null || n < 2) { r['p_' + key] = null; return; }
    var lo = 0; while (lo < n && vals[lo] < r[key]) lo++;
    var hi = lo; while (hi < n && vals[hi] === r[key]) hi++;
    var p = ((lo + hi - 1) / 2) / (n - 1) * 100;
    r['p_' + key] = dir > 0 ? p : 100 - p;
  });
}
function _esScore(rows, W) {
  rows.forEach(function (r) {
    var s = 0, w = 0;
    Object.keys(W).forEach(function (k) { var p = r['p_' + k]; if (p != null) { s += p * W[k]; w += W[k]; } });
    r.score = w ? s / w : null;
  });
}

// 填息：Yahoo 一年日線；除息後（不含除息日前）首次收盤 ≥ 基準價即填息，天數以交易日計
var _esBars = {};   // code → [[iso, close]]（一年日線，記憶體快取；填息計算與明細走勢圖共用）
async function _esBarsOf(code, mkt) {
  if (_esBars[code]) return _esBars[code];
  var syms = mkt === 'OTC' ? [code + '.TWO', code + '.TW'] : [code + '.TW', code + '.TWO'];
  var bars = [];
  for (var i = 0; i < syms.length && !bars.length; i++) {
    try {
      var j = await _esVia('https://query1.finance.yahoo.com/v8/finance/chart/' + syms[i] + '?interval=1d&range=1y', 30000);
      var res = j.chart && j.chart.result && j.chart.result[0];
      var ts = (res && res.timestamp) || [], cl = (res && res.indicators.quote[0].close) || [];
      for (var k = 0; k < ts.length; k++) if (cl[k] != null) bars.push([new Date(ts[k] * 1000 + 8 * 3600000).toISOString().slice(0, 10), cl[k]]);
    } catch (e) {}
  }
  if (bars.length) _esBars[code] = bars;
  return bars;
}
async function _esFillOne(r) {
  var bars = await _esBarsOf(r.code, r.mkt);
  if (!bars.length) return null;
  var n = 0, filled = 0, days = [];
  r.events.forEach(function (e) {
    if (!(e.base > 0)) return;
    var i0 = -1;
    for (var k = 0; k < bars.length; k++) if (bars[k][0] >= e.ex) { i0 = k; break; }
    if (i0 < 0) return;
    n++;
    for (var q = i0; q < bars.length; q++) if (bars[q][1] >= e.base - 1e-9) { filled++; days.push(q - i0 + 1); return; }
  });
  return { n: n, filled: filled, days: days.length ? days.reduce(function (a, b) { return a + b; }, 0) / days.length : null };
}

async function _esEnsureFill(list) {
  var today = _divTwDate().iso;
  try { var c = JSON.parse(localStorage.getItem(ES_FILL_LS) || 'null'); if (c && c.day === today) _esFill = c.map || {}; } catch (e) {}
  var need = list.filter(function (r) { return !_esFill[r.code] && !_esFillBusy[r.code] && r.events.length; });
  if (!need.length) return;
  var done = 0, total = need.length;
  need.forEach(function (r) { _esFillBusy[r.code] = true; });
  var q = need.slice();
  var worker = async function () {
    while (q.length) {
      var r = q.shift();
      try { var f = await _esFillOne(r); if (f) _esFill[r.code] = f; } catch (e) {}
      done++;
      _esMsg = '計算填息率 ' + done + '/' + total + '（Yahoo 日線，當日快取）';
      renderEtfScreen();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  need.forEach(function (r) { delete _esFillBusy[r.code]; });
  try { localStorage.setItem(ES_FILL_LS, JSON.stringify({ day: today, map: _esFill })); } catch (e) {}
  _esMsg = '';
}

// 目前分類的前 20 名（第一輪 → 前 30 → 第二輪）
function _esRank() {
  if (!_esBase) return null;
  var all = _esMetrics(_esBase).filter(function (r) { return r.grp === _esGroup; });
  var rank = all.filter(function (r) { return !r.young; });
  ['tr12', 'y12', 'g12', 'size'].forEach(function (k) { _esPct(rank, k, 1); });
  _esScore(rank, ES_W1);
  rank.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  var short = rank.slice(0, ES_TOP1);
  short.forEach(function (r) {
    var f = _esFill[r.code];
    r.fill = f && f.n ? f.filled / f.n * 100 : null;
    r.fillN = f ? f.filled + '/' + f.n : null;
    r.fillDays = f ? f.days : null;
    var m = (typeof _divMeta !== 'undefined' && _divMeta[r.code]) || {};
    var mg = (typeof _divFeePct === 'function') ? _divFeePct(m.mgmt) : null, cu = (typeof _divFeePct === 'function') ? _divFeePct(m.cust) : null;
    r.fee = (mg != null && cu != null) ? mg + cu : null;
  });
  _esPct(short, 'fill', 1);
  _esPct(short, 'fee', -1);
  _esScore(short, ES_W2);
  short.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  short.forEach(function (r, i) { r.rank = i + 1; });
  var top = short.slice(0, ES_TOP);
  top.forEach(function (r) { if (_esLive[r.code] > 0) _esDerive(r, _esLive[r.code]); });
  _esShown = top.map(function (r) { return { code: r.code, mkt: r.mkt }; });
  return { top: top, short: short, total: all.length, young: all.length - rank.length };
}

var _esLive = {}, _esShown = [], _esLiveTimer = null, _esLiveAt = null;
async function _esLiveTick(always) {
  var wrap = document.getElementById('wt-screen-wrap');
  if (!wrap || wrap.style.display === 'none' || document.hidden || !_esShown.length || typeof fetchSnapshots !== 'function') return;
  if (!always && typeof _twOpen === 'function' && !_twOpen()) return;       // 盤後只在進頁時抓一次最後價
  try {
    var sn = await fetchSnapshots(_esShown.map(function (x) { return { exchange: x.mkt === 'OTC' ? 'OTC' : 'TSE', code: x.code }; }));
    (sn || []).forEach(function (x) { if (x && x.code && x.close > 0) _esLive[x.code] = +x.close; });
    _esLiveAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 19);
    renderEtfScreen();
  } catch (e) { /* 券商連線中斷 → 維持開頁價格 */ }
}
function _esLiveStart() {
  _esLiveTick(true);
  if (!_esLiveTimer) _esLiveTimer = setInterval(function () { _esLiveTick(false); }, 30000);
}

var _esBasePromise = null, _esStale = null, _esRetryTimer = null;
// 最後一次完整成功的資料（不限日期）：今天讀取失敗時先沿用，畫面標示資料日期
function _esLastGood() {
  try { var c = JSON.parse(localStorage.getItem(ES_LS) || 'null'); return c && c.base ? c.base : null; } catch (e) { return null; }
}
function _esGetBase(force) {
  if (!force && _esBase && _esBase.day === _divTwDate().iso) return Promise.resolve(_esBase);
  if (_esBasePromise) return _esBasePromise;
  _esBasePromise = _esLoadBase(force).then(function (b) { _esBase = b; _esStale = null; return b; })
    .catch(function (e) {
      var old = _esLastGood();
      if (!old) throw e;
      _esBase = old; _esStale = old.day;
      // 2 分鐘後自動再試一次（使用者不用自己按重新整理）
      clearTimeout(_esRetryTimer);
      _esRetryTimer = setTimeout(function () { _esStale && startEtfScreen(false); }, 120000);
      return old;
    })
    .finally(function () { _esBasePromise = null; });
  return _esBasePromise;
}
async function startEtfScreen(force) {
  if (_esBusy) return;
  _esBusy = true;
  try {
    await _esGetBase(force);
    _esMsg = '';
    renderEtfScreen();
    _esLiveStart();
    await _esLoadExtra();
  } catch (e) {
    _esMsg = '讀取失敗：' + e.message + '（稍後按「↻ 重新整理」再試）';
  } finally { _esBusy = false; renderEtfScreen(); }
}
// 前 30 名的填息與費用（切換分類時也會呼叫）
async function _esLoadExtra() {
  var rk = _esRank();
  if (!rk) return;
  var codes = rk.short.map(function (r) { return r.code; });
  if (typeof divMetaLoad === 'function') { divMetaLoad(codes).then(renderEtfScreen).catch(function () {}); }
  await _esEnsureFill(rk.short);
  renderEtfScreen();
}
function esSetGroup(k) {
  _esGroup = k;
  try { localStorage.setItem(ES_GROUP_LS, k); } catch (e) {}
  renderEtfScreen();
  if (_esBase) _esLoadExtra();
}
function esSortCol(key) {
  _esSort = (_esSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  try { localStorage.setItem(ES_SORT_LS, _esSort); } catch (e) {}
  renderEtfScreen();
}

// 填息率顯示：「(4/4) 100%」次數在前、比例固定寬度靠右，各列的 % 才會上下對齊
function _esFillTxt(r) {
  return '<span class="dm-dim">(' + r.fillN + ')</span><span class="es-fpct">' + r.fill.toFixed(0) + '%</span>';
}
var ES_COLS = [
  // key, 標題, 格式, 說明
  ['rank', '#', 'int', '綜合排名'],
  ['code', '代號', 'code', ''],
  ['score', '綜合', 'f1', '各指標同類百分位加權：一年含息 25、近12月殖利率 25、填息率 20、一年價格 15、規模 10、內扣費用 5'],
  ['px', '現價', 'f2', '盤中每 30 秒更新（券商快照）；殖利率、成長率、折溢價跟著現價重算，排名維持開頁時的計算'],
  ['y1', '單次配', 'pct', '單次殖利率：最近一次配息 ÷ 現價'],
  ['yEst', '預估年配', 'pct', '預估年殖利率：最近一次配息 × 年配息次數 ÷ 現價'],
  ['y12', '近12月配', 'pct', '近 12 個月殖利率：近 12 個月實際配息合計 ÷ 現價'],
  ['fill', '填息率', 'fill', '近 12 個月：已填息次數 ÷ 除息次數（除息後收盤回到除息前收盤即算填息）'],
  ['fillDays', '平均填息', 'days', '已填息者平均花幾個交易日'],
  ['g6', '半年價格', 'sgn', '不含配息的價格變化：負值代表本金被侵蝕'],
  ['g12', '一年價格', 'sgn', '不含配息的價格變化：負值代表本金被侵蝕'],
  ['tr6', '半年含息', 'sgn', '（現價＋期間配息）÷ 半年前收盤 − 1'],
  ['tr12', '一年含息', 'sgn', '（現價＋期間配息）÷ 一年前收盤 − 1：最公平的總成績'],
  ['size', '規模(億)', 'size', '受益權單位數 × 淨值'],
  ['fee', '內扣', 'fee', '管理費＋保管費（年率，級距制取最低級距）'],
  ['prem', '折溢價', 'sgn', '市價相對預估淨值；正＝溢價（買貴了）'],
  ['watch', '關注', 'watch', '加入／移出關注清單（與「關注股票」頁籤同一份清單）']
];

// 加入／移出關注清單：停留在評比頁（不跳頁），背景重新載入關注清單（補合約、報價、訂閱）
async function esWatchToggle(code) {
  code = String(code);
  if (typeof _wtLoad !== 'function') return;
  var list = _wtLoad(), i = list.indexOf(code);
  if (i >= 0) {
    if (typeof wtRemove === 'function') wtRemove(code);
    _esMsg = code + ' 已移出關注清單';
  } else {
    if (list.length >= WT_MAX) { _esMsg = '關注清單已達上限 ' + WT_MAX + ' 檔，請先到「關注股票」移除'; renderEtfScreen(); return; }
    list.push(code);
    _wtSave();
    _esMsg = code + ' 已加入關注清單';
    if (typeof startWatch === 'function') startWatch().catch(function () {});
  }
  renderEtfScreen();
  setTimeout(function () { if (/關注清單/.test(_esMsg)) { _esMsg = ''; renderEtfScreen(); } }, 4000);
}

function renderEtfScreen() {
  var wrap = document.getElementById('wt-screen-wrap');
  if (!wrap || wrap.style.display === 'none') return;
  var held = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  if (typeof _wtLoad === 'function' && !_wtList) _wtLoad();
  var watched = {}; (typeof _wtList !== 'undefined' && _wtList || []).forEach(function (c) { watched[c] = true; });

  var h = '<div class="tr-toolbar es-bar">' + ES_GROUPS.map(function (g) {
    return '<button class="tx-subtab' + (g.key === _esGroup ? ' active' : '') + '" onclick="esSetGroup(\'' + g.key + '\')">' + g.label + '</button>';
  }).join('') +
    '<button class="btn-query" onclick="startEtfScreen(true)">↻ 重新整理</button>' +
    (_esStale ? '<span class="es-info swap-warn">今日資料讀取失敗（代理服務忙碌），暫用 ' + _esStale.slice(5).replace('-', '/') + ' 的資料，2 分鐘後自動重試</span>' : '') +
    '<span class="es-info">' + (_esMsg || (_esBase ? '資料日 ' + (_esBase.d0 || '—') + '（半年前 ' + (_esBase.d6 || '—') + '、一年前 ' + (_esBase.d12 || '—') + '）' +
      (_esLiveAt ? '｜現價更新 ' + _esLiveAt : '') + '｜點列展開配息與走勢' : '')) + '</span></div>';
  if (!_esBase) { wrap.innerHTML = h + '<div class="modal-loading">' + (_esMsg || '讀取中…') + '</div>'; return; }

  var rk = _esRank();
  var rows = rk.top.slice();
  var key = _esSort.replace(/(Asc|Desc)$/, ''), asc = /Asc$/.test(_esSort);
  if (key !== 'score') {
    rows.sort(function (a, b) {
      var va = a[key], vb = b[key];
      if (va == null && vb == null) return a.rank - b.rank;
      if (va == null) return 1;
      if (vb == null) return -1;
      var c = typeof va === 'string' ? va.localeCompare(vb, undefined, { numeric: true }) : va - vb;
      return (asc ? c : -c) || a.rank - b.rank;
    });
  } else if (asc) rows.reverse();

  var dim = function (s) { return '<span class="dm-dim">' + s + '</span>'; };
  var sg = function (v, d) { if (v == null) return dim('—'); var cls = v > 0 ? 'up' : (v < 0 ? 'down' : ''); return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%</span>'; };
  var fmt = function (r, c) {
    var v = r[c[0]];
    switch (c[2]) {
      case 'int': return v;
      case 'code': return '<span class="code-link" title="' + (r.name || '').replace(/"/g, '&quot;') + '（點代號看線圖，點列展開配息明細）" onclick="openChartPop(\'' + v + '\')">' + v + '</span>' +
        (held[v] > 0 ? '<span class="es-tag es-held" title="目前持有">持</span>' : '') + (watched[v] ? '<span class="es-tag es-watch" title="已在關注清單">關</span>' : '');
      case 'txt': return v || '';
      case 'f1': return v == null ? dim('—') : '<b>' + v.toFixed(1) + '</b>';
      case 'f2': return v == null ? dim('—') : v.toFixed(2);
      case 'pct': return v == null ? dim('—') : v.toFixed(2) + '%';
      case 'fill': return v == null ? (_esFillBusy[r.code] || (_esMsg && /填息/.test(_esMsg)) ? '<span class="const-spin"></span>' : dim('—')) : _esFillTxt(r);
      case 'days': return v == null ? dim('—') : v.toFixed(1) + ' 天';
      case 'sgn': return sg(v);
      case 'size': return v == null ? dim('—') : Math.round(v).toLocaleString('zh-TW');
      case 'fee': return v == null ? dim('—') : v.toFixed(2) + '%';
      case 'watch': return watched[r.code]
        ? '<button class="swap-mini es-wbtn on" title="點一下移出關注清單" onclick="esWatchToggle(\'' + r.code + '\')">✓ 已關注</button>'
        : '<button class="swap-mini es-wbtn" title="加入關注清單" onclick="esWatchToggle(\'' + r.code + '\')">＋ 關注</button>';
    }
    return '';
  };
  h += '<div class="inv-table-wrap"><table class="inv-table es-table"><thead><tr>' + ES_COLS.map(function (c) {
    var sortable = c[0] !== 'rank' && c[0] !== 'watch';
    var k = c[0] === 'rank' ? 'score' : c[0];
    var on = sortable && _esSort.indexOf(k) === 0 && _esSort.replace(/(Asc|Desc)$/, '') === k;
    return '<th class="' + (/^(code|name)$/.test(c[0]) ? '' : 'num ') + (sortable ? 'sort-th' + (on ? ' sorted' : '') : '') + '"' +
      (sortable ? ' onclick="esSortCol(\'' + k + '\')"' : '') + (c[3] ? ' title="' + c[3] + '"' : '') + '>' + c[1] +
      (sortable ? '<span class="sort-ind">' + (on ? (asc ? '▲' : '▼') : '↕') + '</span>' : '') + '</th>';
  }).join('') + '</tr></thead><tbody>';
  rows.forEach(function (r) {
    var open = _esOpen === r.code;
    h += '<tr class="es-row' + (open ? ' es-row-open' : '') + '" onclick="esRowClick(event,\'' + r.code + '\')">' + ES_COLS.map(function (c) {
      return '<td class="' + (c[0] === 'code' ? 'inv-code' : (c[0] === 'name' ? 'inv-name' : (c[0] === 'watch' ? 'es-wcell' : 'num'))) + '">' + fmt(r, c) + '</td>';
    }).join('') + '</tr>';
    if (open) h += '<tr class="es-drow"><td colspan="' + ES_COLS.length + '" class="es-dslot" data-code="' + r.code + '"></td></tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="divest-note">本類共 ' + rk.total + ' 檔（上市未滿一年 ' + rk.young + ' 檔不列入排名），依綜合分數取前 ' + ES_TOP + ' 名；已排除槓桿／反向與期貨商品型。' +
    '綜合＝各指標在同類中的百分位加權（一年含息 25、近12月殖利率 25、填息率 20、一年價格 15、規模 10、內扣費用 5），填息率與費用只對前 ' + ES_TOP1 + ' 名計算。' +
    '含息報酬未計再投入；價格成長為負代表淨值被配息侵蝕。資料來源：TWSE／TPEx 官方行情與除權息結果表、Yahoo 日線（填息）。<b>歷史統計，非投資建議。</b></div>';
  // 重繪時保留已展開的明細（圖已畫好、資料已載入），不重建 → 即時價格每 30 秒刷新也不會閃
  var keep = _esOpen ? wrap.querySelector('.es-detail[data-code="' + _esOpen + '"]') : null;
  if (keep) keep.remove();
  wrap.innerHTML = h;
  esMountDetail(wrap.querySelector('.es-dslot'), keep);
}
var _esOpen = null;
function esRowClick(ev, code) {
  if (ev && ev.target && ev.target.closest('button, a, input, .code-link')) return;   // 按鈕／代號連結各有用途
  _esOpen = (_esOpen === code) ? null : code;
  renderEtfScreen();
}

// ══════════ 關注清單共用：ETF 評比指標欄位 ══════════
// 指標與評比頁同源（_esBase，當日快取）；「類別排名」＝第一輪分數（一年含息、近12月殖利率、一年價格、規模）在同類全部 ETF 中的名次。
// 填息率、內扣費用：關注清單中的 ETF 另外補算（Yahoo 日線／官方規格，同樣有快取）。
var _esAllMap = null, _esAllMapBase = null;
function esMetricsFor(code) {
  if (!_esBase) return null;
  if (_esAllMapBase !== _esBase) {
    var rows = _esMetrics(_esBase), map = {};
    ES_GROUPS.forEach(function (g) {
      var grp = rows.filter(function (r) { return r.grp === g.key; });
      var rank = grp.filter(function (r) { return !r.young; });
      ['tr12', 'y12', 'g12', 'size'].forEach(function (k) { _esPct(rank, k, 1); });
      _esScore(rank, ES_W1);
      rank.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      rank.forEach(function (r, i) { r.grpRank = i + 1; r.grpN = rank.length; });
      grp.forEach(function (r) { r.grpLabel = g.label; map[r.code] = r; });
    });
    _esAllMap = map; _esAllMapBase = _esBase;
  }
  var r = _esAllMap[String(code)];
  if (!r) return null;
  var f = _esFill[r.code];
  r.fill = f && f.n ? f.filled / f.n * 100 : null;
  r.fillN = f ? f.filled + '/' + f.n : null;
  r.fillDays = f ? f.days : null;
  var m = (typeof _divMeta !== 'undefined' && _divMeta[r.code]) || {};
  var mg = (typeof _divFeePct === 'function') ? _divFeePct(m.mgmt) : null, cu = (typeof _divFeePct === 'function') ? _divFeePct(m.cust) : null;
  r.fee = (mg != null && cu != null) ? mg + cu : null;
  return r;
}
var _esWatchBusy = false;
async function esWatchPrep(codes) {
  if (_esWatchBusy) return;
  _esWatchBusy = true;
  try {
    await _esGetBase(false);
    if (typeof renderWatch === 'function') renderWatch();
    var etfs = (codes || []).map(esMetricsFor).filter(Boolean);
    if (!etfs.length) return;
    if (typeof divMetaLoad === 'function') divMetaLoad(etfs.map(function (r) { return r.code; })).then(function () { if (typeof renderWatch === 'function') renderWatch(); }).catch(function () {});
    await _esEnsureFill(etfs);
    if (typeof renderWatch === 'function') renderWatch();
  } catch (e) { console.warn('[關注清單 ETF 指標]', e); }
  finally { _esWatchBusy = false; }
}
var ES_WCOLS = ['score', 'y1', 'yEst', 'y12', 'fill', 'fillDays', 'g6', 'g12', 'tr6', 'tr12', 'size', 'fee', 'prem'];
function esWatchHeads() {
  return ES_WCOLS.map(function (k) {
    var c = ES_COLS.filter(function (x) { return x[0] === k; })[0];
    var label = k === 'score' ? '類別排名' : c[1];
    var tip = k === 'score' ? '在同類 ETF 中的名次（一年含息、近12月殖利率、一年價格、規模加權；上市未滿一年不排名）' : c[3];
    var on = typeof _wtSort !== 'undefined' && _wtSort.replace(/(Asc|Desc)$/, '') === k;
    var asc = on && /Asc$/.test(_wtSort);
    return '<th class="num sort-th' + (on ? ' sorted' : '') + '" onclick="wtSortCol(\'' + k + '\')"' + (tip ? ' title="' + tip + '"' : '') + '>' + label +
      '<span class="sort-ind">' + (on ? (asc ? '▲' : '▼') : '↕') + '</span></th>';
  }).join('');
}
// 關注清單排序用的數值：類別排名越前面越好 → 取負名次，降冪時第 1 名在最上
function esWatchSortVal(code, key) {
  var r = esMetricsFor(code);
  if (!r) return null;
  if (key === 'score') return r.grpRank ? -r.grpRank : null;
  return r[key] == null ? null : r[key];
}
function esWatchCells(code) {
  var r = esMetricsFor(code);
  var dim = function (t) { return '<span class="dm-dim">' + t + '</span>'; };
  if (!r) {
    var loading = !_esBase && (typeof isEtfCode === 'function') && isEtfCode(code);
    return ES_WCOLS.map(function () { return '<td class="num">' + (loading ? '<span class="const-spin"></span>' : dim('—')) + '</td>'; }).join('');
  }
  var sg = function (v) { if (v == null) return dim('—'); var cls = v > 0 ? 'up' : (v < 0 ? 'down' : ''); return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>'; };
  var pct = function (v) { return v == null ? dim('—') : v.toFixed(2) + '%'; };
  var cell = {
    score: r.grpRank ? r.grpLabel + ' <b>' + r.grpRank + '</b>' + dim('/' + r.grpN) : dim(r.grpLabel + '（未滿一年）'),
    y1: pct(r.y1), yEst: pct(r.yEst), y12: pct(r.y12),
    fill: r.fill == null ? (_esFillBusy[r.code] ? '<span class="const-spin"></span>' : dim('—')) : _esFillTxt(r),
    fillDays: r.fillDays == null ? dim('—') : r.fillDays.toFixed(1) + ' 天',
    g6: sg(r.g6), g12: sg(r.g12), tr6: sg(r.tr6), tr12: sg(r.tr12),
    size: r.size == null ? dim('—') : Math.round(r.size).toLocaleString('zh-TW'),
    fee: r.fee == null ? dim('—') : r.fee.toFixed(2) + '%',
    prem: sg(r.prem)
  };
  return ES_WCOLS.map(function (k) { return '<td class="num es-wm">' + cell[k] + '</td>'; }).join('');
}

// ══════════ 展開明細（ETF 評比與關注股票共用）══════════
// 左：配息走勢圖（沿用股利估算的歷年配息圖，近 2 年：長條＝每股配息、折線＝年化殖利率）
// 右：近 2 年配息紀錄（除息日、發放日、每股配息、當次／年化殖利率、填息狀態）
// 填息狀態：官方除權息結果表的「除息前收盤」為基準，除息後首次收盤 ≥ 基準即填息（日線只有一年，更早的顯示「—」）
// 表格很寬（可左右捲動）：明細寬度固定為「看得到的寬度」並黏在左側，圖才不會被推到畫面外、也不會被壓扁
function _esFitDetail(slot, det, tries) {
  var box = slot.closest('.inv-table-wrap');
  var vis = box ? box.clientWidth : 0;
  if (!(vis > 0)) {                                   // 版面還沒排好（剛插入、分頁剛顯示）→ 下一個畫格再量
    if ((tries || 0) < 30) setTimeout(function () { if (det.isConnected) _esFitDetail(slot, det, (tries || 0) + 1); }, 100);   // 不用 rAF：分頁在背景時 rAF 不會執行
    return;
  }
  var w = (vis - 2) + 'px';
  if (det.style.width === w) return;
  det.style.width = w;
  // 寬度變了 → 配息圖依新寬度重畫（紀錄已載入才畫，否則等 _esLoadDetail 畫）
  var he = det.querySelector('.divest-hist'), code = det.getAttribute('data-code');
  if (he && he.querySelector('svg') && typeof _divHistDraw === 'function') _divHistDraw(he, code);
}
window.addEventListener('resize', function () {
  document.querySelectorAll('.es-detail').forEach(function (d) { var sl = d.closest('.es-dslot'); if (sl) _esFitDetail(sl, d); });
});
// 名稱來源：評比資料（官方短名）→ 合約 → 關注清單的合約索引
function _esNameOf(code) {
  var c0 = _esBase && _esBase.c0[code];
  if (c0 && c0.n) return c0.n;
  if (typeof _contracts !== 'undefined' && _contracts[code] && _contracts[code].name) return _contracts[code].name;
  var f = (typeof _wtIdx !== 'undefined' && _wtIdx || []).filter(function (x) { return x.c === code; })[0];
  return f ? f.n : '';
}
function esMountDetail(slot, keep) {
  if (!slot) return;
  var code = slot.getAttribute('data-code');
  if (keep && keep.getAttribute('data-code') === code) { slot.appendChild(keep); _esFitDetail(slot, keep); return; }
  slot.innerHTML = '<div class="es-detail" data-code="' + code + '">' +
    '<div class="es-dhead"><span class="es-dcode">' + code + '</span><span class="es-dname">' + _esNameOf(code) + '</span></div>' +
    '<div class="es-dl"><div class="es-dtitle">配息走勢（近 2 年）</div><div class="divest-hist" data-code="' + code + '"><div class="modal-loading">讀取配息紀錄…</div></div></div>' +
    '<div class="es-dr"><div class="es-dtitle">配息紀錄（近 2 年，新→舊）</div><div class="es-evt"><div class="modal-loading">讀取配息紀錄…</div></div></div>' +
  '</div>';
  _esFitDetail(slot, slot.firstChild);
  _esLoadDetail(slot.firstChild, code);
}
async function _esLoadDetail(el, code) {
  try { if (typeof _divGetRecs === 'function') await _divGetRecs(code); } catch (e) {}
  try { await _esGetBase(false); } catch (e) {}
  if (!el.isConnected) return;
  var recs = ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || []).filter(function (r) { return r.exDate; })
    .slice().sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });

  // 左：配息走勢圖（折線要 2 年收盤，抓完再重畫一次）
  var he = el.querySelector('.divest-hist');
  if (typeof _divHistDraw === 'function') _divHistDraw(he, code);

  // 右：配息紀錄（先出表，填息狀態等日線抓到再補）
  var te = el.querySelector('.es-evt');
  var mkt = (_esBase && _esBase.c0[code] && _esBase.c0[code].mkt) ||
    ((typeof _contracts !== 'undefined' && _contracts[code] && _contracts[code].exchange === 'OTC') ? 'OTC' : 'TSE');
  var base = {};
  ((_esBase && _esBase.divs[code]) || []).forEach(function (e) { base[e.ex] = e; });
  te.innerHTML = _esRecTable(code, recs, base, null);
  var bars = await _esBarsOf(code, mkt);
  if (el.isConnected && bars.length) te.innerHTML = _esRecTable(code, recs, base, bars);

  for (var i = 0; i < 40 && el.isConnected; i++) {
    if (typeof _divPx !== 'undefined' && _divPx[code]) { if (typeof _divHistDraw === 'function') _divHistDraw(he, code); break; }
    await new Promise(function (r) { setTimeout(r, 1000); });
  }
}
// 單次除息的填息結果（除息後首次收盤 ≥ 除息前收盤）
function _esFillOf(bars, ex, basePx) {
  if (!bars || !bars.length || !(basePx > 0)) return null;
  var i0 = -1;
  for (var k = 0; k < bars.length; k++) if (bars[k][0] >= ex) { i0 = k; break; }
  if (i0 < 0) return bars[bars.length - 1][0] < ex ? { wait: true } : null;
  if (bars[0][0] > ex) return null;                                  // 除息早於日線範圍（一年前）
  for (var q = i0; q < bars.length; q++) if (bars[q][1] >= basePx - 1e-9) return { date: bars[q][0], days: q - i0 + 1 };
  return { pending: true, days: bars.length - i0, gap: (basePx - bars[bars.length - 1][1]) / basePx * 100 };
}
function _esRecTable(code, recs, base, bars) {
  var today = _divTwDate().iso;
  var d24 = _esIso(Date.parse(today) - 730 * 86400000);
  var list = recs.filter(function (r) { return r.exDate >= d24; });
  if (!list.length) return '<div class="divest-hist-note">近 2 年無配息紀錄</div>';
  var step = null;
  try { step = _divInferStep(recs.map(function (r) { return Object.assign({ code: code }, r); })); } catch (e) {}
  var perYear = step ? 12 / step : null;
  var md = function (iso) { return iso ? iso.slice(2).replace(/-/g, '/') : '—'; };
  var dim = function (t) { return '<span class="dm-dim">' + t + '</span>'; };
  var h = '<table class="detail-table es-evt-t"><thead><tr><th>除息日</th><th>發放日</th><th class="num">每股配息</th>' +
    '<th class="num" title="當次殖利率：每股配息 ÷ 除息前收盤">當次配</th>' +
    '<th class="num" title="年化殖利率：每股配息 × 年配息次數 ÷ 除息前收盤">年化配</th><th>填息</th></tr></thead><tbody>';
  list.slice().reverse().forEach(function (r) {
    var b = base[r.exDate], bp = b && b.base;
    var amt = r.amount;
    var y1 = (amt > 0 && bp > 0) ? amt / bp * 100 : null;
    var yA = (y1 != null && perYear) ? y1 * perYear : null;
    var fut = r.exDate > today;
    var f = fut ? null : _esFillOf(bars, r.exDate, bp);
    var st = fut ? dim('未除息')
      : (!bars ? (bp ? '<span class="const-spin"></span>' : dim('—'))
      : (!f ? dim('—')
      : (f.wait ? dim('待收盤資料')
      : (f.pending ? '<span class="up">貼息中 ' + f.days + ' 天　距 ' + f.gap.toFixed(2) + '%</span>'
      : '<span class="down">已填息（' + f.days + ' 天）</span>'))));
    h += '<tr' + (fut ? ' class="es-fut"' : '') + '><td>' + md(r.exDate) + '</td><td>' + (r.payDate ? md(r.payDate) : dim('—')) + '</td>' +
      '<td class="num">' + (amt != null ? amt.toFixed(3) : dim('待公告')) + '</td>' +
      '<td class="num">' + (y1 != null ? y1.toFixed(2) + '%' : dim('—')) + '</td>' +
      '<td class="num">' + (yA != null ? yA.toFixed(2) + '%' : dim('—')) + '</td><td>' + st + '</td></tr>';
  });
  return h + '</tbody></table>' +
    '<div class="divest-hist-note">年配息 ' + (perYear ? perYear + ' 次' : '—') + '；殖利率以除息前收盤計（官方除權息結果表，近 12 個月內才有）；填息以一年日線判定。</div>';
}
