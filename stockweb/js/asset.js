// 股利總管 Web — 資產統計
//
// 這一頁要回答的是「時間與結構」：這組配置一路走來長什麼樣、
// 錢是從價差還是配息來的、收入靠哪幾檔撐。
// 現有各頁全是「現在這一刻」的切面，沒有一頁回答這些。
//
// 刻意不做（資料不支援，做了會誤導）：
//   年化報酬 IRR／TWR ── 配息沒有日期，券商的 ex_dividends 是累計值。
//                        算出來是純價差報酬，掛「年化報酬」會被當成含息。
//   含現金的資產配置   ── 帳戶餘額只有當下一個手動輸入值，沒有歷史。
//   稅後數字           ── 二代健保與股利所得稅不在券商回傳裡。
//
// 選單樣式沿用股利估算那一組（dv-shell／dv-nav／dv-navitem）。
// 名稱沿用是刻意的：站上已經有 .set-nav 與 .dv-nav 兩份幾乎相同的宣告，
// 再複製第三份就變成改一個顏色要改三個地方。不要再複製。
// 程式沒有沿用 divnav.js：那支是為了不動 renderDividendEst 的內部，
// 把既有扁平輸出事後包成群組；這一頁從零寫，用 { id, label, render } 清單。

var AS_SEL_LS = 'as_sel_v1', AS_COL_LS = 'as_nav_collapsed_v1';
var _asSel = (function () {
  try { return localStorage.getItem(AS_SEL_LS) || 'src'; } catch (e) { return 'src'; }
})();
var _asCollapsed = (function () {
  try { return localStorage.getItem(AS_COL_LS) === '1'; } catch (e) { return false; }
})();

// need: 'feed' 要券商持股，'pv' 額外要 pvEnsure 的逐日序列。
// 分開是因為 pvEnsure 要逐日重建全部批次，第一次進頁會卡；
// 不該讓只看結構的人也等那一次重建。
var AS_MENU = [
  { id: 'src', label: '錢從哪來', need: 'feed', render: asRenderSrc },
  { id: 'mix', label: '持股結構', need: 'feed', render: asRenderMix },
  { id: 'cap', label: '本金走勢', need: 'pv', render: asRenderCap },
  { id: 'div', label: '每月配息', need: 'pv', render: asRenderDiv },
  { id: 'conc', label: '集中度', need: 'const', render: asRenderConc },
  { id: 'pull', label: '出力不對稱', need: 'feed', render: asRenderPull }
];

function openAsset() {
  showView('asset');
  asBuild();
}

function asBuild() {
  var nav = document.getElementById('as-items');
  if (!nav) return;
  nav.innerHTML = AS_MENU.map(function (m) {
    return '<button class="dv-navitem" data-id="' + m.id + '" onclick="asGo(&quot;' + m.id + '&quot;)">' + m.label + '</button>';
  }).join('');
  asGo(_asSel);
}

function asGo(id) {
  if (!AS_MENU.filter(function (m) { return m.id === id; }).length) id = AS_MENU[0].id;
  _asSel = id;
  try { localStorage.setItem(AS_SEL_LS, id); } catch (e) {}
  _asApply();
  asRender();
}

function asCollapse() {
  _asCollapsed = !_asCollapsed;
  try { localStorage.setItem(AS_COL_LS, _asCollapsed ? '1' : '0'); } catch (e) {}
  _asApply();
}

function _asApply() {
  var nav = document.getElementById('as-items');
  if (nav) [].slice.call(nav.querySelectorAll('.dv-navitem')).forEach(function (b) {
    b.classList.toggle('on', b.getAttribute('data-id') === _asSel);
  });
  var shell = document.getElementById('as-shell');
  if (shell) shell.classList.toggle('collapsed', _asCollapsed);
  var cb = document.getElementById('as-collapse');
  if (cb) { cb.textContent = _asCollapsed ? '»' : '«'; cb.title = _asCollapsed ? '展開選單' : '收合選單'; }
}

