// 股利總管 Web — 即時持股（單欄精簡表＋每列當日分時走勢小圖，盤中逐筆即時更新）
// 欄位：代號｜餘額(股)｜成本均價｜最後買入｜現價｜差價｜漲跌幅｜現值｜含息損益｜含息獲利率｜走勢
// （無明細鈕、無名稱）
// 成本一律用原始成本（券商的成本已扣掉累積配息），與持股庫存同一套；
// 顯示的損益與獲利率都含息，與停損停利的觸發基準一致
// 版面：單欄列完所有持股（原本左右各半，欄位找起來要兩邊掃），
// 最右邊一欄是每檔當日分時走勢小圖，13 檔同時看得到，不用點選。

// 排序狀態：存本機，重新整理後維持；不在可排序欄位內的值回到預設（代號 ▲）
var LIVE_SORT_LS = 'live_sort_v1';
var _liveSort = (function () {
  try { var v = localStorage.getItem(LIVE_SORT_LS); if (/^(code|chg|pnl|prate)(Asc|Desc)$/.test(v || '')) return v; } catch (e) {}
  return 'codeAsc';
})();

// ── 注意股標記（圓形圖標）──
// 每檔固定識別色：全部持股依代號排序後平均分布於紅→紫色階；點選 On(亮)/再點 Off(暗)，狀態存 localStorage。
var _watchSet = null;
var _liveColorMap = {};
function loadWatch() {
  if (_watchSet) return _watchSet;
  try { _watchSet = new Set(JSON.parse(localStorage.getItem('live_watch_v1') || '[]')); } catch (e) { _watchSet = new Set(); }
  return _watchSet;
}
function saveWatch() { try { localStorage.setItem('live_watch_v1', JSON.stringify(Array.from(loadWatch()))); } catch (e) {} }
function buildLiveColors() {
  var codes = _positions.map(function (p) { return String(p.code); })
    .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  var n = codes.length;
  _liveColorMap = {};
  codes.forEach(function (code, i) { var hue = n > 1 ? Math.round(i / (n - 1) * 290) : 0; _liveColorMap[code] = 'hsl(' + hue + ',95%,62%)'; });
}
function toggleWatch(code, el) {
  var s = loadWatch();
  if (s.has(code)) s.delete(code); else s.add(code);
  saveWatch();
  if (el) el.classList.toggle('on', s.has(code));
  // 持股庫存合計列有「點選損益加總」，標記變動需即時重算
  if (typeof renderSummaries === 'function') renderSummaries();
}

// 計算單檔衍生值（現價優先用即時 tick，其次券商 last_price）
function liveCalc(p) {
  var code = String(p.code);
  var c = _contracts[code], r = _rows[code];
  var shares = p.quantity; // 股
  // 原始成本：券商記錄的成本已扣掉累積配息，加回才是實際付出（見 inventory.js invOrigCost）
  var _oc = (typeof invOrigCost === 'function') ? invOrigCost(p) : { cost: p.price * shares };
  var cost = _oc.cost;
  var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
  var val = price != null ? price * shares : null;
  var netVal = val != null ? (_taxMode ? val * 0.997735 : val) : null;
  var profit = netVal != null ? netVal - cost : null;
  var prate = (profit != null && cost) ? profit / cost * 100 : null;
  var chg = (price != null && c && c.reference) ? (price - c.reference) / c.reference * 100 : null;
  var chgAmt = (price != null && c && c.reference) ? price - c.reference : null; // 今日漲跌金額
  // 顯示與觸發一律用含息：整列反紅是含息獲利率觸發的，畫面若顯示純價差會出現
  // 「數字沒到門檻但整列紅了」。價差的拆解留在持股庫存。
  var _m = (typeof invMetrics === 'function') ? invMetrics(p) : null;
  var wprofit = _m ? _m.withDiv : null, wrate = _m ? _m.wrate : null;
  var alert = (typeof evalAlert === 'function') ? evalAlert(code, price, wrate) : null;
  return { code: code, cost: cost, price: price, val: netVal,
           profit: wprofit != null ? wprofit : profit,     // 含息損益
           prate: wrate != null ? wrate : prate,           // 含息獲利率
           chg: chg, chgAmt: chgAmt,
           avg: shares ? cost / shares : p.price, alert: alert };
}

