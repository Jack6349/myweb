// 股利總管 Web — 加減碼報告：系統性風險評分（量化取代質化 veto）
// ※ 依使用者自訂規則自動算分的參考工具，非投資建議。門檻為初始值，待 6 個月歷史回測校準。
// 六項各 0/1/2 分（總 0–12）＋「股債同向重挫」旗標（觸發直接 veto，不論總分）。
// 資料源：Yahoo（^VIX/^TNX/DX-Y.NYB/^SOX/^IXIC，經 GAS 代理）＋ Shioaji 台指期夜盤 TXFR1。

// ── 門檻常數（回測校準後改這裡即可） ──
var RS_TH = {
  vix:    [20, 25],     // VIX 水準（絕對值）
  vix5:   [20, 50],     // VIX 近 5 日累計漲幅%（只計上升）
  oas:    [3.5, 5.0],   // 非投等債信用利差 OAS 水準%
  oas20:  [0.3, 0.8],   // OAS 近 20 日變化（百分點，只計走闊）
  dd:     [8, 15],      // 台股距近一年高點回檔%
  night:  [1, 3]        // 台指期夜盤跌幅%
};
// 股債同向重挫旗標：股市跌幅≥且美10年債殖利率同步漲幅≥（兩者皆達極端 → 傳統對沖失效）
var RS_FLAG = { equityDrop: 4, yieldUp: 2 };
// 債券型（非投等債，標的自持股偵測）信用風險兩層門檻（待 6 個月回測校準）
// drop：HYG/JNK 單日跌幅%（近一年 p10≈0.31–0.34%，取 0.35 為初始值）
// discount：折價達 pp（債券 ETF 折溢價常態 <0.2%）；volShrink：當日量 < 近90日中位數 %
var RS_BOND_TH = { drop: 0.35, discount: 0.5, volShrink: 50 };
// 非投等債 ETF 以「持股中自動偵測」為準，不寫死清單（加減碼要看的是手上實際部位）。
// 用名稱而非代號末碼判斷：末碼 B 是債券 ETF，但主動式非投等債 ETF 末碼是 D（例 00984D），
// 且 Shioaji 合約名稱截斷至 8 字（「主動聯博全球非投等債」→「主動聯博全球非投」），故關鍵字取「非投」。
// 判定改呼叫 category.js 的 catOf()（同一套規則，不再兩處各判一次）；
// 非投等債的分類名為「非投債」（被動）與「主動非投債」，兩者都要納入。
function _rsBondHoldings() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return Object.keys(m).filter(function (c) {
    if (!(m[c] > 0)) return false;
    return typeof catOf === 'function' && /非投債$/.test(catOf(c));
  }).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
}

function _rsScore(v, th) { return v == null ? null : (v < th[0] ? 0 : (v <= th[1] ? 1 : 2)); }
// 指標說明：直接陳述量的是什麼＋各分數的數字區間（門檻取自 RS_TH，改門檻說明同步）
function _rsDesc(what, th, unit, words) {
  return what + '　< ' + th[0] + unit + ' ' + words[0] +
    '｜' + th[0] + '–' + th[1] + unit + ' ' + words[1] +
    '｜> ' + th[1] + unit + ' ' + words[2];
}
function _rsColor(s) { return s == null ? 'var(--text3)' : (s === 0 ? 'var(--down)' : (s === 1 ? 'var(--accent2)' : 'var(--up)')); }

var _rsCache = {}; // sym → {ts,data}；成功結果快取 3 分鐘，減少 GAS urlfetch 消耗
async function _rsYahoo(sym) {
  var c = _rsCache[sym];
  if (c && Date.now() - c.ts < 180000) return c.data;
  try {
    // range 取 3mo（原為 5d）以便同時算近 5 日／20 日趨勢；chg 定義不變（仍為最後兩個交易日的%變化），
    // 六項評分沿用 chg，不受影響。
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=3mo';
    var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
    var j = await r.json();
    var res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    var closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [])
      .filter(function (x) { return x != null; });
    if (closes.length < 2) return null;
    var n = closes.length;
    var last = closes[n - 1], prev = closes[n - 2];
    // 兩種變化並存：abs＝絕對差（殖利率用，單位為百分點）、pct＝%變化（價格型用）
    var back = function (k) { return n > k ? closes[n - 1 - k] : null; };
    var absD = function (k) { var b = back(k); return b == null ? null : last - b; };
    var pctD = function (k) { var b = back(k); return (b == null || !b) ? null : (last - b) / b * 100; };
    var data = {
      value: last, chg: prev ? (last - prev) / prev * 100 : null,
      abs1: absD(1), abs5: absD(5), abs20: absD(20),
      pct5: pctD(5), pct20: pctD(20), bars: n
    };
    _rsCache[sym] = { ts: Date.now(), data: data };
    return data;
  } catch (e) { return null; }
}
async function _rsNight() {
  try {
    var r = await fetch('/api/v1/data/snapshots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contracts: [{ security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }] })
    });
    var a = await r.json();
    if (a && a[0] && a[0].close != null) return { value: a[0].close, chg: a[0].change_rate };
  } catch (e) {}
  return null;
}

// ── 債券型（非投等債）信用風險子模組資料源 ──
// OAS：FRED ICE BofA US High Yield OAS（BAMLH0A0HYM2），fredgraph.csv 走 GAS ?urltext=；約 1 交易日延遲
async function _rsOAS() {
  var c = _rsCache['__oas']; if (c && Date.now() - c.ts < 180000) return c.data;
  try {
    var url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2';
    var r = await fetch(NEWS_GAS_URL + '?urltext=' + encodeURIComponent(url));
    var text = await r.text();
    if (text.charAt(0) === '{') { var je = null; try { je = JSON.parse(text); } catch (e) {} if (je && je.error) return null; }
    var lines = text.trim().split(/\r?\n/), pts = [];
    for (var i = 1; i < lines.length; i++) {
      var p = lines[i].split(','); var v = parseFloat(p[1]);
      if (!isNaN(v)) pts.push({ date: (p[0] || '').trim(), val: v });
    }
    if (pts.length < 2) return null;
    var n = pts.length, last = pts[n - 1], prev = pts[n - 2];
    // 多日變化（百分點）：供一致性檢查與信用債價格的近 20 日走勢對等比較
    var back = function (k) { return n > k ? pts[n - 1 - k].val : null; };
    var d = function (k) { var b = back(k); return b == null ? null : last.val - b; };
    var data = { value: last.val, chg: last.val - prev.val, date: last.date, d5: d(5), d20: d(20) };
    _rsCache['__oas'] = { ts: Date.now(), data: data };
    return data;
  } catch (e) { return null; }
}
// 折溢價：沿用 signals.js 的 TWSE 官方淨值（盤後才準）
async function _rsBondNav(code) {
  try {
    if (typeof sigEnsureNavMap === 'function') await sigEnsureNavMap();
    if (typeof sigGetNav === 'function') return sigGetNav(code); // {nav, premium(%), price, date}
  } catch (e) {}
  return null;
}
// 成交量比：當日量 vs 近 90 日中位數（换股試算的「換手品質」仍在用，見 swap.js _swapQualEnsure）
async function _rsBondVol(code) {
  try {
    if (typeof _chartFetchDay !== 'function') return null;
    var bars = await _chartFetchDay(code);
    if (!bars || bars.length < 10) return null;
    var today = bars[bars.length - 1];
    var hist = bars.slice(0, -1).slice(-90).map(function (b) { return b.v; }).filter(function (v) { return v > 0; });
    if (!hist.length) return null;
    hist.sort(function (a, b) { return a - b; });
    var n = hist.length, med = n % 2 ? hist[(n - 1) / 2] : (hist[n / 2 - 1] + hist[n / 2]) / 2;
    return { today: today.v, median: med, ratio: med ? today.v / med * 100 : null };
  } catch (e) { return null; }
}

