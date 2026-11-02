// 股利總管 Web — 即時持股（單欄精簡表＋右側當日分時走勢，盤中逐筆即時更新）
// 欄位：代號｜餘額(股)｜成本均價｜現價｜漲跌幅｜現值｜含息損益｜含息獲利率（無明細鈕、無名稱）
// 成本一律用原始成本（券商的成本已扣掉累積配息），與持股庫存同一套；
// 顯示的損益與獲利率都含息，與停損停利的觸發基準一致
// 版面：左側單欄列完所有持股（原本左右各半，欄位找起來要兩邊掃），
// 右側一張跟隨選取列的當日分時走勢圖，捲動時圖固定不動。

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
    '<td class="num ' + ccls + '">' + (v.price != null ? v.price.toFixed(2) : '—') + '</td>' +
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
  }
  return arr;
}

// 整欄表頭可點排序（與持股庫存一致）：單一箭頭指示狀態，點擊區＝整格
function _liveSortTh(label, key, numCls) {
  var on = _liveSort === key + 'Asc' || _liveSort === key + 'Desc';
  var arrow = _liveSort === key + 'Asc' ? '▲' : (_liveSort === key + 'Desc' ? '▼' : '↕');
  return '<th class="' + (numCls ? 'num ' : '') + 'sort-th' + (on ? ' sorted' : '') + '" onclick="liveSortCol(\'' + key + '\')" title="點擊排序">' +
    label + '<span class="sort-ind">' + arrow + '</span></th>';
}
function liveHead() {
  return '<thead><tr><th class="live-dot-cell"></th>' +
    _liveSortTh('代號', 'code') +
    '<th class="num">餘額</th><th class="num">成本均價</th><th class="num">現價</th>' +
    '<th class="num">漲跌</th>' +
    _liveSortTh('漲跌幅', 'chg', true) +
    '<th class="num">現值</th>' +
    _liveSortTh('含息損益', 'pnl', true) +
    _liveSortTh('含息獲利率', 'prate', true) + '</tr></thead>';
}

function renderLiveTables() {
  var box = document.getElementById('live-cols');
  if (!box) return;
  var sorted = liveSorted();
  // 外框只建一次：盤中每筆成交都會重畫表格，整個 box 重建會把右側圖一起洗掉
  if (!document.getElementById('live-tblcol')) {
    box.innerHTML = '<div class="live-col" id="live-tblcol"></div><aside class="live-chart" id="live-chart"></aside>';
  }
  document.getElementById('live-tblcol').innerHTML =
    '<table class="inv-table live-table">' + liveHead() + '<tbody>' +
    sorted.map(function (p) {
      var c = String(p.code), al = liveCalc(p).alert;
      return '<tr id="live-tr-' + c + '" class="' + (al ? 'alert-' + al + ' ' : '') + (c === _lcSel ? 'lc-on' : '') +
        '" onclick="liveSelect(\'' + c + '\')">' + liveRowHtml(p) + '</tr>';
    }).join('') + '</tbody></table>';
  // 預設選第一列；排序或庫存變動後選取的檔若不在了，退回第一列
  var codes = sorted.map(function (p) { return String(p.code); });
  if (!_lcSel || codes.indexOf(_lcSel) < 0) { _lcSel = codes[0] || null; _lcMark(); }
  if (_lcSel) { renderLiveChart(); _lcHeadUpdate(); liveChartLoad(_lcSel); }
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
  info.textContent = '已連線｜' + _positions.length + ' 檔庫存';
}

// ── 右側當日分時走勢（跟隨左側選取列）──
// 與線圖彈窗「日均」同一套：Shioaji 1 分 K、縱軸以昨收為中心對稱、白線為均價（VWAP）。
// 這裡是精簡版，不放報價面板與內外盤；點代號仍可開完整大圖。
// 更新節奏刻意與表格分開：表格每筆成交就重建，但分 K 一分鐘才多一根，
// 圖跟著 tick 重畫十次有九次畫出同一張，所以圖自己走 60 秒一次。