async function asRender() {
  var pane = document.getElementById('as-pane');
  if (!pane) return;
  var it = AS_MENU.filter(function (m) { return m.id === _asSel; })[0] || AS_MENU[0];
  pane.innerHTML = '<div class="modal-loading">載入中…</div>';
  // 只有要透持股的項目才等券商。本金走勢與每月配息只讀 pvhist 的序列，
  // 把券商連線当成硬條件的話，連線斷了就連已經快取好的歷史都看不到。
  if (it.need === 'feed') {
    try {
      await ensureFeed();
    } catch (e) {
      pane.innerHTML = '<div class="modal-loading">載入失敗：' + (e.message || e) + '</div>';
      return;
    }
    if (_asSel !== it.id) return;
  }
  if (_asSel !== it.id) return;                    // 載入期間使用者又換了一項
  if (it.need === 'const') {
    pane.innerHTML = '<div class="modal-loading">載入成分股清單…</div>';
    try { await ensureFeed(); if (typeof initConstituents === 'function') await initConstituents(); }
    catch (e) { pane.innerHTML = '<div class="modal-loading">載入失敗：' + (e.message || e) + '</div>'; return; }
    if (_asSel !== it.id) return;
  }
  if (it.need === 'pv') {
    pane.innerHTML = '<div class="modal-loading">重建逐日序列中（第一次較慢，當天會快取）…</div>';
    try { await pvEnsure(); } catch (e) { hush('asset', e); }
    if (_asSel !== it.id) return;
    if (!_pvData || !_pvData.days || !_pvData.days.length) {
      pane.innerHTML = '<div class="modal-loading">序列取不到' +
        (typeof _pvErr !== 'undefined' && _pvErr ? '：' + _pvErr : '') + '</div>';
      return;
    }
  }
  try { pane.innerHTML = it.render(); }
  catch (e) { hush('asset', e); pane.innerHTML = '<div class="modal-loading">繪製失敗：' + (e.message || e) + '</div>'; }
}

// ── 共用：逐檔指標 ──
// 一律走 invMetrics，與持股庫存、即時持股、停損停利同一個定義。
// 自己再算一次的話，券商那個「已扣過配息」的成本會讓同一個數字在兩頁不同。
function _asRows() {
  var out = [];
  (typeof _positions !== 'undefined' ? _positions : []).forEach(function (p) {
    var m = invMetrics(p);
    if (m.val == null) return;                     // 取不到價的不進統計，不用 0 頂替
    var code = String(p.code);
    var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
    out.push({
      code: code, name: (c && c.name) || '', val: m.val, cost: m.cost,
      profit: m.profit, div: m.div || 0, withDiv: m.withDiv,
      cat: (typeof getCategory === 'function') ? getCategory(code, (c && c.name) || '') : '其他'
    });
  });
  return out;
}
function _asMoney(v) { return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('zh-TW'); }
function _asWan(v) {
  var w = Math.abs(v) / 10000;
  return (v < 0 ? '−' : '') + (w >= 1000 ? Math.round(w).toLocaleString('zh-TW') : w.toFixed(0)) + '萬';
}
function _asPct(v) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(2) + '%'; }
function _asEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function _asKpi(lb, v, tip, sign) {
  var cls = sign == null ? '' : (sign > 0 ? ' up' : (sign < 0 ? ' down' : ''));
  return '<div class="as-kpi" title="' + _asEsc(tip) + '"><div class="as-kpi-lb">' + lb + '</div>' +
    '<div class="as-kpi-v' + cls + '">' + v + '</div></div>';
}