// 近 20 個交易日的日均成交金額（中位數，元）：流動性用金額而非張數，不同價位的 ETF 才能相比。
// 不含當日：盤中查看時當日量是累計中，會嚴重低估。需要 broker session（Shioaji 日 kbars）。
async function _rsBondLiq(code) {
  try {
    if (typeof _chartFetchDay !== 'function') return null;
    var bars = await _chartFetchDay(code);
    if (!bars || bars.length < 5) return null;
    var recent = bars.slice(-21, -1);
    if (!recent.length) recent = bars.slice(-20);
    var a = recent.map(function (b) { return b.v * b.c * 1000; }).filter(function (v) { return v > 0; });
    if (!a.length) return null;
    a.sort(function (x, y) { return x - y; });
    var n = a.length;
    return { med: n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2, days: n };
  } catch (e) { return null; }
}

async function startRiskReport(force) {
  var wrap = document.getElementById('risk-wrap');
  var info = document.getElementById('risk-info');
  wrap.innerHTML = '<div class="modal-loading">抓取總經與台指夜盤資料…</div>';

  // 債券區塊要依「實際持有的非投等債 ETF」列出 → 本頁需先有持股資料（本頁原本不載入持股）
  if (typeof ensureFeed === 'function' && !Object.keys((typeof _sharesMap !== 'undefined' && _sharesMap) || {}).length) {
    try { await ensureFeed(function (m) { info.textContent = m; }); } catch (e) {}
  }

  var res = await Promise.all([
    _rsYahoo('^VIX'), _rsYahoo('^TNX'), _rsYahoo('^SOX'), _rsYahoo('^IXIC'),
    _rsNight(), _rsOAS(), _rsBars1y('^TWII')
  ]);
  var vix = res[0], tnx = res[1], sox = res[2], ndx = res[3], night = res[4], oas = res[5];
  var twRange = _rsRange(res[6]);

  // 帶正負號顯示（漲跌都可能，非只跌）
  var sp = function (v, d) { return v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + '%'; };
  // 費半/Nasdaq 取「較弱者」（最負）當代表值；僅供股債同向重挫旗標判定
  var soxC = sox ? sox.chg : null, ndxC = ndx ? ndx.chg : null;
  var equityWorst = (soxC != null && ndxC != null) ? Math.min(soxC, ndxC) : (soxC != null ? soxC : ndxC);
  var equityDrop = equityWorst != null ? Math.max(0, -equityWorst) : null;
  var nightChg = night && night.chg != null ? night.chg : null;
  var nightDrop = nightChg != null ? Math.max(0, -nightChg) : null;
  var vix5 = vix && vix.pct5 != null ? Math.max(0, vix.pct5) : null;
  var twDrop = twRange && twRange.dd != null ? Math.max(0, -twRange.dd) : null;

  // 六項「狀態型」指標。舊版六項全是單日變化，抓到的是雜訊級事件；
  // 系統性風險是持續數日到數週的狀態，用單日變化當觸發會讓核心部位被雜訊反覆打斷。
  var rows = [
    { k: 'VIX 水準', desc: _rsDesc('市場避險情緒', RS_TH.vix, '', ['平穩', '升溫', '濃厚']),
      val: vix ? vix.value.toFixed(2) : '—', score: vix ? _rsScore(vix.value, RS_TH.vix) : null },
    { k: 'VIX 近 5 日變化', desc: _rsDesc('恐慌情緒五日累計升幅', RS_TH.vix5, '%', ['平穩', '升溫', '急升']),
      val: vix && vix.pct5 != null ? sp(vix.pct5, 1) : '—', score: _rsScore(vix5, RS_TH.vix5) },
    { k: '信用利差 OAS 水準', desc: _rsDesc('非投等債要求的風險補償', RS_TH.oas, '%', ['寬鬆', '轉緊', '緊縮']),
      val: oas ? oas.value.toFixed(2) + '%' : '—', score: oas ? _rsScore(oas.value, RS_TH.oas) : null },
    { k: 'OAS 近 20 日變化', desc: _rsDesc('信用環境近月走向', RS_TH.oas20, 'pp', ['持平', '走闊', '急擴']),
      val: oas && oas.d20 != null ? (oas.d20 > 0 ? '+' : '') + oas.d20.toFixed(2) + 'pp' : '—',
      score: oas && oas.d20 != null ? _rsScore(Math.max(0, oas.d20), RS_TH.oas20) : null },
    { k: '台股距一年高點', desc: _rsDesc('大盤回檔幅度', RS_TH.dd, '%', ['高檔', '回檔', '深跌']),
      val: twRange && twRange.dd != null ? sp(twRange.dd, 1) : '—', score: _rsScore(twDrop, RS_TH.dd) },
    { k: '台指期夜盤變化', desc: _rsDesc('台股隔夜跌幅', RS_TH.night, '%', ['平穩', '下挫', '重挫']),
      val: nightChg != null ? sp(nightChg, 2) : '—', score: _rsScore(nightDrop, RS_TH.night) }
  ];

  var total = 0, avail = 0;
  rows.forEach(function (r) { if (r.score != null) { total += r.score; avail++; } });

  // 股債同向重挫旗標：股跌且殖利率同步大漲＝傳統對沖失效，直接跳紅燈
  var flag = (equityDrop != null && tnx && tnx.chg != null && equityDrop >= RS_FLAG.equityDrop && tnx.chg >= RS_FLAG.yieldUp);

  // 三色燈。紅燈才進入「核心減倉評估」，符合核心只在系統性風險時減倉的原則。
  var light, verdict, vColor;
  if (flag || total >= 8) {
    light = 2; vColor = 'var(--up)';
    verdict = flag ? '🔴 股債同向重挫，系統性風險，啟動核心減倉評估' : '🔴 系統性風險，啟動核心減倉評估';
  } else if (total >= 4) {
    light = 1; vColor = 'var(--accent2)'; verdict = '🟡 暫停加碼，觀察是否止穩';
  } else {
    light = 0; vColor = 'var(--down)'; verdict = '🟢 正常，可執行加碼計畫';
  }

  var tw = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
  info.innerHTML = '更新：' + tw + '（台北）' + (typeof dmPill === 'function' ? ' ' + dmPill() : '');

  var html = '';
  // 判定卡
  html += '<div class="rs-verdict" style="border-color:' + vColor + '">' +
    '<div class="rs-score-big" style="color:' + vColor + '">' + total + '<span style="font-size:16px;color:var(--text3)"> / 12</span></div>' +
    '<div class="rs-verdict-txt"><div class="rs-vlabel">建議動作</div><div style="color:' + vColor + ';font-weight:700">' + verdict + '</div>' +
    '<div style="font-size:11px;color:var(--text3);margin-top:2px">六項狀態型指標各 0–2 分' +
    (avail < 6 ? '；' + avail + '/6 項有資料，' + (6 - avail) + ' 項暫缺' : '') + '</div>' +
    '</div></div>';
  // 旗標（正向表列：顯示實際值與門檻比較，不用「需…≥」的反向敘述）
  var eqTxt = equityWorst != null ? sp(equityWorst, 2) : '—';
  var tnxTxt = tnx && tnx.chg != null ? sp(tnx.chg, 2) : '—';
  html += '<div class="rs-flag ' + (flag ? 'on' : '') + '">' +
    (flag ? '🔴 股債同向重挫：費半/Nasdaq ' + eqTxt + ' ≥ 跌幅 ' + RS_FLAG.equityDrop + '%　且　美10年債殖利率 ' + tnxTxt +
        ' ≥ 漲幅 ' + RS_FLAG.yieldUp + '%　→　暫停加碼' :
      '🟢 股債同向重挫：費半/Nasdaq ' + eqTxt + ' < 跌幅 ' + RS_FLAG.equityDrop + '%　且　美10年債殖利率 ' + tnxTxt +
        ' < 漲幅 ' + RS_FLAG.yieldUp + '%') +
    '</div>';
  // 指標明細（股票型系統性風險；每列附說明小字）
  html += '<div class="rs-sec-title">股票型系統性風險 · 指標明細</div><table class="rs-table"><thead><tr><th>指標</th><th class="num">數值</th><th class="num">得分</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    html += '<tr><td>' + r.k + (r.desc ? '<div class="rs-idesc">' + r.desc + '</div>' : '') + '</td><td class="num">' + r.val + '</td>' +
      '<td class="num" style="color:' + _rsColor(r.score) + ';font-weight:700">' + (r.score == null ? '—' : r.score) + '</td></tr>';
  });
  html += '</tbody></table>';
  // 對照與免責（股票區塊）
  html += '<div class="rs-note">' +
    '<b>動作對照</b>：🟢 0–3 正常加碼｜🟡 4–7 暫停加碼、觀察｜🔴 8 分以上啟動核心減倉評估；股債同向重挫發生時直接跳紅燈。<br>' +
    '<b>為什麼看「狀態」不看「單日」</b>：系統性風險是持續數日到數週的狀態。舊版六項全是單日變化，' +
    '會讓核心部位被單日雜訊反覆打斷，與「核心只在系統性風險時減倉」的原則衝突。<br>' +
    '<b>得分色</b>：<span style="color:var(--down)">0 低</span>／<span style="color:var(--accent2)">1 中</span>／<span style="color:var(--up)">2 高</span>。<br>' +
    '資料源：Yahoo（VIX／美10年債／費半／Nasdaq／台股大盤）＋ FRED（信用利差 OAS, BAMLH0A0HYM2，延遲約 1 個交易日' +
    (oas && oas.date ? '，資料日 ' + oas.date : '') + '）＋ Shioaji 台指期夜盤(TXFR1)。' +
    '門檻為初始值、待 6 個月歷史回測校準。<b>本面板為依你設定規則自動算分的參考，非投資建議。</b>' +
    '</div>';

  // ── 表一：核心持股（只在系統性風險時減倉）──
  html += await _rsCoreTableHtml(light);

  // ── 區塊：持股配置結構（依分類）──
  html += _rsCatBlockHtml();

  // ── 表二：非投等債（每月基本收入）──
  html += await _rsBondTableHtml();

  // ── 表三：衛星配置（增加資產與月收入）──
  html += await _rsSatTableHtml();

  wrap.innerHTML = html;
}