var LC_SEL_LS = 'live_chart_sel_v1';
var _lcSel = (function () { try { return localStorage.getItem(LC_SEL_LS) || null; } catch (e) { return null; } })();
var _lcCache = {};            // code → { bars, fetched }
var _lcShown = null;          // 目前畫在右側的代號，避免每筆 tick 重畫同一張圖
var _lcTimer = null, _lcLoading = null;

function _lcYmd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// 先抓今日分 K（約 17KB）；開盤前或非交易日今日無資料，才退回 10 天取最後一個有資料的交易日
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

var LC_W = 520, LC_H = 268, LC_VH = 40, LC_PAD_L = 44, LC_PAD_R = 10, LC_PAD_T = 10, LC_GAP = 14;
var LC_PW = LC_W - LC_PAD_L - LC_PAD_R, LC_PH = LC_H - LC_VH - LC_GAP - LC_PAD_T - 14;
var LC_SESS_S = 540, LC_SESS_E = 810;   // 09:00–13:30，分鐘
function _lcTmin(t) { return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10); }

function _lcSvg(b, code) {
  var n = b.c.length;
  if (!n) return '<div class="modal-loading">當日無成交資料</div>';
  var ct = _contracts[code] || {}, ref = ct.reference || b.c[0];

  // 均價線（VWAP）：累計金額 ÷ 累計量；量的單位是張，要換算成股
  var vwap = [], cumA = 0, cumV = 0;
  for (var i = 0; i < n; i++) { cumA += b.amt[i] || 0; cumV += b.v[i] || 0; vwap.push(cumV ? cumA / (cumV * 1000) : null); }

  // 縱軸以昨收為中心對稱 → 中線永遠是昨收，一眼看出全日在昨收之上或之下
  var dev = 0;
  var track = function (p) { if (p != null) { var d = Math.abs(p - ref); if (d > dev) dev = d; } };
  track(b.h); track(b.l); vwap.forEach(track);
  dev = dev * 1.05 || ref * 0.01;
  var hi = ref + dev, lo = ref - dev;
  var vmax = 1; b.v.forEach(function (v) { if (v > vmax) vmax = v; });

  var x = function (k) { return LC_PAD_L + (_lcTmin(b.t[k]) - LC_SESS_S) / (LC_SESS_E - LC_SESS_S) * LC_PW; };
  var y = function (p) { return LC_PAD_T + (hi - p) * LC_PH / (hi - lo); };
  var vy = function (v) { return LC_PAD_T + LC_PH + LC_GAP + LC_VH - v * LC_VH / vmax; };

  var s = '<svg class="chart-svg lc-svg" viewBox="0 0 ' + LC_W + ' ' + LC_H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var pv = hi - dev * 2 * g / 4, yy = y(pv);
    var kls = g === 2 ? 'ck-ax-ref' : (g < 2 ? 'ck-ax-up' : 'ck-ax-dn');
    s += '<line class="' + (g === 2 ? 'ck-ref' : 'ck-grid') + '" x1="' + LC_PAD_L + '" y1="' + yy.toFixed(1) + '" x2="' + (LC_W - LC_PAD_R) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="ck-axis ' + kls + '" x="' + (LC_PAD_L - 5) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + pv.toFixed(2) + '</text>';
  }
  for (var hh = 9; hh <= 13; hh++) {
    var xg = LC_PAD_L + (hh * 60 - LC_SESS_S) / (LC_SESS_E - LC_SESS_S) * LC_PW;
    if (hh > 9) s += '<line class="ck-grid" x1="' + xg.toFixed(1) + '" y1="' + LC_PAD_T + '" x2="' + xg.toFixed(1) + '" y2="' + (LC_PAD_T + LC_PH) + '"/>';
    s += '<text class="ck-axis" x="' + xg.toFixed(1) + '" y="' + (LC_H - 2) + '" text-anchor="middle">' + String(hh).padStart(2, '0') + '</text>';
  }
  var bw = Math.max(0.6, LC_PW / (LC_SESS_E - LC_SESS_S) * 0.7);
  for (var k2 = 0; k2 < n; k2++) {
    if (!b.v[k2]) continue;
    s += '<rect class="ck-ivol" x="' + (x(k2) - bw / 2).toFixed(1) + '" y="' + vy(b.v[k2]).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.6, b.v[k2] * LC_VH / vmax).toFixed(1) + '"/>';
  }
  // 價格線以昨收為界分段上色：高於昨收＝紅、低於＝綠，跨越處精確切分
  var yRef = y(ref), k3;
  var redFill = '', dnFill = '', redLn = '', dnLn = '';
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
  if (dnLn) s += '<path class="ck-iline dn" d="' + dnLn + '"/>';
  if (redLn) s += '<path class="ck-iline up" d="' + redLn + '"/>';
  var vp = [];
  for (k3 = 0; k3 < n; k3++) if (vwap[k3] != null) vp.push(x(k3).toFixed(1) + ',' + y(vwap[k3]).toFixed(1));
  if (vp.length > 1) s += '<polyline class="ck-vwap" points="' + vp.join(' ') + '"/>';
  s += '<line class="ck-grid" x1="' + LC_PAD_L + '" y1="' + (LC_PAD_T + LC_PH + LC_GAP) + '" x2="' + (LC_W - LC_PAD_R) + '" y2="' + (LC_PAD_T + LC_PH + LC_GAP) + '"/>';
  s += '<rect id="lc-hit" x="' + LC_PAD_L + '" y="' + LC_PAD_T + '" width="' + LC_PW + '" height="' + (LC_PH + LC_GAP + LC_VH) + '" fill="transparent"/>' +
    '<line id="lc-cross" class="ck-cross" x1="0" y1="' + LC_PAD_T + '" x2="0" y2="' + (LC_PAD_T + LC_PH + LC_GAP + LC_VH) + '" style="display:none"/></svg>';
  return s;
}