// ══════════ 錢從哪來（瀑布圖）══════════
// 原始成本 → 資本損益 → 已配息 → 含息現值。
// 把「賺的是價差還是配息」一眼拆開：這兩件事現在要在持股庫存的三個欄位之間心算。
function asRenderSrc() {
  var rows = _asRows();
  if (!rows.length) return '<div class="modal-loading">沒有持股資料</div>';
  var cost = 0, profit = 0, div = 0;
  rows.forEach(function (r) { cost += r.cost; profit += r.profit; div += r.div; });
  var end = cost + profit + div;

  var W = 720, H = 300, PL = 72, PR = 16, PT = 26, PB = 44;
  var hi = Math.max(cost, cost + Math.max(profit, 0), end) * 1.1 || 1;
  var y = function (v) { return PT + (1 - v / hi) * (H - PT - PB); };
  var gap = (W - PL - PR) / 4, bw = gap * 0.5;
  var cx = function (i) { return PL + gap * i + gap / 2; };

  var bars = [
    { lb: '原始成本', from: 0, to: cost, cls: 'as-wf-base', d: false },
    { lb: '資本損益', from: cost, to: cost + profit, cls: profit >= 0 ? 'as-wf-up' : 'as-wf-dn', d: true },
    { lb: '已配息', from: cost + profit, to: end, cls: 'as-wf-div', d: true },
    { lb: '含息現值', from: 0, to: end, cls: 'as-wf-base', d: false }
  ];
  var svg = '<svg class="as-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var gv = hi / 4 * g, gy = y(gv);
    svg += '<line class="as-grid" x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '"/>' +
      '<text class="as-ax" x="' + (PL - 6) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end">' + _asWan(gv) + '</text>';
  }
  bars.forEach(function (b, i) {
    var yTop = y(Math.max(b.from, b.to)), yBot = y(Math.min(b.from, b.to));
    var h = Math.max(1, yBot - yTop);
    svg += '<rect class="as-wf ' + b.cls + '" x="' + (cx(i) - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"/>';
    if (b.d) {                                     // 接在上一段頂端，看得出是累加
      svg += '<line class="as-wf-link" x1="' + (cx(i - 1) + bw / 2).toFixed(1) + '" y1="' + y(b.from).toFixed(1) +
        '" x2="' + (cx(i) - bw / 2).toFixed(1) + '" y2="' + y(b.from).toFixed(1) + '"/>';
    }
    var val = b.d ? (b.to - b.from) : b.to;
    svg += '<text class="as-val" x="' + cx(i).toFixed(1) + '" y="' + (yTop - 8).toFixed(1) + '" text-anchor="middle">' +
      (b.d ? (val >= 0 ? '+' : '−') : '') + _asWan(Math.abs(val)) + '</text>' +
      '<text class="as-lb" x="' + cx(i).toFixed(1) + '" y="' + (H - PB + 20) + '" text-anchor="middle">' + b.lb + '</text>';
  });
  svg += '</svg>';

  var pr = cost ? profit / cost * 100 : null;
  var dr = cost ? div / cost * 100 : null;
  var wr = cost ? (profit + div) / cost * 100 : null;
  return '<div class="sec-title">錢從哪來</div>' + svg +
    '<div class="as-kpis">' +
    _asKpi('原始成本', _asMoney(cost), '當初實際付出的錢（券商淨成本加回累積配息）') +
    _asKpi('資本損益', _asMoney(profit) + '　' + (pr == null ? '' : _asPct(pr)), '現值 − 原始成本，純價差', profit) +
    _asKpi('已配息', _asMoney(div) + '　' + (dr == null ? '' : _asPct(dr)), '仍持有批次自買進以來累計領到的配息', div) +
    _asKpi('含息合計', _asMoney(profit + div) + '　' + (wr == null ? '' : _asPct(wr)), '資本損益 ＋ 已配息，對原始成本', profit + div) +
    '</div>' +
    '<div class="detail-note"><dl>' +
    '<dt>說明</dt><dd>四根由左往右接：第一根是當初付出的錢，中間兩根是它變動的兩個來源，' +
    '最後一根是現在的含息價值。百分比一律對原始成本。</dd>' +
    '<dt>已配息的口徑</dt><dd>是<b>仍持有批次</b>自買進以來的<b>累計</b>領取金額，不是年度配息，' +
    '也不含已經賣掉的批次。持有愈久這一根愈高，跟殖利率高低是兩回事，不要混讀。</dd>' +
    '<dt>這張圖不能告訴你什麼</dt><dd>不分年度，所以看不出「最近一年配得比以前多還是少」。' +
    '那是「每月配息」那一項要回答的。取不到現價的持股不列入，不用 0 頂替。</dd>' +
    '</dl></div>';
}

// ══════════ 持股結構（水平堆疊長條）══════════
// 不用圓餅：圓餅比不出相近的切片，而且佔一大塊版面只放幾個數字。
// 一條長條佔一行，剩下的空間留給逐項明細。
function asRenderMix() {
  var rows = _asRows();
  if (!rows.length) return '<div class="modal-loading">沒有持股資料</div>';
  var agg = {}, tot = 0;
  rows.forEach(function (r) {
    var a = (agg[r.cat] = agg[r.cat] || { cat: r.cat, val: 0, n: 0, codes: [] });
    a.val += r.val; a.n++; a.codes.push(r.code);
    tot += r.val;
  });
  var segs = Object.keys(agg).map(function (k) { return agg[k]; })
    .sort(function (a, b) { return b.val - a.val; });
  var pctOf = function (v) { return tot ? v / tot * 100 : 0; };

  var bar = '<div class="as-stack">' + segs.map(function (s, i) {
    var p = pctOf(s.val);
    return '<div class="as-seg as-c' + (i % 8) + '" style="width:' + p.toFixed(3) + '%" title="' +
      _asEsc(s.cat + '　' + _asMoney(s.val) + ' 元　' + p.toFixed(1) + '%　' + s.n + ' 檔：' + s.codes.join('、')) +
      '">' + (p >= 7 ? '<span>' + p.toFixed(0) + '%</span>' : '') + '</div>';
  }).join('') + '</div>';

  var lg = '<div class="as-legend">' + segs.map(function (s, i) {
    return '<span class="as-lg"><i class="as-c' + (i % 8) + '"></i>' + s.cat +
      '<b>' + pctOf(s.val).toFixed(1) + '%</b><span class="as-lg-n">' + s.n + ' 檔</span></span>';
  }).join('') + '</div>';

  var tb = '<div class="inv-table-wrap as-wrap"><table class="inv-table as-table"><thead><tr>' +
    '<th>分類</th><th class="num">檔數</th><th class="num">現值</th><th class="num">占比</th><th>代號</th>' +
    '</tr></thead><tbody>' + segs.map(function (s) {
      return '<tr><td>' + s.cat + '</td><td class="num">' + s.n + '</td>' +
        '<td class="num">' + _asMoney(s.val) + '</td><td class="num">' + pctOf(s.val).toFixed(1) + '%</td>' +
        '<td class="as-codes">' + s.codes.join('、') + '</td></tr>';
    }).join('') +
    '<tr class="as-tot"><td>合計</td><td class="num">' + rows.length + '</td>' +
    '<td class="num">' + _asMoney(tot) + '</td><td class="num">100.0%</td><td></td></tr>' +
    '</tbody></table></div>';

  return '<div class="sec-title">持股結構</div>' + bar + lg + tb +
    '<div class="detail-note"><dl>' +
    '<dt>說明</dt><dd>依現值占比。分類由代號尾碼與名稱決定：尾碼定結構' +
    '（個股／主動 A／債券 B、D／槓反 L、R），名稱定策略（高息／非投等／投等／公債）。' +
    '與全站其他頁同一套規則，數字對得起來。</dd>' +
    '<dt>分類查不到時</dt><dd>名稱關鍵字全沒命中會歸到「其他債」或「其他」，不猜。' +
    '出現「其他」代表那一檔的代號型態或名稱不在現行規則內。</dd>' +
    '<dt>這張圖不能告訴你什麼</dt><dd>只講錢分在哪裡，不講收入分在哪裡。' +
    '占比最高的分類不一定是配息的主要來源，那要看「出力不對稱」那一項。</dd>' +
    '</dl></div>';
}

