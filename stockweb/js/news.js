// 股利總管 Web — 新聞情勢（RSS 收集彙整 + 產生 AI 分析 Prompt）
// 資料源：財經網站 RSS（經 GAS ?rss= 代理抓取解析，繞過 CORS）
// 過渡方案：先產生完整 Prompt 供手動貼到 AI 對話分析；日後接 API 時 Prompt 內容直接沿用

var NEWS_GAS_URL = 'https://script.google.com/macros/s/AKfycbz8j18olygkPUIsqXEUptyrt7XwDQWEwOcoz81nrLvHCE3HJrDindFnCZ4344o4QT8N1w/exec';

var NEWS_FEEDS = [
  { key: 'yahoo',    name: 'Yahoo股市', url: 'https://tw.stock.yahoo.com/rss?category=news' },
  { key: 'cnyes_tw', name: '鉅亨台股',  url: 'https://news.cnyes.com/rss/v1/news/category/tw_stock' },
  { key: 'cnyes_wd', name: '鉅亨國際',  url: 'https://news.cnyes.com/rss/v1/news/category/wd_stock' }
];
var NEWS_HOURS = 24; // 只彙整最近 N 小時

// 總經市場資料（補足新聞標題缺少的系統性風險判斷依據）
var MACRO_TICKERS = [
  { name: 'S&P 500',      sym: '^GSPC',     fmt: 0 },
  { name: 'Nasdaq',       sym: '^IXIC',     fmt: 0 },
  // 道瓊已移除（格線固定 5 欄，加 HYG 後需空出一格）：它與 S&P 500 講的是同一件事，
  // 移除後留下的 S&P 500 仍涵蓋同一個風險偏好因子。
  { name: '費城半導體',   sym: '^SOX',      fmt: 0 },
  { name: 'VIX 恐慌指數', sym: '^VIX',      fmt: 2 },
  { name: '美10年債殖利率', sym: '^TNX',    fmt: 3 },
  // 美國非投等債：持股是非投等債，這一格才是最直接的對照。實測（240 個交易日、前一交易日對齊）
  // HYG 對 00981B r=+0.270、00984D r=+0.354，比這排其他任何一格都高，而且是多元迴歸中
  // 唯一對這兩檔站得住的變數（t=+3.27、+2.57）。用 ETF 成交價而不是指數：
  // 指數是報價編製、有平滑落後（自我相關 +0.237、波動 0.201%），成交價 -0.162、0.317%。
  { name: '美非投等債 HYG', sym: 'HYG',     fmt: 2 },
  { name: '美元指數',     sym: 'DX-Y.NYB',  fmt: 2 },
  { name: '美元兌台幣',   sym: 'TWD=X',     fmt: 3 }
  // 日圓改用玉山牌告即期匯率（買入/賣出雙價，見 loadEsunFx），不再取 Yahoo 中間價
];

// ── 非投債警示門檻 ────────────────────────────────────────────────
// 只對 HYG 與美10年殖利率兩格亮燈，因為只有這兩項對非投債持股量得出關係。
// 門檻不是自訂的整數，是用近 2 年 499 個美股交易日的分布定位再四捨五入：
//   黃＝第 90 百分位（HYG 跌 0.375%、10Y 升 5.7bp），一年約 24 次
//   紅＝第 97.5 百分位（HYG 跌 0.635%、10Y 升 10.7bp），一年約 5～6 次
// 觸發後「下一個台股交易日」四檔（00981B/00984D/00988B/00989B）的實測結果，
// 對照無條件基準 平均 -0.011%、下跌比率 40.5%（n=640）：
//   HYG 跌 0.38%  n=48  平均 -0.140%  下跌 54%
//   HYG 跌 0.64%  n=12  平均 -0.078%  下跌 50%   ← 沒有比黃色更糟，紅色只代表罕見
//   10Y 升 6bp    n=47  平均 -0.134%  下跌 60%
//   10Y 升 11bp   n= 9  平均 -0.191%  下跌 88%   ← 最強，但 n 小、區間寬
var MACRO_ALERT = {
  'HYG':  { dir: -1, mode: 'pct',  warn: 0.38, alarm: 0.64, unit: '%',  dp: 2, word: '跌' },
  '^TNX': { dir: +1, mode: 'diff', warn: 6,    alarm: 11,   unit: 'bp', dp: 1, word: '升' }
};
var ALERT_FOR = '非投債';
var _twLastClose = null;   // 台股最後一個「已收盤」的交易日（ISO）

var _newsItems = []; // {source, title, link, time(Date)}
var _macroSnap = []; // {name, price, changePct, fmt}
var _nightFut = null; // 台指夜盤 {price, changePct, time}

// 抓單一 Yahoo 指數/匯率：取最新報價，並配對「正確的前一交易日收盤」當變化基準。
// 兩個基準陷阱都要避開：
//   ① chartPreviousClose 是區間起點（range=5d 時為 5 天前），拿它算會虛增漲跌幅。
//   ② 最新價（regularMarketPrice）與日K序列可能不同步：盤前時最新價已跨到新的一天，
//      但當日 bar 尚未產生，若固定取 closes[n-2] 當基準就會錯抓到「前前一日」。
// 故以報價時間與最後一根日K的日期比對，決定基準該取哪一根。
// range 用 1mo 不用 5d：警示要算「台股上次收盤以來的累計」，農曆年台股可連休 9 天，
// 這段期間美股會開 6～7 盤，5 天的日K 不夠回推基準。多抓的資料不影響原本的前收判定。
async function fetchYahooQuote(t) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t.sym) + '?interval=1d&range=1mo';
  var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
  var j = await r.json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(t.name + ' no data');
  var m = res.meta || {};
  var ts = res.timestamp || [];
  var rawCloses = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  // 保留與 timestamp 的對應關係，才能比對日期
  var bars = [];
  for (var i = 0; i < rawCloses.length; i++) {
    if (rawCloses[i] != null && ts[i] != null) bars.push({ t: ts[i], c: rawCloses[i] });
  }
  if (!bars.length) throw new Error(t.name + ' no bars');
  var n = bars.length;
  var price = (m.regularMarketPrice != null) ? m.regularMarketPrice : bars[n - 1].c;
  var asOf = (m.regularMarketTime != null) ? m.regularMarketTime * 1000 : bars[n - 1].t * 1000;
  var day = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
  var prev;
  if (n >= 2 && day(asOf) === day(bars[n - 1].t * 1000)) prev = bars[n - 2].c;  // 最新價仍屬最後一根日K當天
  else prev = bars[n - 1].c;                                                     // 最新價已跨日（盤前）
  var pct = (price != null && prev) ? (price - prev) / prev * 100 : null;
  // bars 供警示計算累計用（日期取美東當地日，與 Yahoo 的日K 標記一致）
  var days = bars.map(function (b) {
    return { d: new Date(b.t * 1000).toISOString().slice(0, 10), c: b.c };
  });
  return { name: t.name, sym: t.sym, price: price, changePct: pct, fmt: t.fmt, asOf: asOf, bars: days };
}

