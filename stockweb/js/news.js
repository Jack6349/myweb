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
    // ref＝期交所的參考價，用 close − change_price 回推。
    // 圖上的基準線與格子右邊那個百分比因此同一個來源，不會各說各話。
    var ref = (s.change_price != null) ? s.close - s.change_price : null;
    return { price: s.close, changePct: s.change_rate, time: (s.datetime || '').slice(11, 16), ref: ref };
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
      // 三組牌告：即期 spot／網銀App優惠 pref／現金 cash。
      // 原本只分即期與現金，優惠那兩筆會先被當成現金、再被真正的現金覆蓋掉。
      var grp = kind.indexOf('即期') >= 0 ? 'spot' : (kind.indexOf('優惠') >= 0 ? 'pref' : 'cash');
      var key = grp + (side.indexOf('買入') >= 0 ? 'Buy' : 'Sell');
      (rates[cur] = rates[cur] || {})[key] = +pr[1];
    }
    if (Object.keys(rates).length) {
      _esun = { at: at, rates: rates }; _esunTs = Date.now();
      _esunJpyHistPush();     // 牌告每抓回來一次就記一天，累積玉山自己的走勢
    }
  } catch (e) { hush('news', e); }
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
  // 分頁之後這一頁有空間，把原本只藏在滑過提示裡的定義寫成看得見的文字。
  el.innerHTML = '<div class="sub-title">美國總經（FRED，各項資料月份不同）</div>' +
    '<div class="nv-note">月頻資料，FRED 轉載 BLS，通常官方發布當天或隔天更新——'
    + '<b>不適合拿來搶即時數字</b>。'
    + '非農就業與前值比（月增減，萬人），失業率是水位，'
    + 'CPI 與核心 CPI 是年增率。每一格的小字是資料所屬月份，四項未必同月。</div>' +
    '<div class="fred-row">' + rows.join('') + '</div>';
}

// ═════ 大盤位置、月份季節性、融資餘額 ═════
//
// 起因是一篇投信稿：「自 5 萬點回檔 2 成」「短線急漲逾 6000 點」
// 「融資瘦身有成」「過去 20 年 11 月到隔年 Q1 上漲機率高」。
// 這幾句全都可以用手邊的資料檢驗，而頁面上卻沒有。
// 這一區的目的是讓使用者能反駁新聞，不是整理新聞。
//
// 實測結果（寫在這裡以免之後重算）：25 年月線 11 月上漲 20/25（80%）是全年最強，
// 但 12 月 56%、3 月 52% 是全年墊底那一群——「11 月到 Q1」是灌水的說法。
var TWPOS_LS = 'news_twpos_v1';
var _twPos = null;    // { at, hi, lo, last, season:[{m,up,n,med}], mgn:{cur,prev,days,chg} }

function _twPosNum(v) { return v == null ? '\u2014' : Math.round(v).toLocaleString('zh-TW'); }
function _twPosPct(v, dp) {
  if (v == null) return '\u2014';
  return (v > 0 ? '+' : (v < 0 ? '\u2212' : '')) + Math.abs(v).toFixed(dp == null ? 2 : dp) + '%';
}

// 大盤位置：距一年高點、自高點後最低反彈、收復了多少
async function _twPosRange() {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=1y';
  var j = await (await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url))).json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('TWII 1y');
  var ts = res.timestamp || [], cl = (res.indicators.quote[0].close || []), b = [];
  for (var i = 0; i < ts.length; i++) {
    if (cl[i] != null) b.push({ d: new Date((ts[i] + 28800) * 1000).toISOString().slice(0, 10), c: cl[i] });
  }
  if (b.length < 30) throw new Error('TWII bars');
  var last = b[b.length - 1];
  var hi = b.reduce(function (a, x) { return x.c > a.c ? x : a; });
  var lo = b.filter(function (x) { return x.d >= hi.d; }).reduce(function (a, x) { return x.c < a.c ? x : a; });
  return { last: last, hi: hi, lo: lo };
}

// 月份季節性：25 年月線，每一個月的上漲機率與中位報酬
async function _twPosSeason() {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1mo&range=25y';
  var j = await (await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url))).json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('TWII 25y');
  var ts = res.timestamp || [], cl = (res.indicators.quote[0].close || []), b = [];
  for (var i = 0; i < ts.length; i++) if (cl[i] != null) b.push({ t: new Date(ts[i] * 1000), c: cl[i] });
  var by = {};
  for (var k = 1; k < b.length; k++) {
    var m = b[k].t.getUTCMonth() + 1;
    (by[m] = by[m] || []).push((b[k].c / b[k - 1].c - 1) * 100);
  }
  var med = function (a) {
    a = a.slice().sort(function (x, y) { return x - y; });
    var n = a.length;
    return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null;
  };
  var out = [];
  for (var mm = 1; mm <= 12; mm++) {
    var a = by[mm] || [];
    if (!a.length) continue;
    out.push({ m: mm, n: a.length, up: a.filter(function (v) { return v > 0; }).length, med: med(a) });
  }
  return out;
}

// 大盤融資餘額：把籌碼頁已經在用的 MI_MARGN 按日加總（單位張）。
// 不新增來源，那一頁的每日快取直接拿來用。
async function _twPosMargin() {
  if (typeof sigRecentMargin !== 'function') return null;
  var ds = await sigRecentMargin(6);
  if (!ds || ds.length < 2) return null;
  var sum = function (d) {
    var t = 0;
    Object.keys(d.map).forEach(function (k) { if (d.map[k] != null) t += d.map[k]; });
    return t;
  };
  var cur = sum(ds[0]), prev = sum(ds[ds.length - 1]);
  return {
    cur: cur, prev: prev, days: ds.length,
    from: String(ds[ds.length - 1].ymd), to: String(ds[0].ymd),
    chg: prev > 0 ? (cur - prev) / prev * 100 : null
  };
}

async function loadTwPos(force) {
  var el = document.getElementById('twpos-bar');
  if (!el) return;
  var day = _divTwDate ? _divTwDate().iso : new Date().toISOString().slice(0, 10);
  if (!force) {
    try {
      var c = JSON.parse(localStorage.getItem(TWPOS_LS) || 'null');
      if (c && c.day === day && c.v) { _twPos = c.v; renderTwPos(); return; }
    } catch (e) {}
  }
  var r = await Promise.allSettled([_twPosRange(), _twPosSeason(), _twPosMargin()]);
  _twPos = {
    rng: r[0].status === 'fulfilled' ? r[0].value : null,
    season: r[1].status === 'fulfilled' ? r[1].value : null,
    mgn: r[2].status === 'fulfilled' ? r[2].value : null
  };
  try { localStorage.setItem(TWPOS_LS, JSON.stringify({ day: day, v: _twPos })); } catch (e) {}
  renderTwPos();
}