// ══════════ 本金走勢（兩條折線）══════════
// 現值與原始成本疊在同一張圖。問的是「本金的長期方向」，不是績效成績單：
// 兩線之間的距離就是未實現的價差，成本線自己的階梯是買進與賣出。
// 序列來自 pvhist，欄位 { d 日期, v 現值, c 原始成本, n 缺價檔數, b 買進, s 賣出, x 除息 }。
function asRenderCap() {
  var days = _pvData.days;
  if (days.length < 2) return '<div class="modal-loading">序列太短</div>';
  var W = 940, H = 340, PL = 78, PR = 18, PT = 20, PB = 46;
  var vs = days.map(function (r) { return r.v; }), cq = days.map(function (r) { return r.c; });
  var hi = Math.max.apply(null, vs.concat(cq)), lo = Math.min.apply(null, vs.concat(cq));
  var pad = (hi - lo) * 0.12 || hi * 0.05 || 1;
  hi += pad; lo = Math.max(0, lo - pad);
  var n = days.length;
  var x = function (i) { return PL + i / (n - 1) * (W - PL - PR); };
  var y = function (v) { return PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB); };
  var path = function (key) {
    return days.map(function (r, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(r[key]).toFixed(1); }).join('');
  };
  var svg = '<svg class="as-svg as-svg-wide" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var gv = lo + (hi - lo) / 4 * g, gy = y(gv);
    svg += '<line class="as-grid" x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '"/>' +
      '<text class="as-ax" x="' + (PL - 6) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end">' + _asWan(gv) + '</text>';
  }
  var ticks = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(n * 3 / 4), n - 1];
  ticks.forEach(function (i, k) {
    if (k && i === ticks[k - 1]) return;
    svg += '<text class="as-ax" x="' + x(i).toFixed(1) + '" y="' + (H - PB + 18) + '" text-anchor="middle">' +
      days[i].d.slice(5).replace('-', '/') + '</text>';
  });
  svg += '<path class="as-ln as-ln-cost" d="' + path('c') + '"/>' +
    '<path class="as-ln as-ln-val" d="' + path('v') + '"/></svg>';

  var last = days[n - 1], first = days[0];
  var gapv = last.v - last.c, gapPct = last.c ? gapv / last.c * 100 : null;
  var noPx = days.filter(function (r) { return r.n > 0; }).length;
  return _asPvBanner() + '<div class="sec-title">本金走勢</div>' +
    '<div class="as-legend"><span class="as-lg"><i class="as-sw-val"></i>現值</span>' +
    '<span class="as-lg"><i class="as-sw-cost"></i>原始成本</span>' +
    '<span class="as-lg-n">' + first.d + ' 起　' + n + ' 個交易日</span></div>' + svg +
    '<div class="as-kpis">' +
    _asKpi('目前現值', _asMoney(last.v), '序列最後一天的現值，應與頂欄的總現值一致') +
    _asKpi('原始成本', _asMoney(last.c), '當初實際付出的錢') +
    _asKpi('兩線距離', _asMoney(gapv) + '　' + (gapPct == null ? '' : _asPct(gapPct)), '現值 − 原始成本，純價差，不含配息', gapv) +
    '</div>' +
    '<div class="detail-note"><dl>' +
    '<dt>說明</dt><dd>兩線之間的距離就是未實現的價差。成本線自己的階梯是買進與賣出造成的，' +
    '不是損益。看的是本金的長期方向，不是績效名次。</dd>' +
    '<dt>這條線不含配息</dt><dd>券商的配息欄位是累計值、沒有日期，拆不到每一天，' +
    '所以這張圖是純價差。配息的時間維度在「每月配息」那一項。</dd>' +
    '<dt>補價的日子</dt><dd>成交清淡的日子沒有分 K，該檔當天用前一日收盤補。' +
    '本段共 <b>' + noPx + '</b> 天有補價' + (noPx ? '（那幾天的現值略為失真，不影響趨勢）' : '') + '。</dd>' +
    '</dl></div>';
}

