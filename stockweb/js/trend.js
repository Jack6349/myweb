// 股利總管 Web — 趨勢評估（自 Yahoo 日 K 計算趨勢強弱/股價高低/報酬，相對 0050 強弱，ETF 成分股隨選展開）
// 註：券商 App 的「診斷分數」為其加值產品、不在 Shioaji API；此處指標為自算技術面，非券商診斷。

var TREND_GAS = NEWS_GAS_URL;   // 沿用同一 GAS 代理（?url= Yahoo）
var TREND_BENCH = '0050';       // 相對強弱基準
var _trendRows = [];            // [{code,name,trend,isEtf}]
var _trendBench = null;         // 基準 trend

function yahooSym(code) {
  code = String(code).trim();
  return /^\d/.test(code) ? code + '.TW' : code;
}

async function fetchDailyCloses(sym) {
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1y';
    var r = await fetch(TREND_GAS + '?url=' + encodeURIComponent(url));
    var j = await r.json();
    var res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    var closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [])
      .filter(function (x) { return x != null; });
    return closes.length >= 20 ? closes : null;
  } catch (e) { return null; }
}

// 台股先試 .TW 再試 .TWO；外資成分股帶國別碼
async function trendForHolding(code) {
  var closes = await fetchDailyCloses(yahooSym(code));
  if (!closes && /^\d/.test(String(code))) closes = await fetchDailyCloses(String(code) + '.TWO');
  return closes ? computeTrend(closes) : null;
}

function computeTrend(c) {
  var n = c.length, last = c[n - 1];
  function ma(k) { if (n < k) return null; var s = 0; for (var i = n - k; i < n; i++) s += c[i]; return s / k; }
  var ma5 = ma(5), ma20 = ma(20), ma60 = ma(60);
  var hi = Math.max.apply(null, c), lo = Math.min.apply(null, c);
  var posPct = hi > lo ? (last - lo) / (hi - lo) * 100 : null; // 52週區間位置
  var fromHi = hi ? (last - hi) / hi * 100 : null;             // 距高（負值）
  function ret(k) { if (n <= k) return null; var p = c[n - 1 - k]; return p ? (last - p) / p * 100 : null; }
  var r1 = ret(20), r3 = ret(60), r6 = ret(120), r12 = c[0] ? (last - c[0]) / c[0] * 100 : null;
  var arr = '盤整';
  if (ma5 && ma20 && ma60) {
    if (last > ma5 && ma5 > ma20 && ma20 > ma60) arr = '多頭排列';
    else if (last < ma5 && ma5 < ma20 && ma20 < ma60) arr = '空頭排列';
  }
  // 連續強弱分數 0~10（1 位小數）：基準 5，綜合均線乖離、52週位置、期間動能，各分量夾限後加權
  function clamp1(v) { return Math.max(-1, Math.min(1, v)); }
  var maComp = 0; // 均線乖離 ±2
  if (ma20) maComp += clamp1(((last / ma20) - 1) * 100 / 5);
  if (ma20 && ma60) maComp += clamp1(((ma20 / ma60) - 1) * 100 / 5);
  var posComp = posPct != null ? clamp1((posPct - 50) / 50) * 2 : 0; // 位置 ±2
  var momComp = 0; // 動能 ±3
  if (r3 != null) momComp += clamp1(r3 / 15) * 1.5;
  if (r1 != null) momComp += clamp1(r1 / 8) * 1.0;
  if (r6 != null) momComp += clamp1(r6 / 30) * 0.5;
  var raw = 5 + maComp * 1.25 + posComp + momComp; // 5 ±7.5
  var score10 = Math.round(Math.max(0, Math.min(10, raw)) * 10) / 10;
  var label = score10 >= 7.5 ? '強' : (score10 >= 6 ? '偏強' : (score10 >= 4 ? '中性' : (score10 >= 2.5 ? '偏弱' : '弱')));
  return { last: last, arr: arr, posPct: posPct, fromHi: fromHi, r1: r1, r3: r3, r6: r6, r12: r12, score10: score10, label: label };
}