// 標題列：代號、名稱、現價、漲跌、均價、日期。盤中每筆成交都重寫（只是一小段文字，成本可忽略）
function _lcHeadHtml(code) {
  var ct = _contracts[code] || {}, cc = _lcCache[code], b = cc && cc.bars;
  var ref = ct.reference, r = _rows[code] || {};
  var last = r.close != null ? r.close : (b ? b.c[b.c.length - 1] : null);
  var chg = (last != null && ref) ? last - ref : null, pct = (chg != null && ref) ? chg / ref * 100 : null;
  var cls = chg == null ? '' : (chg > 0 ? 'up' : (chg < 0 ? 'down' : ''));
  var avg = null;
  if (b) { var cumA = 0, cumV = 0; for (var i = 0; i < b.c.length; i++) { cumA += b.amt[i] || 0; cumV += b.v[i] || 0; } avg = cumV ? cumA / (cumV * 1000) : null; }
  var f2 = function (v) { return v != null ? v.toFixed(2) : '—'; };
  return '<span class="lc-code">' + code + '</span><span class="lc-name">' + (ct.name || '') + '</span>' +
    '<b class="' + cls + '">' + f2(last) + '</b>' +
    '<span class="' + cls + '">' + (chg == null ? '' : (chg > 0 ? '+' : '') + chg.toFixed(2) + '（' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%）') + '</span>' +
    '<span class="ck-legend vwap">均價 ' + f2(avg) + '</span>' +
    '<span class="lc-day">' + (b ? b.day.slice(5).replace('-', '/') : '') + '</span>';
}
function _lcHeadUpdate() {
  var h = document.getElementById('lc-head');
  if (h && _lcSel) h.innerHTML = _lcHeadHtml(_lcSel);
}

function renderLiveChart(force) {
  var host = document.getElementById('live-chart');
  if (!host) return;
  var code = _lcSel;
  if (!code) { host.innerHTML = '<div class="lc-empty">點左側任一列看當日分時走勢</div>'; _lcShown = null; return; }
  if (!force && _lcShown === code) return;      // 同一檔已經畫好，tick 不重畫
  var cc = _lcCache[code];
  var body = !cc ? '<div class="modal-loading">載入當日走勢中…</div>'
    : (cc.bars ? _lcSvg(cc.bars, code) : '<div class="modal-loading">' + (cc.err ? '載入失敗：' + cc.err : '當日無成交資料') + '</div>');
  host.innerHTML = '<div class="lc-head" id="lc-head">' + _lcHeadHtml(code) + '</div>' + body +
    '<div class="detail-note">Shioaji 1 分 K；縱軸以昨收為中心對稱（中線＝昨收），白線為均價（VWAP）。點代號開完整大圖。</div>';
  _lcShown = cc ? code : null;                  // 還在載入的不算畫好，資料到了要重畫
  if (cc && cc.bars) _lcBindHover(cc.bars, code);
}

function _lcBindHover(b, code) {
  var svg = document.querySelector('#live-chart .lc-svg');
  var hit = document.getElementById('lc-hit'), cross = document.getElementById('lc-cross'), head = document.getElementById('lc-head');
  if (!svg || !hit || !cross || !head) return;
  var n = b.c.length, ct = _contracts[code] || {}, ref = ct.reference || b.c[0];
  hit.addEventListener('mousemove', function (ev) {
    var pt = svg.getBoundingClientRect();
    var vx = (ev.clientX - pt.left) / pt.width * LC_W;
    var tgt = LC_SESS_S + (vx - LC_PAD_L) / LC_PW * (LC_SESS_E - LC_SESS_S);
    var k = 0, best = Infinity;
    for (var i = 0; i < n; i++) { var dd = Math.abs(_lcTmin(b.t[i]) - tgt); if (dd < best) { best = dd; k = i; } }
    var xx = LC_PAD_L + (_lcTmin(b.t[k]) - LC_SESS_S) / (LC_SESS_E - LC_SESS_S) * LC_PW;
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.style.display = '';
    var p = b.c[k], d = p - ref, dp = ref ? d / ref * 100 : 0;
    var cls = d > 0 ? 'up' : (d < 0 ? 'down' : '');
    head.innerHTML = '<span class="lc-code">' + code + '</span><span class="lc-name">' + b.t[k] + '</span>' +
      '收 <b class="' + cls + '">' + p.toFixed(2) + '</b>' +
      '<span class="' + cls + '">(' + (d > 0 ? '+' : '') + dp.toFixed(2) + '%)</span>' +
      '<span class="lc-day">量 ' + (b.v[k] || 0).toLocaleString('zh-TW') + '</span>';
  });
  hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; _lcHeadUpdate(); });
}