// 台股最後一個已收盤的交易日。盤中看這排指標時，基準要用「昨天的收盤」，
// 因為今天這一盤正在消化那些美股變動，拿今天當基準會把要提醒的東西算掉。
async function fetchTwLastClose() {
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=1mo';
    var j = await (await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url))).json();
    var res = j.chart.result[0], ts = res.timestamp || [];
    var cl = res.indicators.quote[0].close || [];
    var ds = [];
    for (var i = 0; i < ts.length; i++) {
      if (cl[i] != null) ds.push(new Date(ts[i] * 1000 + 8 * 3600000).toISOString().slice(0, 10));
    }
    var now = new Date(Date.now() + 8 * 3600000);
    var today = now.toISOString().slice(0, 10);
    var closed = now.getUTCHours() >= 14;           // 13:30 收盤，14:00 後視為已收
    for (var k = ds.length - 1; k >= 0; k--) {
      if (ds[k] < today || (ds[k] === today && closed)) return ds[k];
    }
  } catch (e) { console.warn('[twii]', e); }
  return null;
}

// 台股上次收盤之後、尚未被反映的美股累計變動。
// 基準是「台股上次收盤日之前」的最後一根美股日K：美股 D 盤收在台北 D+1 凌晨 4 點，
// 台股 D 日 13:30 就收了，所以台股 D 日的收盤只反映到美股 D-1 盤。
function _macroCum(bars, twLast, mode) {
  if (!bars || !bars.length || !twLast) return null;
  var base = null, last = null, n = 0;
  for (var i = 0; i < bars.length; i++) {
    if (bars[i].d < twLast) base = bars[i];
    else if (bars[i].c != null) { last = bars[i]; n++; }
  }
  if (!base || !last || !base.c) return null;
  return { n: n, from: base.d, to: last.d,
           v: mode === 'pct' ? (last.c / base.c - 1) * 100 : (last.c - base.c) * 100 };
}

// 回傳 {level:'warn'|'alarm', cum, cfg} 或 null
function _macroAlert(m, twLast) {
  var cfg = MACRO_ALERT[m.sym];
  if (!cfg) return null;
  var cum = _macroCum(m.bars, twLast, cfg.mode);
  if (!cum) return null;
  var mag = cum.v * cfg.dir;                        // 轉成「往不利方向的幅度」，正值才算數
  if (mag >= cfg.alarm) return { level: 'alarm', cum: cum, mag: mag, cfg: cfg };
  if (mag >= cfg.warn) return { level: 'warn', cum: cum, mag: mag, cfg: cfg };
  return null;
}

// 台指夜盤（近月期貨快照，含夜盤最新價）— 經本機 Shioaji
async function fetchNightFutures() {
  try {
    var r = await fetch('/api/v1/data/snapshots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contracts: [{ security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }] })
    });
    if (!r.ok) return null;
    var arr = await r.json();
    var s = arr && arr[0];
    if (!s || s.close == null) return null;
    return { price: s.close, changePct: s.change_rate, time: (s.datetime || '').slice(11, 16) };
  } catch (e) { return null; }
}

// ── 玉山銀行牌告匯率（實際換匯用得到的價格，非中間價）──
// 來源頁內嵌 schema.org 的 ExchangeRateSpecification（JSON-LD），非一般 HTML 表格，
// 改版時較不易失效。以該標記切塊後逐塊解析，避免正則跨塊誤配或漏抓。
// 牌告一天變動多次 → 快取 10 分鐘即可，不必每次進頁重抓。
var ESUN_URL = 'https://www.esunbank.com/zh-tw/personal/deposit/rate/forex/foreign-exchange-rates';
var _esun = null;        // {at, rates:{幣別:{spotBuy, spotSell, cashBuy, cashSell}}}
var _esunTs = 0;

async function loadEsunFx(force) {
  if (!force && _esun && Date.now() - _esunTs < 600000) return _esun;
  try {
    var r = await fetch(NEWS_GAS_URL + '?urltext=' + encodeURIComponent(ESUN_URL));
    var t = await r.text();
    if (t.charAt(0) === '{') return _esun;                 // GAS 端錯誤（配額等）→ 沿用舊值
    var parts = t.split('"@type":"ExchangeRateSpecification"');
    var rates = {}, at = null;
    for (var i = 1; i < parts.length; i++) {
      var seg = parts[i];
      var nm = seg.match(/"name":"([^"]+)"/);
      var pr = seg.match(/"price":"([\d.]+)"/);
      if (!nm || !pr) continue;
      var vf = seg.match(/"validFrom":"([^"]+)"/);
      if (vf && !at) at = vf[1];
      var p = nm[1].split(/\s+/);                          // 例：日圓 即期匯率 銀行買入
      if (p.length < 3) continue;
      var cur = p[0], kind = p[1], side = p[2];
      var key = (kind.indexOf('即期') >= 0 ? 'spot' : 'cash') + (side.indexOf('買入') >= 0 ? 'Buy' : 'Sell');
      (rates[cur] = rates[cur] || {})[key] = +pr[1];
    }
    if (Object.keys(rates).length) { _esun = { at: at, rates: rates }; _esunTs = Date.now(); }
  } catch (e) { console.warn('[esun fx]', e); }
  return _esun;
}