function _pct(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function _pctCls(v) { return v == null ? 'flat' : (v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')); }
function _labelCls(s10) { return s10 == null ? 'flat' : (s10 >= 6 ? 'up' : (s10 <= 4 ? 'down' : 'flat')); }

function isEtfCode(code) { return /^00/.test(String(code)); }

async function startTrend() {
  var errEl = document.getElementById('trend-error');
  var wrap = document.getElementById('trend-wrap');
  var info = document.getElementById('trend-info');
  errEl.style.display = 'none';
  wrap.innerHTML = '<div class="modal-loading">計算趨勢中…（抓取日 K）</div>';

  // 取持股（券商優先）
  var holdings = [];
  try {
    var positions = (_positions && _positions.length) ? _positions : await fetchBrokerPositions();
    var names = {};
    try { (await loadPortfolioFallback()).forEach(function (s) { if (s.name) names[String(s.code)] = s.name; }); } catch (e) {}
    holdings = (positions || []).map(function (p) {
      var code = String(p.code);
      return { code: code, name: (_contracts[code] && _contracts[code].name) || names[code] || '' };
    });
  } catch (e) { errEl.style.display = 'block'; errEl.textContent = '讀不到持股：' + e.message; wrap.innerHTML = ''; return; }
  if (!holdings.length) { wrap.innerHTML = '<div class="modal-loading">無持股資料</div>'; return; }

  // 基準 + 各持股平行計算
  var benchP = trendForHolding(TREND_BENCH);
  var rows = await Promise.all(holdings.map(async function (h) {
    return { code: h.code, name: h.name, isEtf: isEtfCode(h.code), trend: await trendForHolding(h.code) };
  }));
  _trendBench = await benchP;
  _trendRows = rows;

  var okCount = rows.filter(function (r) { return r.trend; }).length;
  info.textContent = '共 ' + rows.length + ' 檔（' + okCount + ' 檔取得日 K）｜相對強弱基準：0050' +
    (_trendBench ? '（近3月 ' + _pct(_trendBench.r3) + '）' : '');
  renderTrendTable();
}

function renderTrendTable() {
  var wrap = document.getElementById('trend-wrap');
  if (!wrap) return;
  var rows = _trendRows.slice().sort(function (a, b) {
    var sa = a.trend ? a.trend.score10 : -99, sb = b.trend ? b.trend.score10 : -99;
    if (sb !== sa) return sb - sa;
    var ra = a.trend && a.trend.r3 != null ? a.trend.r3 : -999, rb = b.trend && b.trend.r3 != null ? b.trend.r3 : -999;
    return rb - ra;
  });
  var benchR3 = _trendBench ? _trendBench.r3 : null;
  var html = '<div class="inv-table-wrap"><table class="inv-table trend-table"><thead><tr>' +
    '<th>代號</th><th>名稱</th><th class="num">強弱</th><th>排列</th><th class="num">52週位置</th>' +
    '<th class="num">近1月</th><th class="num">近3月</th><th class="num">近6月</th><th class="num">近1年</th>' +
    '<th class="num">vs0050(3月)</th><th></th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var t = r.trend;
    if (!t) {
      html += '<tr><td class="inv-code">' + r.code + '</td><td class="inv-name">' + (r.name || '') + '</td>' +
        '<td class="num flat" colspan="9">查無日K</td></tr>';
      return;
    }
    var rs = (benchR3 != null && t.r3 != null) ? t.r3 - benchR3 : null;
    var arrCls = t.arr === '多頭排列' ? 'up' : (t.arr === '空頭排列' ? 'down' : 'flat');
    html += '<tr>' +
      '<td class="inv-code">' + r.code + '</td>' +
      '<td class="inv-name">' + (r.name || '') + '</td>' +
      '<td class="num ' + _labelCls(t.score10) + '">' + t.score10.toFixed(1) + ' ' + t.label + '</td>' +
      '<td class="' + arrCls + '">' + t.arr + '</td>' +
      '<td class="num">' + (t.posPct == null ? '—' : Math.round(t.posPct) + '%') + '</td>' +
      '<td class="num ' + _pctCls(t.r1) + '">' + _pct(t.r1) + '</td>' +
      '<td class="num ' + _pctCls(t.r3) + '">' + _pct(t.r3) + '</td>' +
      '<td class="num ' + _pctCls(t.r6) + '">' + _pct(t.r6) + '</td>' +
      '<td class="num ' + _pctCls(t.r12) + '">' + _pct(t.r12) + '</td>' +
      '<td class="num ' + _pctCls(rs) + '">' + (rs == null ? '—' : (rs >= 0 ? '+' : '') + rs.toFixed(1) + '%') + '</td>' +
      '<td>' + (r.isEtf ? '<button class="btn-detail" onclick="showConstituentTrend(\'' + r.code + '\',\'' + (r.name || '') + '\')">成分股</button>' : '') + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

// ── ETF 成分股趨勢（隨選展開）──
function constituentSymbol(code) {
  code = String(code).trim();
  var m = code.match(/^(\S+)\s+([A-Za-z]{1,2})$/); // 外資碼 "000660 KS"
  if (m) {
    var map = { KS: '.KS', TT: '.TW', TW: '.TW', HK: '.HK', JP: '.T', JT: '.T', US: '', CH: '.SS', C1: '.SS', C2: '.SZ' };
    var suf = map[m[2].toUpperCase()];
    return m[1] + (suf !== undefined ? suf : '');
  }
  if (/^\d+$/.test(code)) return code + '.TW';
  return code;
}

async function fetchEtfConstituents(code) {
  // MoneyDJ 優先（台股），空則 CMoney（外資）
  try {
    var r1 = await fetch(TREND_GAS + '?holdings=' + encodeURIComponent(code));
    var j1 = await r1.json();
    if (j1.stat === 'OK' && j1.holdings && j1.holdings.length) return { source: 'MoneyDJ', holdings: j1.holdings };
  } catch (e) {}
  try {
    var r2 = await fetch(TREND_GAS + '?cmconstituent=' + encodeURIComponent(code));
    var j2 = await r2.json();
    var h = j2.holdings || j2.constituents || [];
    if (h.length) return { source: 'CMoney', holdings: h };
  } catch (e) {}
  return { source: null, holdings: [] };
}

async function showConstituentTrend(code, name) {
  var modal = document.getElementById('detail-modal');
  var body = document.getElementById('detail-body');
  var title = document.getElementById('detail-title');
  title.textContent = code + ' ' + name + ' — 成分股趨勢（前 15 大權重）';
  body.innerHTML = '<div class="modal-loading">抓取成分股清單…</div>';
  modal.style.display = 'flex';

  var data = await fetchEtfConstituents(code);
  if (!data.holdings.length) { body.innerHTML = '<div class="modal-loading">查無成分股清單</div>'; return; }
  var top = data.holdings.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); }).slice(0, 15);

  body.innerHTML = '<div class="modal-loading">計算 ' + top.length + ' 檔成分股趨勢…</div>';
  var rows = await Promise.all(top.map(async function (h) {
    var closes = await fetchDailyCloses(constituentSymbol(h.code));
    return { code: h.code, name: h.name || '', weight: h.weight, trend: closes ? computeTrend(closes) : null };
  }));

  rows.sort(function (a, b) { var sa = a.trend ? a.trend.score10 : -1, sb = b.trend ? b.trend.score10 : -1; return sb - sa; });
  var html = '<div class="detail-note" style="margin:0 0 8px">來源：' + data.source + '（共 ' + data.holdings.length + ' 檔，顯示前 15 大權重，依強弱排序）</div>' +
    '<div class="detail-scroll"><table class="detail-table"><thead><tr><th>成分股</th><th class="num">權重</th><th class="num">強弱</th>' +
    '<th>排列</th><th class="num">近1月</th><th class="num">近3月</th><th class="num">52週位置</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var t = r.trend;
    html += '<tr><td>' + r.code + ' ' + (r.name || '') + '</td>' +
      '<td class="num">' + (r.weight != null ? r.weight.toFixed(2) + '%' : '—') + '</td>' +
      (t ? (
        '<td class="num ' + _labelCls(t.score10) + '">' + t.score10.toFixed(1) + ' ' + t.label + '</td>' +
        '<td class="' + (t.arr === '多頭排列' ? 'up' : t.arr === '空頭排列' ? 'down' : 'flat') + '">' + t.arr + '</td>' +
        '<td class="num ' + _pctCls(t.r1) + '">' + _pct(t.r1) + '</td>' +
        '<td class="num ' + _pctCls(t.r3) + '">' + _pct(t.r3) + '</td>' +
        '<td class="num">' + (t.posPct == null ? '—' : Math.round(t.posPct) + '%') + '</td>'
      ) : '<td class="num flat" colspan="5">查無日K</td>') +
    '</tr>';
  });
  html += '</tbody></table></div>';
  body.innerHTML = html;
}