async function liveChartLoad(code, force) {
  if (!code) return;
  var cc = _lcCache[code];
  if (!force && cc && Date.now() - cc.fetched < 55000) { renderLiveChart(); return; }
  if (_lcLoading === code) return;
  _lcLoading = code;
  try {
    var b = await _lcFetch(code);
    _lcCache[code] = { bars: b, fetched: Date.now() };
  } catch (e) {
    _lcCache[code] = { bars: null, fetched: Date.now(), err: e.message };
  }
  _lcLoading = null;
  if (_lcSel === code) renderLiveChart(true);
}

function _lcMark() {
  var box = document.getElementById('live-tblcol');
  if (!box) return;
  [].slice.call(box.querySelectorAll('tbody tr')).forEach(function (tr) {
    tr.classList.toggle('lc-on', tr.id === 'live-tr-' + _lcSel);
  });
}

function liveSelect(code) {
  _lcSel = String(code);
  try { localStorage.setItem(LC_SEL_LS, _lcSel); } catch (e) {}
  _lcMark();
  renderLiveChart(true);
  liveChartLoad(_lcSel);
}

// 盤中每 60 秒更新選取的那張圖（分 K 一分鐘才多一根，更密沒有意義）
function _lcStartTimer() {
  if (_lcTimer) return;
  _lcTimer = setInterval(function () {
    var v = document.getElementById('live-view');
    if (!v || v.style.display === 'none' || !_lcSel) return;
    if (typeof _twMarketLive === 'function' && !_twMarketLive()) return;
    liveChartLoad(_lcSel, true);
  }, 60000);
}
