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
// 債券型（非投等債 00981B/00988B）信用風險兩層 override 門檻（待 6 個月回測校準）
// drop：HYG/JNK 單日跌幅%（近一年 p10≈0.31–0.34%，取 0.35 為初始值）
// discount：00988B/00981B 折價達 pp（債券 ETF 折溢價常態 <0.2%）；volShrink：當日量 < 近90日中位數 %
var RS_BOND_TH = { drop: 0.35, discount: 0.5, volShrink: 50 };
var RS_BOND_CODES = ['00981B', '00988B'];

function _rsScore(v, th) { return v == null ? null : (v < th[0] ? 0 : (v <= th[1] ? 1 : 2)); }
function _rsColor(s) { return s == null ? 'var(--text3)' : (s === 0 ? 'var(--down)' : (s === 1 ? 'var(--accent2)' : 'var(--up)')); }

var _rsCache = {}; // sym → {ts,data}；成功結果快取 3 分鐘，減少 GAS urlfetch 消耗
async function _rsYahoo(sym) {
  var c = _rsCache[sym];
  if (c && Date.now() - c.ts < 180000) return c.data;
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d';
    var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
    var j = await r.json();
    var res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    var closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [])
      .filter(function (x) { return x != null; });
    if (closes.length < 2) return null;
    var last = closes[closes.length - 1], prev = closes[closes.length - 2];
    var data = { value: last, chg: prev ? (last - prev) / prev * 100 : null };
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
    var last = pts[pts.length - 1], prev = pts[pts.length - 2];
    var data = { value: last.val, chg: last.val - prev.val, date: last.date };
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
    { k: 'VIX 絕對值', desc: '市場恐慌程度；>25 代表避險情緒濃', val: vix ? vix.value.toFixed(2) : '—', score: vix ? _rsScore(vix.value, RS_TH.vix) : null },
    { k: 'VIX 單日變化', desc: '恐慌情緒單日升溫幅度（只計上升）', val: vix ? sp(vix.chg, 1) : '—', score: _rsScore(vixUp, RS_TH.vixChg) },
    { k: '美10年債殖利率變化', desc: '利率環境；升息期易上行，與股市同跌時傳統對沖失效', val: tnx ? sp(tnx.chg, 2) : '—', score: tnx && tnx.chg != null ? _rsScore(Math.abs(tnx.chg), RS_TH.yield) : null },
    { k: '美元指數變化', desc: '資金避險流向；急升常伴隨風險資產走弱', val: dxy ? sp(dxy.chg, 2) : '—', score: dxy && dxy.chg != null ? _rsScore(Math.abs(dxy.chg), RS_TH.dxy) : null },
    { k: '費半/Nasdaq 變化（取較弱）', desc: '科技股動能；台股連動最深的美股訊號', val: equityWorst != null ? sp(equityWorst, 2) : '—', score: _rsScore(equityDrop, RS_TH.equity) },
    { k: '台指期夜盤變化', desc: '台股隔夜預期；反映國際盤對台股開盤的壓力', val: nightChg != null ? sp(nightChg, 2) : '—', score: _rsScore(nightDrop, RS_TH.night) }
  ];

  var total = 0, avail = 0;
  rows.forEach(function (r) { if (r.score != null) { total += r.score; avail++; } });

  // 債券型信用風險子模組資料（美股端 HYG/JNK/OAS ＋ 各檔折溢價/量）；與股票區塊獨立、不影響總分
  var bd = await Promise.all([
    _rsYahoo('HYG'), _rsYahoo('JNK'), _rsOAS(),
    _rsBondNav(RS_BOND_CODES[0]), _rsBondNav(RS_BOND_CODES[1]),
    _rsBondVol(RS_BOND_CODES[0]), _rsBondVol(RS_BOND_CODES[1])
  ]);
  var bond = { hyg: bd[0], jnk: bd[1], oas: bd[2], nav: [bd[3], bd[4]], vol: [bd[5], bd[6]] };

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
    (flag ? '🔴 股債同向重挫：費半/Nasdaq ' + eqTxt + '（跌幅 ≥ ' + RS_FLAG.equityDrop + '%）且 美10年債殖利率 ' + tnxTxt +
        '（漲幅 ≥ ' + RS_FLAG.yieldUp + '%）→ 股債齊跌、傳統對沖失效，暫停加碼' :
      '🟢 股債同向重挫：未發生（費半/Nasdaq ' + eqTxt + '，跌幅 < ' + RS_FLAG.equityDrop + '%；美10年債殖利率 ' + tnxTxt +
        '，漲幅 < ' + RS_FLAG.yieldUp + '%）') +
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
function _rsBondBlockHtml(bond, sp) {
  var Y = RS_BOND_TH.discount, Z = RS_BOND_TH.volShrink, X = RS_BOND_TH.drop;
  var hygDrop = bond.hyg && bond.hyg.chg != null ? Math.max(0, -bond.hyg.chg) : null;
  var jnkDrop = bond.jnk && bond.jnk.chg != null ? Math.max(0, -bond.jnk.chg) : null;
  var usHit = (hygDrop != null && hygDrop >= X) || (jnkDrop != null && jnkDrop >= X);
  var usKnown = hygDrop != null || jnkDrop != null;
  var usVals = 'HYG ' + (bond.hyg ? sp(bond.hyg.chg, 2) : '—') + '／JNK ' + (bond.jnk ? sp(bond.jnk.chg, 2) : '—');
  var oas = bond.oas;

  // 逐檔判定：美股跌幅達標 且（折價達標 或 量縮達標）→ 暫停；美股達標但本地未確認 → 注意
  var results = RS_BOND_CODES.map(function (code, i) {
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

  var h = '<div class="rs-sec-title">債券型信用風險 · 非投等債（' + RS_BOND_CODES.join('／') + '）</div>';

  // 綜合判定（操作語言）
  var vTxt, vColor;
  if (worst === 2) { vTxt = '🔴 暫停換股／加碼'; vColor = 'var(--up)'; }
  else if (worst === 1) { vTxt = '🟡 注意，美股信用債走弱，暫緩新進場'; vColor = 'var(--accent2)'; }
  else if (worst === 0) { vTxt = '🟢 正常，可執行換股／加碼計畫'; vColor = 'var(--down)'; }
  else { vTxt = '⚪ 資料暫缺，無法判定'; vColor = 'var(--text3)'; }
  h += '<div class="rs-bond-verdict" style="border-color:' + vColor + ';color:' + vColor + '">綜合判定：' + vTxt + '</div>';

  // 各檔三條件逐條列示
  results.forEach(function (r) {
    var name = (_contracts[r.code] && _contracts[r.code].name) || '';
    h += '<div class="rs-bond-item"><div class="rs-bond-code">' + r.code +
      (name ? ' <span class="rs-bond-name">' + name + '</span>' : '') + '</div><ol class="rs-bond-list">';
    // 1. 美股信用債跌幅
    h += '<li>' + (usKnown ? dot(usHit) : '⚪') + ' 美國非投等債跌幅 ' + (usHit ? '≥' : '<') + ' ' + X + '%（' +
      (usKnown ? usVals : '資料暫缺') + '）</li>';
    // 2. 折價
    var premTxt = r.prem == null ? '資料暫缺' :
      ((r.prem > 0 ? '+' : '') + r.prem.toFixed(2) + '%' + (r.prem > 0 ? '，為溢價、非折價' : (r.prem === 0 ? '，持平' : '，為折價')));
    h += '<li>' + (r.prem == null ? '⚪' : dot(r.discHit)) + ' 折價 ' + (r.discHit ? '≥' : '<') + ' ' + Y + '%（' + premTxt + '）</li>';
    // 3. 成交量
    var volTxt = r.ratio == null ? '資料暫缺' : Math.round(r.ratio) + '%';
    h += '<li>' + (r.ratio == null ? '⚪' : dot(r.volHit)) + ' 成交量 ' + (r.volHit ? '<' : '≥') + ' 90日中位數 ' + Z + '%（' + volTxt + '）</li>';
    h += '</ol></div>';
  });

  // 參考資訊：OAS（延遲一日，作為佐證而非即時判定）
  h += '<div class="rs-bond-oas">參考｜美國非投等債信用利差（OAS）' +
    (oas ? oas.value.toFixed(2) + '%，較前一日' + (oas.chg > 0 ? '走闊 +' : (oas.chg < 0 ? '收斂 −' : '持平 ')) + Math.abs(oas.chg).toFixed(2) + ' 個百分點｜資料截至 ' + oas.date + '（延遲約 1 個交易日）' : '資料暫缺') +
    (oas && usHit && oas.chg > 0 ? '　<b class="up">利差同步走闊，走弱訊號成立</b>' : '') + '</div>';

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
