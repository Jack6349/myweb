// 股利總管 Web — 持股庫存（券商 position_unit 為準，即時更新現值/損益）
// 每列前置〔明細〕按鈕 → 彈出該檔「交易紀錄」（建倉明細 position_detail）

var _invStarted = false;
var _invSort = 'codeAsc';

// 排序用衍生值
function invMetrics(p) {
  var code = String(p.code), r = _rows[code], c = _contracts[code];
  var shares = p.quantity, cost = p.price * shares;
  var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
  var netVal = price != null ? (_taxMode ? price * shares * 0.997735 : price * shares) : null;
  var profit = netVal != null ? netVal - cost : null;
  var prate = (profit != null && cost) ? profit / cost * 100 : null;
  var chg = (price != null && c && c.reference) ? (price - c.reference) / c.reference * 100 : null;
  return { val: netVal, profit: profit, prate: prate, chg: chg };
}

// 整欄表頭可點：第一次點降冪（▼ 高→低），再點升冪（▲），再點又降冪…（兩態切換，恆有排序）
function invSortCol(key) {
  _invSort = (_invSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  renderInvTable();
  _updateInvSortArrows();
}
// 依 _invSort 更新各排序欄位的箭頭方向與高亮
function _updateInvSortArrows() {
  document.querySelectorAll('#inv-view th.sort-th').forEach(function (th) {
    var key = th.getAttribute('data-key');
    var on = _invSort === key + 'Asc' || _invSort === key + 'Desc';
    th.classList.toggle('sorted', on);
    var ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = _invSort === key + 'Asc' ? '▲' : (_invSort === key + 'Desc' ? '▼' : '↕');
  });
}

// 全部持股的今日總現值（＝各檔現價×股數之和，與「現值」欄同基準）；供現值比/現值率分母用
function _invTotalVal() {
  var tot = 0;
  (_positions || []).forEach(function (p) {
    var r = _rows[String(p.code)];
    var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    if (price != null) tot += price * p.quantity;
  });
  return tot;
}

function invValRow(p) {
  var code = String(p.code);
  var c = _contracts[code], r = _rows[code];
  var shares = p.quantity;                   // 已是「股」（含零股）
  var cost = p.price * shares;               // 總付出成本
  var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
  var val = price != null ? price * shares : null;   // 即時現值
  var netVal = val != null ? (_taxMode ? val * 0.997735 : val) : null;
  var profit = netVal != null ? netVal - cost : null;
  var prate = (profit != null && cost) ? profit / cost * 100 : null;
  var chg = (price != null && c && c.reference) ? (price - c.reference) / c.reference * 100 : null;
  var chgAmt = (price != null && c && c.reference) ? price - c.reference : null; // 今日漲跌金額（現價−昨收）
  var pcls = profit == null ? 'flat' : colorClass(profit);
  var ccls = chg == null ? 'flat' : colorClass(chg);
  // 現值比＝該檔現值佔總現值%；現值率＝該檔未實現損益佔總現值%（貢獻值，有正負）
  var totVal = _invTotalVal();
  var vRatio = (val != null && totVal) ? val / totVal * 100 : null;
  var pRatio = (profit != null && totVal) ? profit / totVal * 100 : null;
  var cm = (typeof constEst === 'function') ? constEst(code) : null; // 成份股估算（覆蓋率達標才有）
  var estCls = (cm && cm.est != null) ? colorClass(cm.est) : 'flat';
  // 注意股圓點：與即時持股共用識別色（_liveColorMap）與標記狀態（live_watch_v1），兩頁互通
  var dotOn = (typeof loadWatch === 'function') && loadWatch().has(code);
  var dotColor = (typeof _liveColorMap !== 'undefined' && _liveColorMap[code]) || '#888';
  return '<td class="inv-detail"><button class="btn-detail" onclick="openTradeDetail(\'' + code + '\',' + p.id + ')">明細</button>' +
      (cm ? '<button class="btn-detail" style="margin-left:4px" onclick="openConstituents(\'' + code + '\')">成份股</button>' : '') + '</td>' +
    '<td class="live-dot-cell"><button class="live-dot' + (dotOn ? ' on' : '') + '" style="--dot:' + dotColor +
      '" title="標記注意股" onclick="event.stopPropagation();toggleWatch(\'' + code + '\',this)"></button></td>' +
    '<td class="inv-code' + (typeof limitState === 'function' && limitState(code, price) ? ' lim-' + limitState(code, price) : '') + '"><span class="code-link" title="看線圖" onclick="event.stopPropagation();openChartPop(\'' + code + '\')">' + code + '</span></td>' +
    '<td class="inv-name">' + ((c && c.name) || '') + '</td>' +
    '<td class="num">' + shares.toLocaleString('zh-TW') + '</td>' +
    costCellHtml(p.price, price) +
    '<td class="num ' + ccls + '">' + (chgAmt == null ? '—' : fmtChg(chgAmt)) + '</td>' +
    '<td class="num ' + ccls + '">' + (price != null ? price.toFixed(2) : '—') + '</td>' +
    '<td class="num ' + ccls + '">' + (chg == null ? '—' : fmtPct(chg)) + '</td>' +
    '<td class="num inv-cchg ' + estCls + '" ' + (cm ? 'title="報價覆蓋率 ' + cm.covW.toFixed(1) + '%"' : '') + '>' +
      (cm && cm.est != null ? fmtPct(cm.est) : '—') + '</td>' +
    '<td class="num">' + Math.round(cost).toLocaleString('zh-TW') + '</td>' +
    '<td class="num">' + (val != null ? Math.round(val).toLocaleString('zh-TW') : '—') + '</td>' +
    '<td class="num ' + pcls + '">' + (profit == null ? '—' : (profit >= 0 ? '+' : '') + Math.round(profit).toLocaleString('zh-TW')) + '</td>' +
    '<td class="num ' + pcls + '">' + (prate == null ? '—' : (prate > 0 ? '+' : '') + prate.toFixed(2) + '%') + '</td>' +
    '<td class="num">' + (vRatio == null ? '—' : vRatio.toFixed(2) + '%') + '</td>' +
    '<td class="num ' + pcls + '">' + (pRatio == null ? '—' : (pRatio > 0 ? '+' : '') + pRatio.toFixed(2) + '%') + '</td>';
}

// 停損停利觸發評估（sell/buy/null）
function invAlert(p) {
  var code = String(p.code), r = _rows[code];
  var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
  var shares = p.quantity, cost = p.price * shares;
  var netVal = price != null ? (_taxMode ? price * shares * 0.997735 : price * shares) : null;
  var profit = netVal != null ? netVal - cost : null;
  var prate = (profit != null && cost) ? profit / cost * 100 : null;
  return (typeof evalAlert === 'function') ? evalAlert(code, price, prate) : null;
}

function renderInvTable() {
  var tb = document.getElementById('inv-tbody');
  if (!tb) return;
  // 識別色未建立（先開本頁、沒進過即時持股）或有新檔（盤中新建倉）時重建色階
  if (typeof buildLiveColors === 'function' &&
      _positions.some(function (p) { return !_liveColorMap[String(p.code)]; })) buildLiveColors();
  var num = function (x) { return x == null ? -Infinity : x; };
  var sorted = _positions.slice().sort(function (a, b) {
    switch (_invSort) {
      case 'codeDesc': return String(b.code).localeCompare(String(a.code), undefined, { numeric: true });
      case 'chgDesc': return num(invMetrics(b).chg) - num(invMetrics(a).chg);
      case 'chgAsc': return num(invMetrics(a).chg) - num(invMetrics(b).chg);
      case 'pnlDesc': return num(invMetrics(b).profit) - num(invMetrics(a).profit);
      case 'pnlAsc': return num(invMetrics(a).profit) - num(invMetrics(b).profit);
      case 'prateDesc': return num(invMetrics(b).prate) - num(invMetrics(a).prate);
      case 'prateAsc': return num(invMetrics(a).prate) - num(invMetrics(b).prate);
      default: return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); // codeAsc
    }
  });
  tb.innerHTML = sorted.map(function (p) {
    var al = invAlert(p);
    return '<tr id="inv-tr-' + String(p.code) + '"' + (al ? ' class="alert-' + al + '"' : '') + '>' + invValRow(p) + '</tr>';
  }).join('');
}

