// 股利總管 Web — 主動式 ETF 風格漂移（成分股曝險 → 風格漂移頁籤）
// 資料檔 data/etf-style.json 由 shioaji-server/etf-style.py 每日排程產生並上傳。
// 網頁只讀不抓：富邦投信的揭露頁回 HTML，GAS 代理只收 JSON，瀏覽器端抓不到。
//
// 這一頁要回答的問題只有一個：持有這檔主動式 ETF 的理由還在不在。
// 主動式 ETF 買的是風格，不是某幾檔個股。風格變了，持有理由就沒了，而價格看不出來——
// 漂移中的基金可以繼續漲一段時間，等績效反映時已經晚了。
//
// 四個指標都用權重，不用股數：贖回會讓所有持股按比例減少，股數全面下降但權重不變，
// 用權重才分得出主動調整。
//   檔數        分散到幾檔
//   前五大合計   集中在前幾名的程度
//   最大單一     單一個股的曝險上限實際走到哪
//   台積電權重   有沒有往大型權值股靠攏（往上＝越來越像市值型，持有它的理由變薄）
//
// 判讀門檻一律取自該檔自己的歷史分位數（P25／P50／P75），不自訂數字：
// 這檔基金 2026 年 6 月才成立，沒有跨市場可比的基準，唯一有意義的對照是它自己。

var SD_METRICS = [
  { k: 'n',     t: '持股檔數',     u: '',  dp: 0, hint: '分散到幾檔。往下＝集中' },
  { k: 'top5',  t: '前五大合計',   u: '%', dp: 2, hint: '前五名權重相加。往上＝集中' },
  { k: 'max1',  t: '最大單一',     u: '%', dp: 2, hint: '最大一檔的權重。往上＝單一個股曝險變重' },
  { k: 'bench', t: '台積電權重',   u: '%', dp: 2, hint: '往上＝向市值型靠攏' },
  { k: 'stock', t: '股票水位',     u: '%', dp: 2, hint: '股票合計權重，其餘為現金' }
];
var _sdData = null, _sdFund = null, _sdPick = 'top5';