// 最後買入：建倉明細（_lotsMap，載入庫存時已抓，不另外呼叫 API）日期最大的那一批。
// 同一天分多筆成交就加總後取加權平均。買價＝原始成本 ÷ 股數，與建倉明細彈窗同一套
// （券商記的成本已扣掉該筆累積配息，price>0 的筆要加回）。
function _liveLastBuy(code) {
  var lots = (typeof _lotsMap !== 'undefined' && _lotsMap[String(code)]) || null;
  if (!lots || !lots.length) return null;
  var day = lots[lots.length - 1].date, cost = 0, sh = 0;
  lots.forEach(function (l) {
    if (l.date !== day) return;
    cost += l.cost + (l.sub ? (l.div || 0) : 0);
    sh += l.shares;
  });
  return { date: day, px: sh ? cost / sh : null };
}
// 日期一律 YY/MM/DD：只給 MM/DD 的話，跨年度的批次分不出是哪一年
function _liveBuyCell(code) {
  var b = _liveLastBuy(code);
  if (!b || b.px == null) return '<td class="num lb-cell"><span class="flat">—</span></td>';
  return '<td class="num lb-cell"><span class="lb-date">(' + b.date.slice(2).replace(/-/g, '/') + ')</span>' +
    '<span class="lb-px">' + b.px.toFixed(2) + '</span></td>';
}

// 差價：現價 － 最後買入價。買得比現價低＝這批賺，台股慣例用紅；買得比現價高＝這批套牢，用綠。
// 看的是「最後那一批」的處境，不是整體成本，所以會和含息獲利率不同向。
// 排序和顯示共用同一個值，不在兩邊各算一次
function _liveDiffVal(code, price) {
  var b = _liveLastBuy(code);
  if (!b || b.px == null || price == null) return null;
  return price - b.px;
}
function _liveDiffCell(code, price) {
  var b = _liveLastBuy(code);
  var d = _liveDiffVal(code, price);
  if (d == null) return '<td class="num"><span class="flat">—</span></td>';
  return '<td class="num ' + colorClass(d) + '" title="現價 ' + price.toFixed(2) + ' － 最後買入 ' + b.px.toFixed(2) + '">' +
    (d > 0 ? '+' : '') + d.toFixed(2) + '</td>';
}

function liveRowHtml(p) {
  var v = liveCalc(p);
  var pcls = v.profit == null ? 'flat' : colorClass(v.profit);
  var ccls = v.chg == null ? 'flat' : colorClass(v.chg);
  var on = loadWatch().has(v.code);
  var dotColor = _liveColorMap[v.code] || '#888';
  return '<td class="live-dot-cell"><button class="live-dot' + (on ? ' on' : '') + '" style="--dot:' + dotColor +
      '" title="標記注意股" onclick="event.stopPropagation();toggleWatch(\'' + v.code + '\',this)"></button></td>' +
    '<td class="inv-code' + (typeof limitState === 'function' && limitState(v.code, v.price) ? ' lim-' + limitState(v.code, v.price) : '') + '"><span class="code-link" title="看線圖" onclick="event.stopPropagation();openChartPop(\'' + v.code + '\')">' + v.code + '</span></td>' +
    '<td class="num">' + (p.quantity != null ? Math.round(p.quantity).toLocaleString('zh-TW') : '—') + '</td>' +
    costCellHtml(v.avg, v.price) +
    _liveBuyCell(v.code) +
    '<td class="num ' + ccls + '">' + (v.price != null ? v.price.toFixed(2) : '—') + '</td>' +
    _liveDiffCell(v.code, v.price) +
    '<td class="num ' + ccls + '">' + (v.chgAmt == null ? '—' : fmtChg(v.chgAmt)) + '</td>' +
    '<td class="num ' + ccls + '">' + (v.chg == null ? '—' : fmtPct(v.chg)) + '</td>' +
    '<td class="num">' + (v.val != null ? Math.round(v.val).toLocaleString('zh-TW') : '—') + '</td>' +
    '<td class="num ' + pcls + '">' + (v.profit == null ? '—' : (v.profit >= 0 ? '+' : '') + Math.round(v.profit).toLocaleString('zh-TW')) + '</td>' +
    '<td class="num ' + pcls + '">' + (v.prate == null ? '—' : (v.prate > 0 ? '+' : '') + v.prate.toFixed(2) + '%') + '</td>';
}