// 持股配置結構：依分類加總成本/現值/損益，回答「現在偏向哪一類」。
// 加減碼前先看這張：分數說的是時機，這裡說的是部位，兩者分開看。
// 金額一律未扣稅費（與庫存表「付出成本」「現值」同基準），不隨含稅費切換變動。
function _rsCatBlockHtml() {
  if (typeof catAggregate !== 'function' || typeof _positions === 'undefined') return '';
  var groups = catAggregate(_positions);
  if (!groups.length) return '';
  var tc = 0, tv = 0;
  groups.forEach(function (g) { tc += g.cost; tv += g.val; });
  var money = function (v) { return Math.round(v).toLocaleString('zh-TW'); };
  var pct = function (v, t) { return t ? (v / t * 100).toFixed(1) + '%' : '\u2014'; };
  var pnlTd = function (v, base) {
    var cls = v == null ? 'flat' : (typeof colorClass === 'function' ? colorClass(v) : 'flat');
    var c = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--text3)' }[cls];
    return '<td class="num" style="color:' + c + '">' + (v >= 0 ? '+' : '') + money(v) + '</td>' +
      '<td class="num" style="color:' + c + '">' + (base ? (v / base * 100 >= 0 ? '+' : '') + (v / base * 100).toFixed(1) + '%' : '\u2014') + '</td>';
  };
  var h = '<div class="rs-sec-title">\u6301\u80a1\u914d\u7f6e\u7d50\u69cb\uff08\u4f9d\u5206\u985e\uff09</div>' +
    '<div class="rs-cat-wrap"><table class="rs-table rs-cat-table"><thead><tr><th>\u5206\u985e</th><th class="num">\u6a94\u6578</th>' +
    '<th class="num">\u4ed8\u51fa\u6210\u672c</th><th class="num">\u6210\u672c\u5360\u6bd4</th>' +
    '<th class="num">\u73fe\u503c</th><th class="num">\u73fe\u503c\u5360\u6bd4</th>' +
    '<th class="num">\u640d\u76ca</th><th class="num">\u640d\u76ca\u7387</th></tr></thead><tbody>';
  groups.forEach(function (g) {
    h += '<tr><td>' + g.cat + '</td><td class="num">' + g.n + '</td>' +
      '<td class="num">' + money(g.cost) + '</td><td class="num">' + pct(g.cost, tc) + '</td>' +
      '<td class="num">' + money(g.val) + '</td><td class="num">' + pct(g.val, tv) + '</td>' +
      pnlTd(g.val - g.cost, g.cost) + '</tr>';
  });
  h += '</tbody><tfoot><tr><td>\u5408\u8a08</td><td class="num">' +
    groups.reduce(function (a, g) { return a + g.n; }, 0) + '</td>' +
    '<td class="num">' + money(tc) + '</td><td class="num">100.0%</td>' +
    '<td class="num">' + money(tv) + '</td><td class="num">100.0%</td>' +
    pnlTd(tv - tc, tc) + '</tr></tfoot></table></div>';
  h += '<div class="rs-note">\u5206\u985e\u4f9d\u4ee3\u78bc\u5c3e\u78bc\uff08A\uff1d\u4e3b\u52d5\u80a1\u7968\u3001B\uff1d\u88ab\u52d5\u50b5\u5238\u3001D\uff1d\u4e3b\u52d5\u50b5\u5238\u3001L/R\uff1d\u69d3\u687f\u53cd\u5411\uff09' +
    '\u52a0\u4e0a\u5408\u7d04\u540d\u7a31\u95dc\u9375\u5b57\u5224\u5b9a\uff1b\u540d\u7a31\u6703\u88ab\u622a\u65b7\u81f3 8 \u5b57\uff0c\u65b0\u8cb7\u9032\u7684 ETF \u82e5\u6b78\u985e\u4e0d\u5c0d\u8acb\u544a\u8a34\u6211\u3002' +
    '\u91d1\u984d\u672a\u6263\u7a05\u8cbb\u3002</div>';
  return h;
}

