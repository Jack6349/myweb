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
  try { var v = localStorage.getItem(ES_SORT_LS); if (/^(score|code|name|px|y1|yEst|y12|fill|fillDays|g6|g12|tr6|tr12|size|fee|prem)(Asc|Desc)$/.test(v || '')) return v; } catch (e) {}
  return 'scoreDesc';
})();

function _esVia(u, ms) {
  return _divFetchT(NEWS_GAS_URL + '?url=' + encodeURIComponent(u), ms || 40000).then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.error) throw new Error(j.error); return j; });
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
  for (var a = 0; a < 3 && !mis; a++) {
    try { mis = await _esVia('https://mis.twse.com.tw/stock/data/all_etf.txt'); }
    catch (e) { misErr = e; await new Promise(function (r) { setTimeout(r, 2000); }); }
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
  if (dv.ok && now.otcOk && m6.otcOk && m12.otcOk) { try { localStorage.setItem(ES_LS, JSON.stringify({ day: today, base: base })); } catch (e) {} }
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
      code: code, name: name, grp: g.key, cat: g.cat, mkt: (c0 && c0.mkt) || ((c12 && c12.mkt) || 'TSE'), px: px,
      size: (L.units && L.nav) ? L.units * L.nav / 1e8 : null, prem: L.prem,
      y1: last ? last.amt / px * 100 : null,
      yEst: (last && step) ? last.amt * (12 / step) / px * 100 : null,
      y12: d12s.length ? sum(d12s) / px * 100 : 0,
      g6: c6 ? (px / c6.c - 1) * 100 : null,
      g12: c12 ? (px / c12.c - 1) * 100 : null,
      tr6: c6 ? ((px + sum(d6s)) / c6.c - 1) * 100 : null,
      tr12: c12 ? ((px + sum(d12s)) / c12.c - 1) * 100 : null,
      young: !c12, events: d12s
    };
    rows.push(r);
  });
  return rows;
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
async function _esFillOne(r) {
  var syms = r.mkt === 'OTC' ? [r.code + '.TWO', r.code + '.TW'] : [r.code + '.TW', r.code + '.TWO'];
  var bars = [];
  for (var i = 0; i < syms.length && !bars.length; i++) {
    try {
      var j = await _esVia('https://query1.finance.yahoo.com/v8/finance/chart/' + syms[i] + '?interval=1d&range=1y', 30000);
      var res = j.chart && j.chart.result && j.chart.result[0];
      var ts = (res && res.timestamp) || [], cl = (res && res.indicators.quote[0].close) || [];
      for (var k = 0; k < ts.length; k++) if (cl[k] != null) bars.push([new Date(ts[k] * 1000 + 8 * 3600000).toISOString().slice(0, 10), cl[k]]);
    } catch (e) {}
  }
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
  return { top: short.slice(0, ES_TOP), short: short, total: all.length, young: all.length - rank.length };
}

var _esBasePromise = null;
function _esGetBase(force) {
  if (!force && _esBase && _esBase.day === _divTwDate().iso) return Promise.resolve(_esBase);
  if (_esBasePromise) return _esBasePromise;
  _esBasePromise = _esLoadBase(force).then(function (b) { _esBase = b; return b; })
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
    await _esLoadExtra();
  } catch (e) {
    _esMsg = '讀取失敗：' + e.message + '（GAS 忙碌時請稍後按「重新整理」）';
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

var ES_COLS = [
  // key, 標題, 格式, 說明
  ['rank', '#', 'int', '綜合排名'],
  ['code', '代號', 'code', ''],
  ['name', '名稱', 'txt', ''],
  ['score', '綜合', 'f1', '各指標同類百分位加權：一年含息 25、近12月殖利率 25、填息率 20、一年價格 15、規模 10、內扣費用 5'],
  ['px', '現價', 'f2', ''],
  ['y1', '單次殖利率', 'pct', '最近一次配息 ÷ 現價'],
  ['yEst', '預估年殖利率', 'pct', '最近一次配息 × 年配息次數 ÷ 現價'],
  ['y12', '近12月殖利率', 'pct', '近 12 個月實際配息合計 ÷ 現價'],
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
    '<span class="es-info">' + (_esMsg || (_esBase ? '資料日 ' + (_esBase.d0 || '—') + '（半年前 ' + (_esBase.d6 || '—') + '、一年前 ' + (_esBase.d12 || '—') + '）' : '')) + '</span></div>';
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
      case 'code': return '<span class="code-link" title="看線圖" onclick="openChartPop(\'' + v + '\')">' + v + '</span>' +
        (held[v] > 0 ? '<span class="es-tag es-held" title="目前持有">持</span>' : '') + (watched[v] ? '<span class="es-tag es-watch" title="已在關注清單">關</span>' : '');
      case 'txt': return v || '';
      case 'f1': return v == null ? dim('—') : '<b>' + v.toFixed(1) + '</b>';
      case 'f2': return v == null ? dim('—') : v.toFixed(2);
      case 'pct': return v == null ? dim('—') : v.toFixed(2) + '%';
      case 'fill': return v == null ? (_esFillBusy[r.code] || (_esMsg && /填息/.test(_esMsg)) ? '<span class="const-spin"></span>' : dim('—')) : v.toFixed(0) + '%' + dim('（' + r.fillN + '）');
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
    h += '<tr>' + ES_COLS.map(function (c) {
      return '<td class="' + (c[0] === 'code' ? 'inv-code' : (c[0] === 'name' ? 'inv-name' : (c[0] === 'watch' ? 'es-wcell' : 'num'))) + '">' + fmt(r, c) + '</td>';
    }).join('') + '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="divest-note">本類共 ' + rk.total + ' 檔（上市未滿一年 ' + rk.young + ' 檔不列入排名），依綜合分數取前 ' + ES_TOP + ' 名；已排除槓桿／反向與期貨商品型。' +
    '綜合＝各指標在同類中的百分位加權（一年含息 25、近12月殖利率 25、填息率 20、一年價格 15、規模 10、內扣費用 5），填息率與費用只對前 ' + ES_TOP1 + ' 名計算。' +
    '含息報酬未計再投入；價格成長為負代表淨值被配息侵蝕。資料來源：TWSE／TPEx 官方行情與除權息結果表、Yahoo 日線（填息）。<b>歷史統計，非投資建議。</b></div>';
  wrap.innerHTML = h;
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
    fill: r.fill == null ? (_esFillBusy[r.code] ? '<span class="const-spin"></span>' : dim('—')) : r.fill.toFixed(0) + '%' + dim('（' + r.fillN + '）'),
    fillDays: r.fillDays == null ? dim('—') : r.fillDays.toFixed(1) + ' 天',
    g6: sg(r.g6), g12: sg(r.g12), tr6: sg(r.tr6), tr12: sg(r.tr12),
    size: r.size == null ? dim('—') : Math.round(r.size).toLocaleString('zh-TW'),
    fee: r.fee == null ? dim('—') : r.fee.toFixed(2) + '%',
    prem: sg(r.prem)
  };
  return ES_WCOLS.map(function (k) { return '<td class="num es-wm">' + cell[k] + '</td>'; }).join('');
}
