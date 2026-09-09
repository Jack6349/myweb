// 股利總管 Web — 加減碼報告：系統性風險評分（量化取代質化 veto）
// ※ 依使用者自訂規則自動算分的參考工具，非投資建議。門檻為初始值，待 6 個月歷史回測校準。
// 六項各 0/1/2 分（總 0–12）＋「股債同向重挫」旗標（觸發直接 veto，不論總分）。
// 資料源：Yahoo（^VIX/^TNX/DX-Y.NYB/^SOX/^IXIC，經 GAS 代理）＋ Shioaji 台指期夜盤 TXFR1。

// ── 門檻常數（回測校準後改這裡即可） ──
var RS_TH = {
  vix:    [20, 25],    // 絕對值：<20→0, 20~25→1, >25→2
  vixChg: [10, 20],    // 單日漲幅%（只計上升）
  yield:  [1, 2],      // 美10年債殖利率單日變化%（絕對值）
  dxy:    [0.5, 1],    // 美元指數單日變化%（絕對值）
  equity: [2, 4],      // 費半/Nasdaq 單日跌幅%（取較大者）
  night:  [1, 3]       // 台指期夜盤跌幅%
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
var RS_HY_RE = /非投|高收/;
function _rsBondHoldings() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return Object.keys(m).filter(function (c) {
    if (!(m[c] > 0) || !/^00\d+[A-Z]?$/.test(c)) return false;
    return RS_HY_RE.test((_contracts[c] && _contracts[c].name) || '');
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
// 成交量：Shioaji 日 kbars → 當日量 vs 近90日中位數（需 broker session）
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

async function startRiskReport(force) {
  var wrap = document.getElementById('risk-wrap');
  var info = document.getElementById('risk-info');
  wrap.innerHTML = '<div class="modal-loading">抓取總經與台指夜盤資料…</div>';

  // 債券區塊要依「實際持有的非投等債 ETF」列出 → 本頁需先有持股資料（本頁原本不載入持股）
  if (typeof ensureFeed === 'function' && !Object.keys((typeof _sharesMap !== 'undefined' && _sharesMap) || {}).length) {
    try { await ensureFeed(function (m) { info.textContent = m; }); } catch (e) {}
  }

  var res = await Promise.all([
    _rsYahoo('^VIX'), _rsYahoo('^TNX'), _rsYahoo('DX-Y.NYB'),
    _rsYahoo('^SOX'), _rsYahoo('^IXIC'), _rsNight()
  ]);
  var vix = res[0], tnx = res[1], dxy = res[2], sox = res[3], ndx = res[4], night = res[5];

  // 帶正負號顯示（漲跌都可能，非只跌）
  var sp = function (v, d) { return v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + '%'; };
  // 費半/Nasdaq 取「較弱者」（最負）當代表值；跌幅用於評分
  var soxC = sox ? sox.chg : null, ndxC = ndx ? ndx.chg : null;
  var equityWorst = (soxC != null && ndxC != null) ? Math.min(soxC, ndxC) : (soxC != null ? soxC : ndxC);
  var equityDrop = equityWorst != null ? Math.max(0, -equityWorst) : null;
  var nightChg = night && night.chg != null ? night.chg : null;
  var nightDrop = nightChg != null ? Math.max(0, -nightChg) : null;
  var vixUp = vix && vix.chg != null ? Math.max(0, vix.chg) : null;

  var rows = [
    { k: 'VIX 絕對值', desc: _rsDesc('市場避險情緒', RS_TH.vix, '', ['平穩', '升溫', '濃厚']), val: vix ? vix.value.toFixed(2) : '—', score: vix ? _rsScore(vix.value, RS_TH.vix) : null },
    { k: 'VIX 單日變化', desc: _rsDesc('恐慌情緒單日升幅', RS_TH.vixChg, '%', ['平穩', '升溫', '急升']), val: vix ? sp(vix.chg, 1) : '—', score: _rsScore(vixUp, RS_TH.vixChg) },
    { k: '美10年債殖利率變化', desc: _rsDesc('利率環境單日變動', RS_TH.yield, '%', ['平穩', '波動', '劇烈']), val: tnx ? sp(tnx.chg, 2) : '—', score: tnx && tnx.chg != null ? _rsScore(Math.abs(tnx.chg), RS_TH.yield) : null },
    { k: '美元指數變化', desc: _rsDesc('資金避險流向單日變動', RS_TH.dxy, '%', ['平穩', '波動', '劇烈']), val: dxy ? sp(dxy.chg, 2) : '—', score: dxy && dxy.chg != null ? _rsScore(Math.abs(dxy.chg), RS_TH.dxy) : null },
    { k: '費半/Nasdaq 變化（取較弱）', desc: _rsDesc('科技股單日跌幅', RS_TH.equity, '%', ['平穩', '下挫', '重挫']), val: equityWorst != null ? sp(equityWorst, 2) : '—', score: _rsScore(equityDrop, RS_TH.equity) },
    { k: '台指期夜盤變化', desc: _rsDesc('台股隔夜跌幅', RS_TH.night, '%', ['平穩', '下挫', '重挫']), val: nightChg != null ? sp(nightChg, 2) : '—', score: _rsScore(nightDrop, RS_TH.night) }
  ];

  var total = 0, avail = 0;
  rows.forEach(function (r) { if (r.score != null) { total += r.score; avail++; } });

  // 債券型信用風險子模組資料（美股端 HYG/JNK/OAS ＋ 各檔折溢價/量）；與股票區塊獨立、不影響總分
  var bCodes = _rsBondHoldings();                     // 持股中的非投等債 ETF（檔數隨持股變動）
  var bd = await Promise.all(
    [_rsYahoo('HYG'), _rsYahoo('JNK'), _rsOAS()]
      .concat(bCodes.map(_rsBondNav))
      .concat(bCodes.map(_rsBondVol))
  );
  var bn = bCodes.length;
  var bond = { hyg: bd[0], jnk: bd[1], oas: bd[2], tnx: tnx, codes: bCodes,
    nav: bd.slice(3, 3 + bn), vol: bd.slice(3 + bn, 3 + 2 * bn) };

  // 股債同向重挫旗標
  var flag = (equityDrop != null && tnx && tnx.chg != null && equityDrop >= RS_FLAG.equityDrop && tnx.chg >= RS_FLAG.yieldUp);

  // 動作對照
  var verdict, vColor;
  if (flag) { verdict = '🔴 股債齊跌，暫停加碼'; vColor = 'var(--up)'; }
  else if (total >= 7) { verdict = '🔴 暫停加碼，等分數回落'; vColor = 'var(--up)'; }
  else if (total >= 4) { verdict = '🟡 加碼額度減半，或延後一日確認止穩'; vColor = 'var(--accent2)'; }
  else { verdict = '🟢 正常，可執行加碼計畫'; vColor = 'var(--down)'; }

  var tw = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
  info.textContent = '更新：' + tw + '（台北）';

  var html = '';
  // 判定卡
  html += '<div class="rs-verdict" style="border-color:' + vColor + '">' +
    '<div class="rs-score-big" style="color:' + vColor + '">' + total + '<span style="font-size:16px;color:var(--text3)"> / 12</span></div>' +
    '<div class="rs-verdict-txt"><div class="rs-vlabel">建議動作</div><div style="color:' + vColor + ';font-weight:700">' + verdict + '</div>' +
    (avail < 6 ? '<div style="font-size:11px;color:var(--text3);margin-top:2px">（' + avail + '/6 項有資料，' + (6 - avail) + ' 項暫缺）</div>' : '') +
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
    '<b>動作對照</b>：0–3 正常加碼｜4–6 減半或延後｜7 分以上暫停加碼｜股債同向重挫發生時直接暫停加碼。<br>' +
    '<b>得分色</b>：<span style="color:var(--down)">0 低</span>／<span style="color:var(--accent2)">1 中</span>／<span style="color:var(--up)">2 高</span>。<br>' +
    '資料源：Yahoo（VIX/美10年債/美元指數/費半/Nasdaq）＋ Shioaji 台指期夜盤(TXFR1)。' +
    '門檻為初始值、待 6 個月歷史回測校準。<b>本面板為依你設定規則自動算分的參考，非投資建議。</b>' +
    '</div>';

  // ── 區塊 B：債券型（非投等債）信用風險（獨立兩層 override，不影響上方股票總分）──
  html += _rsBondBlockHtml(bond, sp);

  wrap.innerHTML = html;
}

// 債券型信用風險區塊：每檔逐條紅綠燈直述（美股信用債跌幅／折價／成交量），綜合判定用操作語言
// 利率與信用的多日趨勢：單日變化容易被雜訊主導，近 5 日／20 日才看得出方向。
// 只呈現數值與方向，不做自動判定：換股決策屬相對面（見換股試算的「換手品質」），
// 此處回答的是「非投等債的持有環境近期往哪走」。
// 殖利率與 OAS 本身即為百分比，變化以百分點（pp）表示；HYG／JNK 為價格，用 % 變化。
function _rsTrendHtml(bond) {
  var t = bond.tnx, hyg = bond.hyg, jnk = bond.jnk, oas = bond.oas;
  if (!t && !hyg && !jnk && !oas) return '';
  // 對「持有非投等債」有利＝紅、不利＝綠（與全站漲跌配色一致）
  var cell = function (v, dp, suf, goodIsUp) {
    if (v == null) return '<td class="num"><span class="rs-dim">—</span></td>';
    var cls = Math.abs(v) < 1e-9 ? 'flat' : ((v > 0) === !!goodIsUp ? 'up' : 'down');
    return '<td class="num ' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(dp) + suf + '</td>';
  };
  var val = function (v, dp, suf) { return v == null ? '—' : v.toFixed(dp) + suf; };

  var h = '<div class="rs-trend-title">利率與信用趨勢</div>' +
    '<div class="inv-table-wrap"><table class="inv-table rs-trend"><thead><tr>' +
    '<th>指標</th><th class="num">最新</th><th class="num">近1日</th><th class="num">近5日</th><th class="num">近20日</th>' +
    '</tr></thead><tbody>';

  // 殖利率上升 → 債券價格下跌 → 對持有人不利（goodIsUp=false）
  h += '<tr><td title="美國10年期公債殖利率；上升不利於債券價格">美10年債殖利率</td>' +
    '<td class="num">' + val(t && t.value, 3, '%') + '</td>' +
    cell(t && t.abs1, 3, 'pp', false) + cell(t && t.abs5, 3, 'pp', false) + cell(t && t.abs20, 3, 'pp', false) + '</tr>';

  [['HYG', hyg, '美國非投等債 ETF（iShares）'], ['JNK', jnk, '美國非投等債 ETF（SPDR）']].forEach(function (p) {
    var d = p[1];
    h += '<tr><td title="' + p[2] + '；下跌代表信用債走弱">' + p[0] + '</td>' +
      '<td class="num">' + val(d && d.value, 2, '') + '</td>' +
      cell(d && d.chg, 2, '%', true) + cell(d && d.pct5, 2, '%', true) + cell(d && d.pct20, 2, '%', true) + '</tr>';
  });

  // OAS 走闊＝市場要求更高風險補償＝信用惡化（goodIsUp=false）；FRED 僅取最後兩點，無多日
  h += '<tr><td title="ICE BofA 美國非投等債選擇權調整利差（FRED BAMLH0A0HYM2）；走闊代表信用風險升高">' +
    '信用利差 OAS</td>' +
    '<td class="num">' + val(oas && oas.value, 2, '%') + '</td>' +
    cell(oas && oas.chg, 2, 'pp', false) +
    '<td class="num"><span class="rs-dim">—</span></td><td class="num"><span class="rs-dim">—</span></td></tr>';

  h += '</tbody></table></div>' +
    '<div class="rs-trend-note">紅＝對持有非投等債有利、綠＝不利。' +
    'OAS 取自 FRED，約有 1 個交易日延遲' + (oas && oas.date ? '（資料日 ' + oas.date + '）' : '') +
    '，僅提供單日變化。此表只陳述環境走向，不產生買賣判定。</div>';
  return h;
}

function _rsBondBlockHtml(bond, sp) {
  var Y = RS_BOND_TH.discount, Z = RS_BOND_TH.volShrink, X = RS_BOND_TH.drop;
  var hygDrop = bond.hyg && bond.hyg.chg != null ? Math.max(0, -bond.hyg.chg) : null;
  var jnkDrop = bond.jnk && bond.jnk.chg != null ? Math.max(0, -bond.jnk.chg) : null;
  var usHit = (hygDrop != null && hygDrop >= X) || (jnkDrop != null && jnkDrop >= X);
  var usKnown = hygDrop != null || jnkDrop != null;
  var usVals = 'HYG ' + (bond.hyg ? sp(bond.hyg.chg, 2) : '—') + '／JNK ' + (bond.jnk ? sp(bond.jnk.chg, 2) : '—');
  var oas = bond.oas;

  // 逐檔判定：美股跌幅達標 且（折價達標 或 量縮達標）→ 暫停；美股達標但本地未確認 → 注意
  var results = (bond.codes || []).map(function (code, i) {
    var nav = bond.nav[i], vol = bond.vol[i];
    var prem = nav && nav.premium != null ? nav.premium : null;   // 正=溢價、負=折價
    var ratio = vol && vol.ratio != null ? vol.ratio : null;
    var discHit = prem != null && prem <= -Y;
    var volHit = ratio != null && ratio < Z;
    var localKnown = prem != null || ratio != null;
    var level;                                                     // 0 綠 / 1 黃 / 2 紅 / -1 資料缺
    if (!usKnown || !localKnown) level = -1;
    else if (usHit && (discHit || volHit)) level = 2;
    else if (usHit) level = 1;
    else level = 0;
    return { code: code, prem: prem, ratio: ratio, discHit: discHit, volHit: volHit, level: level };
  });
  var worst = Math.max.apply(null, results.map(function (r) { return r.level; }));
  var dot = function (hit) { return hit ? '🔴' : '🟢'; };

  if (!results.length) {
    return '<div class="rs-sec-title">債券型信用風險 · 非投等債</div>' +
      '<div class="rs-bond-verdict" style="border-color:var(--text3);color:var(--text3)">目前未持有非投等債 ETF</div>';
  }
  var h = '<div class="rs-sec-title">債券型信用風險 · 非投等債（' + bond.codes.join('／') + '）</div>';

  // 綜合判定（操作語言）
  var vTxt, vColor;
  if (worst === 2) { vTxt = '🔴 暫停換股／加碼'; vColor = 'var(--up)'; }
  else if (worst === 1) { vTxt = '🟡 注意，美股信用債走弱，暫緩新進場'; vColor = 'var(--accent2)'; }
  else if (worst === 0) { vTxt = '🟢 正常，可執行換股／加碼計畫'; vColor = 'var(--down)'; }
  else { vTxt = '⚪ 資料暫缺，無法判定'; vColor = 'var(--text3)'; }
  h += '<div class="rs-bond-verdict" style="border-color:' + vColor + ';color:' + vColor + '">綜合判定：' + vTxt + '</div>';
  h += _rsTrendHtml(bond);

  // 各檔三條件逐條列示
  results.forEach(function (r) {
    var name = (_contracts[r.code] && _contracts[r.code].name) || '';
    h += '<div class="rs-bond-item"><div class="rs-bond-code">' + r.code +
      (name ? ' <span class="rs-bond-name">' + name + '</span>' : '') + '</div><ol class="rs-bond-list">';
    // 1. 美股非投等債跌幅：實際值 比較符 門檻（純數字比較，不加補充敘述）
    h += '<li>' + (usKnown ? dot(usHit) : '⚪') + ' ' +
      (usKnown ? usVals + ' ' + (usHit ? '≥' : '<') + ' 跌幅 ' + X + '%' : '美國非投等債跌幅 資料暫缺') + '</li>';
    // 2. 折溢價：溢價時條件不成立、只列數值；折價時才做門檻比較
    var premLi;
    if (r.prem == null) premLi = '⚪ 折價 資料暫缺';
    else if (r.prem > 0) premLi = '🟢 溢價 ' + r.prem.toFixed(2) + '%';
    else premLi = dot(r.discHit) + ' 折價 ' + Math.abs(r.prem).toFixed(2) + '% ' + (r.discHit ? '≥' : '<') + ' ' + Y + '%';
    h += '<li>' + premLi + '</li>';
    // 3. 成交量：當日量佔 90 日中位數比例 比較 門檻
    h += '<li>' + (r.ratio == null ? '⚪ 成交量 資料暫缺' :
      dot(r.volHit) + ' 成交量 ' + Math.round(r.ratio) + '% ' + (r.volHit ? '<' : '≥') + ' 90日中位數 ' + Z + '%') + '</li>';
    h += '</ol></div>';
  });

  // 參考資訊：OAS（延遲一日，作為佐證而非即時判定）
  var oasSign = oas ? (oas.chg > 0 ? '+' : (oas.chg < 0 ? '−' : '')) + Math.abs(oas.chg).toFixed(2) : '';
  h += '<div class="rs-bond-oas">參考｜美國非投等債信用利差（OAS）' +
    (oas ? '　今日 ' + oas.value.toFixed(2) + '%　前一日 ' + (oas.value - oas.chg).toFixed(2) + '%　變化 ' + oasSign +
      '　資料截至 ' + oas.date + '（延遲約 1 個交易日）' : '　資料暫缺') +
    (oas && usHit && oas.chg > 0 ? '　<b class="up">利差變化 ' + oasSign + ' > 0，走弱訊號成立</b>' : '') + '</div>';

  h += '<div class="rs-note">' +
    '<b>怎麼判定</b>：先看美國非投等債（HYG/JNK）單日跌幅是否達 ' + X + '%；若已達，再看該檔在台灣市場是否同步惡化——折價達 ' + Y + '% <b>或</b> 當日成交量不到 90 日中位數的 ' + Z + '%，兩者任一成立就顯示暫停。' +
    '美股走弱但台灣端還沒惡化時顯示注意，代表衝擊尚未傳導過來。此判定<b>只適用於這兩檔非投等債</b>，不影響上方股票型的評分與加碼建議。<br>' +
    '<b>指標說明</b>：HYG/JNK＝美國非投等債 ETF 價格，信用風險反應最快，美股收盤早於台股開盤，等於隔夜領先訊號；OAS＝非投等債比公債多要求的利差，已剔除利率因素、最能反映純信用風險，但公布延遲約一日，只當佐證；折價＝市價低於淨值，擴大代表台灣端流動性轉差；成交量為當日累計，盤中查看時偏低屬正常。<br>' +
    '資料源：Yahoo（HYG/JNK）＋ FRED（OAS, BAMLH0A0HYM2）＋ TWSE 官方淨值（折溢價）＋ Shioaji 日K（成交量）。判定標準 ' + X + '% 取自近一年 HYG/JNK 單日跌幅的後 10% 分位，' + Y + '%／' + Z + '% 為初始值，待回測校準。<b>非投資建議。</b>' +
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