// ══════════ 表一：核心持股（只在系統性風險時減倉）══════════
// 依使用者原則：00918／00922／00923 是核心，平常一律持有，只有系統性風險發生時才考慮
// 減倉停利、保留現金或轉往債券避險。所以這張表只回答兩件事：
//   1. 現在是不是系統性風險（上方的系統風險燈）
//   2. 真要減倉時，先減哪一檔（用單因子 beta 排序）
//
// beta 只對台股大盤（^TWII）跑單因子迴歸，不做多因子拆解。多因子（費半／金融／匯率／信用）
// 對「先減哪一檔」沒有額外幫助，而單因子可以直接翻成一句話：大盤跌 5% 時這檔預估跌多少。

// 1 年日線快取（記憶體，開頁一次）。指數（^TWII）不能走 _esBarsOf，它只會試 .TW／.TWO。
var _rsBars = {};
async function _rsBars1y(sym) {
  if (_rsBars[sym]) return _rsBars[sym];
  var bars = [];
  try {
    var j = await _esVia('https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(sym) + '?interval=1d&range=1y', 30000);
    var res = j.chart && j.chart.result && j.chart.result[0];
    var ts = (res && res.timestamp) || [], cl = (res && res.indicators.quote[0].close) || [];
    for (var k = 0; k < ts.length; k++) {
      if (cl[k] != null) bars.push([new Date(ts[k] * 1000 + 8 * 3600000).toISOString().slice(0, 10), cl[k]]);
    }
  } catch (e) {}
  if (bars.length) _rsBars[sym] = bars;
  return bars;
}

// 近一年高低點與位階：dd＝距高點回檔%（負值），pos＝在高低區間中的位置%（100＝在高點）
function _rsRange(bars) {
  if (!bars || bars.length < 20) return null;
  var v = bars.map(function (x) { return x[1]; });
  var hi = Math.max.apply(null, v), lo = Math.min.apply(null, v), last = v[v.length - 1];
  return { last: last, hi: hi, lo: lo, dd: hi > 0 ? (last - hi) / hi * 100 : null,
           pos: hi > lo ? (last - lo) / (hi - lo) * 100 : null };
}

// 單因子 beta：以最近 n 個共同交易日的日報酬對大盤迴歸（beta = cov/var）
function _rsBeta(bars, mkt, n) {
  if (!bars || !mkt || bars.length < 30 || mkt.length < 30) return null;
  var m = {};
  mkt.forEach(function (x) { m[x[0]] = x[1]; });
  var ds = [], px = [], mx = [];
  bars.forEach(function (x) { if (m[x[0]] != null) { ds.push(x[0]); px.push(x[1]); mx.push(m[x[0]]); } });
  var ra = [], rb = [];
  for (var i = 1; i < ds.length; i++) {
    if (px[i - 1] > 0 && mx[i - 1] > 0) { ra.push(px[i] / px[i - 1] - 1); rb.push(mx[i] / mx[i - 1] - 1); }
  }
  if (ra.length < 30) return null;
  ra = ra.slice(-(n || 120)); rb = rb.slice(-(n || 120));
  var k = ra.length, ma = 0, mb = 0;
  for (var t = 0; t < k; t++) { ma += ra[t]; mb += rb[t]; }
  ma /= k; mb /= k;
  var cov = 0, vb = 0;
  for (var t2 = 0; t2 < k; t2++) { cov += (ra[t2] - ma) * (rb[t2] - mb); vb += (rb[t2] - mb) * (rb[t2] - mb); }
  return vb > 0 ? { beta: cov / vb, n: k } : null;
}

// light: 0 綠 / 1 黃 / 2 紅（由系統風險燈傳入，決定「建議」欄的語氣）
async function _rsCoreTableHtml(light) {
  var held = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  var codes = RS_CORE.filter(function (c) { return held[c] > 0; });
  var head = '<div class="rs-sec-title">表一 · 核心持股（只在系統性風險時減倉）</div>';
  if (!codes.length) {
    return head + '<div class="rs-bond-verdict" style="border-color:var(--text3);color:var(--text3)">目前未持有核心標的（' + RS_CORE.join('／') + '）</div>';
  }
  var mkt = await _rsBars1y('^TWII');
  var barsArr = await Promise.all(codes.map(function (c) {
    return (typeof _esBarsOf === 'function') ? _esBarsOf(c).catch(function () { return []; }) : Promise.resolve([]);
  }));

  var rows = codes.map(function (code, i) {
    var bars = barsArr[i];
    var rg = _rsRange(bars), bt = _rsBeta(bars, mkt, 120);
    var r = (typeof _rows !== 'undefined') && _rows[code];
    return {
      code: code,
      name: (typeof _contracts !== 'undefined' && _contracts[code] && _contracts[code].name) || '',
      px: (r && r.close > 0) ? r.close : (rg ? rg.last : null),
      rg: rg, beta: bt ? bt.beta : null, bn: bt ? bt.n : 0
    };
  });
  // 減倉順序：beta 大者先減（同樣減一張，對總市值的保護效果較大）
  var ranked = rows.filter(function (x) { return x.beta != null; })
    .slice().sort(function (a, b) { return b.beta - a.beta; });
  ranked.forEach(function (x, i) { x.cut = i + 1; });

  var mrg = _rsRange(mkt);
  var num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  var sgn = function (v, dp) {
    if (v == null) return '<span class="dm-dim">—</span>';
    var cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(dp == null ? 1 : dp) + '%</span>';
  };

  var h = head + '<div class="inv-table-wrap"><table class="inv-table rs-b-table"><thead><tr>' +
    '<th>代號</th>' +
    '<th class="num" title="最新成交價；盤後為收盤價">現價</th>' +
    '<th class="num" title="相對近一年最高收盤價的回檔幅度">距一年高</th>' +
    '<th class="num" title="現價在近一年高低區間中的位置；100% 代表就在最高點、0% 在最低點">一年位階</th>' +
    '<th class="num" title="近 120 個交易日的日報酬對台股大盤迴歸；1.0 代表跟大盤同步">大盤敏感度</th>' +
    '<th class="num" title="大盤單日跌 5% 時，依敏感度推算的預估跌幅">跌5%預估</th>' +
    '<th>建議</th></tr></thead><tbody>';

  rows.forEach(function (x) {
    var adv, cls = '';
    if (light >= 2) {
      adv = x.cut ? '減倉順序 ' + x.cut : '評估減倉';
      cls = 'rs-b-swap';
    } else if (light === 1) {
      adv = '持有，暫停加碼';
    } else {
      adv = '持有' + (x.rg && x.rg.dd != null && x.rg.dd <= -8 ? '，已回檔可考慮加碼' : '');
    }
    h += '<tr><td>' + x.code + (x.name ? '<div class="rs-b-name">' + x.name + '</div>' : '') + '</td>' +
      '<td class="num">' + num(x.px) + '</td>' +
      '<td class="num">' + sgn(x.rg && x.rg.dd) + '</td>' +
      '<td class="num">' + (x.rg && x.rg.pos != null ? Math.round(x.rg.pos) + '%' : '—') + '</td>' +
      '<td class="num">' + (x.beta == null ? '—' : x.beta.toFixed(2)) + '</td>' +
      '<td class="num">' + (x.beta == null ? '—' : '<span class="down">−' + (x.beta * 5).toFixed(1) + '%</span>') + '</td>' +
      '<td>' + (cls ? '<span class="' + cls + '">' + adv + '</span>' : adv) + '</td></tr>';
  });
  h += '</tbody></table></div>';

  h += '<div class="rs-note">' +
    '<b>怎麼看</b>：燈號綠色時這張表的答案就是「持有」，這符合你的原則——核心部位不因短期波動調整。' +
    '只有燈號轉紅時「減倉順序」才有意義。<br>' +
    '<b>大盤敏感度</b>：近 120 個交易日的日報酬對台股大盤迴歸出來的倍數。1.0 代表跟大盤同步，' +
    '0.6 代表大盤跌 10% 時這檔大約跌 6%。要減倉避險時，先減敏感度高的那檔，同樣張數的保護效果比較大。<br>' +
    '<b>回檔加碼提示</b>：距近一年高點回檔 8% 以上才會出現，避免在高檔附近一直提示加碼。<br>' +
    (mrg ? '參考｜台股大盤近一年高點 ' + Math.round(mrg.hi).toLocaleString('zh-TW') +
      '，目前 ' + Math.round(mrg.last).toLocaleString('zh-TW') + '（距高點 ' + num(mrg.dd, 1) + '%、位階 ' +
      (mrg.pos != null ? Math.round(mrg.pos) + '%' : '—') + '）。<br>' : '') +
    '資料來源：Yahoo 日線（近一年）。<b>本表為依你設定規則自動算分的參考，非投資建議。</b>' +
    '</div>';
  return h;
}

// ══════════ 表二：非投等債（每月基本收入）══════════
// 決策權重依使用者設定：殖利率 75%、流動性 25%。違約風險交給發行商經理人，此處不判定
// （分析端能取得的信用指標與經理人之間資訊量差太大，做出來的判定沒有決策價值）。
//
// 殖利率一律用「真實配息率」＝年化配息率 ×（股利＋利息占比），理由：
//   收益平準金＝把新申購者的本金撥出來當配息發，等於本金退回，還會稀釋淨值；
//   已實現資本利得＝賣債賺的價差，行情反轉就沒有。
// 兩者都不是債息收入，卻會讓帳面配息率看起來很高。占比取近 12 個月線性遞減加權（見 div-mix.js），
// 最新一期權重最高，避免單純平均把趨勢抹掉。
var RS_B_W = { yield: 0.75, liq: 0.25 };     // 綜合分權重（使用者設定）
var RS_B_LIQ = { amt: 0.7, prem: 0.3 };      // 流動性內部權重：日均成交金額 70%、折溢價貼近度 30%
var RS_B_GAP = 15;                           // 最低分與最高分差距達此值才標「換股候選」，避免四檔差不多時亂標

// 年化配息率：近 12 個月各期配發金額的平均 × 每年期數。
// 用「平均 × 期數」而非「12 個月加總」，新上市未滿一年的 ETF（如 00989B）才不會被低估。
// 金額取自 MOPS 公告（與占比同一來源），期數由配息頻率（div-meta.js）決定。
function _rsBondYield(code, px) {
  if (!px || typeof dmRecs !== 'function') return null;
  var a = dmRecs(code, 12).map(function (x) { return x.amt; }).filter(function (v) { return v > 0; });
  if (!a.length) return null;
  var step = (typeof _divFreqOverride === 'function' && _divFreqOverride(code)) || 1;
  var avg = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  return avg * (12 / step) / px * 100;
}

// 組內 min-max 正規化（0–1）。只有一檔或全部相同時回 1，避免除以零把分數打成 0。
function _rsNorm(vals, v) {
  var ok = vals.filter(function (x) { return x != null; });
  if (!ok.length || v == null) return null;
  var mn = Math.min.apply(null, ok), mx = Math.max.apply(null, ok);
  return mx > mn ? (v - mn) / (mx - mn) : 1;
}

async function _rsBondTableHtml() {
  var codes = _rsBondHoldings();
  var head = '<div class="rs-sec-title">表二 · 非投等債（每月基本收入）</div>';
  if (!codes.length) {
    return head + '<div class="rs-bond-verdict" style="border-color:var(--text3);color:var(--text3)">目前未持有非投等債 ETF</div>';
  }
  var navs = await Promise.all(codes.map(_rsBondNav));
  var liqs = await Promise.all(codes.map(_rsBondLiq));

  var rows = codes.map(function (code, i) {
    var nav = navs[i], liq = liqs[i];
    var r = (typeof _rows !== 'undefined') && _rows[code];
    var px = (r && r.close > 0) ? r.close : (nav && nav.price > 0 ? nav.price : null);
    var mix = typeof dmMix === 'function' ? dmMix(code, 12) : null;
    var yld = _rsBondYield(code, px);
    var core = mix ? mix.core / 100 : null;
    return {
      code: code,
      name: (typeof _contracts !== 'undefined' && _contracts[code] && _contracts[code].name) || '',
      px: px, yld: yld, mix: mix,
      real: (yld != null && core != null) ? yld * core : null,
      trend: typeof dmTrend === 'function' ? dmTrend(code, dmPickE) : null,
      pend: typeof dmPending === 'function' ? dmPending(code) : null,
      prem: nav && nav.premium != null ? nav.premium : null,
      liq: liq ? liq.med : null
    };
  });

  // 綜合分：真實配息率 75% + 流動性 25%（流動性＝日均成交金額 70% + 折溢價貼近度 30%）
  var vReal = rows.map(function (x) { return x.real; });
  var vLiq = rows.map(function (x) { return x.liq == null ? null : Math.log(x.liq); });   // 金額量級差距大，取對數
  var vPrem = rows.map(function (x) { return x.prem == null ? null : -Math.abs(x.prem); });
  rows.forEach(function (x) {
    var ys = _rsNorm(vReal, x.real);
    var ls1 = _rsNorm(vLiq, x.liq == null ? null : Math.log(x.liq));
    var ls2 = _rsNorm(vPrem, x.prem == null ? null : -Math.abs(x.prem));
    var ls = (ls1 == null && ls2 == null) ? null
      : (ls1 == null ? ls2 : (ls2 == null ? ls1 : ls1 * RS_B_LIQ.amt + ls2 * RS_B_LIQ.prem));
    x.sYield = ys; x.sLiq = ls;
    x.score = (ys == null) ? null : 100 * (ys * RS_B_W.yield + (ls == null ? ys : ls) * RS_B_W.liq);
  });
  var scored = rows.filter(function (x) { return x.score != null; });
  var worst = null;
  if (scored.length >= 2) {
    var mn = Math.min.apply(null, scored.map(function (x) { return x.score; }));
    var mx = Math.max.apply(null, scored.map(function (x) { return x.score; }));
    if (mx - mn >= RS_B_GAP) worst = scored.filter(function (x) { return x.score === mn; })[0];
  }

  var pct = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp) + '%'; };
  var money = function (v) {
    return v == null ? '—' : (v >= 1e8 ? (v / 1e8).toFixed(2) + ' 億' : Math.round(v / 1e4).toLocaleString('zh-TW') + ' 萬');
  };

  var h = head + '<div class="inv-table-wrap"><table class="inv-table rs-b-table"><thead><tr>' +
    '<th>代號</th>' +
    '<th class="num" title="近 12 個月各期配發金額平均 × 每年期數 ÷ 現價；這是公告上看得到的帳面數字">年化配</th>' +
    '<th class="num" title="年化配息率 ×（股利＋利息占比）。扣掉收益平準金與資本利得後，真正來自債息的部分">真實配</th>' +
    '<th class="num" title="收益平準金占比（近 12 個月加權）。把新申購者的本金撥出來當配息發，會稀釋淨值">平準金</th>' +
    '<th title="近半年平均 vs 前半年平均，差距超過 5 個百分點才標箭頭">趨勢</th>' +
    '<th class="num" title="近 20 個交易日成交金額中位數（不含當日）">日均成交</th>' +
    '<th class="num" title="市價相對淨值；正為溢價、負為折價，越接近 0 越好">折溢價</th>' +
    '<th class="num" title="真實配息率 75% + 流動性 25%，組內相對評分">綜合分</th>' +
    '<th>建議</th></tr></thead><tbody>';

  rows.forEach(function (x) {
    var tip = '';
    if (x.mix) {
      tip = dmRecs(x.code, 12).map(function (r) { return r.ex + ' ' + (r.pct.e || 0).toFixed(1) + '%'; }).join('&#10;');
    }
    h += '<tr><td>' + x.code + (x.name ? '<div class="rs-b-name">' + x.name + '</div>' : '') + '</td>' +
      '<td class="num">' + pct(x.yld) + '</td>' +
      '<td class="num"><b>' + pct(x.real) + '</b></td>' +
      '<td class="num"' + (tip ? ' title="每期平準金占比：&#10;' + tip + '"' : '') + '>' +
      (x.mix ? pct(x.mix.e, 1) : '—') + '</td>' +
      '<td>' + (typeof dmTrendHtml === 'function' ? dmTrendHtml(x.trend, false) : '—') + '</td>' +
      '<td class="num">' + money(x.liq) + '</td>' +
      '<td class="num">' + (x.prem == null ? '—' : (x.prem > 0 ? '+' : '') + x.prem.toFixed(2) + '%') + '</td>' +
      '<td class="num"><b>' + (x.score == null ? '—' : Math.round(x.score)) + '</b></td>' +
      '<td>' + (worst && worst.code === x.code ? '<span class="rs-b-swap">換股候選</span>' : '') +
      (x.pend ? '<span class="rs-b-pend" title="除息日 ' + x.pend.ex + ' 的組成占比公告尚未發布（發行商通常在除息後約 10 天才發）">下期待公告</span>' : '') +
      '</td></tr>';
  });
  h += '</tbody></table></div>';

  var noLiq = rows.some(function (x) { return x.liq == null; });
  h += '<div class="rs-note">' +
    '<b>怎麼看</b>：只比較「同樣一筆錢放哪一檔比較划算」，不預測漲跌。綜合分是組內相對分數，' +
    '最低分且與最高分差距達 ' + RS_B_GAP + ' 分才標為換股候選；換去哪一檔要另外看你的現金與配息月份安排。<br>' +
    '<b>真實配息率</b>：帳面年化配息率扣掉收益平準金與資本利得後的部分。平準金是把新申購者的本金當配息發回，' +
    '資本利得靠賣債價差、行情反轉就沒有，兩者都不是可持續的債息收入。占比取近 12 個月線性遞減加權，最新一期權重最高。<br>' +
    '<b>違約風險</b>不在此表判定，交給發行商經理人。<br>' +
    (noLiq ? '<b class="up">日均成交金額需要券商連線</b>（Shioaji 日 K），目前有部分檔取不到；' +
      '該檔的流動性改以折溢價單項計算，兩項都缺時則只看殖利率。<br>' : '') +
    '資料來源：配息金額與組成占比＝公開資訊觀測站（資料日見頁面上方）；折溢價＝TWSE 官方淨值；成交金額＝Shioaji 日 K。' +
    '<b>本表為依你設定規則自動算分的參考，非投資建議。</b>' +
    '</div>';
  return h;
}