function renderTwPos() {
  var el = document.getElementById('twpos-bar');
  if (!el || !_twPos) return;
  var cells = [];
  var cell = function (nm, sub, val, cls, tip) {
    return '<div class="fred-cell"' + (tip ? ' title="' + tip + '"' : '') + '>'
      + '<span class="fred-name">' + nm + '<span class="fred-month">' + (sub || '') + '</span></span>'
      + '<span class="fred-val ' + (cls || '') + '">' + val + '</span></div>';
  };
  var g = _twPos.rng;
  if (g) {
    var dHi = (g.last.c / g.hi.c - 1) * 100;
    var dLo = (g.last.c / g.lo.c - 1) * 100;
    var back = (g.hi.c > g.lo.c) ? (g.last.c - g.lo.c) / (g.hi.c - g.lo.c) * 100 : null;
    var dd = (g.lo.c / g.hi.c - 1) * 100;
    cells.push(cell('\u8ddd\u4e00\u5e74\u9ad8\u9ede', g.hi.d.slice(5) + ' ' + _twPosNum(g.hi.c),
      _twPosPct(dHi), dHi < 0 ? 'down' : 'up',
      '\u6700\u65b0 ' + _twPosNum(g.last.c) + '\uff0c\u4e00\u5e74\u9ad8 ' + _twPosNum(g.hi.c)));
    cells.push(cell('\u81ea\u4f4e\u9ede\u53cd\u5f48', g.lo.d.slice(5) + ' ' + _twPosNum(g.lo.c),
      _twPosPct(dLo), dLo > 0 ? 'up' : 'down',
      '\u9ad8\u9ede\u4e4b\u5f8c\u7684\u6700\u4f4e\u6536\u76e4\u3002\u6700\u5927\u56de\u6a94 ' + _twPosPct(dd)));
    cells.push(cell('\u6536\u5fa9\u6bd4\u4f8b', '\u8dcc\u5e45\u88e1\u88dc\u56de\u4e86\u591a\u5c11',
      back == null ? '\u2014' : back.toFixed(0) + '%', '',
      '\uff08\u73fe\u50f9 \u2212 \u6700\u4f4e\uff09\u00f7\uff08\u6700\u9ad8 \u2212 \u6700\u4f4e\uff09\u3002100% \u4ee3\u8868\u56de\u5230\u9ad8\u9ede'));
  }
  var ss = _twPos.season;
  if (ss && ss.length) {
    var nowM = new Date(Date.now() + 8 * 3600000).getUTCMonth() + 1;
    var cur = ss.filter(function (x) { return x.m === nowM; })[0];
    if (cur) {
      var rate = cur.up / cur.n * 100;
      // 排名：這個月在十二個月裡的位置
      var rank = ss.slice().sort(function (a, b) { return (b.up / b.n) - (a.up / a.n); })
        .findIndex(function (x) { return x.m === nowM; }) + 1;
      cells.push(cell(nowM + ' \u6708\u4e0a\u6f32\u6a5f\u7387', cur.n + ' \u5e74\u4e2d ' + cur.up + ' \u6b21',
        rate.toFixed(0) + '%', rate >= 60 ? 'up' : (rate <= 45 ? 'down' : ''),
        '\u5168\u5e74\u7b2c ' + rank + ' \u5f37\u3002\u4e2d\u4f4d\u5831\u916c ' + _twPosPct(cur.med)
        + '\u3002\u8cc7\u6599\uff1a\u52a0\u6b0a\u6307\u6578 25 \u5e74\u6708\u7dda\uff0c\u81ea\u5df1\u7b97\u7684'));
    }
  }
  var mg = _twPos.mgn;
  if (mg) {
    cells.push(cell('\u5927\u76e4\u878d\u8cc7\u9918\u984d', _twPosNum(mg.cur / 10000) + ' \u842c\u5f35',
      _twPosPct(mg.chg), mg.chg > 0 ? 'up' : (mg.chg < 0 ? 'down' : ''),
      mg.from.slice(4, 6) + '/' + mg.from.slice(6) + ' \u7684 ' + _twPosNum(mg.prev) + ' \u5f35 \u2192 '
      + mg.to.slice(4, 6) + '/' + mg.to.slice(6) + ' \u7684 ' + _twPosNum(mg.cur) + ' \u5f35\u3002'
      + '\u4f86\u6e90\uff1a\u8b49\u4ea4\u6240 MI_MARGN \u6309\u65e5\u52a0\u7e3d\uff08\u8207\u7c4c\u78bc\u8a55\u4f30\u9801\u540c\u4e00\u4efd\u5feb\u53d6\uff09'));
  }
  if (!cells.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="sub-title">\u5927\u76e4\u4f4d\u7f6e\u8207\u7c4c\u78bc</div>'
    + '<div class="fred-row">' + cells.join('') + '</div>';
}

// ═════ 頁籤：盤勢／位置與籌碼／新聞 ═════
//
// 實測整頁 107,789px，其中新聞清單（220 則）就佔 103,823px。
// 看盤勢資料要先捏過它，看新聞又被前面四區擋著。
var NV_TAB_LS = 'news_tab_v1';
var _nvTab = (function () {
  try { var v = localStorage.getItem(NV_TAB_LS); if (/^(mkt|pos|news)$/.test(v || '')) return v; } catch (e) {}
  return 'mkt';
})();
function nvTab(k) {
  _nvTab = /^(mkt|pos|news)$/.test(k) ? k : 'mkt';
  try { localStorage.setItem(NV_TAB_LS, _nvTab); } catch (e) {}
  nvApplyTab();
}
function nvApplyTab() {
  ['mkt', 'pos', 'news'].forEach(function (t) {
    var pane = document.getElementById('nv-' + t);
    if (pane) pane.style.display = (t === _nvTab) ? '' : 'none';
    var b = document.getElementById('nv-tab-' + t);
    if (b) b.classList.toggle('on', t === _nvTab);
  });
}

// ═════ 持股籌碼 ═════
//
// 改版前這一區畫的是「穿透成份股的法人連買賣加權分數」，已經拿掉。
// 那個數字看起來像綜合評分，實際上只是連買賣天數的加權平均，沒有可驗證的意義：
// 實測 7 檔持股 × 41 個交易日 = 196 個觀察，用它去分「籌碼與價格背離」的四種狀態，
// 四格的後 5 日中位報酬全是負的（區間本身是 20% 的下跌段），而唯一有意思的那一格
// 只有 2 個樣本。撐不住的解讀就不要畫。
//
// 現在改用這一檔 ETF 自己在 T86 裡的買賣超，跟券商 App 的「三大法人」同一份資料。
// 三家分開畫，因為主動式 ETF 的自營商部位是造市與避險，跟外資投信的方向性部位不同性質。
var CHIP_WIN = 5;          // 一個觀察窗 = 5 個交易日
var CHIP_SCAN_DAYS = 63;   // 往回掃幾個日曆天（約 43 個交易日）取自身分布
var _chipRows = null, _chipBusy = false, _chipProg = '', _chipMeta = null, _chipYc = null;

// T86 整日 JSON 約 1MB。sigFetchT86Day 會把整份存進 localStorage，
// 那適合只抓近 5 日；這裡要回溯 40 幾天，存整份會把額度吃光，
// 所以自己抓、只留持股這幾檔（一天約 20 bytes）。
async function _chipDay(ymd, codes) {
  var key = 'chipD_v1_' + ymd, cached = null;
  try {
    var c = localStorage.getItem(key);
    if (c === 'HOLIDAY') return null;
    if (c) cached = JSON.parse(c);
  } catch (e) {}
  if (cached && !codes.some(function (k) { return !(k in cached); })) return cached;
  var j = null;
  try {
    var r = await fetch('https://www.twse.com.tw/rwd/zh/fund/T86?date=' + ymd + '&selectType=ALLBUT0999&response=json');
    j = await r.json();
  } catch (e) { return null; }
  if (!j || !j.data || !j.data.length) {
    if (ymd < _sigTodayYmd()) { try { localStorage.setItem(key, 'HOLIDAY'); } catch (e) {} }
    return null;
  }
  var out = cached || {}, want = {};
  codes.forEach(function (k) { want[k] = 1; });
  j.data.forEach(function (row) {
    var cd = String(row[0]).trim();
    if (want[cd]) out[cd] = [_sigNum(row[4]), _sigNum(row[10]), _sigNum(row[11])];   // 外資、投信、自營商
  });
  // 當天沒出現在 T86（沒成交）：寫 null 佔位，否則每次載入都會為它重抓整天
  codes.forEach(function (k) { if (!(k in out)) out[k] = null; });
  try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
  return out;
}

function _chipYmds(days) {
  var out = [], now = new Date(Date.now() + 8 * 3600000);
  for (var back = 0; back < days; back++) {
    var d = new Date(now.getTime() - back * 86400000), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
  }
  return out;
}

// 目前這一窗落在自己歷史分布的第幾百分位（不含自己）
function _chipPctile(hist, cur) {
  if (hist.length < 10) return null;
  var lt = 0;
  for (var i = 0; i < hist.length; i++) if (hist[i] < cur) lt++;
  return Math.round(lt / hist.length * 100);
}

async function loadChipBars() {
  if (_chipBusy) return;
  _chipBusy = true;
  _chipProg = '';
  _chipMeta = null;
  renderChipBars();
  try {
    // 進新聞情勢頁時 _positions 是空的（那是持股庫存載的），自己去抓
    var ps = (typeof _positions !== 'undefined' && _positions && _positions.length) ? _positions : [];
    if (!ps.length && typeof fetchBrokerPositions === 'function') {
      try { ps = (await fetchBrokerPositions()) || []; } catch (e) { hush('news', e); }
    }
    var held = ps.map(function (x) { return String(x.code).toUpperCase(); });
    held = held.filter(function (c, k) { return held.indexOf(c) === k; });
    if (!held.length) { _chipRows = []; return; }

    // 流通單位數與官方折溢價跟 ETF 評比同源（當日 localStorage 快取，通常不用重抓）
    var list = {};
    if (typeof _esGetBase === 'function') {
      try { var b = await _esGetBase(false); if (b && b.list) list = b.list; } catch (e) { hush('news', e); }
    }

    var ymds = _chipYmds(CHIP_SCAN_DAYS), got = {}, q = ymds.slice(), done = 0, total = ymds.length;
    var worker = async function () {
      while (q.length) {
        var y = q.shift();
        var m = await _chipDay(y, held);
        if (m) got[y] = m;
        done++;
        _chipProg = done + '/' + total;
        renderChipBars();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    var days = Object.keys(got).map(Number).sort(function (a, b) { return b - a; });   // 新 → 舊

    var K = 1000;   // T86 是股數，換成張
    var out = [];
    held.forEach(function (c) {
      var ser = days.map(function (y) { return got[y][c] || null; });
      var f = 0, t = 0, d = 0, nd = 0, i, k;
      for (i = 0; i < CHIP_WIN && i < ser.length; i++) {
        if (!ser[i]) continue;
        f += ser[i][0]; t += ser[i][1]; d += ser[i][2]; nd++;
      }
      var cur = (f + t + d) / K;
      var hist = [];
      for (i = 1; i + CHIP_WIN <= ser.length; i++) {
        var v = 0, ok = false;
        for (k = i; k < i + CHIP_WIN; k++) if (ser[k]) { v += ser[k][0] + ser[k][1] + ser[k][2]; ok = true; }
        if (ok) hist.push(v / K);
      }
      var L = list[c];
      var units = (L && L.units > 0) ? L.units / K : null;    // 流通張數
      var pc = function (x) { return units ? (x / K) / units * 100 : null; };
      out.push({
        code: c, name: (typeof _rbName === 'function' ? _rbName(c) : ''),
        f: f / K, t: t / K, d: d / K,
        fp: pc(f), tp: pc(t), dp: pc(d),
        net: nd ? cur : null, nd: nd, units: units,
        pct: (nd && units) ? cur / units * 100 : null,
        rank: nd ? _chipPctile(hist, cur) : null, hn: hist.length,
        prem: (L && L.prem != null) ? L.prem : null,
        bk: null, mg: null, as: null, mgRank: null
      });
    });

    // 分點主力、融資水位、資產分佈：排程每天抓 Yahoo 個股頁寫成的靜態檔。
    // 證交所的 BSR 分點查詢要過驗證碼，抓不到；Yahoo 那一頁是算好的結果。
    // 融資不用 MI_MARGN 的 5 日差分：差分會蓋掉水位的變化，
    // 00406A 融資三週從 144,219 張漲到 281,885 張，當下的 5 日差分只有 −5.0%。
    try {
      var yr = await fetch('data/yahoo-chip.json?t=' + Date.now());
      _chipYc = await yr.json();
    } catch (e) { _chipYc = null; hush('news', e); }
    var ym = (_chipYc && _chipYc.map) || {};
    out.forEach(function (r) {
      var y = ym[r.code];
      if (!y) return;
      r.bk = y.broker || null;
      r.mg = y.margin || null;
      r.as = y.asset || null;
      if (r.mg && r.mg.hist && r.mg.hist.length >= 11) {
        var h = r.mg.hist.slice(1).map(function (x) { return x[1]; })
          .filter(function (v) { return v != null; });
        r.mgRank = _chipPctile(h, r.mg.bal);
      }
    });

    out.sort(function (a, b) {
      if (a.pct == null && b.pct == null) return a.code.localeCompare(b.code);
      if (a.pct == null) return 1;
      if (b.pct == null) return -1;
      return b.pct - a.pct;
    });
    _chipRows = out;
    var newest = function (k) {
      var v = '';
      out.forEach(function (r) { var o2 = r[k]; if (o2 && o2.d && o2.d > v) v = o2.d; });
      return v;
    };
    _chipMeta = { n: days.length, yUpd: (_chipYc && _chipYc.updated) || '',
      dBk: newest('bk'), dMg: newest('mg'), dAs: newest('as'),
      from: days.length ? String(days[days.length - 1]) : '', to: days.length ? String(days[0]) : '' };
  } finally {
    _chipBusy = false;
    renderChipBars();
  }
}

function _chipMd(y) { return y ? (y.slice(4, 6) + '/' + y.slice(6)) : '—'; }
function _chipSign(v, dp, unit, miss) {
  if (v == null) return '<span class="chip-na">' + (miss || '—') + '</span>';
  var cls = v > 0 ? 'up' : (v < 0 ? 'down' : '');
  var txt = (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toLocaleString('zh-TW', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + (unit || '');
  return '<span class="' + cls + '">' + txt + '</span>';
}

function renderChipBars() {
  var el = document.getElementById('chip-bar');
  if (!el) return;
  var T = '<div class="sub-title">持股籌碼</div>';
  if (_chipBusy) {
    el.innerHTML = T + '<div class="modal-loading">抓證交所 T86 多日三大法人… ' + (_chipProg || '') + '</div>';
    return;
  }
  if (!_chipRows) {
    el.innerHTML = T + '<div class="chip-hint">要回溯約 ' + CHIP_SCAN_DAYS
      + ' 個日曆天的三大法人日報才算得出自身分位，第一次載入要幾十秒，之後每天只多抓一天，所以不自動載。'
      + '<button class="btn-query" onclick="loadChipBars()">載入持股籌碼</button></div>';
    return;
  }
  if (!_chipRows.length) {
    el.innerHTML = T + '<div class="modal-loading">無持股</div>';
    return;
  }
  // 滿格取不到最大值：00406A 近 5 日自營商賣超相當於流通量的 7%，
  // 用它當滿格，其他 14 檔全部縮成看不見的細線。改用上四分位當滿格，
  // 超出的畫到底、在邊緣標一個箭頭（管制圖的超限點就是這樣標）。
  var tot = _chipRows.filter(function (r) { return r.pct != null; })
    .map(function (r) { return Math.abs(r.fp) + Math.abs(r.tp) + Math.abs(r.dp); })
    .sort(function (a, b) { return a - b; });
  var SC = tot.length ? tot[Math.min(tot.length - 1, Math.floor(tot.length * 0.75))] : 1;
  if (!(SC > 0)) SC = 1;
  var bar = function (r) {
    if (r.pct == null) return '<span class="chip-mid"></span>';
    var defs = [[r.fp, 'f'], [r.tp, 't'], [r.dp, 'd']];
    var h = '<span class="chip-mid"></span>', off = 0, i, v, w;
    for (i = 0; i < 3; i++) {
      v = defs[i][0];
      if (!(v > 0)) continue;
      w = v / SC * 50;
      h += '<span class="chip-seg s-' + defs[i][1] + '" style="left:' + (50 + off) + '%;width:' + w + '%"></span>';
      off += w;
    }
    if (off > 50) h += '<span class="chip-clip r">▸</span>';
    var neg = 0;
    for (i = 0; i < 3; i++) {
      v = defs[i][0];
      if (!(v < 0)) continue;
      w = -v / SC * 50;
      neg += w;
      // left 可以是負值：track 有 overflow:hidden，超出的自然被裁掉
      h += '<span class="chip-seg s-' + defs[i][1] + ' sell" style="left:' + (50 - neg) + '%;width:' + w + '%"></span>';
    }
    if (neg > 50) h += '<span class="chip-clip l">◂</span>';
    return h;
  };
  var m = _chipMeta || { n: 0 };
  var hc = function (name, d) {
    return '<span>' + name + '<i>' + (d ? _chipMd(d) : '') + '</i></span>';
  };
  var dT = _chipMd(m.to), dBk = m.dBk || '', dMg = m.dMg || '', dAs = m.dAs || '';
  var head = '<div class="chip-row chip-head"><span>代號<i></i></span>'
    + '<span class="chip-hl">← 賣超　｜　買超 →<i>' + dT + '</i></span>'
    + hc('淨張', '') + '<span>佔流通<i>' + dT + '</i></span><span>分位<i>' + dT + '</i></span>'
    + hc('主力淨張', dBk) + hc('佔量', dBk)
    + hc('融資餘額', dMg) + hc('使用率', dMg) + hc('水位分位', dMg)
    + hc('現金', dAs) + hc('折溢價', '') + '</div>';
  // 某一列的資料日比表頭舊時整格壓暗：那一格不是今天的數字，不能讓它混在同一行裡
  var old = function (o2, d) { return (o2 && o2.d && d && o2.d !== d) ? ' chip-old' : ''; };
  var plain = function (v, dp, unit, cls) {
    if (v == null) return '<span class="chip-na">✕</span>';
    return '<span class="' + (cls || '') + '">'
      + v.toLocaleString('zh-TW', { minimumFractionDigits: dp, maximumFractionDigits: dp })
      + (unit || '') + '</span>';
  };
  var rows = _chipRows.map(function (r) {
    var bk = r.bk, mg = r.mg, as = r.as;
    return '<div class="chip-row">'
      + '<span class="chip-code">' + r.code + '</span>'
      + '<span class="chip-track">' + bar(r) + '</span>'
      // nd === 0：T86 抓到了但這一檔不在裡面（債券 ETF 不在 ALLBUT0999），算抓不到 → ✕
      // units 缺：個股沒有流通單位數可除，這一欄不適用 → —
      + '<span class="chip-num">' + _chipSign(r.net == null ? null : Math.round(r.net), 0, '', '✕') + '</span>'
      + '<span class="chip-num">' + _chipSign(r.pct, 2, '%', r.nd ? '—' : '✕') + '</span>'
      + '<span class="chip-num chip-rk">' + (r.rank == null ? '<span class="chip-na">✕</span>' : r.rank) + '</span>'
      + '<span class="chip-num' + old(bk, dBk) + '">'
      + _chipSign(bk ? bk.net : null, 0, '') + '</span>'
      + '<span class="chip-num' + old(bk, dBk) + '">'
      + plain(bk ? bk.pv : null, 1, '%') + '</span>'
      + '<span class="chip-num' + old(mg, dMg) + '">'
      + plain(mg ? mg.bal : null, 0, '') + '</span>'
      + '<span class="chip-num' + old(mg, dMg) + '">'
      + plain(mg ? mg.use : null, 2, '%') + '</span>'
      + '<span class="chip-num chip-rk' + old(mg, dMg) + '">'
      + (r.mgRank == null ? '<span class="chip-na">✕</span>' : r.mgRank) + '</span>'
      + '<span class="chip-num' + old(as, dAs) + '">'
      + (as ? plain(as.cash, 2, '%') : '<span class="chip-na">—</span>') + '</span>'
      + '<span class="chip-num">' + _chipSign(r.prem, 2, '%') + '</span>'
      + '</div>';
  }).join('');
  el.innerHTML = '<div class="sub-title">持股籌碼'
    + '<span class="chip-sub">法人近 ' + CHIP_WIN + ' 個交易日。三個來源的資料日不同，標在各欄名稱下面'
    + ((m.yUpd && m.yUpd !== (typeof _divTwDate === 'function' ? _divTwDate().iso : '')) 
       ? '｜<b class="cs-n">主力與融資的排程停在 ' + m.yUpd + '</b>' : '') + '</span>'
    + '<button class="btn-query chip-reload" onclick="loadChipBars()">↓ 重新載入</button></div>'
    + '<div class="chip-lg">'
    + '<span class="chip-k s-f"></span>外資'
    + '<span class="chip-k s-t"></span>投信'
    + '<span class="chip-k s-d"></span>自營商'
    + '<span class="chip-lgx">右側買超、左側賣超（賣超同色偏淡）。滿格＝'
    + SC.toFixed(2) + '% 流通量（持股的上四分位），超出的畫到底並標 ▸；條長只能在這張圖裡互相比。</span>'
    + '</div>'
    + '<div class="chip-wrap">' + head + rows + '</div>'
    + '<div class="nv-note">'
    + '<div class="chip-ex"><b>三段堆疊條與佔流通</b>　'
    + '<b>定義</b>：證交所 T86 的「外資／投信／自營商買賣超股數」除 1,000 換成張，近 ' + CHIP_WIN
    + ' 個交易日加總，再除以該檔流通張數（流通單位數 ÷ 1,000，與 ETF 評比同一份資料）。'
    + '<b>比較基準</b>：條長跟同一張圖裡的其他持股比（滿格取這批持股的上四分位，不是最大值，'
    + '否則單一檔的大額申贖會把其他人壓成細線）；要跟自己的歷史比看「分位」欄。'
    + '<b>白話</b>：這 5 天哪幾家法人在買這檔、哪幾家在賣，量相當於這檔的百分之幾。'
    + '<b>機制</b>：主動式 ETF 的自營商部位主要是造市與避險申贖，不是看多看空；外資與投信才是方向性部位。'
    + '所以同一個淨額要分家看：「外資買、自營賣」通常是造市商在對沖申購，'
    + '「三家一起賣」才是真的在減碼，兩者對後續價格的意思不同。'
    + '<b>行動含義</b>：三段同向、且分位落在 80 以上或 20 以下，才值得去查是不是有申贖或指數調整這類一次性原因。'
    + '單獨這一欄不足以支撐買賣決定。'
    + '<b>不能告訴你</b>：看不出對手方是誰（法人買超必然有人賣超），也看不出價格有沒有先反應完。'
    + '要配「分位」與「折溢價」一起看。</div>'
    + '<div class="chip-ex"><b>分位</b>　'
    + '<b>定義</b>：把這檔過去 ' + m.n + ' 個交易日裡每一個 ' + CHIP_WIN
    + ' 日窗的法人淨買賣張數排成分布，看目前這一窗落在第幾百分位（0＝歷史最賣，100＝歷史最買），不含目前這一窗本身。'
    + '<b>比較基準</b>：只跟自己比，不跟別檔比。'
    + '<b>白話</b>：現在這波買賣，對這檔來說算大還是算平常。'
    + '<b>機制</b>：絕對張數不能跨檔比（規模不同），佔流通量能跨檔比卻不知道「對這檔算不算多」，分位補的是後者。'
    + '<b>行動含義</b>：80 以上或 20 以下才算訊號，中間就是日常噪音，不必看。'
    + '<b>不能告訴你</b>：分位分不出「正在往下探底」和「已經止跌打底」，兩者都是低分位。'
    + '要配淨張的實際方向一起讀。</div>'
    + '<div class="chip-ex"><b>主力淨張與佔量</b>　'
    + '<b>定義</b>：Yahoo 個股頁的分點券商買賣超，當日買超前 15 家減賣超前 15 家的合計張數；'
    + '「佔量」是主力買賣超佔當日成交量的比率。證交所的分點查詢要過驗證碼，抓不到，'
    + 'Yahoo 這一頁是算好的結果。'
    + '<b>比較基準</b>：跟這檔自己當天的成交量比。沒有歷史序列可以回溯，做不出分位。'
    + '<b>白話</b>：今天買賣最集中的那幾家券商，合起來是站在買方還是賣方，佔了多少量。'
    + '<b>機制</b>：這一欄是上面那段「自營商的賣可能只是造市」唯一能驗證的地方。'
    + '造市商的單子會落在元大總公司、台新、凱基這些主辦券商的分點上，'
    + '外資的單子落在摩根大通、高盛、瑞銀。賣方集中在主辦券商，表示那是申購買回的對沖；'
    + '賣方散在一堆分點，才是真的有人在倒貨。同一個自營商賣超，兩種意思。'
    + '<b>行動含義</b>：佔量超過兩成而且買賣兩方分別集中在外資分點與主辦券商，'
    + '通常就是申贖造成的，不必當成看空。'
    + '<b>不能告訴你</b>：分點不等於實際客戶，元大總公司底下不只造市一種流量；'
    + '也只有前 15 名，中間那些分散的單子看不到。</div>'
    + '<div class="chip-ex"><b>融資餘額、使用率與水位分位</b>　'
    + '<b>定義</b>：融資餘額（張）與融資使用率（餘額 ÷ 該檔的融資限額）取自 Yahoo 資券變化頁，'
    + '原始資料是證交所。水位分位是把今天的餘額放回這檔自己過去 60 個交易日的餘額分布，'
    + '看落在第幾百分位，不含今天。'
    + '<b>比較基準</b>：使用率跟這檔自己的融資限額比，水位分位跟它自己 60 日的歷史比。'
    + '<b>白話</b>：用借來的錢買這檔的人有多少，比它自己平常多還是少。'
    + '<b>機制</b>：融資是散戶的槓桿部位，不耐跌。有維持率壓力，跌到追繳就被迫賣出，'
    + '所以融資水位高的時候，下跌會多一段被動賣壓；水位退下來代表這段加速器已經拆掉。'
    + '<b>行動含義</b>：水位分位 80 以上而且溢價同時擴大，是散戶追價的組合，'
    + '追進去的成本比淨值貴。'
    + '<b>不能告訴你</b>：看不出融資的人是誰、成本在哪；'
    + '也分不出餘額下降是自願減碼還是被斷頭。借券賣出餘額在 Yahoo 是另外載入的圖表，抓不到，'
    + '所以法人的放空部位這一頁沒有。</div>'
    + '<div class="chip-ex"><b>現金</b>　'
    + '<b>定義</b>：Yahoo 持股分析頁的資產分佈，股票以外的現金部位佔基金資產的比率。'
    + '個股沒有這一項，顯示「—」。'
    + '<b>比較基準</b>：跟同一批持股的其他主動式 ETF 比。'
    + '一般被動式 ETF 貼著指數跑，現金通常壓在 5% 以下。'
    + '<b>白話</b>：經理人有多少錢沒有投下去。'
    + '<b>機制</b>：主動式 ETF 的現金部位是經理人自己的決定，不是被動跟著指數走。'
    + '現金拉高代表他在等，或者正在應付贖回；現金壓低代表他把子彈打完了，'
    + '之後市場再跌，他沒有加碼的餘裕，只能賣股票換現金。這是在價格上完全看不到的資訊。'
    + '<b>行動含義</b>：同一天同一類的兩檔，一檔現金 6%、一檔 21%，'
    + '後面那檔對下跌的緩衝比較厚，對上漲的參與比較少。'
    + '<b>不能告訴你</b>：這一格更新不規律，看到的通常是幾天前的數字（表頭有標資料日），'
    + '不能當成今天的部位；也分不出高現金是看空還是剛拿到一筆申購還沒配置。</div>'
    + '</div>'
    + '<div class="nb"><b>說明</b>：為什麼沒有綜合分數，以及背離解讀的實測紀錄。'
    + '舊版畫的是「穿透成份股的法人連買賣加權分數」，已經拿掉：它看起來像綜合評分，'
    + '實際上只是連買賣天數的加權平均。實測 7 檔持股 × 41 個交易日 ＝ 196 個觀察，'
    + '用 10 日累計籌碼與同期價格變化分成四種狀態，量測之後 5 日：'
    + '同向上 92 次（中位 −1.90%、上漲率 47%）、背離·籌碼買價跌 28 次（−2.79%、25%）、'
    + '同向下 74 次（−5.03%、20%）、背離·籌碼賣價漲 2 次（+2.68%、100%）。'
    + '四格全負是因為這段區間本身是 20% 的下跌段，而唯一有意思的那一格只有 2 個樣本，'
    + '所以「背離」這個解讀撐不住，不畫。另外舊版的 T86 快取只存了外資與投信，漏掉自營商：'
    + '2026-11-06 的 00405A，外資＋投信是 +2,133 張（看起來是買超日），加上自營商是 −37,932 張，'
    + '正負相反；同一天 00981A 從 −46,530 變成 −145,747，差 3 倍。這次一起修掉。</div>';
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
  var h = '<div class="sub-title">訊號一致性　' +
    (n ? '<b class="cs-n">' + n + ' 項方向不一致</b>' : '各項方向一致') + '</div>'
    + '<div class="nv-note">只做<b>方向比對</b>：陳述哪兩項資料彼此同向或相反，'
    + '不推論股債會漲會跌。不給紅黃綠燈是因為同一組資料在軟著陸與衰退情境下'
    + '市場解讀相反，程式無從分辨；壓成單一燈號會把不確定性藏起來，'
    + '而<b>背離本身才是最有資訊量的部分</b>。'
    + '資料全部取自現有來源（FRED 月頻、Yahoo 多日、非投等債 OAS）。</div>';
  _consist.forEach(function (r) {
    h += '<div class="cs-row"><span class="cs-dot">' + (r.level === 'diverge' ? '🔶' : '🟢') + '</span>' +
      '<span class="cs-title">' + r.title + '</span>' +
      '<span class="cs-detail">' + r.detail + '</span></div>';
  });
  h += '<div class="detail-note"><dl>' +
    '<dt>比對內容</dt><dd>只看各項資料的方向是否一致，不推論股債後續走勢。</dd>' +
    '<dt>方向不一致</dt><dd>訊號互相牴觸，是需要進一步查證的地方，本身不是買賣訊號。</dd>' +
    '</dl></div>';
  el.innerHTML = h;
}

// ── 盤勢快取 ────────────────────────────────────────────────
// loadMacro() 一次要打 11 個請求（8 檔 Yahoo ＋ 台股收盤日 ＋ 夜盤 ＋ 玉山匯率）。
// 以前只有新聞情勢頁會載，一次就算了；現在每一頁的抽屜都看得到，
// 沒有快取就會變成每切一頁重打一輪。
// TTL 取 10 分鐘：沿用 loadEsunFx 既有的牌告匯率快取時間，不另訂一套數字。
// 用 sessionStorage 不用 localStorage：關掉分頁就丟掉，不會隔天還拿到昨天的收盤價。
var MACRO_CACHE_KEY = 'macro_snap_v1';
var MACRO_TTL_MS = 10 * 60 * 1000;
var _macroAt = 0;
function _macroCacheWrite() {
  try {
    sessionStorage.setItem(MACRO_CACHE_KEY, JSON.stringify(
      { at: _macroAt, snap: _macroSnap, tw: _twLastClose, fut: _nightFut,
        twidx: _twIdxIntra, txf: _txfIntra, jpy: _jpyMid, esun: _esun, esunTs: _esunTs }));
  } catch (e) {}   // 容量滿或隱私模式：沒快取就是每次重抓，不該因此壞掉
}
function _macroCacheRead() {
  try {
    var j = JSON.parse(sessionStorage.getItem(MACRO_CACHE_KEY));
    if (j && j.snap && j.snap.length && Date.now() - j.at < MACRO_TTL_MS) return j;
  } catch (e) {}
  return null;
}
// 抽屜展開時呼叫：快取還新就直接用，過期才重抓。
async function ensureMacro(force) {
  if (!force) {
    if (_macroSnap.length && Date.now() - _macroAt < MACRO_TTL_MS) return;
    var c = _macroCacheRead();
    if (c) {
      _macroSnap = c.snap; _twLastClose = c.tw; _nightFut = c.fut; _macroAt = c.at;
      _twIdxIntra = c.twidx || null; _txfIntra = c.txf || null; _jpyMid = c.jpy || null;
      if (c.esun) { _esun = c.esun; _esunTs = c.esunTs || 0; }
      if (!_esun) await loadEsunFx();   // 牌告沒進快取（上次抓失敗）才補一個請求
      return;
    }
  }
  await loadMacro();
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
  // 美股分時（只給抽屜畫圖用）。與日線分開抓：日線給警示的跨日累計，分時給圖。
  // 任一檔失敗只讓那一格沒有圖，其餘照常。
  var intras = await Promise.allSettled(MACRO_INTRA_SYMS.map(fetchYahooIntra));
  MACRO_INTRA_SYMS.forEach(function (sym, i) {
    var hit = _macroSnap.filter(function (m) { return m.sym === sym; })[0];
    if (hit) hit.intra = (intras[i].status === 'fulfilled') ? intras[i].value : null;
    if (intras[i].status === 'rejected') hush('news', intras[i].reason);
  });
  _nightFut = await fetchNightFutures();
  // 加權指數分時：本機 Shioaji，失敗不影響其餘七格（那一格不畫就是了）
  try { await loadTwIdxIntra(); } catch (e) { hush('news', e); }
  // 台指期分時：參考價來自上面那個快照，沒有快照就不畫圖
  try { await loadTxfIntra(_nightFut && _nightFut.ref); } catch (e) { hush('news', e); }
  // 日圓中間價：只拿來畫線形，抓不到就這格不畫圖，數字照舊
  try { await loadJpyMid(); } catch (e) { hush('news', e); }
  _macroAt = Date.now();
  _macroCacheWrite();
  renderMacroBar();
  if (typeof renderDrawerMacro === 'function') renderDrawerMacro();
  // 玉山牌告匯率（10 分鐘快取）非阻塞補上，回來後重繪
  loadEsunFx().then(function () {
    _macroCacheWrite();
    renderMacroBar();
    if (typeof renderDrawerMacro === 'function') renderDrawerMacro();
  });
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

// 每格的資料時間小字。這裡標的是「資料本身的時刻」（交易所成交時間、銀行掛牌時間），
// 不是我們打 API 的時刻 —— 美股收盤後兩者會差好幾個小時，混在一起標會讓人
// 以為收盤價是即時價。抓取時刻另外標在盤勢標頭。
function _macroAtHtml(ms, lab) {
  if (!ms) return '';
  return '<span class="macro-at">' + (lab || '') + _asOfTxt(ms) + '</span>';
}

// ── 每格的近一個月走勢小圖 ──
// 資料用本來就抓回來的日K（range=1mo，原本是給警示算累計用的），不另外打請求。
// 基準線取區間第一根收盤：這張圖回答「現在相對一個月前」。右邊的百分比回答的是
// 「今天相對昨天」，兩者問的不是同一件事，所以同一格的線色與百分比可能相反。
// 畫法與即時持股的分時小圖同一套：基準線以上紅、以下綠，跨線處在交點切開。
var MSPK_W = 100, MSPK_H = 26;
function _macroSparkHtml(m) {
  var b = m.bars;
  if (!b || b.length < 3) return '';
  var cs = b.map(function (r) { return r.c; });
  var ds = b.map(function (r) { return r.d; });
  var liveK = -1;   // 最後一點是現價而不是收盤時，標在哪一格
  // 端點換成最新報價，圖的尾巴才跟格子裡的數字是同一個價
  if (m.price != null && m.asOf) {
    var d = new Date(m.asOf).toISOString().slice(0, 10);
    if (d === b[b.length - 1].d) { cs[cs.length - 1] = m.price; }
    else { cs.push(m.price); ds.push(d); }
    liveK = cs.length - 1;
  }
  var n = cs.length, ref = cs[0];
  var hi = Math.max.apply(null, cs), lo = Math.min.apply(null, cs);
  var pad = (hi - lo) * 0.08 || Math.abs(ref) * 0.01 || 1;
  hi += pad; lo -= pad;
  var x = function (k) { return k / (n - 1) * MSPK_W; };
  var y = function (p) { return (hi - p) * MSPK_H / (hi - lo); };
  var yRef = y(ref), upLn = '', dnLn = '', upFl = '', dnFl = '';
  var seg = function (xa, ya, xb, yb, red) {
    var ln = 'M' + xa.toFixed(1) + ' ' + ya.toFixed(1) + 'L' + xb.toFixed(1) + ' ' + yb.toFixed(1);
    var fl = ln + 'L' + xb.toFixed(1) + ' ' + yRef.toFixed(1) + 'L' + xa.toFixed(1) + ' ' + yRef.toFixed(1) + 'Z';
    if (red) { upLn += ln; upFl += fl; } else { dnLn += ln; dnFl += fl; }
  };
  for (var k = 0; k < n - 1; k++) {
    var ca = cs[k], cb = cs[k + 1], xa = x(k), xb = x(k + 1);
    if ((ca >= ref) === (cb >= ref)) { seg(xa, y(ca), xb, y(cb), ca >= ref); continue; }
    var xc = xa + (xb - xa) * (ref - ca) / (cb - ca);
    seg(xa, y(ca), xc, yRef, ca >= ref);
    seg(xc, yRef, xb, y(cb), cb >= ref);
  }
  var last = cs[n - 1];
  var pct = ref ? (last - ref) / ref * 100 : null;
  var tip = '近 ' + n + ' 個交易日收盤走勢　基準線＝區間起點 ' + _fmtNum(ref, m.fmt) +
    (pct == null ? '' : '　至今 ' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%') +
    '　（此處比的是一個月前，與右邊的當日漲跌不同基準）' + (m.note || '');
  // hover 用的點位。寫在 data 屬性上，滑鼠移上來直接讀，不必每次重繪都重算。
  // 格式：日期|收盤|x|y|相對基準%，以 ; 分隔；最後一點若是現價，日期寫成空字串。
  // 百分比在這裡就算好，hover 時只讀不算。比的是基準線（區間起點），
  // 與線色同一個基準，所以紅線上的點必是正數，不會自相矛盾。
  var pts = [];
  for (var j = 0; j < n; j++) {
    var dp = ref ? (cs[j] - ref) / ref * 100 : null;
    pts.push((j === liveK ? '' : ds[j].slice(5).replace('-', '/')) + '|' +
      _fmtNum(cs[j], m.fmt) + '|' + x(j).toFixed(1) + '|' + y(cs[j]).toFixed(1) + '|' +
      (dp == null ? '' : (dp > 0 ? '+' : '') + dp.toFixed(2)));
  }
  return '<span class="macro-spark" title="' + tip.replace(/"/g, '&quot;') + '"' +
    ' data-pts="' + pts.join(';') + '">' +
    '<svg viewBox="0 0 ' + MSPK_W + ' ' + MSPK_H + '" preserveAspectRatio="none">' +
    (dnFl ? '<path class="ck-fill dn" d="' + dnFl + '"/>' : '') +
    (upFl ? '<path class="ck-fill up" d="' + upFl + '"/>' : '') +
    '<line class="ck-ref lc-ln" x1="0" y1="' + yRef.toFixed(1) + '" x2="' + MSPK_W + '" y2="' + yRef.toFixed(1) + '"/>' +
    (dnLn ? '<path class="ck-iline dn lc-ln" d="' + dnLn + '"/>' : '') +
    (upLn ? '<path class="ck-iline up lc-ln" d="' + upLn + '"/>' : '') +
    '<line class="mspk-cross lc-ln" x1="0" y1="0" x2="0" y2="' + MSPK_H + '" style="display:none"/>' +
    '<circle class="mspk-dot" r="2" cx="0" cy="0" style="display:none"/>' +
    '</svg></span>';
}

// ── 小圖的滑鼠指示 ──
// 事件掛在 document 上做委派：盤勢每 10 分鐘整批重繪，逐格綁監聽器會重繪幾次疊幾層。
// 原生 title 保留（寫基準與區間漲跌），它給不了「現在指著哪一天」，所以另外做這個浮層。
var _mspkTipEl = null, _mspkCur = null;
function _mspkTip() {
  if (!_mspkTipEl) {
    _mspkTipEl = document.createElement('div');
    _mspkTipEl.className = 'macro-tip';
    _mspkTipEl.style.display = 'none';
    document.body.appendChild(_mspkTipEl);
  }
  return _mspkTipEl;
}
function _mspkClear() {
  if (_mspkCur) {
    var c = _mspkCur.querySelector('.mspk-cross'), o = _mspkCur.querySelector('.mspk-dot');
    if (c) c.style.display = 'none';
    if (o) o.style.display = 'none';
    _mspkCur = null;
  }
  if (_mspkTipEl) _mspkTipEl.style.display = 'none';
}
document.addEventListener('mousemove', function (ev) {
  var sp = ev.target && ev.target.closest ? ev.target.closest('.macro-spark') : null;
  if (!sp || !sp.dataset.pts) { _mspkClear(); return; }
  if (_mspkCur && _mspkCur !== sp) _mspkClear();
  _mspkCur = sp;
  var pts = sp.dataset.pts.split(';');
  var r = sp.getBoundingClientRect();
  if (!r.width) return;
  var k = Math.round((ev.clientX - r.left) / r.width * (pts.length - 1));
  if (k < 0) k = 0; if (k > pts.length - 1) k = pts.length - 1;
  var f = pts[k].split('|');
  var cross = sp.querySelector('.mspk-cross'), dot = sp.querySelector('.mspk-dot');
  if (cross) { cross.setAttribute('x1', f[2]); cross.setAttribute('x2', f[2]); cross.style.display = ''; }
  if (dot) { dot.setAttribute('cx', f[2]); dot.setAttribute('cy', f[3]); dot.style.display = ''; }
  var t = _mspkTip();
  t.innerHTML = '<b>' + (f[0] || '現價') + '</b>　' + f[1] +
    (f[4] === '' || f[4] == null ? ''
      : '　<span class="' + (parseFloat(f[4]) > 0 ? 'up' : (parseFloat(f[4]) < 0 ? 'down' : 'flat')) +
        '">' + f[4] + '%</span>');
  t.style.display = '';
  // 預設貼在圖的上緣，貼到視窗邊界就往內收
  var tw = t.offsetWidth, th = t.offsetHeight;
  var left = Math.min(Math.max(4, ev.clientX - tw / 2), window.innerWidth - tw - 4);
  var top = r.top - th - 6;
  if (top < 4) top = r.bottom + 6;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
});
// 抽屜收起、頁面捲動、滑鼠離開視窗：殘留的浮層要收掉
document.addEventListener('scroll', _mspkClear, true);
window.addEventListener('blur', _mspkClear);

// ── 美股五格的當盤分時 ──
// 抽屜看的是「今晚美股對今天台股開盤的影響」，近一個月的日線回答不了這件事：
// 台股開盤前要知道的是這一盤走成什麼樣，不是一個月的趨勢。所以抽屜改畫分時，
// 基準線用 chartPreviousClose（美股昨收），與格子右邊的當日漲跌同一個基準。
//
// 日線不能拔掉：HYG 與美10年殖利率的警示算的是「台股收盤後至今的累計變動」，
// 那是跨日的計算，要日線才做得出來（見 _macroCum）。所以日線照抓，分時另外抓一份。
//
// 均價線用當盤累計算術平均，不是 VWAP：實測只有 ^IXIC 與 HYG 有成交量，
// ^SOX／^VIX／^TNX 的 volume 全為 0，算不出 VWAP。五格用同一個定義才不會各說各話。
// 分時序列有沒有真的在動。沒動就不該畫分時——一條直線看起來像只有一個值。
// 2026-11-12 實測 ^TNX：Yahoo 給了 41 個 5 分鐘點，41 個全是 4.998，
// 因為殖利率指數的盤中報價更新極疏。這種時候退回日線，
// 至少看得到近一個月的走勢，而不是一条無資訊的平線。
function _intraVaries(i) {
  if (!i || !i.c || i.c.length < 3) return false;
  var hi = Math.max.apply(null, i.c), lo = Math.min.apply(null, i.c);
  return hi > lo;
}
var MACRO_INTRA_SYMS = ['^IXIC', '^SOX', '^VIX', '^TNX', 'HYG'];
async function fetchYahooIntra(sym) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=5m&range=1d';
  var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
  var j = await r.json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(sym + ' no intra');
  var m = res.meta || {}, ts = res.timestamp || [];
  var raw = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  var off = (m.gmtoffset || 0);
  var t = [], c = [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] == null || ts[i] == null) continue;
    // 標的所在交易所的當地時間（^VIX／^TNX 是芝加哥、其餘紐約），與 Yahoo 畫的一致
    t.push(new Date((ts[i] + off) * 1000).toISOString().slice(11, 16));
    c.push(raw[i]);
  }
  if (c.length < 3) throw new Error(sym + ' intra too few');
  var avg = [], sum = 0;
  for (var k = 0; k < c.length; k++) { sum += c[k]; avg.push(sum / (k + 1)); }
  var ref = (m.chartPreviousClose != null) ? m.chartPreviousClose : null;
  // 每一檔的交易時段 Yahoo 自己會給，不用寫死：
  // ^IXIC／HYG 09:30–16:00（紐約）、^TNX 07:20–14:00、^VIX 02:00–15:15（苝加哥）
  var hm = function (ts) { return new Date((ts + off) * 1000).toISOString().slice(11, 16); };
  var rg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  var span = (rg && rg.start && rg.end) ? { from: hm(rg.start), to: hm(rg.end) } : null;
  return { t: t, c: c, avg: avg, ref: ref, span: span, tz: m.exchangeTimezoneName || '' };
}

// ── 加權指數的當日分時（抽屜第一格）──
// 比照券商 App 的大盤「詳細」頁：分時線 ＋ 均價線 ＋ 昨收基準，昨收之上紅、之下綠。
// 資料來自本機 Shioaji 的指數分 K：security_type IND、exchange TSE、code 001。
// 抓 10 天、只取最後一個有資料的交易日 → 非盤中時段自動顯示最近交易日。
//
// 均價線＝當日到該分鐘為止所有分 K 收盤的算術平均。
// 不能用 Amount ÷ Volume：指數分 K 的這兩個欄位是全市場的成交金額與股數，
// 相除得到的是「每股平均成交價」（幾十元），跟三萬多點的指數不是同一個量級。
//
// 這一格的時間軸與同一排其他格不同（它是今天，其他是近一個月日 K），
// 所以名稱後面固定標「今日」，第二行標資料日期。
var _twIdxIntra = null;      // { day, t[], c[], avg[], ref, last, pct }
async function loadTwIdxIntra() {
  var d = function (t) { return new Date(t.getTime() + 8 * 3600000).toISOString().slice(0, 10); };
  var now = new Date();
  var r = await fetch(API + '/api/v1/data/kbars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract: { security_type: 'IND', exchange: 'TSE', code: '001' },
      start: d(new Date(now.getTime() - 10 * 86400000)), end: d(now) })
  });
  if (!r.ok) throw new Error('指數分K HTTP ' + r.status);
  var j = await r.json();
  if (!j || !j.datetime || !j.datetime.length) throw new Error('無指數分K');
  var day = j.datetime[j.datetime.length - 1].slice(0, 10);
  // 昨收：取前一個交易日的最後一根收盤。快照的 change_price 也能回推，
  // 但快照盤後會停更，用同一份 K 線資料推比較不會兩邊對不起來。
  var prevClose = null, t = [], c = [];
  for (var i = 0; i < j.datetime.length; i++) {
    if (j.datetime[i].slice(0, 10) === day) { t.push(j.datetime[i].slice(11, 16)); c.push(j.Close[i]); }
    else prevClose = j.Close[i];
  }
  if (!c.length) throw new Error('當日無指數分K');
  var avg = [], sum = 0;
  for (var k = 0; k < c.length; k++) { sum += c[k]; avg.push(sum / (k + 1)); }
  var last = c[c.length - 1];
  _twIdxIntra = { day: day, t: t, c: c, avg: avg, ref: prevClose, last: last,
    span: { from: '09:00', to: '13:30' },
    pct: prevClose ? (last - prevClose) / prevClose * 100 : null };
  return _twIdxIntra;
}

// 分時小圖（加權指數與台指期共用）。與其他格共用 MSPK_W/MSPK_H 與紅綠切線那一套，
// 差別有二：基準線是參考價（不是區間起點），而且多畫一條均價線。
// o = { t[], c[], avg[], ref, fmt, note }
function _intraSparkHtml(o) {
  var c = o.c, n = c.length;
  if (n < 3 || !o.ref) return '';
  var ref = o.ref, fmt = o.fmt || 0;
  var hi = Math.max.apply(null, c), lo = Math.min.apply(null, c);
  // 基準線一定要在圖內，否則「在昨收之上或之下」看不出來
  if (ref > hi) hi = ref;
  if (ref < lo) lo = ref;
  var pad = (hi - lo) * 0.08 || Math.abs(ref) * 0.001 || 1;
  hi += pad; lo -= pad;
  // 橫軸用「整盤有多長」當分母，不是「拿到幾個點」。
  //
  // 舊寫法 x = k/(n-1)，最後一點永遠貼右緣——盤中看起來跟收盤後一模一樣，
  // 看不出這一盤還剩多少。2026-11-12 紐約 12:47 實測：
  // ^IXIC／^SOX／HYG 才走完 50.5%、^TNX 63.0%、^VIX 71.9%，三個不同的位置
  // 全被畫成一樣滿。改成時間刻度後，線走到哪停到哪，右側留白。
  //
  // span 是該標的的盤別窗（HH:MM），由各自的資料來源給：
  // Yahoo 各檔的交易時段寫在回應的 meta 裡（連 ^VIX 跨到苝加哥時間都正確），
  // 台股與台指期則是固定的。沒給 span 就沒事，退回舊行為。
  var x;
  if (o.span && o.span.from && o.span.to && o.t && o.t.length === n) {
    var mn = function (hm) { return (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5)); };
    var s0 = mn(o.span.from), tot = mn(o.span.to) - s0;
    if (tot <= 0) tot += 1440;                        // 夜盤跨午夜
    x = function (k) {
      var v = mn(o.t[k]) - s0;
      if (v < 0) v += 1440;
      return Math.max(0, Math.min(1, v / tot)) * MSPK_W;
    };
  } else {
    x = function (k) { return k / (n - 1) * MSPK_W; };
  }
  var y = function (p) { return (hi - p) * MSPK_H / (hi - lo); };
  var yRef = y(ref), upLn = '', dnLn = '', upFl = '', dnFl = '';
  var seg = function (xa, ya, xb, yb, red) {
    var ln = 'M' + xa.toFixed(1) + ',' + ya.toFixed(1) + 'L' + xb.toFixed(1) + ',' + yb.toFixed(1);
    var fl = ln + 'L' + xb.toFixed(1) + ',' + yRef.toFixed(1) + 'L' + xa.toFixed(1) + ',' + yRef.toFixed(1) + 'Z';
    if (red) { upLn += ln; upFl += fl; } else { dnLn += ln; dnFl += fl; }
  };
  for (var k = 0; k < n - 1; k++) {
    var ca = c[k], cb = c[k + 1], xa = x(k), xb = x(k + 1);
    if ((ca >= ref) === (cb >= ref)) { seg(xa, y(ca), xb, y(cb), ca >= ref); continue; }
    var xc = xa + (xb - xa) * (ref - ca) / (cb - ca);
    seg(xa, y(ca), xc, yRef, ca >= ref);
    seg(xc, yRef, xb, y(cb), cb >= ref);
  }
  // 均價線：單一灰線，不分紅綠（它是一條平均，沒有「漲或跌」可言）
  var av = [];
  for (var a = 0; a < n; a++) av.push(x(a).toFixed(1) + ',' + y(o.avg[a]).toFixed(1));
  // hover 的資料：時間|指數|x|y|相對昨收%，與其他小圖同一個格式
  var pts = [];
  for (var p = 0; p < n; p++) {
    var dp = (c[p] - ref) / ref * 100;
    pts.push(o.t[p] + '|' + _fmtNum(c[p], fmt) + '|' + x(p).toFixed(1) + '|' +
      y(c[p]).toFixed(1) + '|' + (dp > 0 ? '+' : '') + dp.toFixed(2));
  }
  var tip = o.note + '　基準線＝參考價 ' + _fmtNum(ref, fmt) +
    '　（此處比的是參考價，與其他格的近一個月不同基準）' +
    (o.span && o.span.from ? '　橫軸＝' + o.span.from + '～' + o.span.to
      + '，右側留白是還沒走完的那一段' : '');
  return '<span class="macro-spark" title="' + tip.replace(/"/g, '&quot;') + '"' +
    ' data-pts="' + pts.join(';') + '">' +
    '<svg viewBox="0 0 ' + MSPK_W + ' ' + MSPK_H + '" preserveAspectRatio="none">' +
    (dnFl ? '<path class="ck-fill dn" d="' + dnFl + '"/>' : '') +
    (upFl ? '<path class="ck-fill up" d="' + upFl + '"/>' : '') +
    '<line class="ck-ref lc-ln" x1="0" y1="' + yRef.toFixed(1) + '" x2="' + MSPK_W + '" y2="' + yRef.toFixed(1) + '"/>' +
    (dnLn ? '<path class="ck-iline dn lc-ln" d="' + dnLn + '"/>' : '') +
    (upLn ? '<path class="ck-iline up lc-ln" d="' + upLn + '"/>' : '') +
    '<polyline class="mspk-avg lc-ln" points="' + av.join(' ') + '"/>' +
    '<line class="mspk-cross lc-ln" x1="0" y1="0" x2="0" y2="' + MSPK_H + '" style="display:none"/>' +
    '<circle class="mspk-dot" r="2" cx="0" cy="0" style="display:none"/>' +
    '</svg></span>';
}

// 抽屜第一格。時間前面固定標「分時」：同一排其他格的小圖畫的是近一個月日 K，
// 這一格是當日分時，不標會被讀成同一個期間。前綴掛在第二行而不是名稱後面 ——
// 四欄格子裡名稱是 nowrap ＋ ellipsis，多兩個字就會被截成「加權指…」。
function _twIdxCellHtml() {
  var o = _twIdxIntra;
  if (!o) return '';
  var at = o.day.slice(5).replace(/-/g, '/') + (o.t.length ? ' ' + o.t[o.t.length - 1] : '');
  return '<div class="macro-cell"><span class="macro-nm">' +
    '<span class="macro-name">加權指數</span>' +
    '<span class="macro-at">分時 ' + at + '</span></span>' +
    '<span class="macro-price">' + _fmtNum(o.last, 0) + '</span>' +
    '<span class="macro-chg ' + _chgCls(o.pct) + '">' + (_chgTxt(o.pct) || '—') + '</span>' +
    _intraSparkHtml({ t: o.t, c: o.c, avg: o.avg, ref: o.ref, span: o.span, fmt: 0,
      note: o.day + ' 當日分時　灰線＝當日累計平均指數' }) + '</div>';
}

// ── 台指期的當盤分時（抽屜最後一格）──
// 與加權指數那格同一套畫法，但均價線是真的 VWAP：
// 期貨分 K 的 Amount 就是點數 × 口數，累計相除即 VWAP。實測本盤 39,220.79，
// 對照快照的 average_price 39,217.3 差 3.5 點（0.009%，來自快照時點之後那幾根）。
// 加權指數那格做不到這件事 —— 指數的 Amount ÷ Volume 是全市場每股均價，量級不對。
//
// 盤別：分 K 間隔超過 2 分鐘就是換盤，實測乾淨切出
//   夜盤 15:01 → 次日 05:00（840 根，跨午夜，所以不能用日期分組）
//   日盤 08:46 → 13:45（300 根）
// 取最後一個區塊＝當下這一盤（盤與盤之間則是最近收完的那一盤）。
// 名稱跟著盤別走：原本固定寫「台指夜盤」，但這格抓的是 TXFR1 的當下快照、不分盤別，
// 所以白天會出現「台指夜盤 成交 12:28」這種自相矛盾的顯示（2026-11-06 實例）。
// 日盤與夜盤的參考價不同，不講是哪一盤就不知道那個百分比在比什麼。
var _txfIntra = null;        // { sess, t[], c[], avg[], ref, last, pct, day }
async function loadTxfIntra(ref) {
  if (ref == null) return null;
  var d = function (t) { return new Date(t.getTime() + 8 * 3600000).toISOString().slice(0, 10); };
  var now = new Date();
  var r = await fetch(API + '/api/v1/data/kbars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract: { security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' },
      start: d(new Date(now.getTime() - 4 * 86400000)), end: d(now) })
  });
  if (!r.ok) throw new Error('台指期分K HTTP ' + r.status);
  var j = await r.json();
  if (!j || !j.datetime || !j.datetime.length) throw new Error('無台指期分K');
  var ms = j.datetime.map(function (x) { return Date.parse(x); });
  // 盤別看「最後一根的時刻」，不再用「間隔超過 2 分鐘就是換盤」。
  // 凌晨成交稀疏，每隔幾分鐘就會斷一次：2026-11-11 03:19→03:22 斷 3 分鐘，
  // 舊邏輯把 03:22 當成新一盤起點，03:22 < 14:00 就標成「日盤」，
  // 分時圖也只剩後面那十幾根，整段夜盤走勢被砍掉。
  // 夜盤 15:00～次日 05:00、日盤 08:45～13:45，兩者不重疊，時刻就分得出來。
  var isNight = function (x) { var v = x.slice(11, 16); return v >= '15:00' || v <= '05:00'; };
  var night = isNight(j.datetime[j.datetime.length - 1]);
  var st = ms.length - 1;
  // 往回走到同一盤的起點；盤與盤之間至少隔 75 分鐘（日盤收到夜盤開），
  // 盤內再怎麼疏也不會斷 3 小時，用它當分界不會誤切。
  while (st > 0 && isNight(j.datetime[st - 1]) === night && ms[st] - ms[st - 1] <= 3 * 3600000) st--;
  var t = [], c = [], avg = [], cv = 0, ca = 0;
  for (var k = st; k < j.datetime.length; k++) {
    t.push(j.datetime[k].slice(11, 16));
    c.push(j.Close[k]);
    cv += (j.Volume[k] || 0); ca += (j.Amount[k] || 0);
    avg.push(cv > 0 ? ca / cv : j.Close[k]);   // 開盤第一根若無量，先用收盤頂著
  }
  if (c.length < 3) return (_txfIntra = null);
  var sess = night ? '夜盤' : '日盤';
  var last = c[c.length - 1];
  _txfIntra = { sess: sess, t: t, c: c, avg: avg, ref: ref, last: last,
    span: night ? { from: '15:00', to: '05:00' } : { from: '08:45', to: '13:45' },
    day: j.datetime[st].slice(0, 10), pct: (last - ref) / ref * 100 };
  return _txfIntra;
}