// ── 美國總經資料（FRED 官方 CSV，經 GAS ?urltext= 代理；與加減碼報告的 OAS 同一條管道）──
// 每項標自己的資料月份：非農／失業率由 BLS 月初發布，CPI 約月中發布，兩者常差一個月，
// 不可混為一談。FRED 轉載 BLS，通常在官方發布當天或隔天更新，不適合搶即時數字。
// 月頻資料一天最多變一次 → 每日快取，避免重複消耗 GAS 配額。
var FRED_LS = 'news_fred_v1';
var FRED_SERIES = [
  { id: 'PAYEMS',   name: '非農就業', mode: 'mom',  dp: 1, unit: '萬', scale: 0.1 }, // 千人 → 萬人
  { id: 'UNRATE',   name: '失業率',   mode: 'level', dp: 1, unit: '%' },
  { id: 'CPIAUCSL', name: 'CPI 年增', mode: 'yoy',  dp: 2, unit: '%' },
  { id: 'CPILFESL', name: '核心 CPI', mode: 'yoy',  dp: 2, unit: '%' }
];
var _fredSnap = [];   // {name, month, value, prev, dp, unit}

async function _fredSeries(s) {
  try {
    var url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + s.id;
    var r = await fetch(NEWS_GAS_URL + '?urltext=' + encodeURIComponent(url));
    var text = await r.text();
    if (text.charAt(0) === '{') return null;          // GAS 端錯誤（配額等）會回 JSON
    var lines = text.trim().split(/\r?\n/), pts = [];
    for (var i = 1; i < lines.length; i++) {
      var p = lines[i].split(','), v = parseFloat(p[1]);
      if (!isNaN(v)) pts.push({ d: (p[0] || '').trim(), v: v });
    }
    var n = pts.length;
    if (n < 14) return null;                          // yoy 需回看 13 期
    var cur, prev;
    if (s.mode === 'mom') {                           // 月變化（非農新增就業）
      cur = pts[n - 1].v - pts[n - 2].v;
      prev = pts[n - 2].v - pts[n - 3].v;
    } else if (s.mode === 'yoy') {                    // 年增率
      cur = (pts[n - 1].v - pts[n - 13].v) / pts[n - 13].v * 100;
      prev = (pts[n - 2].v - pts[n - 14].v) / pts[n - 14].v * 100;
    } else {                                          // 直接取值（失業率）
      cur = pts[n - 1].v; prev = pts[n - 2].v;
    }
    if (s.scale) { cur *= s.scale; prev *= s.scale; }
    return { name: s.name, month: pts[n - 1].d.slice(0, 7).replace('-', '/'),
             value: cur, prev: prev, dp: s.dp, unit: s.unit };
  } catch (e) { return null; }
}

async function loadFred() {
  var day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  try {
    var c = JSON.parse(localStorage.getItem(FRED_LS) || 'null');
    if (c && c.day === day && c.rows && c.rows.length) { _fredSnap = c.rows; renderFredBar(); return; }
  } catch (e) {}
  var got = await Promise.all(FRED_SERIES.map(_fredSeries));
  _fredSnap = got.filter(Boolean);
  if (_fredSnap.length) {
    try { localStorage.setItem(FRED_LS, JSON.stringify({ day: day, rows: _fredSnap })); } catch (e) {}
  }
  renderFredBar();
}

function renderFredBar() {
  var el = document.getElementById('fred-bar');
  if (!el) return;
  if (!_fredSnap.length) { el.innerHTML = ''; return; }
  var sign = function (v, dp) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dp); };
  var rows = _fredSnap.map(function (m) {
    // 非農用帶正負號的增減表示，其餘為水準值；前值一律附上供對照
    var isDelta = m.name === '非農就業';
    var val = (isDelta ? sign(m.value, m.dp) : m.value.toFixed(m.dp)) + m.unit;
    var pv = (isDelta ? sign(m.prev, m.dp) : m.prev.toFixed(m.dp)) + m.unit;
    // 相對前值的方向（與市場資料列同一套）：上升▲紅、下降▼綠、持平白且不加箭頭。
    // 純粹標示數值走向，不含好壞判斷（失業率上升同樣顯示紅）。
    var d = m.value - m.prev;
    var cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
    var arrow = d > 0 ? '▲' : (d < 0 ? '▼' : '');
    return '<div class="fred-cell"><span class="fred-name">' + m.name +
      '<span class="fred-month">' + m.month + '</span></span>' +
      '<span class="fred-val ' + cls + '">' + arrow + val + '</span>' +
      '<span class="fred-prev">前值 ' + pv + '</span></div>';
  });
  el.innerHTML = '<div class="fred-title">美國總經（FRED，各項資料月份不同）</div>' +
    '<div class="fred-row">' + rows.join('') + '</div>';
}

// ── 訊號一致性檢查 ──
// 只做「方向比對」：陳述哪兩項資料彼此同向或相反，不推論股債會漲會跌。
// 為何不給趨勢結論：同一組資料在軟著陸與衰退情境下市場解讀相反，程式無從分辨，
// 壓成單一紅黃綠燈會把不確定性藏起來，且背離本身才是最有資訊量的部分。
// 資料全部取自既有來源（FRED 月頻 ＋ _rsYahoo 多日 ＋ OAS），不新增 API。
var _consist = [];   // {level:'ok'|'diverge'|'na', title, detail}

