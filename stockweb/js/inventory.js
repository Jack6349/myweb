// 股利總管 Web — 持股庫存（券商 position_unit 為準，即時更新現值/損益）
// 每列前置〔明細〕按鈕 → 彈出該檔「交易紀錄」（建倉明細 position_detail）

var _invStarted = false;
var _invSort = 'exDesc';   // 預設：最近除息由近至遠（配息紀錄載入前全為空，排序維持原順序，載入後自動重排）

// 排序用衍生值
function invMetrics(p) {
  var code = String(p.code), r = _rows[code], c = _contracts[code];
  var shares = p.quantity, cost = p.price * shares;
  var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
  var netVal = price != null ? (_taxMode ? price * shares * 0.997735 : price * shares) : null;
  var profit = netVal != null ? netVal - cost : null;
  var prate = (profit != null && cost) ? profit / cost * 100 : null;
  var chg = (price != null && c && c.reference) ? (price - c.reference) / c.reference * 100 : null;
  return { val: netVal, profit: profit, prate: prate, chg: chg, shares: shares };
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
  // 現值比＝該檔現值佔總現值%
  var totVal = _invTotalVal();
  var vRatio = (val != null && totVal) ? val / totVal * 100 : null;
  var cm = (typeof constEst === 'function') ? constEst(code) : null; // 成份股估算（覆蓋率達標才有）
  var estCls = (cm && cm.est != null) ? colorClass(cm.est) : 'flat';
  // 注意股圓點：與即時持股共用識別色（_liveColorMap）與標記狀態（live_watch_v1），兩頁互通
  var dotOn = (typeof loadWatch === 'function') && loadWatch().has(code);
  var dotColor = (typeof _liveColorMap !== 'undefined' && _liveColorMap[code]) || '#888';
  // 成份股按鈕在資料載入完成後才會出現 → 載入中先放同寬的佔位（轉圈），避免整列/整頁事後位移
  var constWait = (typeof constLoading === 'function') && constLoading(code);
  return '<td class="inv-detail"><button class="btn-detail" onclick="openTradeDetail(\'' + code + '\',' + p.id + ')">明細</button>' +
      (cm ? '<button class="btn-detail" style="margin-left:4px" onclick="openConstituents(\'' + code + '\')">成份股</button>'
          : (constWait ? '<span class="btn-detail btn-ghost" style="margin-left:4px" title="成份股資料載入中"><i class="spin"></i></span>' : '')) + '</td>' +
    '<td class="live-dot-cell"><button class="live-dot' + (dotOn ? ' on' : '') + '" style="--dot:' + dotColor +
      '" title="標記注意股" onclick="event.stopPropagation();toggleWatch(\'' + code + '\',this)"></button></td>' +
    '<td class="inv-code' + (typeof limitState === 'function' && limitState(code, price) ? ' lim-' + limitState(code, price) : '') + '"><span class="code-link" title="看線圖" onclick="event.stopPropagation();openChartPop(\'' + code + '\')">' + code + '</span></td>' +
    '<td class="inv-name">' + ((c && c.name) || '') + '</td>' +
    '<td class="num">' + shares.toLocaleString('zh-TW') + '</td>' +
    '<td class="num ' + ccls + '">' + (price != null ? price.toFixed(2) : '—') + '</td>' +
    '<td class="num ' + ccls + '">' + (chgAmt == null ? '—' : fmtChg(chgAmt)) + '</td>' +
    '<td class="num ' + ccls + '">' + (chg == null ? '—' : fmtPct(chg)) + '</td>' +
    '<td class="num inv-cchg ' + estCls + '" ' + (cm ? 'title="報價覆蓋率 ' + cm.covW.toFixed(1) + '%"' : '') + '>' +
      (cm && cm.est != null ? fmtPct(cm.est) : (constWait ? '<i class="spin"></i>' : '—')) + '</td>' +
    costCellHtml(p.price, price) +
    '<td class="num">' + Math.round(cost).toLocaleString('zh-TW') + '</td>' +
    '<td class="num">' + (val != null ? Math.round(val).toLocaleString('zh-TW') : '—') + '</td>' +
    '<td class="num ' + pcls + '">' + (profit == null ? '—' : (profit >= 0 ? '+' : '') + Math.round(profit).toLocaleString('zh-TW')) + '</td>' +
    '<td class="num ' + pcls + '">' + (prate == null ? '—' : (prate > 0 ? '+' : '') + prate.toFixed(2) + '%') + '</td>' +
    '<td class="num">' + (vRatio == null ? '—' : vRatio.toFixed(2) + '%') + '</td>' +
    _invExCell(code);
}