// 單格 HTML：新聞情勢頁的盤勢列與頂欄抽屜共用，避免兩邊各寫一份而漂走。
function _macroCellHtml(m, intra) {
  {
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
      '>' + icon + '<span class="macro-nm"><span class="macro-name">' + m.name + tag + '</span>' +
      _macroAtHtml(m.asOf) + '</span>' +
      '<span class="macro-price">' + _fmtNum(m.price, m.fmt) + '</span>' +
      '<span class="macro-chg ' + _chgCls(m.changePct) + '">' + (_chgTxt(m.changePct) || '—') + cumTxt + '</span>' +
      ((intra && m.intra && _intraVaries(m.intra))
      ? _intraSparkHtml({ t: m.intra.t, c: m.intra.c, avg: m.intra.avg, span: m.intra.span,
      ref: m.intra.ref, fmt: m.fmt, note: '當盤分時（' + (m.intra.tz || '當地') + '）　灰線＝當盤累計平均' })
      : _macroSparkHtml(m)) + '</div>';
  }
}

// 玉山日圓即期單格：換匯實際成交的價格（買入＝銀行跟你買，賣出＝銀行賣你）。
// Yahoo 的 JPYTWD=X 是國際中間價，換匯時拿不到，故另列一格供實際判斷。
function _esunJpyCellHtml() {
  if (!(_esun && _esun.rates && _esun.rates['日圓'])) return '';
  var jp = _esun.rates['日圓'];
  var at = _esun.at ? _esun.at.slice(5, 16).replace('T', ' ').replace('-', '/') : '—';   // 與其他格的 11/04 同格式
  return '<div class="macro-cell macro-fx" title="玉山銀行 網銀/App優惠 銀行賣出＝線上換匯時你買日圓要付的台幣。' +
    '　掛牌時間 ' + at + '　同時間即期賣出 ' + (jp.spotSell != null ? jp.spotSell.toFixed(4) : '—') + '">' +
    '<span class="macro-nm"><span class="macro-name">日圓網銀優惠<span class="macro-dim"> 玉山</span>' +
    '<button class="fx-reload" onclick="event.stopPropagation();esunReload(this)" title="重新抓牌告">↻</button></span>' +
    '<span class="macro-at">掛牌 ' + at +
    // 線與數字不同來源，標在格子上而不是只寫在 tooltip：
    // 不標會被讀成玉山自己的歷史牌告。
    (_jpyMid ? '<span class="macro-dim">　線＝中間價</span>' : '') + '</span></span>' +
    '<span class="macro-fx-pair"><span class="fx-lb">賣出</span><span class="fx-v">' +
    (jp.prefSell != null ? jp.prefSell.toFixed(4) : '—') + '</span></span>' +
    (_jpyMid ? _macroSparkHtml({ bars: _jpyMid.bars, price: _jpyMid.price, asOf: _jpyMid.asOf, fmt: 4,
      note: '　線是 Yahoo 的 JPYTWD=X 國際中間價，與上面那個玉山網銀優惠賣出不是同一個價' +
        '（差的是銀行價差）。這張圖看方向，絕對價位看數字。' }) : '') +
    '</div>';
}