// ══════════ 每月配息（月長條 ＋ 12 個月移動平均）══════════
// 資料不必重建：pvhist 的序列每一天就有 x ＝ 當天除息金額 × 當時持股張數。
// 單月高低主要由「那個月有幾檔除息」決定，不是配得多，所以一定要配移動平均，
// 否則會把月份分布誤讀成趨勢。
function asRenderDiv() {
  var by = {};
  _pvData.days.forEach(function (r) {
    if (!r.x) return;
    var m = r.d.slice(0, 7);
    by[m] = (by[m] || 0) + r.x;
  });
  var ms = Object.keys(by).sort();
  if (!ms.length) return '<div class="modal-loading">這段期間沒有除息紀錄</div>';
  // 月份要補齊：中間完全沒除息的月份也得是一根 0，否則 x 軸會把時間壓縮
  var full = [], cur = ms[0], endM = ms[ms.length - 1];
  while (cur <= endM && full.length < 240) {
    full.push({ m: cur, v: by[cur] || 0 });
    var yy = +cur.slice(0, 4), mm = +cur.slice(5, 7) + 1;
    if (mm > 12) { yy++; mm = 1; }
    cur = yy + '-' + ('0' + mm).slice(-2);
  }
  var n = full.length, MA = 12;
  var ma = full.map(function (_, i) {
    if (i < MA - 1) return null;
    var s = 0;
    for (var k = i - MA + 1; k <= i; k++) s += full[k].v;
    return s / MA;
  });
  var W = 940, H = 320, PL = 78, PR = 18, PT = 22, PB = 46;
  var hi = Math.max.apply(null, full.map(function (r) { return r.v; })) * 1.12 || 1;
  var y = function (v) { return PT + (1 - v / hi) * (H - PT - PB); };
  var gap = (W - PL - PR) / n, bw = Math.max(2, gap * 0.62);
  var cx = function (i) { return PL + gap * i + gap / 2; };
  var svg = '<svg class="as-svg as-svg-wide" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var gv = hi / 4 * g, gy = y(gv);
    svg += '<line class="as-grid" x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '"/>' +
      '<text class="as-ax" x="' + (PL - 6) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end">' + _asWan(gv) + '</text>';
  }
  full.forEach(function (r, i) {
    var yy = y(r.v);
    svg += '<rect class="as-mbar" x="' + (cx(i) - bw / 2).toFixed(1) + '" y="' + yy.toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, H - PB - yy).toFixed(1) + '" rx="1">' +
      '<title>' + r.m + '　' + _asMoney(r.v) + ' 元</title></rect>';
    var mm2 = r.m.slice(5);
    var show = (mm2 === '01') || (n <= 18) || (n <= 40 && /^(04|07|10)$/.test(mm2));
    if (show) {
      svg += '<text class="as-ax" x="' + cx(i).toFixed(1) + '" y="' + (H - PB + 18) + '" text-anchor="middle">' +
        (mm2 === '01' ? r.m.slice(2, 4) + '/01' : mm2) + '</text>';
    }
  });
  var mp = ma.map(function (v, i) {
    return v == null ? null : ((i && ma[i - 1] != null ? 'L' : 'M') + cx(i).toFixed(1) + ' ' + y(v).toFixed(1));
  }).filter(Boolean).join('');
  if (mp) svg += '<path class="as-ln as-ln-ma" d="' + mp + '"/>';
  svg += '</svg>';

  var tot = full.reduce(function (a, b) { return a + b.v; }, 0);
  var last12 = full.slice(-12).reduce(function (a, b) { return a + b.v; }, 0);
  var prev12 = full.length >= 24 ? full.slice(-24, -12).reduce(function (a, b) { return a + b.v; }, 0) : null;
  var yoy = (prev12 != null && prev12) ? (last12 / prev12 - 1) * 100 : null;
  var nz = full.filter(function (r) { return r.v > 0; }).length;
  return _asPvBanner() + '<div class="sec-title">每月配息</div>' +
    '<div class="as-legend"><span class="as-lg"><i class="as-sw-bar"></i>當月應領</span>' +
    (mp ? '<span class="as-lg"><i class="as-sw-ma"></i>12 個月移動平均</span>' : '') +
    '<span class="as-lg-n">' + full[0].m + ' 起　' + n + ' 個月，其中 ' + nz + ' 個月有除息</span></div>' + svg +
    '<div class="as-kpis">' +
    _asKpi('區間合計', _asMoney(tot), '這段期間的應領配息合計') +
    _asKpi('近 12 個月', _asMoney(last12), '最近 12 個月的應領配息合計') +
    _asKpi('月均（近 12 個月）', _asMoney(last12 / 12), '近 12 個月合計 ÷ 12') +
    (yoy == null ? '' : _asKpi('對前 12 個月', _asPct(yoy), '近 12 個月 ÷ 前 12 個月 − 1', yoy)) +
    '</div>' +
    '<div class="detail-note"><dl>' +
    '<dt>說明</dt><dd>長條是當月的除息金額 × 當時持有張數。單月高低主要由' +
    '「那個月有幾檔除息」決定，不是配得多或少，所以趨勢要看折線那條 12 個月移動平均。</dd>' +
    '<dt>這是應領，不是實收</dt><dd>沒有扣稅（二代健保、股利所得稅都不在券商回傳裡）。' +
    '另外，借出期間的配息由借券人支付權益補償、與直接入帳分成兩筆，' +
    '金額對得上但入帳方式不同（見股利估算的借出張數）。</dd>' +
    '<dt>這張圖不能告訴你什麼</dt><dd>它反映的是「當時持有多少」，後來加碼或減碼不會回頭修改過去的長條。' +
    '要問「照現在的持股，未來每個月領多少」要看股利估算，那是另一個問題。</dd>' +
    '</dl></div>';
}