// 即時更新（SSE 觸發）：整表重繪，讓現值比/現值率等「跨列指標」隨任一檔跳動同步一致
// （現值比/現值率的分母是總現值，任一檔變動都影響全部列，故不能只重繪單列）
// 以 setTimeout 節流（~120ms）合併連續 tick：至多每 120ms 重繪一次、且讀取當下最新報價；
// 用 setTimeout 而非 requestAnimationFrame，因 rAF 在分頁切到背景時不觸發、會凍結表格。
var _invRenderPending = false;
function renderInvRow(code) {
  var tb = document.getElementById('inv-tbody');
  if (!tb || !tb.children.length) return; // 未在持股庫存頁 → 不動作
  if (_invRenderPending) return;
  _invRenderPending = true;
  setTimeout(function () {
    _invRenderPending = false;
    var t = document.getElementById('inv-tbody');
    if (t && t.children.length) renderInvTable();
  }, 120);
}

async function startInventory() {
  var errEl = document.getElementById('inv-error');
  var info = document.getElementById('stream-info');
  errEl.style.display = 'none';
  if (!(await checkServer())) { errEl.style.display = 'block'; errEl.innerHTML = serverDownHtml(); return; }
  try {
    await ensureFeed(function (msg) { info.textContent = msg; });
  } catch (e) { errEl.style.display = 'block'; errEl.textContent = e.message; return; }
  renderInvTable();
  _updateInvSortArrows();
  renderSummary('inv-summary');
  if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
  info.textContent = '已連線｜' + _positions.length + ' 檔庫存';
  _invStarted = true;
  if (typeof initConstituents === 'function') initConstituents(); // 背景載入成份股（不阻塞畫面）
}

