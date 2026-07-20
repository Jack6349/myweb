// 股利總管 Web — 即時持股（左右兩欄精簡表，盤中逐筆即時更新）
// 欄位：代號｜餘額(股)｜成本均價｜現價｜漲跌幅｜現值｜未實現損益｜獲利率（無明細鈕、無名稱）
// 分配：先左後右平均分配，奇數檔左欄多一（如 13 檔 → 左 7 右 6）

var _liveSort = 'codeAsc'; // 排序狀態

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
}

// 計算單檔衍生值（現價優先用即時 tick，其次券商 last_price）
function liveCalc(p) {
  var code = String(p.code);
  var c = _contracts[code], r = _rows[code];
  var shares = p.quantity; // 股
  var cost = p.price * shares;
  var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
  var val = price != null ? price * shares : null;
  var netVal = val != null ? (_taxMode ? val * 0.997735 : val) : null;
  var profit = netVal != null ? netVal - cost : null;
  var prate = (profit != null && cost) ? profit / cost * 100 : null;
  var chg = (price != null && c && c.reference) ? (price - c.reference) / c.reference * 100 : null;
  var alert = (typeof evalAlert === 'function') ? evalAlert(code, price, prate) : null;
  return { code: code, cost: cost, price: price, val: netVal, profit: profit, prate: prate, chg: chg, avg: p.price, alert: alert };
}

function liveRowHtml(p) {
  var v = liveCalc(p);
  var pcls = v.profit == null ? 'flat' : colorClass(v.profit);
  var ccls = v.chg == null ? 'flat' : colorClass(v.chg);
  var on = loadWatch().has(v.code);
  var dotColor = _liveColorMap[v.code] || '#888';
  return '<td class="live-dot-cell"><button class="live-dot' + (on ? ' on' : '') + '" style="--dot:' + dotColor +
      '" title="標記注意股" onclick="event.stopPropagation();toggleWatch(\'' + v.code + '\',this)"></button></td>' +
    '<td class="inv-code">' + v.code + '</td>' +
    '<td class="num">' + (p.quantity != null ? Math.round(p.quantity).toLocaleString('zh-TW') : '—') + '</td>' +
    '<td class="num">' + v.avg.toFixed(2) + '</td>' +
    '<td class="num ' + ccls + '">' + (v.price != null ? v.price.toFixed(2) : '—') + '</td>' +
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
    _liveSortTh('漲跌幅', 'chg', true) +
    '<th class="num">現值</th>' +
    _liveSortTh('未實現損益', 'pnl', true) +
    _liveSortTh('獲利率', 'prate', true) + '</tr></thead>';
}

function renderLiveTables() {
  var box = document.getElementById('live-cols');
  if (!box) return;
  var sorted = liveSorted();
  var half = Math.ceil(sorted.length / 2); // 奇數左欄多一
  var cols = [sorted.slice(0, half), sorted.slice(half)];
  box.innerHTML = cols.map(function (list) {
    return '<div class="live-col"><table class="inv-table live-table">' + liveHead() + '<tbody>' +
      list.map(function (p) { var al = liveCalc(p).alert; return '<tr id="live-tr-' + String(p.code) + '"' + (al ? ' class="alert-' + al + '"' : '') + '>' + liveRowHtml(p) + '</tr>'; }).join('') +
      '</tbody></table></div>';
  }).join('');
}

// 即時更新（SSE 觸發）：整表重建並依目前排序即時重排（13 檔重排為微秒級，成本可忽略）
function renderLiveRow(code) {
  var box = document.getElementById('live-cols');
  if (!box || !box.children.length) return; // 未進入即時持股頁時不動作
  renderLiveTables();
}

function liveSortCol(key) {
  _liveSort = (_liveSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
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