// ── 序列不完整時的警告橫幅 ──
// pvBuild 對每一檔分別抓日 K，抓不到的那幾檔會被當成 0，但它只把代號塞進 warn 陣列。
// 2026-11-16 實測：盤中在 SSE 連線同時跑，17 檔全部抓不到日 K，
// 畫面卻照樣畫出「目前現值 702,700」（真值 16,195,316），只有 warn 裡有線索。
// 少掉的部分不是略為失真，是整個數量級不對，所以不能只寫在說明裡，要擋在圖的前面。
function _asPvBanner() {
  var w = (_pvData && _pvData.warn) || [];
  if (!w.length) return '';
  return '<div class="as-warn"><b>序列不完整，下面的數字不可信</b>' +
    '<div class="as-warn-d">' + w.map(_asEsc).join('<br>') + '</div>' +
    '<div class="as-warn-d">抓不到日 K 的那幾檔會被當成 0，現值與配息都會少一截。' +
    '盤中與即時報價搶本機伺服器時最容易發生，收盤後或按右邊重抓多半就正常。</div>' +
    '<button class="btn-query" onclick="asPvReload()">↻ 重新抓取序列</button></div>';
}
function asPvReload() {
  if (typeof _pvData !== 'undefined') _pvData = null;
  try { localStorage.removeItem('pv_hist_v4'); } catch (e) {}
  asRender();
}