// ── 最近／下次除息日 ──
// 規則：本月有除息 → 顯示本月那次（已過含當天＝灰、尚未到＝亮橘）；
//       本月沒有 → 顯示下月起到年底最近一次（含股利估算的預估除息日）＝白字；年底前都沒有 → —。
// 資料：已公告紀錄取自 _divRecMap（含 TPEx 預告與手動補登）；預估取自股利估算 _divEstResult 的月度結果
//      （預估月若無除息日，以發放日往前推 28 天回推，與 _divDerivePay 同一組規則）。
function _invExInfo(code) {
  code = String(code);
  var map = (typeof _divRecMap !== 'undefined' && _divRecMap) || {};
  var loaded = !!Object.keys(map).length;
  var today = _divTwDate().iso, ym = today.slice(0, 7), yearEnd = today.slice(0, 4) + '-12-31';

  // 候選：已公告紀錄 ＋ 股利估算的預估除息（同一天以已公告者為準）
  var cand = {};
  (map[code] || []).forEach(function (r) {
    if (r.exDate) cand[r.exDate] = { iso: r.exDate, amount: r.amount, est: false };
  });
  var st = (typeof _divEstResult !== 'undefined' && _divEstResult) &&
    _divEstResult.stocks.filter(function (x) { return x.code === code; })[0];
  if (st) st.res.months.forEach(function (m) {
    if (m.status !== 'est') return;
    var iso = m.exDate || (m.payDate ? new Date(Date.parse(m.payDate) - 28 * 86400000).toISOString().slice(0, 10) : null);
    if (iso && !cand[iso]) cand[iso] = { iso: iso, amount: m.perShare, est: true };
  });
  var list = Object.keys(cand).sort().map(function (k) { return cand[k]; });
  if (!list.length) return { iso: null, loaded: loaded };

  var inMonth = list.filter(function (x) { return x.iso.slice(0, 7) === ym; })[0];
  if (inMonth) return Object.assign({ cls: inMonth.iso <= today ? 'inv-ex-past' : 'inv-ex-soon',
    past: inMonth.iso <= today, loaded: true }, inMonth);
  var nxt = list.filter(function (x) { return x.iso > today && x.iso <= yearEnd; })[0];
  if (nxt) return Object.assign({ cls: 'inv-ex-next', past: false, loaded: true }, nxt);
  return { iso: null, loaded: true, none: true };
}
function _invExCell(code) {
  var e = _invExInfo(code);
  if (!e.iso) {
    _invEnsureDiv();   // 股利估算尚未載入 → 背景載一次（配息資料每日快取，之後切頁不再抓）
    return '<td class="num inv-ex inv-ex-none"' + (e.none ? ' title="年底前無除息（含預估）"' : '') + '>' +
      (e.loaded ? '—' : '<i class="spin"></i>') + '</td>';
  }
  var tip = e.iso + (e.est ? '（預估）' : '') +
    (e.amount > 0 ? '　每股 ' + e.amount.toFixed(4) + (e.est ? '（預估）' : '') : '　金額待公告') +
    (e.past ? '　已除息' : '');
  // 預估標記放日期前面：欄位靠右對齊，星號放後面會把日期往左推、與其他列對不齊
  return '<td class="num inv-ex ' + e.cls + '" title="' + tip + '">' +
    (e.est ? '<span class="inv-ex-est">*</span>' : '') + e.iso.slice(5).replace('-', '/') + '</td>';
}
// 持股庫存單獨開啟時 _divRecMap 還是空的 → 背景跑一次股利估算載入配息紀錄，完成後重繪本表
var _invDivLoading = false;
function _invEnsureDiv() {
  if (_invDivLoading || typeof startDividendEst !== 'function') return;
  if (typeof _divRecMap !== 'undefined' && Object.keys(_divRecMap).length) return;
  _invDivLoading = true;
  startDividendEst(false).catch(function () {}).then(function () {
    _invDivLoading = false;
    if (document.getElementById('inv-tbody') && document.getElementById('inv-tbody').children.length) renderInvTable();
  });
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

// ── 分類配置列（表格上方）──
// 收起＝單行摘要（名稱・檔數・成本萬・占比・現值萬・占比），字型量測後自動塞進一行；
// 展開＝4×2 格線，欄位上下對齐、字型與上方合計列一致，並顯示完整金額與合計。
// 折疊狀態寫 localStorage，與股利估算的個股明細同一個使用習慣。
// 現值高於成本用紅、低於用綠（台股慣例）。
// 兩個分母各自獨立：成本占比除以總成本、現值占比除以總現值；
// 後者與庫存表「現值比」欄同基準（未扣稅費），同類各列相加等於這裡的值。
var CAT_LS = 'inv_cats_open_v1';
var _catOpen = (function () { try { return localStorage.getItem(CAT_LS) === '1'; } catch (e) { return false; } })();
function toggleInvCats() {
  _catOpen = !_catOpen;
  try { localStorage.setItem(CAT_LS, _catOpen ? '1' : '0'); } catch (e) {}
  renderInvCats();
}
function renderInvCats() {
  var el = document.getElementById('inv-cats');
  if (!el || typeof catAggregate !== 'function') return;
  var groups = catAggregate(_positions);
  if (!groups.length) { el.style.display = 'none'; return; }
  var totCost = 0, totVal = 0;
  groups.forEach(function (g) { totCost += g.cost; totVal += g.val; });
  var money = function (v) { return Math.round(v).toLocaleString('zh-TW'); };
  var wan = function (v) { return Math.round(v / 10000).toLocaleString('zh-TW') + '萬'; };
  var pct = function (v, t) { return t ? (v / t * 100).toFixed(1) + '%' : '—'; };
  var cls2var = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--text3)' };
  // 現值 vs 成本：高於→紅、低於→綠、相等→灰
  var vcOf = function (g) { return cls2var[colorClass(g.val - g.cost)]; };
  var chev = '<button class="cat-chev" onclick="toggleInvCats()" title="' +
    (_catOpen ? '收起' : '展開分類明細') + '">' + (_catOpen ? '▼' : '▶') + '</button>';

  var html;
  if (!_catOpen) {
    html = '<div class="cat-line">' + groups.map(function (g) {
      return '<span class="cat-item" title="' + g.cat + '：' + g.n + ' 檔　成本 ' + money(g.cost) +
          '　現值 ' + money(g.val) + '">' +
        '<span class="cat-name">' + g.cat + '<span class="cat-n">' + g.n + '</span></span>' +
        '<span class="cat-cost">' + wan(g.cost) + '</span>' +
        '<span class="cat-cp">' + pct(g.cost, totCost) + '</span>' +
        '<span class="cat-val" style="color:' + vcOf(g) + '">' + wan(g.val) + '</span>' +
        '<span class="cat-vp" style="color:' + vcOf(g) + '">' + pct(g.val, totVal) + '</span></span>';
    }).join('') + '</div>' + chev;
  } else {
    // 標題列：名稱｜損益金額｜損益率，與下方「成本／現值」共用同一組三欄格線 → 金額、百分比上下對齊。
    // 損益＝現值－成本、損益率＝損益÷成本，皆未扣稅費（與本格成本、現值同基準，損益剛好等於兩行相減）。
    // 注意：下方兩行的百分比是「占全部持股比重」，標題列的是「本類報酬率」，只是同欄對齊。
    var cell = function (name, n, cost, val, cp, vp, cls) {
      var pnl = val - cost, pc = cls2var[colorClass(pnl)];
      var sign = function (v) { return v > 0 ? '+' : ''; };
      return '<div class="cat-cell' + (cls || '') + '">' +
        '<div class="cat-cname">' + name + (n != null ? '<span class="cat-n">' + n + '</span>' : '') + '</div>' +
        '<div class="cat-pnl" style="color:' + pc + '" title="損益＝現值－成本（未扣稅費）">' + sign(pnl) + money(pnl) + '</div>' +
        '<div class="cat-pp" style="color:' + pc + '" title="損益率＝損益÷成本">' +
          (cost ? sign(pnl) + (pnl / cost * 100).toFixed(1) + '%' : '—') + '</div>' +
        '<div class="cat-lb">成本</div><div class="cat-cost">' + money(cost) + '</div><div class="cat-cp">' + cp + '</div>' +
        '<div class="cat-lb">現值</div><div class="cat-val" style="color:' + pc + '">' + money(val) + '</div>' +
        '<div class="cat-vp" style="color:' + pc + '">' + vp + '</div></div>';
    };
    var cells = groups.map(function (g) {
      return cell(g.cat, g.n, g.cost, g.val, pct(g.cost, totCost), pct(g.val, totVal));
    }).concat([cell('合計', groups.reduce(function (a, g) { return a + g.n; }, 0),
      totCost, totVal, '100.0%', '100.0%', ' cat-cell-tot')]);
    // 每 4 格（一排）之間插一條橫跨整排的分隔線；分類數不固定，依格數自動決定排數
    html = '<div class="cat-grid">' + cells.map(function (h, i) {
      return (i && i % 4 === 0 ? '<div class="cat-sep"></div>' : '') + h;
    }).join('') + '</div>' + chev;
  }
  el.innerHTML = html;
  el.className = 'cat-bar' + (_catOpen ? ' open' : '');
  el.style.display = '';
  if (!_catOpen) _catLineFit(el.querySelector('.cat-line'));
}
// 收起狀態才需要量測：七類塞一行，從 16px（與上方合計列同尺）逐步調小至塞得進，下限 11px。
// 頁面還沒佈局（clientWidth 0）時不量，否則會一路縮到下限；
// 下一次 renderInvTable（行情 tick）或 resize 會重量。
function _catLineFit(line) {
  if (!line || !line.clientWidth) return;
  for (var fs = 16; fs >= 11; fs -= 0.5) {
    line.style.fontSize = fs + 'px';
    if (line.scrollWidth <= line.clientWidth) return;
  }
}
window.addEventListener('resize', function () {
  var line = document.querySelector('#inv-cats .cat-line');
  if (line && line.clientWidth) _catLineFit(line);
});

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
      case 'sharesDesc': return num(invMetrics(b).shares) - num(invMetrics(a).shares);
      case 'sharesAsc': return num(invMetrics(a).shares) - num(invMetrics(b).shares);
      // 現值比 = 該檔現值 ÷ 總現值；分母全表相同，排序絉同於比現值，
      // 直接比 val 可避開每次比較都重算一次 _invTotalVal()
      case 'vratioDesc': return num(invMetrics(b).val) - num(invMetrics(a).val);
      case 'vratioAsc': return num(invMetrics(a).val) - num(invMetrics(b).val);
      // 最近除息：依畫面顯示的日期排；沒有除息紀錄的一律墊底（升冪降冪皆然）
      case 'exDesc': case 'exAsc': {
        var ia = _invExInfo(a.code).iso, ib = _invExInfo(b.code).iso;
        if (!ia && !ib) return 0;
        if (!ia) return 1;
        if (!ib) return -1;
        return _invSort === 'exAsc' ? (ia < ib ? -1 : (ia > ib ? 1 : 0)) : (ib < ia ? -1 : (ib > ia ? 1 : 0));
      }
      default: return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); // codeAsc
    }
  });
  tb.innerHTML = sorted.map(function (p) {
    var al = invAlert(p);
    return '<tr id="inv-tr-' + String(p.code) + '"' + (al ? ' class="alert-' + al + '"' : '') + '>' + invValRow(p) + '</tr>';
  }).join('');
  renderInvCats();   // 分類配置列：跟表格同一個重繪周期，隨行情跟稅費切換同步
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