// 依 _liveSort 回傳排序後的持倉
function liveSorted() {
  var arr = _positions.slice();
  var num = function (x) { return x == null ? -Infinity : x; };
  switch (_liveSort) {
    case 'codeAsc':  arr.sort(function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); }); break;
    case 'codeDesc': arr.sort(function (a, b) { return String(b.code).localeCompare(String(a.code), undefined, { numeric: true }); }); break;
    case 'chgDesc':  arr.sort(function (a, b) { return num(liveCalc(b).chg) - num(liveCalc(a).chg); }); break;
    case 'chgAsc':   arr.sort(function (a, b) { return num(liveCalc(a).chg) - num(liveCalc(b).chg); }); break;
    case 'pnlDesc':  arr.sort(function (a, b) { return num(liveCalc(b).profit) - num(liveCalc(a).profit); }); break;
    case 'pnlAsc':   arr.sort(function (a, b) { return num(liveCalc(a).profit) - num(liveCalc(b).profit); }); break;
    case 'prateDesc': arr.sort(function (a, b) { return num(liveCalc(b).prate) - num(liveCalc(a).prate); }); break;
    case 'prateAsc':  arr.sort(function (a, b) { return num(liveCalc(a).prate) - num(liveCalc(b).prate); }); break;
    case 'diffDesc': arr.sort(function (a, b) { return num(_liveDiffVal(String(b.code), liveCalc(b).price)) - num(_liveDiffVal(String(a.code), liveCalc(a).price)); }); break;
    case 'diffAsc':  arr.sort(function (a, b) { return num(_liveDiffVal(String(a.code), liveCalc(a).price)) - num(_liveDiffVal(String(b.code), liveCalc(b).price)); }); break;
  }
  return arr;
}

// 整欄表頭可點排序（與持股庫存一致）：單一箭頭指示狀態，點擊區＝整格
function _liveSortTh(label, key, numCls, tip) {
  var on = _liveSort === key + 'Asc' || _liveSort === key + 'Desc';
  var arrow = _liveSort === key + 'Asc' ? '▲' : (_liveSort === key + 'Desc' ? '▼' : '↕');
  return '<th class="' + (numCls ? 'num ' : '') + 'sort-th' + (on ? ' sorted' : '') + '" onclick="liveSortCol(\'' + key + '\')" title="' + (tip ? tip + '（點擊排序）' : '點擊排序') + '">' +
    label + '<span class="sort-ind">' + arrow + '</span></th>';
}
function liveHead() {
  return '<thead><tr><th class="live-dot-cell"></th>' +
    _liveSortTh('代號', 'code') +
    '<th class="num">餘額</th><th class="num">成本均價</th>' +
    '<th class="num lb-cell" title="建倉明細裡日期最新的那一批：(買進日) 每股買價">最後買入</th>' +
    '<th class="num">現價</th>' +
    _liveSortTh('差價', 'diff', true, '現價 － 最後買入價。紅＝那一批買得比現價便宜，綠＝買得比現價貴') +
    '<th class="num">漲跌</th>' +
    _liveSortTh('漲跌幅', 'chg', true) +
    '<th class="num">現值</th>' +
    _liveSortTh('含息損益', 'pnl', true) +
    _liveSortTh('含息獲利率', 'prate', true) +
    '<th class="lc-cell">走勢</th></tr></thead>';
}