// ══════════ 集中度（累計曝險曲線）══════════
// 問的不是「分散得好不好」，是「哪一檔減配或出事會打掉多少收入」。
// 成分股曝險那一頁只列前 20，看不出前幾名吃掉多少、曲線在哪裡轉平。
function asRenderConc() {
  if (typeof computeTopConst !== 'function') return '<div class="modal-loading">成分股模組未載入</div>';
  var all = computeTopConst(999) || [];
  if (!all.length) return '<div class="modal-loading">沒有台股成分股資料（持股 ETF 的成分股清單尚未載入）</div>';
  var n = all.length, cum = [], s = 0;
  all.forEach(function (r) { s += r.pct; cum.push(s); });

  var W = 940, H = 320, PL = 60, PR = 18, PT = 20, PB = 46;
  var hiY = Math.min(100, Math.ceil(cum[n - 1] / 10) * 10 + 5);
  var x = function (i) { return PL + (i + 1) / n * (W - PL - PR); };
  var y = function (v) { return PT + (1 - v / hiY) * (H - PT - PB); };
  var svg = '<svg class="as-svg as-svg-wide" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var gv = hiY / 4 * g, gy = y(gv);
    svg += '<line class="as-grid" x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) + '"/>' +
      '<text class="as-ax" x="' + (PL - 6) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end">' + gv.toFixed(0) + '%</text>';
  }
  [1, 5, 10, 20, 30, 50, 100, 150, n].forEach(function (k, i, arr) {
    if (k > n || (i && k === arr[i - 1])) return;
    svg += '<text class="as-ax" x="' + x(k - 1).toFixed(1) + '" y="' + (H - PB + 18) + '" text-anchor="middle">' + k + '</text>';
  });
  svg += '<path class="as-ln as-ln-cum" d="' +
    cum.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join('') + '"/>';
  // 前 20 的參考線：成分股曝險那一頁列的就是這裡
  if (n >= 20) {
    svg += '<line class="as-mark" x1="' + x(19).toFixed(1) + '" y1="' + y(0).toFixed(1) +
      '" x2="' + x(19).toFixed(1) + '" y2="' + y(cum[19]).toFixed(1) + '"/>' +
      '<text class="as-marktx" x="' + (x(19) + 6).toFixed(1) + '" y="' + (y(cum[19]) - 6).toFixed(1) + '">' +
      '前 20 名 ' + cum[19].toFixed(1) + '%</text>';
  }
  svg += '</svg>';

  var hit = function (p) { for (var i = 0; i < n; i++) if (cum[i] >= p) return i + 1; return null; };
  var h25 = hit(25), h50 = hit(50);
  var tb = '<div class="inv-table-wrap as-wrap"><table class="inv-table as-table"><thead><tr>' +
    '<th>名次</th><th>代號</th><th>名稱</th><th class="num">總權重</th><th class="num">累計</th>' +
    '</tr></thead><tbody>' + all.slice(0, 10).map(function (r, i) {
      return '<tr><td class="num">' + (i + 1) + '</td><td class="inv-code">' + r.code + '</td>' +
        '<td class="inv-name">' + _asEsc(r.name) + '</td>' +
        '<td class="num">' + r.pct.toFixed(2) + '%</td><td class="num">' + cum[i].toFixed(1) + '%</td></tr>';
    }).join('') + '</tbody></table></div>';

  return '<div class="sec-title">集中度</div>' +
    '<div class="as-legend"><span class="as-lg-n">橫軸＝依曝險排名，縱軸＝累計總權重；共 ' + n + ' 檔台股成分</span></div>' + svg +
    '<div class="as-kpis">' +
    _asKpi('第 1 名', all[0].code + '　' + all[0].pct.toFixed(2) + '%', '曝險最高的那一檔佔總持股現值的比重') +
    _asKpi('前 10 名累計', cum[Math.min(9, n - 1)].toFixed(1) + '%', '前 10 檔合計佔總持股現值') +
    _asKpi('前 20 名累計', (n >= 20 ? cum[19].toFixed(1) + '%' : '—'), '與成分股曝險那一頁列出的範圍相同') +
    _asKpi('吃掉一半要幾檔', (h50 == null ? '—' : h50 + ' 檔'), '累計曝險達到 50% 所需的檔數，越少越集中') +
    '</div>' + tb +
    '<div class="detail-note"><dl>' +
    '<dt>說明</dt><dd>曝險＝Σ(各 ETF 現值 × 該檔在此 ETF 的權重)，總權重＝曝險 ÷ 總持股現值。' +
    '與成分股曝險同一個算法，前 20 名的累計值兩邊對得起來。' +
    '曲線轉平的位置就是「再往後的名次對你影響很小」的分界。</dd>' +
    '<dt>為什麼看這個</dt><dd>你持有的是一籃子 ETF，但它們的成分重疊。' +
    '同一檔台股可能同時出現在好幾檔 ETF 裡，分開看每檔 ETF 的權重都不高，' +
    '加總之後才看得出單一公司實際佔了多少' +
    (h25 ? '。目前 ' + h25 + ' 檔就吃掉 25%' : '') + '。</dd>' +
    '<dt>這張圖不能告訴你什麼</dt><dd>只涵蓋台股成分。海外成分、債券部位不在裡面，' +
    '所以曲線的終點不會到 100%。也不代表收入集中度：' +
    '權重高的公司不一定是配息的來源，那要看「出力不對稱」。</dd>' +
    '</dl></div>';
}

// ══════════ 出力不對稱（成對水平長條）══════════
// 逐檔比「它佔了多少錢」與「它生了多少息」。兩個比例不一致的地方就是答案：
// 哪幾檔用較少的錢扛了較多的收入，哪幾檔佔了位子但不生息。
//
// 年配息金額的來源有兩個，優先序是固定的：
//   1. 股利估算的 _divRoll（逐月預估，處理過補登與配息頻率）── 這一頁問的是「我的收入」，
//      就該跟顯示你收入的那一頁同一個數字。但它要先進過股利估算那一頁才會存在。
//   2. ETF 評比的 esMetricsFor(code).yEst（預估年配％）× 現值 ── 退路。
// 兩者絕對值可能差一截，但這張圖畫的是比例，分母同時放大或縮小大致互相抵銷，
// 所以不會因為來源不同而指向不同結論。實際用的是哪一個，標在圖上。
function _asAnnualDiv(rows) {
  var src = '', out = {};
  if (typeof _divRoll !== 'undefined' && _divRoll && typeof _divStatRows === 'function') {
    try {
      _divStatRows(_divRoll.stocks).forEach(function (r) {
        var a = 0;
        for (var i = 1; i <= 12; i++) a += (r.m[i] || 0);
        if (a > 0) out[String(r.code)] = a;
      });
      if (Object.keys(out).length) src = '股利估算（逐月預估合計）';
    } catch (e) { hush('asset', e); out = {}; }
  }
  if (!src && typeof esMetricsFor === 'function') {
    rows.forEach(function (r) {
      var m = null;
      try { m = esMetricsFor(r.code); } catch (e) { hush('asset', e); }
      if (m && m.yEst > 0) out[r.code] = m.yEst / 100 * r.val;
    });
    if (Object.keys(out).length) src = 'ETF 評比的預估年配％ × 現值（退路；進過「股利估算」之後會改用那邊的數字）';
  }
  return { map: out, src: src };
}