// ══════════ 表三：衛星配置（增加資產與月收入）══════════
// 衛星＝股票型持股扣掉核心三檔與個股。核心只在系統性風險時減倉（見表一），不參與汰弱留強；
// 個股的總經解釋力太低（實測 R² 0.06），用同一套指標排序沒有意義，故排除。
//
// 兩個維度對應使用者對衛星的期待「增加資產」與「提高每月平均收入」：
//   資產成長＝價格報酬（不含息）
//   月收入  ＝真實配息率（年化配息率 × 本業占比）
// 刻意用價格報酬而非總報酬：總報酬已內含配息，與右邊的配息欄重複計分會讓高配息標的被算兩次。
// 兩者相加約等於總報酬，分開看才知道報酬是靠價差還是靠配息來的。
var RS_CORE = ['00918', '00922', '00923'];            // 核心持股，不列入衛星汰弱
var RS_S_CATS = /^(市值型|高息型|主動市值|主動高息)$/;
var RS_S_W = { ret: 0.5, inc: 0.5 };                  // 綜合分權重：資產成長 50%、月收入 50%

function _rsSatHoldings() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return Object.keys(m).filter(function (c) {
    if (!(m[c] > 0) || RS_CORE.indexOf(c) >= 0) return false;
    return typeof catOf === 'function' && RS_S_CATS.test(catOf(c));
  }).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
}