function renderLiveTables() {
  var box = document.getElementById('live-cols');
  if (!box) return;
  var sorted = liveSorted();
  box.innerHTML = '<div class="live-col"><table class="inv-table live-table">' + liveHead() + '<tbody>' +
    sorted.map(function (p) {
      var c = String(p.code), al = liveCalc(p).alert;
      return '<tr id="live-tr-' + c + '"' + (al ? ' class="alert-' + al + '"' : '') + '>' + liveRowHtml(p) +
        '<td class="lc-cell">' + _lcCellHtml(c) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  liveChartLoadAll();
  _lcStartTimer();
}

// 即時更新（SSE 觸發）：整表重建並依目前排序即時重排（13 檔重排為微秒級，成本可忽略）
function renderLiveRow(code) {
  var box = document.getElementById('live-cols');
  if (!box || !box.children.length) return; // 未進入即時持股頁時不動作
  renderLiveTables();
}

function liveSortCol(key) {
  _liveSort = (_liveSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  try { localStorage.setItem(LIVE_SORT_LS, _liveSort); } catch (e) {}
  renderLiveTables();
}

async function startLive() {
  var errEl = document.getElementById('live-error');
  var info = document.getElementById('stream-info');
  errEl.style.display = 'none';
  if (!(await checkServer())) { errEl.style.display = 'block'; errEl.innerHTML = serverDownHtml(); return; }
  try {
    await ensureFeed(function (msg) { info.textContent = msg; });
  } catch (e) { errEl.style.display = 'block'; errEl.textContent = e.message; return; }
  loadWatch();
  buildLiveColors();
  renderSummary('live-summary');
  if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
  renderLiveTables();
  if (typeof renderDailyDigest === 'function') renderDailyDigest(); // 今日提醒（非阻塞）
  if (typeof touchMount === 'function') touchMount();             // 掛單參考（只有勾選過的標的才抓）
  info.textContent = '已連線｜' + _positions.length + ' 檔庫存';
}

// ── 每列的當日分時走勢小圖 ──
// 與線圖彈窗「日均」同一套：Shioaji 1 分 K、縱軸以昨收為中心對稱（中線＝昨收）、
// 白線為均價（VWAP）、昨收之上紅、之下綠。小圖不放座標文字與成交量，那些留在大圖。
// X 軸固定 09:00–13:30，所以 13 張圖的時間軸互相對齊，可以橫著比。
//
// 更新節奏刻意與表格分開：表格每筆成交就重建，但分 K 一分鐘才多一根，
// 圖跟著 tick 重畫十次有九次畫出同一張。做法是把畫好的 SVG 字串快取起來，
// 表格重建時直接貼字串，只有 60 秒一次的資料更新才真的重畫。

var _lcCache = {};            // code → { bars, fetched, svg, err }
var _lcTimer = null, _lcLoading = {};

function _lcYmd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// 先抓今日分 K（單檔約 17KB）；開盤前或非交易日今日無資料，才退回 10 天取最後一個有資料的交易日
async function _lcFetch(code) {
  var ex = (_contracts[code] || {}).exchange || 'TSE';
  var get = async function (s, e) {
    var r = await fetch(API + '/api/v1/data/kbars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'STK', exchange: ex, code: code }, start: s, end: e })
    });
    if (!r.ok) throw new Error('kbars HTTP ' + r.status);
    return await r.json();
  };
  var today = _lcYmd(new Date());
  var j = await get(today, today);
  if (!j || !j.datetime || !j.datetime.length) j = await get(_lcYmd(new Date(Date.now() - 10 * 86400000)), today);
  if (!j || !j.datetime || !j.datetime.length) return null;
  var day = j.datetime[j.datetime.length - 1].slice(0, 10);
  var b = { day: day, t: [], c: [], v: [], amt: [] };
  for (var i = 0; i < j.datetime.length; i++) {
    if (j.datetime[i].slice(0, 10) !== day) continue;
    b.t.push(j.datetime[i].slice(11, 16)); b.c.push(j.Close[i]); b.v.push(j.Volume[i]); b.amt.push(j.Amount[i]);
    if (b.o == null) { b.o = j.Open[i]; b.h = j.High[i]; b.l = j.Low[i]; }
    if (j.High[i] > b.h) b.h = j.High[i];
    if (j.Low[i] < b.l) b.l = j.Low[i];
  }
  return b;
}

var LC_W = 300, LC_H = 50;
var LC_SESS_S = 540, LC_SESS_E = 810;   // 09:00–13:30，分鐘
function _lcTmin(t) { return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10); }

function _lcSvg(b, code) {
  var n = b.c.length;
  if (!n) return '';
  var ct = _contracts[code] || {}, ref = ct.reference || b.c[0];

  // 均價線（VWAP）：累計金額 ÷ 累計量；量的單位是張，要換算成股
  var vwap = [], cumA = 0, cumV = 0;
  for (var i = 0; i < n; i++) { cumA += b.amt[i] || 0; cumV += b.v[i] || 0; vwap.push(cumV ? cumA / (cumV * 1000) : null); }

  // 縱軸以昨收為中心對稱 → 中線永遠是昨收，一眼看出全日在昨收之上或之下
  var dev = 0;
  var track = function (p) { if (p != null) { var d = Math.abs(p - ref); if (d > dev) dev = d; } };
  track(b.h); track(b.l); vwap.forEach(track);
  dev = dev * 1.08 || ref * 0.01;
  var hi = ref + dev, lo = ref - dev;

  var x = function (k) { return (_lcTmin(b.t[k]) - LC_SESS_S) / (LC_SESS_E - LC_SESS_S) * LC_W; };
  var y = function (p) { return (hi - p) * LC_H / (hi - lo); };

  var s = '<svg class="lc-svg" viewBox="0 0 ' + LC_W + ' ' + LC_H + '" preserveAspectRatio="none">';
  // 昨收中線
  var yRef = y(ref);
  s += '<line class="ck-ref" x1="0" y1="' + yRef.toFixed(1) + '" x2="' + LC_W + '" y2="' + yRef.toFixed(1) + '"/>';
  // 價格線以昨收為界分段上色，跨越處精確切分
  var k3, redFill = '', dnFill = '', redLn = '', dnLn = '';
  var seg = function (xa, ya, xb, yb, red) {
    var ln = 'M' + xa.toFixed(1) + ' ' + ya.toFixed(1) + 'L' + xb.toFixed(1) + ' ' + yb.toFixed(1);
    var fl = ln + 'L' + xb.toFixed(1) + ' ' + yRef.toFixed(1) + 'L' + xa.toFixed(1) + ' ' + yRef.toFixed(1) + 'Z';
    if (red) { redLn += ln; redFill += fl; } else { dnLn += ln; dnFill += fl; }
  };
  for (k3 = 0; k3 < n - 1; k3++) {
    var ca = b.c[k3], cb = b.c[k3 + 1], xa = x(k3), xb = x(k3 + 1);
    if ((ca >= ref) === (cb >= ref)) {
      seg(xa, y(ca), xb, y(cb), ca >= ref);
    } else {
      var xc = xa + (xb - xa) * (ref - ca) / (cb - ca);
      seg(xa, y(ca), xc, yRef, ca >= ref);
      seg(xc, yRef, xb, y(cb), cb >= ref);
    }
  }
  if (dnFill) s += '<path class="ck-fill dn" d="' + dnFill + '"/>';
  if (redFill) s += '<path class="ck-fill up" d="' + redFill + '"/>';
  if (dnLn) s += '<path class="ck-iline dn lc-ln" d="' + dnLn + '"/>';
  if (redLn) s += '<path class="ck-iline up lc-ln" d="' + redLn + '"/>';
  var vp = [];
  for (k3 = 0; k3 < n; k3++) if (vwap[k3] != null) vp.push(x(k3).toFixed(1) + ',' + y(vwap[k3]).toFixed(1));
  if (vp.length > 1) s += '<polyline class="ck-vwap lc-ln" points="' + vp.join(' ') + '"/>';
  return s + '</svg>';
}

// 表格重建時貼的就是這個字串：畫好的放快取，還沒好的先給一行字
function _lcCellHtml(code) {
  var cc = _lcCache[code];
  if (cc && cc.svg) return '<div class="lc-mini" title="點代號看完整大圖">' + cc.svg + '</div>';
  var msg = !cc ? '載入中…' : (cc.err ? '載入失敗' : '無成交');
  return '<div class="lc-mini lc-msg">' + msg + '</div>';
}

async function _lcLoad(code, force) {
  var cc = _lcCache[code];
  if (!force && cc && Date.now() - cc.fetched < 55000) return false;
  if (_lcLoading[code]) return false;
  _lcLoading[code] = 1;
  try {
    var b = await _lcFetch(code);
    _lcCache[code] = { bars: b, fetched: Date.now(), svg: b ? _lcSvg(b, code) : '' };
  } catch (e) {
    _lcCache[code] = { bars: null, fetched: Date.now(), svg: '', err: e.message };
  }
  delete _lcLoading[code];
  return true;
}

// 13 檔一次要 13 個請求，四個一批送，不要一口氣打滿本機伺服器
async function liveChartLoadAll(force) {
  var codes = _positions.map(function (p) { return String(p.code); });
  for (var i = 0; i < codes.length; i += 4) {
    var batch = codes.slice(i, i + 4);
    var done = await Promise.all(batch.map(function (c) { return _lcLoad(c, force); }));
    // 每批畫完就更新那幾格，不必等全部回來
    batch.forEach(function (c, k) { if (done[k]) _lcPaint(c); });
  }
}

// 只換那一格的內容，不動整張表（整表重建由 renderLiveTables 負責）
function _lcPaint(code) {
  var tr = document.getElementById('live-tr-' + code);
  var cell = tr && tr.querySelector('.lc-cell');
  if (cell) cell.innerHTML = _lcCellHtml(code);
}

// 盤中每 60 秒更新所有小圖（分 K 一分鐘才多一根，更密沒有意義）
function _lcStartTimer() {
  if (_lcTimer) return;
  _lcTimer = setInterval(function () {
    var v = document.getElementById('live-view');
    if (!v || v.style.display === 'none') return;
    if (typeof _twMarketLive === 'function' && !_twMarketLive()) return;
    liveChartLoadAll(true);
  }, 60000);
}