function asRenderPull() {
  var rows = _asRows();
  if (!rows.length) return '<div class="modal-loading">沒有持股資料</div>';
  var ad = _asAnnualDiv(rows);
  if (!ad.src) return '<div class="modal-loading">取不到預估年配息（請先開啟「股利估算」或「ETF 評比」一次）</div>';
  var totVal = 0, totDiv = 0;
  rows.forEach(function (r) { r.ann = ad.map[r.code] || 0; totVal += r.val; totDiv += r.ann; });
  if (!totDiv) return '<div class="modal-loading">預估年配息合計為 0</div>';
  rows.forEach(function (r) {
    r.pv = totVal ? r.val / totVal * 100 : 0;
    r.pd = totDiv ? r.ann / totDiv * 100 : 0;
    r.gap = r.pd - r.pv;
  });
  rows.sort(function (a, b) { return b.gap - a.gap; });
  var mx = Math.max.apply(null, rows.map(function (r) { return Math.max(r.pv, r.pd); })) || 1;

  var bars = rows.map(function (r) {
    return '<div class="as-pr">' +
      '<div class="as-pr-nm"><b>' + r.code + '</b><span>' + _asEsc(r.name) + '</span></div>' +
      '<div class="as-pr-bars">' +
      '<div class="as-pr-row" title="' + _asEsc('現值比 ' + r.pv.toFixed(2) + '%　' + _asMoney(r.val) + ' 元') + '">' +
        '<i class="as-pr-b as-pr-v" style="width:' + (r.pv / mx * 100).toFixed(2) + '%"></i>' +
        '<span>' + r.pv.toFixed(1) + '%</span></div>' +
      '<div class="as-pr-row" title="' + _asEsc('配息貢獻比 ' + r.pd.toFixed(2) + '%　年配息約 ' + _asMoney(r.ann) + ' 元') + '">' +
        '<i class="as-pr-b as-pr-d" style="width:' + (r.pd / mx * 100).toFixed(2) + '%"></i>' +
        '<span>' + r.pd.toFixed(1) + '%</span></div>' +
      '</div>' +
      '<div class="as-pr-gap ' + (r.gap > 0.5 ? 'pos' : (r.gap < -0.5 ? 'neg' : '')) + '">' +
        (r.gap > 0 ? '+' : (r.gap < 0 ? '−' : '')) + Math.abs(r.gap).toFixed(1) + 'pp</div>' +
      '</div>';
  }).join('');

  var over = rows.filter(function (r) { return r.gap > 0.5; });
  var under = rows.filter(function (r) { return r.gap < -0.5; });
  return '<div class="sec-title">出力不對稱</div>' +
    '<div class="as-legend"><span class="as-lg"><i class="as-sw-pv"></i>現值比</span>' +
    '<span class="as-lg"><i class="as-sw-pd"></i>配息貢獻比</span>' +
    '<span class="as-lg-n">依差距排序，右欄是兩者相減的百分點</span></div>' +
    '<div class="as-pairs">' + bars + '</div>' +
    '<div class="as-kpis">' +
    _asKpi('預估年配息合計', _asMoney(totDiv), '來源：' + ad.src) +
    _asKpi('出力高於佔比', over.length + ' 檔', '配息貢獻比高於現值比 0.5 個百分點以上：' +
      (over.map(function (r) { return r.code; }).join('、') || '無')) +
    _asKpi('佔比高於出力', under.length + ' 檔', '現值比高於配息貢獻比 0.5 個百分點以上：' +
      (under.map(function (r) { return r.code; }).join('、') || '無')) +
    '</div>' +
    '<div class="detail-note"><dl>' +
    '<dt>說明</dt><dd>上面那根是這一檔佔總現值多少，下面那根是它佔預估年配息多少。' +
    '下根比上根長代表它用較少的錢扛了較多的收入，反過來代表它佔了位子但不太生息。' +
    '右邊的 pp 是兩者相減的百分點。</dd>' +
    '<dt>年配息的來源</dt><dd>' + _asEsc(ad.src) + '。' +
    '這張圖畫的是比例，來源不同時絕對值會差一截，但分母同時放大或縮小大致互相抵銷，' +
    '不會因此指向不同結論。</dd>' +
    '<dt>這張圖不能告訴你什麼</dt><dd>不生息不等於不該持有：債券部位與市值型本來就不是為了配息而持有的，' +
    '它們的任務是分散與本金。這張圖只標出不對稱在哪裡，不判斷對錯。' +
    '另外預估年配息是前瞻值，配息政策改變會讓它整個移動。</dd>' +
    '</dl></div>';
}