// 區間價格報酬%：Yahoo 1 年日線（沿用 ETF 評比的 _esBarsOf，同一份記憶體快取，不重複打 GAS）
function _rsSatRet(bars, months) {
  if (!bars || bars.length < 5) return null;
  var d = new Date(Date.now() + 8 * 3600000);
  d.setUTCMonth(d.getUTCMonth() - months);
  var from = d.toISOString().slice(0, 10), i0 = -1;
  for (var k = 0; k < bars.length; k++) { if (bars[k][0] >= from) { i0 = k; break; } }
  if (i0 < 0 || i0 >= bars.length - 1) return null;         // 上市未滿該區間 → 不強行計算
  var a = bars[i0][1], b = bars[bars.length - 1][1];
  return a > 0 ? (b - a) / a * 100 : null;
}

// 依欄位排名並換成 0–1 分數（第一名 1、最後一名 0；同分同名次）。
// key 寫回 x[out]（分數）與 x['rk' + 後綴]（名次），名次供表格顯示與「兩項都吊車尾」判定。
function _rsRank(rows, field, out, descIsBetter) {
  var tag = 'rk' + out.slice(1);
  var vals = rows.map(function (x) { return x[field]; }).filter(function (v) { return v != null; });
  if (!vals.length) { rows.forEach(function (x) { x[out] = null; x[tag] = null; }); return; }
  var sorted = vals.slice().sort(function (a, b) { return descIsBetter ? b - a : a - b; });
  var n = rows.length;
  rows.forEach(function (x) {
    if (x[field] == null) { x[out] = null; x[tag] = null; return; }
    var r = sorted.indexOf(x[field]) + 1;                 // 同值取較前名次
    x[tag] = r;
    x[out] = n > 1 ? (n - r) / (n - 1) : 1;
  });
}