// ── 供 AI Prompt 併入（壓縮成精簡文字）──
async function ensureTrend() {
  if (_trendRows.length) return;
  // 靜默計算（不動畫面），供 Prompt 使用
  try {
    var positions = (_positions && _positions.length) ? _positions : await fetchBrokerPositions();
    _trendBench = await trendForHolding(TREND_BENCH);
    _trendRows = await Promise.all((positions || []).map(async function (p) {
      var code = String(p.code);
      return { code: code, name: (_contracts[code] && _contracts[code].name) || '', isEtf: isEtfCode(code), trend: await trendForHolding(code) };
    }));
  } catch (e) {}
}

function trendSummaryForPrompt() {
  if (!_trendRows.length) return '';
  var benchR3 = _trendBench ? _trendBench.r3 : null;
  return _trendRows.map(function (r) {
    var t = r.trend;
    if (!t) return '- ' + r.code + ' ' + (r.name || '') + '：查無日K';
    var rs = (benchR3 != null && t.r3 != null) ? '，相對0050(3月) ' + (t.r3 - benchR3 >= 0 ? '+' : '') + (t.r3 - benchR3).toFixed(1) + '%' : '';
    return '- ' + r.code + ' ' + (r.name || '') + '：強弱 ' + t.score10.toFixed(1) + '/10(' + t.label + ')（' + t.arr +
      '，52週位置' + (t.posPct == null ? 'N/A' : Math.round(t.posPct) + '%') +
      '，近1月' + _pct(t.r1) + ' 近3月' + _pct(t.r3) + ' 近1年' + _pct(t.r12) + rs + '）';
  }).join('\n');
}