// ── 日圓小圖的資料 ──
// 這一格的數字是玉山的網銀優惠賣出（爬牌告，只有「現在這一筆」）。
// 玉山不提供歷史牌告，畫不出它自己的走勢，所以線形借用 Yahoo 的 JPYTWD=X 國際中間價。
//
// 兩者不是同一個價：實測 2026-11-06 中間價 0.2065、玉山即期買入 0.2067、
// 網銀優惠賣出 0.2095、即期賣出 0.2107。中間價與格子上的數字差約 1.45%，那是銀行價差。
// 所以這張圖只回答「日圓這一個月往哪走」，絕對價位要看格子上的數字。
//
// 刻意不做的事：把中間價整條平移、讓尾端對上 0.2095。那等於宣稱一個月前玉山的價差
// 也是 0.0030，是編出來的數字。線與數字接不起來是事實，標清楚比抹平誠實。
// 另一個已知限制：銀行價差這一個月是否穩定無法驗證（沒有玉山歷史可比），
// 價差若變動，線形的方向大致對、幅度不保證。
//
// 長期解：下面的 _esunJpyHistPush 從今天起把每天的玉山牌告記進 localStorage，
// 累積夠多之後這張圖可以換成真正的玉山走勢。只在你開過頁的日子有資料，會是斷續序列。
var _jpyMid = null;          // Yahoo JPYTWD=X：{ price, asOf, bars[], fmt }
async function loadJpyMid() {
  _jpyMid = await fetchYahooQuote({ name: '日圓中間價', sym: 'JPYTWD=X', fmt: 4 });
  return _jpyMid;
}