// 年化配息率：與表二同式（近 12 個月各期金額平均 × 每年期數 ÷ 現價）
function _rsSatYield(code, px) { return _rsBondYield(code, px); }

async function _rsSatTableHtml() {
  var codes = _rsSatHoldings();
  var head = '<div class="rs-sec-title">表三 · 衛星配置（增加資產與月收入）</div>';
  if (!codes.length) {
    return head + '<div class="rs-bond-verdict" style="border-color:var(--text3);color:var(--text3)">目前未持有衛星部位</div>';
  }
  var barsArr = await Promise.all(codes.map(function (c) {
    return (typeof _esBarsOf === 'function') ? _esBarsOf(c).catch(function () { return []; }) : Promise.resolve([]);
  }));
  var navs = await Promise.all(codes.map(_rsBondNav));

  var rows = codes.map(function (code, i) {
    var bars = barsArr[i], nav = navs[i];
    var r = (typeof _rows !== 'undefined') && _rows[code];
    // 現價三層後備：即時快照 → TWSE 淨值檔（盤前偶爾缺檔）→ 日線最後一筆收盤
    var px = (r && r.close > 0) ? r.close
      : (nav && nav.price > 0 ? nav.price : (bars && bars.length ? bars[bars.length - 1][1] : null));
    var mix = typeof dmMix === 'function' ? dmMix(code, 12) : null;
    var yld = _rsSatYield(code, px);
    var core = mix ? mix.core / 100 : null;
    return {
      code: code,
      name: (typeof _contracts !== 'undefined' && _contracts[code] && _contracts[code].name) || '',
      cat: typeof catOf === 'function' ? catOf(code) : '',
      r3: _rsSatRet(bars, 3), r6: _rsSatRet(bars, 6),
      yld: yld, mix: mix, n: mix ? mix.n : 0,
      real: (yld != null && core != null) ? yld * core : null,
      trend: typeof dmTrend === 'function' ? dmTrend(code, dmPickCore) : null,
      pend: typeof dmPending === 'function' ? dmPending(code) : null
    };
  });

  // 評分用排名而非 min-max 正規化：衛星只有兩三檔時，min-max 會讓兩個極端值決定整個尺度，
  // 兩項都排中間的標的反而拿到最低分（實測 00878 成長第一/收入最後 50 分、00999A 兩項都第二卻只有 36 分）。
  // 排名制不受極端值影響，名次相同就同分。
  _rsRank(rows, 'r6', 'kR', true);
  _rsRank(rows, 'real', 'kI', true);
  rows.forEach(function (x) {
    var a = x.kR, b = x.kI;
    x.score = (a == null && b == null) ? null
      : (a == null ? b : (b == null ? a : a * RS_S_W.ret + b * RS_S_W.inc)) * 100;
  });
  // 換股候選：兩項都吊車尾才標（單項墊底可能只是風格差異，不構成汰換理由）
  var n = rows.length, worst = null;
  if (n >= 3) {
    worst = rows.filter(function (x) { return x.rkR === n && x.rkI === n; })[0] || null;
  }

  var pct = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp) + '%'; };
  var ret = function (v) {
    if (v == null) return '<span class="dm-dim">—</span>';
    var cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  };

  var h = head + '<div class="inv-table-wrap"><table class="inv-table rs-b-table"><thead><tr>' +
    '<th>代號</th>' +
    '<th class="num" title="近 3 個月價格報酬（不含配息）">近3月</th>' +
    '<th class="num" title="近 6 個月價格報酬（不含配息）；綜合分的資產成長項用這個">近6月</th>' +
    '<th class="num" title="近 12 個月各期配發金額平均 × 每年期數 ÷ 現價">年化配</th>' +
    '<th class="num" title="年化配息率 ×（股利＋利息占比）；扣掉平準金與資本利得後真正來自成分股配息的部分">真實配</th>' +
    '<th class="num" title="收益平準金占比（近 12 個月加權）">平準金</th>' +
    '<th class="num" title="資本利得占比（近 12 個月加權）。括號內為賣出選擇權權利金，屬掩護性買權策略收入，會持續產生；其餘為賣股價差，行情反轉就沒有">資本利得</th>' +
    '<th title="本業占比（股利＋利息）近半年 vs 前半年，差距超過 5 個百分點才標箭頭">本業趨勢</th>' +
    '<th class="num" title="資產成長 50% + 月收入 50%，依組內名次計分（第一名 100、最後一名 0）">綜合分</th>' +
    '<th>建議</th></tr></thead><tbody>';

  rows.forEach(function (x) {
    var capTxt = '—';
    if (x.mix) {
      capTxt = pct(x.mix.cap, 1);
      if (x.mix.cc >= 0.5) capTxt += '<div class="rs-b-name">權利金 ' + x.mix.cc.toFixed(1) + '%</div>';
    }
    h += '<tr><td>' + x.code + (x.name ? '<div class="rs-b-name">' + x.name +
      (x.cat ? '・' + x.cat : '') + '</div>' : '') + '</td>' +
      '<td class="num">' + ret(x.r3) + '</td>' +
      '<td class="num">' + ret(x.r6) + (x.rkR ? '<div class="rs-b-name">成長 ' + x.rkR + '/' + rows.length + '</div>' : '') + '</td>' +
      '<td class="num"' + (x.n ? ' title="近 12 個月取到 ' + x.n + ' 期"' : '') + '>' + pct(x.yld) + '</td>' +
      '<td class="num"><b>' + pct(x.real) + '</b>' + (x.rkI ? '<div class="rs-b-name">收入 ' + x.rkI + '/' + rows.length + '</div>' : '') + '</td>' +
      '<td class="num">' + (x.mix ? pct(x.mix.e, 1) : '—') + '</td>' +
      '<td class="num">' + capTxt + '</td>' +
      '<td>' + (typeof dmTrendHtml === 'function' ? dmTrendHtml(x.trend, true) : '—') + '</td>' +
      '<td class="num"><b>' + (x.score == null ? '—' : Math.round(x.score)) + '</b></td>' +
      '<td>' + (worst && worst.code === x.code ? '<span class="rs-b-swap">換股候選</span>' : '') +
      (x.pend ? '<span class="rs-b-pend" title="除息日 ' + x.pend.ex + ' 的組成占比公告尚未發布">下期待公告</span>' : '') +
      '</td></tr>';
  });
  h += '</tbody></table></div>';

  var thin = rows.filter(function (x) { return x.mix && x.n < 3; }).map(function (x) { return x.code; });
  h += '<div class="rs-note">' +
    '<b>怎麼看</b>：衛星部位負責增加資產與提高月收入，所以兩個維度各占一半。綜合分依組內<b>名次</b>計分' +
    '（第一名 100、最後一名 0，名次相同就同分），不受單一極端值影響。' +
    '<b>兩項都吊車尾</b>才標為換股候選——只有一項墊底可能只是風格差異，不構成汰換理由；' +
    '要換去哪一檔請看「關注股票 → ETF 評比」的前 20 名。<br>' +
    '<b>報酬用價格報酬（不含配息）</b>：總報酬已經內含配息，若直接拿來當成長項，會與右邊的配息欄重複計分、' +
    '讓高配息標的被算兩次。價格報酬 ＋ 配息率 ≈ 總報酬，分開看才知道報酬是靠價差還是靠配息。<br>' +
    '<b>資本利得</b>：靠基金賣股賺的價差發配息，行情好時撐得住、轉弱時配息會縮水。括號內的權利金是掩護性買權' +
    '策略收入（主動式 ETF 才有），性質上比賣股價差可重複。<br>' +
    '核心持股（' + RS_CORE.join('／') + '）依你的原則只在系統性風險時減倉，不列入此表的汰弱比較；個股也不列入。<br>' +
    (thin.length ? '<b class="up">' + thin.join('／') + ' 近 12 個月只有 1–2 期配息紀錄</b>（上市未滿一年），年化與占比的代表性有限。<br>' : '') +
    '資料來源：價格＝Yahoo 日線；配息金額與組成占比＝公開資訊觀測站（資料日見頁面上方）。' +
    '<b>本表為依你設定規則自動算分的參考，非投資建議。</b>' +
    '</div>';
  return h;
}