async function loadConsistency() {
  if (typeof _rsYahoo !== 'function') return;
  var got = await Promise.all([
    _rsYahoo('^TNX'), _rsYahoo('^GSPC'), _rsYahoo('^VIX'),
    _rsYahoo('HYG'), _rsYahoo('JNK'),
    (typeof _rsOAS === 'function') ? _rsOAS() : null
  ]);
  var tnx = got[0], spx = got[1], vix = got[2], hyg = got[3], jnk = got[4], oas = got[5];
  var fred = {};
  _fredSnap.forEach(function (m) { fred[m.name] = m; });
  var cpi = fred['CPI 年增'], nfp = fred['非農就業'];

  var rows = [];
  var pp = function (v, dp) { return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(dp == null ? 3 : dp); };
  var pct = function (v) { return v == null ? '—' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%'; };

  // 1. 通膨方向 vs 長天期利率方向
  if (cpi && tnx && tnx.abs20 != null) {
    var cpiDown = cpi.value < cpi.prev, yUp = tnx.abs20 > 0;
    var same = (cpiDown && !yUp) || (!cpiDown && yUp);   // 通膨降配殖利率降＝同向
    rows.push({
      level: same ? 'ok' : 'diverge',
      title: '通膨與長天期利率',
      detail: 'CPI 年增 ' + cpi.value.toFixed(2) + '%（前值 ' + cpi.prev.toFixed(2) + '%，' + (cpiDown ? '下降' : '上升') + '）' +
        '　美10年債殖利率近20日 ' + pp(tnx.abs20) + 'pp（' + (yUp ? '上升' : '下降') + '）' +
        (same ? '' : '　兩者方向相反')
    });
  }
  // 2. 就業與通膨對降息預期的推力方向
  if (cpi && nfp) {
    var nfpUp = nfp.value > nfp.prev, cpiDown2 = cpi.value < cpi.prev;
    var conflict = nfpUp && cpiDown2;    // 就業轉強（延後降息）配通膨降溫（支持降息）
    rows.push({
      level: conflict ? 'diverge' : 'ok',
      title: '就業與通膨',
      detail: '非農 ' + (nfp.value > 0 ? '+' : '') + nfp.value.toFixed(1) + '萬（前值 ' +
        (nfp.prev > 0 ? '+' : '') + nfp.prev.toFixed(1) + '萬，' + (nfpUp ? '回升' : '走弱') + '）' +
        '　CPI 年增 ' + (cpiDown2 ? '下降' : '上升') +
        (conflict ? '　兩者對降息時點的指向相反' : '')
    });
  }
  // 3. 股市與波動率（常態為反向；同向較少見）
  if (spx && vix && spx.pct20 != null && vix.pct20 != null) {
    var sUp = spx.pct20 > 0, vUp = vix.pct20 > 0;
    rows.push({
      level: (sUp !== vUp) ? 'ok' : 'diverge',
      title: '股市與波動率',
      detail: 'S&P 500 近20日 ' + pct(spx.pct20) + '　VIX 近20日 ' + pct(vix.pct20) +
        ((sUp === vUp) ? '　兩者同向（常態為反向）' : '')
    });
  }
  // 4. 信用債價格 vs 信用利差：價格走弱但利差未擴大，代表壓力來自利率而非信用
  var bondPx = (hyg && hyg.pct20 != null) ? hyg.pct20 : (jnk && jnk.pct20 != null ? jnk.pct20 : null);
  if (bondPx != null && oas && oas.d20 != null) {
    var pxDown = bondPx < 0, oasWide = oas.d20 > 0;
    var mismatch = pxDown && !oasWide;
    rows.push({
      level: mismatch ? 'diverge' : 'ok',
      title: '非投等債價格與信用利差',
      detail: 'HYG 近20日 ' + pct(hyg && hyg.pct20) + '／JNK ' + pct(jnk && jnk.pct20) +
        '　OAS ' + oas.value.toFixed(2) + '%，近20日 ' + pp(oas.d20, 2) + 'pp' +
        (mismatch ? '　價格下跌但利差未擴大' : '')
    });
  }
  // 5. 股市與信用債（風險偏好的兩個面向，常態同向）
  if (spx && spx.pct20 != null && hyg && hyg.pct20 != null) {
    var same5 = (spx.pct20 > 0) === (hyg.pct20 > 0);
    rows.push({
      level: same5 ? 'ok' : 'diverge',
      title: '股市與信用債',
      detail: 'S&P 500 近20日 ' + pct(spx.pct20) + '　HYG 近20日 ' + pct(hyg.pct20) +
        (same5 ? '' : '　兩者方向相反')
    });
  }
  _consist = rows;
  renderConsistency();
}

function renderConsistency() {
  var el = document.getElementById('consist-bar');
  if (!el) return;
  if (!_consist.length) { el.innerHTML = ''; return; }
  var n = _consist.filter(function (r) { return r.level === 'diverge'; }).length;
  var h = '<div class="fred-title">訊號一致性　' +
    (n ? '<b class="cs-n">' + n + ' 項方向不一致</b>' : '各項方向一致') + '</div>';
  _consist.forEach(function (r) {
    h += '<div class="cs-row"><span class="cs-dot">' + (r.level === 'diverge' ? '🔶' : '🟢') + '</span>' +
      '<span class="cs-title">' + r.title + '</span>' +
      '<span class="cs-detail">' + r.detail + '</span></div>';
  });
  h += '<div class="cs-note"><dl>' +
    '<dt>比對內容</dt><dd>只看各項資料的方向是否一致，不推論股債後續走勢。</dd>' +
    '<dt>方向不一致</dt><dd>訊號互相牴觸，是需要進一步查證的地方，本身不是買賣訊號。</dd>' +
    '</dl></div>';
  el.innerHTML = h;
}

async function loadMacro() {
  var results = await Promise.allSettled(MACRO_TICKERS.map(fetchYahooQuote).concat([fetchTwLastClose()]));
  var twRes = results.pop();
  _twLastClose = (twRes.status === 'fulfilled') ? twRes.value : null;
  _macroSnap = results.map(function (res, i) {
    return res.status === 'fulfilled' ? res.value
      : { name: MACRO_TICKERS[i].name, sym: MACRO_TICKERS[i].sym, price: null, changePct: null, fmt: MACRO_TICKERS[i].fmt };
  });
  _macroSnap.forEach(function (m) { m.alert = _macroAlert(m, _twLastClose); });
  _nightFut = await fetchNightFutures();
  renderMacroBar();
  // 玉山牌告匯率（10 分鐘快取）非阻塞補上，回來後重繪
  loadEsunFx().then(function () { renderMacroBar(); });
}

function _fmtNum(v, dp) { return v == null ? '—' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
function _chgTxt(pct) {
  if (pct == null) return '';
  var arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '');
  return arrow + Math.abs(pct).toFixed(2) + '%';
}
function _chgCls(pct) { return pct == null ? 'flat' : (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat')); }

// 報價時間（台北）與距今多久：美股收盤後這些數字會停在收盤價，標明時間才不會誤以為是即時
function _asOfTxt(ms) {
  if (!ms) return '';
  var d = new Date(ms + 8 * 3600000);
  return ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + d.getUTCDate()).slice(-2) + ' ' +
    ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
}
function _agoTxt(ms) {
  if (!ms) return '';
  var mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return mins + ' 分鐘前';
  var h = Math.floor(mins / 60);
  if (h < 24) return h + ' 小時前';
  return Math.floor(h / 24) + ' 天前';
}

function renderMacroBar() {
  var el = document.getElementById('macro-bar');
  if (!el) return;
  var cells = _macroSnap.map(function (m) {
    var tip = m.asOf ? '報價時間 ' + _asOfTxt(m.asOf) + '（台北）　' + _agoTxt(m.asOf) : '';
    var icon = '', tag = '';
    if (m.alert) {
      var a = m.alert, c = a.cfg;
      icon = '<span class="macro-warn ' + a.level + '">⚠</span>';
      tag = '<span class="macro-dim"> 對' + ALERT_FOR + '</span>';
      tip = (a.level === 'alarm' ? '紅色警告' : '黃色警示') + '（對' + ALERT_FOR + '）：' +
        '台股 ' + a.cum.from + ' 收盤後至今，' + c.word + ' ' + a.mag.toFixed(c.dp) + ' ' + c.unit +
        '，達' + (a.level === 'alarm' ? '紅色' : '黃色') + '門檻 ' + (a.level === 'alarm' ? c.alarm : c.warn) + ' ' + c.unit +
        '。累計 ' + a.cum.n + ' 個美股交易日（至 ' + a.cum.to + '）。' +
        '　門檻取近 2 年美股日變動的第 ' + (a.level === 'alarm' ? '97.5' : '90') + ' 百分位。' +
        (tip ? '\n' + tip : '');
    }
    // 台股連假後，欄位上的當日漲跌只是最後一盤，台股要一次吃掉好幾盤。
    // 兩者不同時把累計也寫出來，否則會看不懂為什麼 -0.41% 會亮燈。
    var cumTxt = '';
    if (MACRO_ALERT[m.sym]) {
      var cc = _macroCum(m.bars, _twLastClose, MACRO_ALERT[m.sym].mode);
      if (cc && cc.n > 1) {
        cumTxt = '<span class="macro-dim"> 累計' + (cc.v > 0 ? '▲' : '▼') +
          Math.abs(cc.v).toFixed(MACRO_ALERT[m.sym].mode === 'pct' ? 2 : 1) +
          (MACRO_ALERT[m.sym].mode === 'pct' ? '%' : 'bp') + '</span>';
      }
    }
    return '<div class="macro-cell' + (m.alert ? ' macro-hit' : '') + '"' +
      (tip ? ' title="' + tip.replace(/"/g, '&quot;') + '"' : '') +
      '>' + icon + '<span class="macro-name">' + m.name + tag + '</span>' +
      '<span class="macro-price">' + _fmtNum(m.price, m.fmt) + '</span>' +
      '<span class="macro-chg ' + _chgCls(m.changePct) + '">' + (_chgTxt(m.changePct) || '—') + cumTxt + '</span></div>';
  });
  // 玉山日圓即期匯率：換匯實際成交的價格（買入＝銀行跟你買，賣出＝銀行賣你）。
  // Yahoo 的 JPYTWD=X 是國際中間價，換匯時拿不到，故另列一格供實際判斷。
  if (_esun && _esun.rates && _esun.rates['日圓']) {
    var jp = _esun.rates['日圓'];
    cells.push('<div class="macro-cell macro-fx" title="玉山銀行牌告即期匯率　掛牌時間 ' +
      (_esun.at ? _esun.at.slice(5, 16).replace('T', ' ') : '—') +
      '　銀行買入＝你賣日圓可換得的台幣；銀行賣出＝你買日圓要付的台幣">' +
      '<span class="macro-name">日圓即期<span class="macro-dim"> 玉山</span></span>' +
      '<span class="macro-fx-pair"><span class="fx-lb">買入</span><span class="fx-v">' +
      (jp.spotBuy != null ? jp.spotBuy.toFixed(4) : '—') + '</span>' +
      '<span class="fx-lb">賣出</span><span class="fx-v">' +
      (jp.spotSell != null ? jp.spotSell.toFixed(4) : '—') + '</span></span></div>');
  }
  if (_nightFut) {
    cells.push('<div class="macro-cell"><span class="macro-name">台指夜盤 ' + (_nightFut.time || '') + '</span>' +
      '<span class="macro-price">' + _fmtNum(_nightFut.price, 0) + '</span>' +
      '<span class="macro-chg ' + _chgCls(_nightFut.changePct) + '">' + (_chgTxt(_nightFut.changePct) || '—') + '</span></div>');
  }
  // 整列標報價時間「範圍」而非只標最新：匯率 24 小時交易可能是 1 分鐘前，
  // 美股收盤後的指數卻是數小時前的收盤價，只寫最新會讓人誤以為全部都是即時。
  var newest = 0, oldest = Infinity;
  _macroSnap.forEach(function (m) {
    if (!m.asOf) return;
    if (m.asOf > newest) newest = m.asOf;
    if (m.asOf < oldest) oldest = m.asOf;
  });
  var head = '';
  if (newest) {
    var same = (newest - oldest) < 120000;   // 相差 2 分鐘內視為同一時點
    head = '<div class="macro-asof">報價時間 ' +
      (same ? _asOfTxt(newest) + '（台北）　<b>' + _agoTxt(newest) + '</b>'
            : _asOfTxt(oldest) + ' ～ ' + _asOfTxt(newest) + '（台北）　最舊 <b>' + _agoTxt(oldest) +
              '</b>、最新 <b>' + _agoTxt(newest) + '</b>') +
      '　<span class="macro-dim">美股收盤後為收盤價；滑鼠移到單項可看該項時間</span></div>';
  }
  // 警示說明：亮燈了才寫，平常不佔版面
  var hits = _macroSnap.filter(function (m) { return m.alert; });
  var foot = '';
  if (hits.length) {
    foot = '<div class="macro-alert-note">' +
      hits.map(function (m) {
        var a = m.alert, c = a.cfg;
        return '<span class="macro-warn ' + a.level + '">⚠</span>' + m.name + ' ' +
          c.word + ' ' + a.mag.toFixed(c.dp) + ' ' + c.unit +
          '（' + (a.level === 'alarm' ? '紅色警告' : '黃色警示') + '門檻 ' +
          (a.level === 'alarm' ? c.alarm : c.warn) + ' ' + c.unit + '）';
      }).join('　') +
      // 警示本文一直顯示，只有下面這段說明收合
      '<div class="cs-note"><dl>' +
      '<dt>適用對象</dt><dd>' + ALERT_FOR + '持股，其他類型不適用。</dd>' +
      '<dt>幅度</dt><dd>台股 ' + (_twLastClose || '—') + ' 收盤後<b>累計</b>，不是單日。</dd>' +
      '<dt>門檻</dt><dd>近 2 年美股日變動的第 90（黃）與 97.5（紅）百分位，黃色一年約 24 次、紅色約 5～6 次。</dd>' +
      '<dt>意義</dt><dd>「該留意」不是買賣訊號。觸發後隔一個台股交易日，四檔非投債平均 -0.13% ～ -0.19%，' +
      '無條件基準 -0.01%。</dd>' +
      '</dl></div></div>';
  }
  el.innerHTML = head + '<div class="macro-row">' + cells.join('') + '</div>' + foot;
}

async function fetchFeed(feed) {
  var r = await fetch(NEWS_GAS_URL + '?rss=' + encodeURIComponent(feed.url));
  if (!r.ok) throw new Error(feed.name + ' HTTP ' + r.status);
  var j = await r.json();
  if (j.stat !== 'OK') throw new Error(feed.name + ' ' + (j.error || j.stat));
  return (j.items || []).map(function (it) {
    return { source: feed.name, title: (it.title || '').trim(), link: it.link || '', time: new Date(it.pubDate) };
  });
}

async function loadNews() {
  var listEl = document.getElementById('news-list');
  var infoEl = document.getElementById('news-info');
  listEl.innerHTML = '<div class="modal-loading">抓取 RSS 中…</div>';

  loadMacro(); // 市場資料平行抓取，不阻塞新聞
  loadFred().then(loadConsistency);  // 總經（每日快取）→ 完成後做訊號一致性比對，皆不阻塞新聞

  var results = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
  var items = [], errs = [];
  results.forEach(function (res, i) {
    if (res.status === 'fulfilled') items = items.concat(res.value);
    else errs.push(NEWS_FEEDS[i].name + '：' + res.reason.message);
  });

  var cutoff = Date.now() - NEWS_HOURS * 3600000;
  items = items.filter(function (it) { return it.title && !isNaN(it.time) && it.time.getTime() >= cutoff; });
  items.sort(function (a, b) { return b.time - a.time; });
  _newsItems = items;

  infoEl.textContent = '近 ' + NEWS_HOURS + ' 小時共 ' + items.length + ' 則' +
    (errs.length ? '｜部分來源失敗：' + errs.join('；') : '');

  if (!items.length) {
    listEl.innerHTML = '<div class="modal-loading">' + (errs.length ? errs.join('<br>') : '近 ' + NEWS_HOURS + ' 小時無新聞') + '</div>';
    return;
  }
  listEl.innerHTML = items.map(function (it) {
    var hm = String(it.time.getHours()).padStart(2, '0') + ':' + String(it.time.getMinutes()).padStart(2, '0');
    var md = (it.time.getMonth() + 1) + '/' + it.time.getDate();
    return '<div class="news-row">' +
      '<span class="news-time">' + md + ' ' + hm + '</span>' +
      '<span class="news-src">' + it.source + '</span>' +
      (it.link ? '<a class="news-title" href="' + it.link + '" target="_blank" rel="noopener">' : '<span class="news-title">') +
      it.title + (it.link ? '</a>' : '</span>') +
    '</div>';
  }).join('');
}

// ── 取得持股清單（供 Prompt 脈絡）：券商庫存優先，名稱補自 Firestore ──
async function newsHoldingsList() {
  var names = {};
  try {
    var pf = await loadPortfolioFallback();
    pf.forEach(function (s) { if (s.name) names[String(s.code)] = s.name; });
  } catch (e) {}
  var positions = _positions;
  if (!positions || !positions.length) {
    try { positions = await fetchBrokerPositions(); } catch (e) { positions = []; }
  }
  return (positions || []).map(function (p) {
    var code = String(p.code);
    var nm = (_contracts[code] && _contracts[code].name) || names[code] || '';
    return code + (nm ? ' ' + nm : '');
  });
}

// ── 產生 AI 分析 Prompt ──
async function buildNewsPrompt() {
  var now = new Date();
  var holdings = await newsHoldingsList();

  // 市場資料快照（若尚未載入則現抓）
  if (!_macroSnap.length) { try { await loadMacro(); } catch (e) {} }
  if (!_esun) { try { await loadEsunFx(); } catch (e) {} }
  if (!_fredSnap.length) { try { await loadFred(); } catch (e) {} }
  if (!_consist.length) { try { await loadConsistency(); } catch (e) {} }
  // 持股技術面趨勢（若尚未載入則靜默計算）
  var trendTxt = '';
  if (typeof ensureTrend === 'function') {
    try { await ensureTrend(); trendTxt = trendSummaryForPrompt(); } catch (e) {}
  }
  // 籌碼/淨值面（L2 折溢價 + L3 法人籌碼）
  var sigTxt = '';
  if (typeof ensureSignals === 'function') {
    try { await ensureSignals(); sigTxt = signalsSummaryForPrompt(); } catch (e) {}
  }
  var macroTxt = _macroSnap.map(function (m) {
    var s = '- ' + m.name + '：' + _fmtNum(m.price, m.fmt) + '（' + (m.changePct == null ? 'N/A' : (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2) + '%') + '）';
    if (m.alert) {
      var a = m.alert, c = a.cfg;
      s += '　【' + (a.level === 'alarm' ? '紅色警告' : '黃色警示') + '｜對' + ALERT_FOR + '】台股 ' +
        a.cum.from + ' 收盤後累計' + c.word + ' ' + a.mag.toFixed(c.dp) + ' ' + c.unit +
        '（門檻 ' + (a.level === 'alarm' ? c.alarm : c.warn) + ' ' + c.unit + '，近 2 年第 ' +
        (a.level === 'alarm' ? '97.5' : '90') + ' 百分位）';
    }
    return s;
  }).join('\n');
  if (_macroSnap.some(function (m) { return m.alert; })) {
    macroTxt += '\n（警示只針對非投等債 ETF，門檻由歷史分布定位；觸發後隔一個台股交易日，' +
      '四檔非投債平均 -0.13% ～ -0.19%，無條件基準 -0.01%。屬於「該留意」的量級，不是買賣訊號。）';
  }
  if (_nightFut) {
    macroTxt += '\n- 台指期近月夜盤（' + (_nightFut.time || '') + '）：' + _fmtNum(_nightFut.price, 0) +
      '（' + (_nightFut.changePct >= 0 ? '+' : '') + _nightFut.changePct.toFixed(2) + '%）';
  }
  // 日圓走玉山牌告（買賣雙價；牌告無前日基準，故不附漲跌幅）
  if (_esun && _esun.rates && _esun.rates['日圓']) {
    var _jp = _esun.rates['日圓'];
    macroTxt += '\n- 日圓兌台幣（玉山牌告即期，掛牌 ' + (_esun.at ? _esun.at.slice(0, 16).replace('T', ' ') : '—') +
      '）：銀行買入 ' + (_jp.spotBuy != null ? _jp.spotBuy.toFixed(4) : '—') +
      '／銀行賣出 ' + (_jp.spotSell != null ? _jp.spotSell.toFixed(4) : '—') + '（牌告價，非中間價）';
  }

  // 美國總經：月頻資料，各項資料月份不同，明確標註以免 AI 誤判為同期
  var fredTxt = _fredSnap.map(function (m) {
    var sg = function (v) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(m.dp) + m.unit; };
    var isDelta = m.name === '非農就業';
    return '- ' + m.name + '（資料月份 ' + m.month + '）：' +
      (isDelta ? sg(m.value) : m.value.toFixed(m.dp) + m.unit) +
      '，前值 ' + (isDelta ? sg(m.prev) : m.prev.toFixed(m.dp) + m.unit);
  }).join('\n');

  // 一致性檢查：逐條標明「方向一致／不一致」，讓 AI 看得到推理素材而非結論
  var consistTxt = _consist.map(function (r) {
    return '- [' + (r.level === 'diverge' ? '方向不一致' : '方向一致') + '] ' + r.title + '：' + r.detail;
  }).join('\n');

  var byQ = {};
  _newsItems.forEach(function (it) {
    (byQ[it.source] = byQ[it.source] || []).push(it);
  });
  var newsTxt = Object.keys(byQ).map(function (src) {
    return '【' + src + '】\n' + byQ[src].map(function (it) {
      var hm = String(it.time.getHours()).padStart(2, '0') + ':' + String(it.time.getMinutes()).padStart(2, '0');
      return '- (' + (it.time.getMonth() + 1) + '/' + it.time.getDate() + ' ' + hm + ') ' + it.title;
    }).join('\n');
  }).join('\n\n');

  return '你是一位協助退休投資人的財經分析助手。我的投資策略：以台股 ETF 領息為主、長期持有，' +
    '股息再投入時偏好低接，最需要避開的是「系統性風險下的錯誤加碼」。\n\n' +
    '今天是 ' + now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate() +
    '。以下提供三類資訊：(A) 即時市場資料快照、(B) 我的持股清單、(C) 最近 ' + NEWS_HOURS + ' 小時財經新聞標題。' +
    '請優先依據 (A) 的量化資料判斷系統性風險（美股走勢、VIX 恐慌指數、美債殖利率、美國非投等債 HYG、美元指數、台指夜盤、匯率），' +
    '新聞標題作為輔助佐證。\n\n' +
    '【評估規則】\n' +
    '1. 拒絕假精確：所有評分不要只給單一分類（高/中/低）。改以「點估計＋合理區間」表達，區間寬度反映你的不確定性；' +
    '關鍵風險改用機率＋不確定帶。註：你不是抽樣統計量，此區間是主觀不確定範圍、非統計信賴區間，據實標示即可。\n' +
    '2. 主題不得過度外推到個別 ETF：任何產業題材（如 HBM、AI、記憶體）只能連結到「確實有對應成分股權重」的持股。' +
    '若不確定該 ETF 對此題材的實際權重曝險，須寫「對○○供應鏈整體偏向X，傳導到本 ETF 的力道取決於實際持股權重」，' +
    '不可直接斷言為某檔 ETF 的結構性利多/利空。\n' +
    '3. 利率、匯率等指標須拆兩維度判讀：「絕對水位」與「當日變化率」分開講，不可用單日變化率掩蓋絕對水位' +
    '（例：美10年債 4.5% 當日 +0.66%，水位屬近年區間中段但仍偏高，變化率則為當日走高，兩者分述）。\n' +
    '4. 每個評級/風險都要附一句依據（綁回具體資料），不能空給評級。\n' +
    '5. (A) 裡的指標互相重疊，不可當成多個獨立證據累加。實測近 240 個交易日的日變動相關：' +
    'S&P 500 與 Nasdaq +0.96、與 VIX −0.81、與費城半導體 +0.73、與 HYG +0.68，' +
    '這五格講的是同一件事（風險偏好）；美10年殖利率與 S&P 500 只有 −0.32、與費城半導體 −0.15，' +
    '才算獨立的第二個因子。「美股跌、VIX 漲、HYG 跌」是一個訊號，不是三個。\n\n' +
    '「只回傳」以下格式的 JSON（不要其他文字）：\n\n' +
    '```json\n{\n' +
    '  "macro_score": 0,            // 點估計，-5(系統性風險極高) ~ +5(樂觀)\n' +
    '  "macro_score_range": [0, 0], // 合理區間 [下限, 上限]，反映不確定性\n' +
    '  "systemic_risk_prob": "",    // 今日系統性風險機率＋不確定帶，如 "15% (5~30%)"\n' +
    '  "confidence": "",            // 對本次評估的整體信心：高/中高/中/低\n' +
    '  "us_market": "",             // 隔夜美股與國際情勢一句話摘要\n' +
    '  "rates_fx": "",              // 利率/匯率：分述絕對水位與當日變化率\n' +
    '  "sector_risks": {},          // 各產業風險，值為物件 {"level":"中","basis":"依據一句話"}\n' +
    '  "per_holding_notes": {},     // 個別持股注意事項（僅列有事件者）；題材須對應實際持股權重，權重不明時明說\n' +
    '  "veto": false,               // true=偵測到系統性風險，今日應凍結所有加碼\n' +
    '  "reasons": []                // 主要判斷依據，2~4 條，每條一句話\n' +
    '}\n```\n\n' +
    '## (A) 即時市場資料快照\n' + (macroTxt || '（暫無）') + '\n\n' +
    (consistTxt ? '## (A3) 訊號一致性（各項資料的方向比對）\n' +
      '※ 這是機械式方向比對，非趨勢預測。標示「方向不一致」處代表訊號互相牴觸，請在分析中說明可能原因，不要直接當作買賣訊號。\n' +
      consistTxt + '\n\n' : '') +
    (fredTxt ? '## (A2) 美國總經資料（月頻，FRED 轉載 BLS）\n' +
      '※ 各項資料月份不同：非農／失業率由 BLS 月初發布，CPI 約月中發布，常差一個月，請勿當作同期資料比較。\n' +
      fredTxt + '\n\n' : '') +
    (function () {
      var sec = 'C'.charCodeAt(0);
      var out = '## (B) 我的持股\n' + holdings.join('、') + '\n\n';
      if (trendTxt) { out += '## (' + String.fromCharCode(sec++) + ') 持股技術面趨勢（自算日 K：強弱／均線排列／52週位置／期間報酬）\n' + trendTxt + '\n\n'; }
      if (sigTxt) { out += '## (' + String.fromCharCode(sec++) + ') 籌碼/淨值面（隔夜美股預估開盤：純美股 ETF 以成分股隔夜漲跌×匯率推估今日開盤方向，前晚美股大跌通常隔日必跌；ADR 隔夜偏向：台股成分股的美股 ADR 隔夜漲跌，與台股高連動；L2 官方折溢價：折價=可能錯殺、溢價=過熱；L3 成分股法人籌碼分數±10）\n' +
        '※ 重要：法人籌碼分數僅來自 TWSE T86 台股法人買賣，只涵蓋「有台股法人資料的成分股」（覆蓋率標於各檔後）。' +
        '外資股、債券成分股本來就無此資料，覆蓋率無法達 100%。覆蓋率低於約 60% 時，該分數只代表 ETF 內的台股部位，' +
        '請勿外推成整檔 ETF 的籌碼結論，也不要為了「補到 100%」而用其他資料源硬湊——那會導致訊號失真反轉。\n' +
        sigTxt + '\n\n'; }
      out += '## (' + String.fromCharCode(sec) + ') 近 ' + NEWS_HOURS + ' 小時新聞標題（' + _newsItems.length + ' 則）\n' + newsTxt + '\n';
      return out;
    })();
}

async function showNewsPrompt() {
  if (!_newsItems.length) { alert('尚無新聞資料，請先重新整理'); return; }
  var modal = document.getElementById('detail-modal');
  var body = document.getElementById('detail-body');
  var title = document.getElementById('detail-title');
  title.textContent = 'AI 分析 Prompt（貼到 AI 對話使用）';
  body.innerHTML = '<div class="modal-loading">產生中…</div>';
  modal.style.display = 'flex';
  var prompt = await buildNewsPrompt();
  body.innerHTML =
    '<div style="display:flex;gap:10px;margin-bottom:10px">' +
      '<button class="btn-query" onclick="copyNewsPrompt()">📋 複製全文</button>' +
      '<span id="news-copy-msg" style="font-size:13px;color:var(--text2);align-self:center"></span>' +
    '</div>' +
    '<textarea id="news-prompt-text" class="news-prompt-ta" readonly></textarea>';
  document.getElementById('news-prompt-text').value = prompt;
}

async function copyNewsPrompt() {
  var ta = document.getElementById('news-prompt-text');
  var msg = document.getElementById('news-copy-msg');
  try {
    await navigator.clipboard.writeText(ta.value);
    msg.textContent = '已複製 ✓';
  } catch (e) {
    ta.select(); document.execCommand('copy');
    msg.textContent = '已複製 ✓';
  }
  setTimeout(function () { msg.textContent = ''; }, 2500);
}

async function startNews() {
  loadNews();
}