// 玉山牌告的自記歷史。一天一筆（同一天重複開頁就更新成最後看到的值）。
// 上限 400 筆：一年多的交易日，localStorage 放得下，也夠一張月線圖用很久。
var ESUN_JPY_HIST_LS = 'esun_jpy_hist_v1';
function _esunJpyHistRead() {
  try { var a = JSON.parse(localStorage.getItem(ESUN_JPY_HIST_LS)); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function _esunJpyHistPush() {
  if (!(_esun && _esun.rates && _esun.rates['日圓'])) return;
  var v = _esun.rates['日圓'].prefSell;
  if (v == null) return;
  // 日期用牌告時間，不是現在：盤後才開頁時記的仍是那天的牌告
  var d = (_esun.at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  var a = _esunJpyHistRead();
  if (a.length && a[a.length - 1].d === d) a[a.length - 1].s = v;
  else a.push({ d: d, s: v });
  if (a.length > 400) a = a.slice(a.length - 400);
  try { localStorage.setItem(ESUN_JPY_HIST_LS, JSON.stringify(a)); } catch (e) { hush('news', e); }
}

// ── 日圓買入提醒 ──
// 門檻比的是「網銀優惠賣出」：那是線上換匯時你買日圓實際付的價格，
// 不是即期中間價，也不是銀行跟你買的「買入」。數字愈低愈划算，所以是 ≤ 門檻才提醒。
// 只設一個門檻（只買不賣，不需要上下限）。純數字設定，照 sbl 那組的做法存 localStorage。
var FX_JPY_KEY = 'fx_jpy_alert_v1';
function fxJpyThr() {
  var v = parseFloat(localStorage.getItem(FX_JPY_KEY));
  return isNaN(v) ? null : v;
}
function fxJpySet(v) {
  var n = parseFloat(v);
  try {
    if (v === '' || v == null || isNaN(n)) localStorage.removeItem(FX_JPY_KEY);
    else localStorage.setItem(FX_JPY_KEY, n);
  } catch (e) {}
  if (typeof renderSummary === 'function') renderSummary();
}
// 目前牌告的網銀優惠賣出價；沒抓到回 null
function fxJpySell() {
  var jp = _esun && _esun.rates && _esun.rates['日圓'];
  return (jp && jp.prefSell != null) ? jp.prefSell : null;
}
function fxJpyHit() {
  var t = fxJpyThr(), v = fxJpySell();
  return (t != null && v != null && v <= t);
}

// 持股庫存合計列的日圓格。資料沿用既有的玉山牌告（10 分鐘快取），不另外抓。
// 抓不到牌告就整格不出現 —— 顯示「—」只會佔位置，沒有資訊。
function fxJpyPairHtml() {
  var v = fxJpySell();
  if (v == null) {
    if (typeof loadEsunFx === 'function') loadEsunFx();   // 還沒抓就順手觸發，下次重繪就有
    return '';
  }
  var t = fxJpyThr(), hit = fxJpyHit();
  var dot = hit ? '<span class="fx-hit" title="已達門檻"></span>' : '';
  var tip = '玉山網銀／App 優惠賣出，線上換匯時你買日圓付的價格'
    + (t != null ? '｜門檻 ' + t.toFixed(4) + (hit ? '（已達）' : '（未達）') : '｜未設門檻，可在設定 → 匯率提醒填');
  return '<span class="sum-pair" title="' + tip + '">' +
    '<span class="sum-plabel">日圓網銀優惠</span>' +
    '<span class="sum-pval"' + (hit ? ' style="color:var(--accent2)"' : '') + '>' +
    dot + v.toFixed(4) + '</span></span>';
}

// 牌告一天變動多次，抽屜又有 10 分鐘快取 → 給一個手動重抓的入口
async function esunReload(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await loadEsunFx(true);
    if (typeof _macroCacheWrite === 'function') _macroCacheWrite();
    renderMacroBar();
    if (typeof renderDrawerMacro === 'function') renderDrawerMacro();
  } catch (e) {
    console.warn('[玉山牌告]', e);
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
  }
}

// 台指夜盤單格（不在 MACRO_TICKERS 裡，另外抓）
function _nightFutCellHtml() {
  if (!_nightFut) return '';
  // 名稱跟著盤別走，不再固定寫「夜盤」。分 K 抓不到時退回原本的純數字顯示。
  var o = _txfIntra;
  var nm = '台指期' + (o ? o.sess : '');
  var spark = o ? _intraSparkHtml({ t: o.t, c: o.c, avg: o.avg, ref: o.ref, span: o.span, fmt: 0,
    note: o.day.slice(5).replace(/-/g, '/') + ' ' + o.sess + ' 分時　灰線＝VWAP（累計成交金額 ÷ 累計口數）' }) : '';
  return '<div class="macro-cell"><span class="macro-nm"><span class="macro-name">' + nm + '</span>' +
    (_nightFut.time ? '<span class="macro-at">成交 ' + _nightFut.time + '</span>' : '') + '</span>' +
    '<span class="macro-price">' + _fmtNum(_nightFut.price, 0) + '</span>' +
    '<span class="macro-chg ' + _chgCls(_nightFut.changePct) + '">' + (_chgTxt(_nightFut.changePct) || '—') + '</span>' +
    spark + '</div>';
}

// 頂欄抽屜的盤勢：加權指數（當日分時）＋ 五檔 ＋ 日圓即期 ＋ 台指夜盤，排 4×2。
// 不含美元指數與美元兌台幣（抽屜只有四欄）。
// S&P 500 只在抽屜略過，不從 MACRO_TICKERS 刪：新聞情勢頁那排要留，
// 而且加減碼報告的系統性風險評分也在用它。
var MACRO_DRAWER_SKIP = ['DX-Y.NYB', 'TWD=X', '^GSPC'];
function macroDrawerHtml() {
  if (!_macroSnap.length) return '<div class="macro-cell"><span class="macro-name">載入中…</span></div>';
  // 大盤排第一格：這是台股投資組合的工具，本地市場應該在美股前面
  return _twIdxCellHtml() +
    _macroSnap.filter(function (m) { return MACRO_DRAWER_SKIP.indexOf(m.sym) < 0; })
    .map(function (m) { return _macroCellHtml(m, true); }).join('') +
    _esunJpyCellHtml() + _nightFutCellHtml();
}

// 抓取時刻 ＋ 手動重抓。跟格子裡的資料時間分開標：
// 這個是「我這邊打 API 的時刻」，格子裡那個是「資料本身的時刻」。
function macroFetchHtml() {
  if (!_macroAt) return '';
  return '<span class="macro-fetch">抓取 ' + _asOfTxt(_macroAt) + '　<b>' + _agoTxt(_macroAt) + '</b>' +
    '<button class="fx-reload" onclick="event.stopPropagation();macroReload(this)" ' +
    'title="略過 10 分鐘快取，整批重新抓取">↻</button></span>';
}
// 整批重抓：繞過 10 分鐘快取。玉山牌告也一起強制重抓，
// 否則按了「重新抓取」牌告卻還是快取裡那份，跟按鈕的字對不上。
async function macroReload(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await ensureMacro(true);
    await loadEsunFx(true);
    _macroCacheWrite();
  } catch (e) { console.warn('[盤勢]', e); }
  renderMacroBar();
  if (typeof renderDrawerMacro === 'function') renderDrawerMacro();
}

// ── 自動更新 ──
// 每 60 秒檢查「距離上次抓取是否已滿 TTL」，不是設一個 10 分鐘的 interval：
// 分頁被瀏覽器凍結或電腦睡眠時計時器不會補跑，固定 interval 會漂成 20、30 分鐘才抓一次。
// 這個檢查順便每分鐘重畫「n 分鐘前」那行，否則抽屜不重開就一直停在展開當下的數字。
var _macroTimer = null;
var _macroLoading = false;
// 看得到才抓：一輪是 11 個請求，沒人在看照打除了浪費還會提高被 Yahoo 擋的機會。
function _macroVisible() {
  if (document.hidden) return false;
  if (typeof _dwOpen !== 'undefined' && _dwOpen) return true;          // 頂欄抽屜展開中
  var el = document.getElementById('macro-bar');
  return !!(el && el.innerHTML && el.offsetParent !== null);           // 人在新聞情勢頁
}
// 只換標頭那一行。兩個地方（抽屜、新聞情勢頁）可能同時存在，一起換。
function renderMacroFetch() {
  var h = macroFetchHtml();
  [].forEach.call(document.querySelectorAll('.macro-fetch'), function (s) { s.outerHTML = h; });
}
async function _macroTick() {
  if (_macroLoading || !_macroAt || !_macroVisible()) return;   // 第一次抓由展開抽屜那條路徑負責
  if (Date.now() - _macroAt < MACRO_TTL_MS) { renderMacroFetch(); return; }
  _macroLoading = true;
  try { await loadMacro(); } catch (e) { console.warn('[盤勢自動更新]', e); }
  finally { _macroLoading = false; }
}
if (!_macroTimer) _macroTimer = setInterval(_macroTick, 60000);
// 分頁切回來時立刻補一次：背景時不抓，可能已經過期很久了
document.addEventListener('visibilitychange', function () { if (!document.hidden) _macroTick(); });

function renderMacroBar() {
  var el = document.getElementById('macro-bar');
  if (!el) return;
  // 不能直接把 _macroCellHtml 當 callback：map 會把索引當第二個參數傳進去，
  // 而第二個參數是「畫分時」的旗標 —— 索引 1 以後全為真，這一頁就會變成分時圖。
  // 新聞情勢頁要的是近一個月的趨勢，不是今晚這一盤。
  var cells = _macroSnap.map(function (m) { return _macroCellHtml(m); });
  // 玉山日圓即期匯率：換匯實際成交的價格（買入＝銀行跟你買，賣出＝銀行賣你）。
  // Yahoo 的 JPYTWD=X 是國際中間價，換匯時拿不到，故另列一格供實際判斷。
  // 新聞情勢頁維持即期買入／賣出（換匯前後都要看），抽屜那格只給線上換匯會用到的優惠賣出
  if (_esun && _esun.rates && _esun.rates['日圓']) {
    var jp2 = _esun.rates['日圓'];
    cells.push('<div class="macro-cell macro-fx" title="玉山銀行牌告即期匯率　掛牌時間 ' +
      (_esun.at ? _esun.at.slice(5, 16).replace('T', ' ') : '—') +
      '　銀行買入＝你賣日圓可換得的台幣；銀行賣出＝你買日圓要付的台幣">' +
      '<span class="macro-nm"><span class="macro-name">日圓即期<span class="macro-dim"> 玉山</span></span>' +
      '<span class="macro-at">掛牌 ' + (_esun.at ? _esun.at.slice(5, 16).replace('T', ' ').replace('-', '/') : '—') + '</span></span>' +
      '<span class="macro-fx-pair"><span class="fx-lb">買入</span><span class="fx-v">' +
      (jp2.spotBuy != null ? jp2.spotBuy.toFixed(4) : '—') + '</span>' +
      '<span class="fx-lb">賣出</span><span class="fx-v">' +
      (jp2.spotSell != null ? jp2.spotSell.toFixed(4) : '—') + '</span></span></div>');
  }
  if (_nightFut) cells.push(_nightFutCellHtml());
  // 每格都標了自己的資料時間，這一行不再重述報價時間範圍，只標抓取時刻與重抓入口。
  var head = '';
  if (_macroAt) {
    head = '<div class="macro-asof">' + macroFetchHtml() + '</div>'
      + '<div class="nv-note">各格第二行是該項<b>資料本身的時間</b>（台北），'
      + '與最上方的「抓取」不同：那個是我這邊打 API 的時刻。美股收盤後顯示收盤價。'
      + '小圖是<b>近一個月的日收盤走勢</b>，基準線是區間起點，'
      + '跟格子右邊的當日漲跌<b>不是同一個基準</b>。'
      + '滑過小圖可看每一天的數字；亮⚙的那格是累計變動達門檻，說明在下方。</div>';
  }
  // 警示說明：亮燈了才寫，平常不佔版面
  var hits = _macroSnap.filter(function (m) { return m.alert; });
  var foot = '';
  if (hits.length) {
    foot = '<div class="detail-note nb-keep">' +
      hits.map(function (m) {
        var a = m.alert, c = a.cfg;
        return '<span class="macro-warn ' + a.level + '">⚠</span>' + m.name + ' ' +
          c.word + ' ' + a.mag.toFixed(c.dp) + ' ' + c.unit +
          '（' + (a.level === 'alarm' ? '紅色警告' : '黃色警示') + '門檻 ' +
          (a.level === 'alarm' ? c.alarm : c.warn) + ' ' + c.unit + '）';
      }).join('　') +
      // 警示本文一直顯示，只有下面這段說明收合
      '<div class="detail-note"><dl>' +
      '<dt>適用對象</dt><dd>' + ALERT_FOR + '持股，其他類型不適用。</dd>' +
      '<dt>幅度</dt><dd>台股 ' + (_twLastClose || '—') + ' 收盤後<b>累計</b>，不是單日。</dd>' +
      '<dt>門檻</dt><dd>近 2 年美股日變動的第 90（黃）與 97.5（紅）百分位，黃色一年約 24 次、紅色約 5～6 次。</dd>' +
      '<dt>意義</dt><dd>「該留意」不是買賣訊號。觸發後隔一個台股交易日，四檔非投債平均 -0.13% ～ -0.19%，' +
      '無條件基準 -0.01%。</dd>' +
      '</dl></div></div>';
  }
  // 圖表區的說明：原本分散在每一格的滑過提示裡，分頁後寫出來。
  el.innerHTML = head + '<div class="macro-row">' + cells.join('') + '</div>' + foot;
}

// 來源的 RSS 不保證是合法 XML。實測 2026-10-23 鉅亨台股第 584 行：
//   caption="過去70年間S&P 500指數於歷次期中選舉後一年的報酬均為正…"
// 「S&P」的 & 沒有跳脫，整份裡這樣的裸 & 有 8 處（還包括 &nbsp;，那也不是
// XML 認得的實體，XML 只認 amp/lt/gt/quot/apos）。GAS 端用 XmlService.parse
// 嚴格解析，碰到就整個來源失敗，畫面顯示一長串 SAXParseException。
// 這是對方的問題，但不該讓整個來源消失，所以把不合法的 & 補成 &amp; 之後自己解析。
function _newsFixXml(txt) {
  return txt.replace(/&nbsp;/g, ' ')
            .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

// 取 <item> 的直接子元素。不用 querySelector('link')：RSS 常同時有 <link> 與
// <atom:link>，在 XML 模式下前綴的比對行為各家不一，直接看 localName 才準。
function _newsField(item, tag) {
  for (var i = 0; i < item.children.length; i++) {
    var c = item.children[i];
    if (!c.prefix && (c.localName || c.nodeName) === tag) return (c.textContent || '').trim();
  }
  return '';
}

async function _fetchFeedRaw(feed) {
  var r = await fetch(NEWS_GAS_URL + '?urltext=' + encodeURIComponent(feed.url));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  var doc = new DOMParser().parseFromString(_newsFixXml(await r.text()), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML 修補後仍無法解析');
  var items = doc.getElementsByTagName('item');
  if (!items.length) throw new Error('XML 內沒有 item');
  return [].map.call(items, function (it) {
    return { source: feed.name, title: _newsField(it, 'title'), link: _newsField(it, 'link'),
             time: new Date(_newsField(it, 'pubDate')) };
  });
}

async function fetchFeed(feed) {
  try {
    var r = await fetch(NEWS_GAS_URL + '?rss=' + encodeURIComponent(feed.url));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    if (j.stat !== 'OK') throw new Error(j.error || j.stat);
    return (j.items || []).map(function (it) {
      return { source: feed.name, title: (it.title || '').trim(), link: it.link || '', time: new Date(it.pubDate) };
    });
  } catch (e) {
    // 代理端解析失敗 → 自己抓原文、補跳脫再解析。兩邊都失敗才算這個來源掛掉。
    try {
      return await _fetchFeedRaw(feed);
    } catch (e2) {
      throw new Error(feed.name + '：' + _newsErrShort(e.message) + '（退路也失敗：' + _newsErrShort(e2.message) + '）');
    }
  }
}

// SAXParseException 那串有兩百多字，整串塞進頁首會把其他資訊擠掉，只留關鍵。
function _newsErrShort(m) {
  m = String(m || '').replace(/\s+/g, ' ').trim();
  var x = m.match(/lineNumber:\s*(\d+).*?columnNumber:\s*(\d+);\s*(.*)$/);
  if (x) return 'XML 第 ' + x[1] + ' 行第 ' + x[2] + ' 字：' + x[3].slice(0, 60);
  return m.length > 90 ? m.slice(0, 90) + '…' : m;
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
    else errs.push(res.reason.message);
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
  } catch (e) { hush('news', e); }
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
  if (!_macroSnap.length) { try { await loadMacro(); } catch (e) { hush('news', e); } }
  if (!_esun) { try { await loadEsunFx(); } catch (e) { hush('news', e); } }
  if (!_fredSnap.length) { try { await loadFred(); } catch (e) { hush('news', e); } }
  if (!_consist.length) { try { await loadConsistency(); } catch (e) { hush('news', e); } }
  // 持股技術面趨勢（若尚未載入則靜默計算）
  var trendTxt = '';
  if (typeof ensureTrend === 'function') {
    try { await ensureTrend(); trendTxt = trendSummaryForPrompt(); } catch (e) { hush('news', e); }
  }
  // 籌碼/淨值面（L2 折溢價 + L3 法人籌碼）
  var sigTxt = '';
  if (typeof ensureSignals === 'function') {
    try { await ensureSignals(); sigTxt = signalsSummaryForPrompt(); } catch (e) { hush('news', e); }
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
      if (trendTxt) { out += '## (' + String.fromCharCode(sec++) + ') 持股技術面趨勢（自算日 K：均線排列／52週位置／期間報酬）\n' + trendTxt + '\n\n'; }
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
  nvApplyTab();
  renderChipBars();
  loadNews();
  loadTwPos(false).catch(function (e) { hush('news', e); });
}
