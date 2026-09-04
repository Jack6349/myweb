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

// 總經市場數據（補足新聞標題缺少的系統性風險判斷依據）
var MACRO_TICKERS = [
  { name: 'S&P 500',      sym: '^GSPC',     fmt: 0 },
  { name: 'Nasdaq',       sym: '^IXIC',     fmt: 0 },
  { name: '道瓊',         sym: '^DJI',      fmt: 0 },
  { name: '費城半導體',   sym: '^SOX',      fmt: 0 },
  { name: 'VIX 恐慌指數', sym: '^VIX',      fmt: 2 },
  { name: '美10年債殖利率', sym: '^TNX',    fmt: 3 },
  { name: '美元指數',     sym: 'DX-Y.NYB',  fmt: 2 },
  { name: '美元兌台幣',   sym: 'TWD=X',     fmt: 3 },
  { name: '日圓兌台幣',   sym: 'JPYTWD=X',  fmt: 4 }
];

var _newsItems = []; // {source, title, link, time(Date)}
var _macroSnap = []; // {name, price, changePct, fmt}
var _nightFut = null; // 台指夜盤 {price, changePct, time}

// 抓單一 Yahoo 指數/匯率：以最近兩個日收盤算日變動，避開 chartPreviousClose 基準陷阱
async function fetchYahooQuote(t) {
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t.sym) + '?interval=1d&range=5d';
  var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
  var j = await r.json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error(t.name + ' no data');
  var closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [])
    .filter(function (x) { return x != null; });
  var price = (res.meta && res.meta.regularMarketPrice != null) ? res.meta.regularMarketPrice
    : (closes.length ? closes[closes.length - 1] : null);
  var prev = closes.length >= 2 ? closes[closes.length - 2] : null;
  var pct = (price != null && prev) ? (price - prev) / prev * 100 : null;
  return { name: t.name, price: price, changePct: pct, fmt: t.fmt };
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

async function loadMacro() {
  var results = await Promise.allSettled(MACRO_TICKERS.map(fetchYahooQuote));
  _macroSnap = results.map(function (res, i) {
    return res.status === 'fulfilled' ? res.value : { name: MACRO_TICKERS[i].name, price: null, changePct: null, fmt: MACRO_TICKERS[i].fmt };
  });
  _nightFut = await fetchNightFutures();
  renderMacroBar();
}

function _fmtNum(v, dp) { return v == null ? '—' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
function _chgTxt(pct) {
  if (pct == null) return '';
  var arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '');
  return arrow + Math.abs(pct).toFixed(2) + '%';
}
function _chgCls(pct) { return pct == null ? 'flat' : (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat')); }

function renderMacroBar() {
  var el = document.getElementById('macro-bar');
  if (!el) return;
  var cells = _macroSnap.map(function (m) {
    return '<div class="macro-cell"><span class="macro-name">' + m.name + '</span>' +
      '<span class="macro-price">' + _fmtNum(m.price, m.fmt) + '</span>' +
      '<span class="macro-chg ' + _chgCls(m.changePct) + '">' + (_chgTxt(m.changePct) || '—') + '</span></div>';
  });
  if (_nightFut) {
    cells.push('<div class="macro-cell"><span class="macro-name">台指夜盤 ' + (_nightFut.time || '') + '</span>' +
      '<span class="macro-price">' + _fmtNum(_nightFut.price, 0) + '</span>' +
      '<span class="macro-chg ' + _chgCls(_nightFut.changePct) + '">' + (_chgTxt(_nightFut.changePct) || '—') + '</span></div>');
  }
  el.innerHTML = cells.join('');
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

  loadMacro(); // 市場數據平行抓取，不阻塞新聞

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

  // 市場數據快照（若尚未載入則現抓）
  if (!_macroSnap.length) { try { await loadMacro(); } catch (e) {} }
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
    return '- ' + m.name + '：' + _fmtNum(m.price, m.fmt) + '（' + (m.changePct == null ? 'N/A' : (m.changePct >= 0 ? '+' : '') + m.changePct.toFixed(2) + '%') + '）';
  }).join('\n');
  if (_nightFut) {
    macroTxt += '\n- 台指期近月夜盤（' + (_nightFut.time || '') + '）：' + _fmtNum(_nightFut.price, 0) +
      '（' + (_nightFut.changePct >= 0 ? '+' : '') + _nightFut.changePct.toFixed(2) + '%）';
  }

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
    '。以下提供三類資訊：(A) 即時市場數據快照、(B) 我的持股清單、(C) 最近 ' + NEWS_HOURS + ' 小時財經新聞標題。' +
    '請優先依據 (A) 的量化數據判斷系統性風險（美股走勢、VIX 恐慌指數、美債殖利率、美元指數、台指夜盤、匯率），' +
    '新聞標題作為輔助佐證。\n\n' +
    '【評估規則】\n' +
    '1. 拒絕假精確：所有評分不要只給單一分類（高/中/低）。改以「點估計＋合理區間」表達，區間寬度反映你的不確定性；' +
    '關鍵風險改用機率＋不確定帶。註：你不是抽樣統計量，此區間是主觀不確定範圍、非統計信賴區間，據實標示即可。\n' +
    '2. 主題不得過度外推到個別 ETF：任何產業題材（如 HBM、AI、記憶體）只能連結到「確實有對應成分股權重」的持股。' +
    '若不確定該 ETF 對此題材的實際權重曝險，須寫「對○○供應鏈整體偏向X，傳導到本 ETF 的力道取決於實際持股權重」，' +
    '不可直接斷言為某檔 ETF 的結構性利多/利空。\n' +
    '3. 利率、匯率等指標須拆兩維度判讀：「絕對水位」與「當日變化率」分開講，不可用單日變化率掩蓋絕對水位' +
    '（例：美10年債 4.5% 當日 +0.66%，水位屬近年區間中段但仍偏高，變化率則為當日走高——兩者分述）。\n' +
    '4. 每個評級/風險都要附一句依據（綁回具體資料），不能空給評級。\n\n' +
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
    '## (A) 即時市場數據快照\n' + (macroTxt || '（暫無）') + '\n\n' +
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