// ── 頂欄台指期即時徽章（僅「加減碼報告」頁；夜盤時即時、收盤後為最後/結算值） ──
var _txfTimer = null;
async function renderTxfBadge() {
  var el = document.getElementById('topbar-txf');
  if (!el) return;
  var n = await _rsNight();
  if (!n || n.value == null) { el.innerHTML = ''; return; }
  var cls = n.chg > 0 ? 'up' : (n.chg < 0 ? 'down' : 'flat'); // 台股慣例：漲紅跌綠
  var arrow = n.chg > 0 ? '▲' : (n.chg < 0 ? '▼' : '');
  el.innerHTML = '<span class="txf-lb">台指期</span>' +
    '<span class="txf-v ' + cls + '">' + Math.round(n.value).toLocaleString('zh-TW') +
    ' ' + arrow + Math.abs(n.chg == null ? 0 : n.chg).toFixed(2) + '%</span>';
}
function startTxfBadge() {
  renderTxfBadge();
  if (_txfTimer) clearInterval(_txfTimer);
  _txfTimer = setInterval(renderTxfBadge, 15000); // 夜盤即時；收盤後值不變、成本極低（直連 Shioaji 無 GAS 配額）
}
function stopTxfBadge() {
  if (_txfTimer) { clearInterval(_txfTimer); _txfTimer = null; }
  var el = document.getElementById('topbar-txf');
  if (el) el.innerHTML = '';
}