async function startStyleDrift(force) {
  var wrap = document.getElementById('sd-wrap');
  if (!wrap) return;
  if (!_sdData || force) {
    wrap.innerHTML = '<div class="modal-loading">讀取風格漂移資料…</div>';
    try {
      var r = await fetch('data/etf-style.json', { cache: force ? 'reload' : 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _sdData = await r.json();
    } catch (e) {
      wrap.innerHTML = '<div class="rf-cal-empty">讀不到 data/etf-style.json（' + e.message +
        '）。這份資料由 shioaji-server/etf-style.py 每日產生。</div>';
      return;
    }
  }
  var codes = Object.keys((_sdData && _sdData.funds) || {});
  if (!codes.length) { wrap.innerHTML = '<div class="rf-cal-empty">目前沒有任何主動式 ETF 的持股揭露資料。</div>'; return; }
  if (!_sdFund || codes.indexOf(_sdFund) < 0) _sdFund = codes[0];
  renderStyleDrift();
}

function sdPickFund(code) { _sdFund = code; renderStyleDrift(); }
function sdPickMetric(k) { _sdPick = k; renderStyleDrift(); }

// 分位數：線性插值，與 risk-score 的作法一致
function _sdPct(sorted, p) {
  if (!sorted.length) return null;
  var i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
// 某個值在這串歷史裡的百分位（0–100）：比它小的佔幾成
function _sdRank(arr, v) {
  if (!arr.length) return null;
  var n = 0;
  arr.forEach(function (x) { if (x < v) n++; });
  return n / arr.length * 100;
}

function _sdFmt(v, m) { return v == null ? '—' : v.toFixed(m.dp) + m.u; }

function renderStyleDrift() {
  var wrap = document.getElementById('sd-wrap');
  if (!wrap) return;
  var f = _sdData.funds[_sdFund], codes = Object.keys(_sdData.funds);
  var dates = f.dates, last = dates.length - 1;
  var info = document.getElementById('sd-info');
  if (info) info.textContent = f.issuer + '揭露・' + dates[0] + ' ~ ' + dates[last] + '・' + dates.length + ' 個交易日';

  var h = '';
  if (codes.length > 1) {
    h += '<div class="sd-funds">' + codes.map(function (c) {
      return '<button class="sd-fbtn' + (c === _sdFund ? ' on' : '') + '" onclick="sdPickFund(\'' + c + '\')">' +
        c + ' ' + _sdData.funds[c].name + '</button>';
    }).join('') + '</div>';
  }
  h += '<div class="sd-title">' + _sdFund + '　' + f.name + '</div>';

  // ── 指標卡：現值、成立以來變化、在自身歷史的百分位 ──
  h += '<div class="sd-cards">';
  SD_METRICS.forEach(function (m) {
    var arr = (f[m.k] || []).filter(function (x) { return x != null; });
    if (!arr.length) return;
    var now = f[m.k][last], first = arr[0], d = now - first;
    var rank = _sdRank(arr, now);
    var sign = d > 0 ? '+' : (d < 0 ? '−' : '');
    // 百分比的差值單位是百分點，不是 %：35.48% − 23.57% 是 11.91 個百分點，
    // 寫成 +11.91% 會被讀成成長 11.91%（那是 +50.5%），兩者差很多。
    var du = m.u === '%' ? ' 個百分點' : m.u;
    h += '<div class="sd-card' + (m.k === _sdPick ? ' on' : '') + '" onclick="sdPickMetric(\'' + m.k + '\')" title="' + m.hint + '">' +
      '<div class="sd-cv">' + _sdFmt(now, m) + '</div>' +
      '<div class="sd-ct">' + m.t + '</div>' +
      '<div class="sd-cd">成立以來 ' + sign + Math.abs(d).toFixed(m.dp) + m.u +
        '（' + _sdFmt(first, m) + ' → ' + _sdFmt(now, m) + '）</div>' +
      '<div class="sd-cr">自身歷史第 ' + (rank == null ? '—' : rank.toFixed(0)) + ' 百分位</div>' +
      '</div>';
  });
  h += '</div>';

  h += _sdChart(f, _sdPick);
  h += _sdTopHtml(f);
  h += _sdNote(f);
  wrap.innerHTML = h;
}

// ── 單一指標的走勢圖：折線＋該指標自身的 P25／P50／P75 參考線 ──
function _sdChart(f, key) {
  var m = SD_METRICS.filter(function (x) { return x.k === key; })[0] || SD_METRICS[1];
  var ys = f[key] || [], dates = f.dates;
  var vals = ys.filter(function (x) { return x != null; });
  if (vals.length < 2) return '<div class="rf-cal-empty">' + m.t + ' 資料不足，畫不出走勢。</div>';
  var sorted = vals.slice().sort(function (a, b) { return a - b; });
  var p25 = _sdPct(sorted, 0.25), p50 = _sdPct(sorted, 0.5), p75 = _sdPct(sorted, 0.75);

  var W = 900, H = 260, ml = 52, mr = 16, mt = 18, mb = 30;
  var pw = W - ml - mr, ph = H - mt - mb;
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad;
  var X = function (i) { return ml + (dates.length === 1 ? pw / 2 : pw * i / (dates.length - 1)); };
  var Y = function (v) { return mt + ph - (v - lo) / (hi - lo) * ph; };

  var g = '';
  for (var t = 0; t <= 4; t++) {                       // 格線與左軸
    var v = lo + (hi - lo) / 4 * t, yy = Y(v);
    g += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy +
      '" stroke="var(--border)" stroke-opacity=".45"/>' +
      '<text x="' + (ml - 6) + '" y="' + (yy + 4) + '" text-anchor="end" class="dh-ax">' + v.toFixed(m.dp) + '</text>';
  }
  // 分位數參考線：判讀門檻取自這檔自己的歷史，不自訂數字
  [[p25, 'P25'], [p50, 'P50'], [p75, 'P75']].forEach(function (q) {
    if (q[0] == null) return;
    g += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(q[0]) + '" y2="' + Y(q[0]) +
      '" stroke="var(--accent2)" stroke-opacity=".55" stroke-width="1" stroke-dasharray="4 4"/>' +
      '<text x="' + (W - mr - 2) + '" y="' + (Y(q[0]) - 3) + '" text-anchor="end" class="dh-lg" ' +
      'fill="var(--accent2)">' + q[1] + ' ' + q[0].toFixed(m.dp) + '</text>';
  });
  var pts = [];
  ys.forEach(function (v, i) { if (v != null) pts.push([X(i), Y(v)]); });
  g += '<polyline points="' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ') +
    '" fill="none" stroke="var(--down)" stroke-width="2" stroke-linejoin="round"/>';
  // 只在最後一點放圓點與數值：85 個點全放會糊成一片
  var lastI = ys.length - 1;
  g += '<circle cx="' + X(lastI) + '" cy="' + Y(ys[lastI]) + '" r="3.5" fill="var(--bg2)" stroke="var(--down)" stroke-width="2"/>';
  // X 軸：首、中、尾三個日期
  [0, Math.floor((dates.length - 1) / 2), dates.length - 1].forEach(function (i, k) {
    g += '<text x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="' +
      (k === 0 ? 'start' : (k === 2 ? 'end' : 'middle')) + '" class="dh-ax">' + dates[i].slice(5) + '</text>';
  });
  // 整張圖加一個 title，滑鼠移上去看頭尾值
  g = '<title>' + m.t + '　' + dates[0] + ' ' + _sdFmt(ys[0], m) + ' → ' +
      dates[lastI] + ' ' + _sdFmt(ys[lastI], m) + '</title>' + g;

  return '<div class="sd-chart"><div class="sd-ctitle">' + m.t +
    '<span class="sd-chint">' + m.hint + '；虛線為這檔自己歷史的 P25／P50／P75</span></div>' +
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="divest-hist-svg">' + g + '</svg></div>';
}

// ── 最新一日的前 10 大：風格講的是「集中在哪些名字」，光看數字看不出來 ──
function _sdTopHtml(f) {
  if (!f.top || !f.top.length) return '';
  var sum = 0;
  f.top.forEach(function (x) { sum += x.w; });
  var h = '<div class="sd-ctitle">最新前 ' + f.top.length + ' 大持股　<span class="sd-chint">' +
    f.dates[f.dates.length - 1] + '　合計 ' + sum.toFixed(2) + '%</span></div>';
  h += '<div class="inv-table-wrap"><table class="inv-table swap-table"><thead><tr>' +
    '<th>#</th><th>代號</th><th>名稱</th><th class="num">權重</th></tr></thead><tbody>';
  f.top.forEach(function (x, i) {
    h += '<tr><td>' + (i + 1) + '</td>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + x.c + '\')">' + x.c + '</span></td>' +
      '<td class="inv-name">' + x.n + '</td>' +
      '<td class="num">' + x.w.toFixed(2) + '%</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function _sdNote(f) {
  var last = f.dates.length - 1;
  return '<div class="cs-note"><dl>' +
    '<dt>這一頁要回答什麼</dt><dd>持有這檔主動式 ETF 的理由還在不在。買的是風格，不是某幾檔個股；' +
    '風格變了理由就沒了，而價格看不出來。</dd>' +
    '<dt>為什麼用權重不用股數</dt><dd><code>贖回 → 股數按比例下降、權重不變</code>。' +
    '用股數分不出主動調整與贖回，用權重才分得出來。</dd>' +
    '<dt>判讀門檻</dt><dd>取這檔自己歷史的 P25／P50／P75。' +
    '它 ' + f.dates[0] + ' 才有第一筆揭露，沒有跨市場可比的基準，唯一有意義的對照是它自己。</dd>' +
    '<dt>往上往下的意思</dt><dd><code>前五大合計、最大單一往上＝越集中</code>；' +
    '<code>檔數往下＝越集中</code>；<code>台積電權重往上＝向市值型靠攏</code>。</dd>' +
    '<dt>不做什麼</dt><dd>不從單日的進出推測經理人的用意。揭露只給結果，不給理由，' +
    '一天的差異可能是調倉、也可能是應付贖回。</dd>' +
    '<dt>資料</dt><dd>' + (_sdData.source || '') + '，更新於 ' + (_sdData.updated || '—') +
    '；最後一筆揭露 ' + f.dates[last] + '。非投資建議。</dd>' +
    '</dl></div>';
}

// ── 成分股曝險頁的子頁籤切換（成分股曝險／風格漂移）──
// 記住選擇：曝險是盤中看的、漂移是幾天看一次的，兩者使用節奏不同，
// 每次進頁都跳回第一個頁籤會一直要重點。
var CS_TAB_LS = 'cs_tab_v1';
var _csTab = (function () {
  try { var v = localStorage.getItem(CS_TAB_LS); if (v === 'expo' || v === 'drift') return v; } catch (e) {}
  return 'expo';
})();
function csShowTab(tab) {
  _csTab = tab;
  try { localStorage.setItem(CS_TAB_LS, tab); } catch (e) {}
  ['expo', 'drift'].forEach(function (t) {
    var b = document.getElementById('cs-subtab-' + t);
    if (b) b.classList.toggle('active', t === tab);
    var p = document.getElementById('cs-' + t + '-pane');
    if (p) p.style.display = (t === tab) ? '' : 'none';
  });
  if (tab === 'drift') startStyleDrift(false);
}