// ── 交易紀錄明細彈窗（該檔建倉明細 position_detail） ──
async function openTradeDetail(code, detailId) {
  var modal = document.getElementById('detail-modal');
  var body = document.getElementById('detail-body');
  var title = document.getElementById('detail-title');
  var c = _contracts[String(code)];
  title.textContent = code + ' ' + ((c && c.name) || '') + ' — 建倉明細';
  body.innerHTML = '<div class="modal-loading">載入中…</div>';
  modal.style.display = 'flex';
  try {
    var rows = await fetchPositionDetail(detailId);
    if (!rows || !rows.length) { body.innerHTML = '<div class="modal-loading">無明細資料</div>'; return; }
    var totQ = 0, totCost = 0, totPnl = 0, totDiv = 0;
    var html = '<div class="detail-scroll"><table class="detail-table"><thead><tr>' +
      '<th>買進日</th><th>張</th><th class="num">買價</th><th class="num">單筆成本</th><th class="num">現值</th>' +
      '<th class="num">未實現損益</th><th class="num">已配息</th><th class="num">手續費</th></tr></thead><tbody>';
    var ov = (typeof COST_OVERRIDES !== 'undefined' && COST_OVERRIDES[String(code)]) || null;
    rows.forEach(function (d) {
      var lp = d.last_price != null ? d.last_price : 0;
      // 銀行認購成本補正：券商端 price=0 的筆改用實際付出成本顯示，損益同步扣回
      var adj = (d.price === 0 && ov && ov[d.date] != null) ? ov[d.date] : 0;
      var dCost = d.price + adj, dPnl = (d.pnl || 0) - adj;
      var buyPx = d.quantity ? dCost / (d.quantity * 1000) : null; // 每股買價 = 單筆成本 / 股數
      totQ += d.quantity; totCost += dCost; totPnl += dPnl; totDiv += (d.ex_dividends || 0);
      var pcls = dPnl >= 0 ? 'up' : 'down';
      html += '<tr><td>' + d.date + '</td><td class="num">' + d.quantity + '</td>' +
        '<td class="num">' + (buyPx != null ? buyPx.toFixed(2) : '—') + '</td>' +
        '<td class="num">' + Math.round(dCost).toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + Math.round(lp).toLocaleString('zh-TW') + '</td>' +
        '<td class="num ' + pcls + '">' + (dPnl >= 0 ? '+' : '') + Math.round(dPnl).toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + Math.round(d.ex_dividends || 0).toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + Math.round(d.fee || 0).toLocaleString('zh-TW') + '</td></tr>';
    });
    var tcls = totPnl >= 0 ? 'up' : 'down';
    var avgPx = totQ ? totCost / (totQ * 1000) : null; // 加權平均買價
    html += '</tbody><tfoot><tr><td>合計</td><td class="num">' + totQ + '</td>' +
      '<td class="num">' + (avgPx != null ? avgPx.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + Math.round(totCost).toLocaleString('zh-TW') + '</td><td class="num">—</td>' +
      '<td class="num ' + tcls + '">' + (totPnl >= 0 ? '+' : '') + Math.round(totPnl).toLocaleString('zh-TW') + '</td>' +
      '<td class="num">' + Math.round(totDiv).toLocaleString('zh-TW') + '</td><td class="num">—</td></tr></tfoot></table></div>' +
      '<div class="detail-note">累積已配息 ' + Math.round(totDiv).toLocaleString('zh-TW') + ' 元（未計入上方損益）</div>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>';
  }
}
function closeDetailModal() {
  var modal = document.getElementById('detail-modal');
  modal.style.display = 'none';
  var box = modal.querySelector('.modal-box');
  if (box) box.classList.remove('chart-wide'); // 還原一般彈窗尺寸
  if (typeof closeConstPop === 'function') closeConstPop(); // 成份股彈窗收尾（還原輪詢頻率）
  // 線圖彈窗收尾：停止延遲渲染、關閉盤中自動更新、退訂五檔（歸還訂閱額度）
  if (typeof _chartCode !== 'undefined') _chartCode = null;
  if (typeof _chartStopBidAsk === 'function') _chartStopBidAsk();
  if (typeof _chartStopLiveTimer === 'function') _chartStopLiveTimer();
}
