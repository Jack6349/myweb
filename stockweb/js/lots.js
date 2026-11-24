// 股利總管 Web — 建倉明細彙整（資產統計的一頁）
//
// 這一頁要回答的是「手上這些部位是怎麼買起來的」：每一檔分成哪幾批、
// 各批當初付多少、現在值多少、含息之後是賺是賠。
//
// 為什麼要有這一頁：同樣的資料持股庫存那邊也看得到，但要一列一列按〔細〕，
// 而且是彈窗，看完得先關掉才能按下一檔。想比較兩檔的建倉結構就得來回開關。
// 這裡左邊一排持股、右邊一張表，點一下換一檔。
//
// 資料不另外打券商：載入持股的時候每一檔的建倉明細就已經抓過一次並留著，
// 出借中的批次也在裡面（彙總股數不含出借，明細含，載入時已經補回）。
//
// 現值與資本損益用「即時現價 × 股數」算，不是券商回的那個快照。
// 兩者差在時間點：券商那個數字停在你載入的那一刻，之後不動。
// 用快照的話，同一列的現價是即時的、現值是幾小時前的，價差與資本損益
// 方向可能相反。改成即時之後五個金額欄互相對得起來，也跟持股庫存頁同一個基準。
// 取不到即時價時退回前一天收盤，再取不到才退回券商快照，並在畫面上標出來。
//
// 這一頁看不到的（資料本身就沒有，不是沒做）：
//   已經整批賣掉的批次 ── 建倉明細只有現在還持有的部位，賣掉就查不到了。
//                         買賣過什麼看交易紀錄那一頁。
//   借券補償           ── 配息只到券商帳務記的那個數，補償另外到帳，
//                         含息損益因此可能略低於實際。
//   年化報酬           ── 配息沒有日期，算出來是純價差報酬，掛年化會被當成含息。

var LT_SEL_LS = 'as_lots_sel_v1', LT_SORT_LS = 'as_lots_sort_v1';
var LT_SORTS = [
  { id: 'code', label: '代號' },
  { id: 'with', label: '含息損益' },
  { id: 'val', label: '現值' },
  { id: 'rate', label: '報酬率' }
];
var _ltPending = false;

function _ltSel() { try { return localStorage.getItem(LT_SEL_LS) || ''; } catch (e) { return ''; } }
function _ltSort() {
  try { return localStorage.getItem(LT_SORT_LS) || 'code'; } catch (e) { return 'code'; }
}

// 即時價。取不到就退前收，再取不到回 null（整列的現值改用券商快照）。
function _ltPx(code) {
  var r = (typeof _rows !== 'undefined' && _rows[code]) || null;
  if (r && r.close != null) return { px: r.close, live: true };
  var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
  if (c && c.reference != null) return { px: c.reference, live: false };
  return { px: null, live: false };
}

// 一檔的每一批。欄位全部在這裡算完，表格與左側清單共用，不會兩邊各算一套。
//
// 原始成本：券商記的成本已經把該批領過的配息扣掉了，加回才是當初實際付出的錢。
// 由認購價還原的那種筆沒有被扣過，加回去會重複，所以要看 sub。
function _ltLots(code) {
  var lots = (typeof _lotsMap !== 'undefined' && _lotsMap[code]) || [];
  var q = _ltPx(code), px = q.px;
  return lots.map(function (l) {
    var sh = l.shares || 0;
    var cost = (l.cost || 0) + (l.sub ? (l.div || 0) : 0);     // 原始成本
    var snap = (l.cost || 0) + (l.pnl || 0);                    // 券商快照的現值
    var val = (px != null) ? px * sh : snap;
    var pnl = val - cost;                                       // 資本損益＝純價差
    var div = l.div || 0;
    return {
      date: l.date, shares: sh, lots: sh / 1000,
      buy: sh ? cost / sh : null,
      px: px, cost: cost, val: val, pnl: pnl, div: div,
      with: pnl + div, fee: l.fee || 0
    };
  });
}

// 一檔的合計。買價是對原始成本的加權平均，價差與報酬率跟著用它算。
function _ltSum(rows) {
  var t = { lots: 0, cost: 0, val: 0, pnl: 0, div: 0, with: 0, fee: 0, shares: 0 };
  rows.forEach(function (r) {
    t.lots += r.lots; t.shares += r.shares; t.cost += r.cost; t.val += r.val;
    t.pnl += r.pnl; t.div += r.div; t.with += r.with; t.fee += r.fee;
  });
  t.buy = t.shares ? t.cost / t.shares : null;
  t.rate = t.cost ? t.pnl / t.cost * 100 : null;
  return t;
}

// 左側清單的順序
function _ltCodes() {
  var out = (typeof _positions !== 'undefined' ? _positions : []).map(function (p) {
    var code = String(p.code);
    var t = _ltSum(_ltLots(code));
    var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
    return { code: code, name: (c && c.name) || '', t: t,
             rate: t.cost ? t.with / t.cost * 100 : null };
  }).filter(function (x) { return x.t.shares > 0; });
  var s = _ltSort();
  out.sort(function (a, b) {
    if (s === 'with') return b.t.with - a.t.with;
    if (s === 'val') return b.t.val - a.t.val;
    if (s === 'rate') return (b.rate == null ? -1e9 : b.rate) - (a.rate == null ? -1e9 : a.rate);
    return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0);
  });
  return out;
}

function ltPick(code) {
  try { localStorage.setItem(LT_SEL_LS, code); } catch (e) {}
  _ltPaint();
}
function ltSortBy(id) {
  try { localStorage.setItem(LT_SORT_LS, id); } catch (e) {}
  _ltPaint();
}

// 盤中每一筆 tick 都會叫到這裡。整塊重畫而不是只換幾格：
// 合計那一列跟著每一批的現值動，單獨補一格會讓合計跟內容對不起來。
// 這一塊沒有能打字的欄位，重畫不會吃掉任何輸入；只有左側清單的捲動位置要留住。
function ltOnTick() {
  if (typeof _curView === 'undefined' || _curView !== 'asset') return;
  if (typeof _asSel === 'undefined' || _asSel !== 'lots') return;
  if (_ltPending) return;
  _ltPending = true;
  setTimeout(function () { _ltPending = false; _ltPaint(); }, 200);
}

function _ltPaint() {
  var pane = document.getElementById('as-pane');
  if (!pane || !pane.querySelector('.lt-wrap')) return;
  var side = pane.querySelector('.lt-side');
  var top = side ? side.scrollTop : 0;
  pane.innerHTML = asRenderLots();
  var ns = pane.querySelector('.lt-side');
  if (ns) ns.scrollTop = top;
}

function _ltMoney(v) {
  return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('zh-TW');
}
function _ltSigned(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.round(Math.abs(v)).toLocaleString('zh-TW');
}
function _ltSignedPx(v, n) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(n == null ? 2 : n);
}
function _ltPct(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(2) + '%';
}
function _ltCol(v) {
  return (v == null) ? 'var(--text3)' : (v > 0 ? 'var(--up)' : (v < 0 ? 'var(--down)' : 'var(--text)'));
}
function _ltEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// ── 左側一列 ──
//
// 一列講四件事：哪一檔、現在多少錢、有幾張、含息之後賺賠多少。
// 每一格固定寬度，不讓名稱的長短把右邊的數字推來推去 ── 這一排是用來掃的，
// 掃的前提是同一個欄位每一列都在同一個水平位置上。
function _ltRow(x, on) {
  var q = _ltPx(x.code);
  var c = (typeof _contracts !== 'undefined' && _contracts[x.code]) || null;
  var ref = c ? c.reference : null;
  var chg = (q.px != null && ref) ? (q.px - ref) / ref * 100 : null;
  return '<button class="lt-row' + (on ? ' on' : '') + '" onclick="ltPick(&quot;' + x.code + '&quot;)">'
    + '<span class="lt-r1"><span class="lt-code">' + x.code + '</span>'
    + '<span class="lt-name">' + _ltEsc(x.name) + '</span></span>'
    + '<span class="lt-r2">'
    + '<span class="lt-px">' + (q.px == null ? '—' : q.px.toFixed(2)) + '</span>'
    + '<span class="lt-chg" style="color:' + _ltCol(chg) + '">' + _ltPct(chg) + '</span>'
    + '<span class="lt-sep">｜</span>'
    + '<span class="lt-q">' + (Math.round(x.t.lots * 1000) / 1000).toLocaleString('zh-TW') + ' 張</span>'
    + '<span class="lt-sep">｜</span>'
    + '<span class="lt-w" style="color:' + _ltCol(x.t.with) + '">' + _ltSigned(x.t.with) + '</span>'
    + '</span></button>';
}

// ── 右側一檔的明細 ──
function _ltPanel(x) {
  if (!x) return '<div class="modal-loading">左邊挑一檔</div>';
  var rows = _ltLots(x.code);
  var c = (typeof _contracts !== 'undefined' && _contracts[x.code]) || null;
  var head = '<div class="lt-ptitle"><span class="lt-pcode">' + x.code + '</span>'
    + '<span class="lt-pname">' + _ltEsc((c && c.name) || '') + '</span>'
    + '<span class="lt-pn">' + rows.length + ' 批</span></div>';
  if (!rows.length) {
    return head + '<div class="modal-loading">建倉明細還沒到齊，或這一檔查不到批次</div>';
  }
  var q = _ltPx(x.code);
  var stale = (q.px == null);
  var t = _ltSum(rows);
  var h = head + '<div class="lt-scroll"><table class="detail-table lt-table"><thead><tr>'
    + '<th>買進日</th><th class="num">張</th>'
    + '<th class="num" title="原始成本 ÷ 股數，等於當初每股實際付出多少">買價</th>'
    + '<th class="num" title="盤中最新成交價，收盤後是當天收盤。同一檔每一列都一樣，不分批">現價</th>'
    + '<th class="num" title="現價 － 買價，每股差多少。不含配息，配過很多次息的老批次會偏負">價差</th>'
    + '<th class="num" title="資本損益 ÷ 原始成本。不是年化，放三年與放三個月用同一個分母">損益%</th>'
    + '<th class="num" title="券商記錄的成本已扣掉該筆累積配息，這裡加回，等於當初實際付出的錢">原始成本</th>'
    + '<th class="num" title="現價 × 股數">現值</th>'
    + '<th class="num" title="現值 － 原始成本，純價差">資本損益</th>'
    + '<th class="num">已配息</th>'
    + '<th class="num" title="資本損益 ＋ 已配息。配息是券商帳務記錄的實收金額">含息損益</th>'
    + '<th class="num">手續費</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var sp = (r.px != null && r.buy != null) ? r.px - r.buy : null;
    var rate = r.cost ? r.pnl / r.cost * 100 : null;
    h += '<tr><td>' + r.date + '</td>'
      + '<td class="num">' + (Math.round(r.lots * 1000) / 1000).toLocaleString('zh-TW') + '</td>'
      + '<td class="num">' + (r.buy == null ? '—' : r.buy.toFixed(2)) + '</td>'
      + '<td class="num">' + (r.px == null ? '—' : r.px.toFixed(2)) + '</td>'
      + '<td class="num" style="color:' + _ltCol(sp) + '">' + _ltSignedPx(sp) + '</td>'
      + '<td class="num" style="color:' + _ltCol(rate) + '">' + _ltPct(rate) + '</td>'
      + '<td class="num">' + _ltMoney(r.cost) + '</td>'
      + '<td class="num">' + _ltMoney(r.val) + '</td>'
      + '<td class="num" style="color:' + _ltCol(r.pnl) + '">' + _ltSigned(r.pnl) + '</td>'
      + '<td class="num">' + _ltMoney(r.div) + '</td>'
      + '<td class="num" style="color:' + _ltCol(r.with) + '">' + _ltSigned(r.with) + '</td>'
      + '<td class="num">' + _ltMoney(r.fee) + '</td></tr>';
  });
  var tsp = (q.px != null && t.buy != null) ? q.px - t.buy : null;
  h += '</tbody><tfoot><tr>'
    + '<td>合計</td>'
    + '<td class="num">' + (Math.round(t.lots * 1000) / 1000).toLocaleString('zh-TW') + '</td>'
    + '<td class="num" title="加權平均買價">' + (t.buy == null ? '—' : t.buy.toFixed(2)) + '</td>'
    + '<td class="num">' + (q.px == null ? '—' : q.px.toFixed(2)) + '</td>'
    + '<td class="num" style="color:' + _ltCol(tsp) + '">' + _ltSignedPx(tsp) + '</td>'
    + '<td class="num" style="color:' + _ltCol(t.rate) + '">' + _ltPct(t.rate) + '</td>'
    + '<td class="num">' + _ltMoney(t.cost) + '</td>'
    + '<td class="num">' + _ltMoney(t.val) + '</td>'
    + '<td class="num" style="color:' + _ltCol(t.pnl) + '">' + _ltSigned(t.pnl) + '</td>'
    + '<td class="num">' + _ltMoney(t.div) + '</td>'
    + '<td class="num" style="color:' + _ltCol(t.with) + '">' + _ltSigned(t.with) + '</td>'
    + '<td class="num">' + _ltMoney(t.fee) + '</td>'
    + '</tr></tfoot></table></div>';
  if (stale) {
    h += '<div class="lt-stale">取不到這一檔的即時價與前收，現值與損益暫用券商載入當下的數字，'
      + '不會跟著盤中跳。</div>';
  } else if (!q.live) {
    h += '<div class="lt-stale">目前用的是前一天收盤價，行情還沒進來。</div>';
  }
  h += _ltNote(t);
  return h;
}

// 說明。放一次，講到完整為止，不在別處重講。
function _ltNote(t) {
  return '<details class="nbox lt-note"><summary>說明</summary><div class="detail-note nb-keep">'
    + '<b>原始成本</b>＝券商記錄的成本 ＋ 該批累積配息 ' + _ltMoney(t.div) + ' 元。'
    + '券商把領過的配息直接從成本裡扣掉，它報的損益因此已經含息；這裡把成本還原，'
    + '才分得出資本損益（純價差）與含息損益。'
    + '<br><b>現值</b>＝現價 × 股數，盤中跟著跳，與持股庫存頁同一個基準。'
    + '資本損益、價差、損益% 全部由它推出來，所以這幾欄互相對得起來。'
    + '<br><b>價差</b>是每股的現價減買價，紅漲綠跌。它<b>不含配息</b>，'
    + '配過很多次息的老批次價差會偏負，實際含息是賺的，要配右邊的含息損益一起看。'
    + '<br><b>損益%</b>＝資本損益 ÷ 原始成本，<b>不是年化</b>。分母是當初付的錢，'
    + '放三年跟放三個月用同一個分母，兩批持有時間差很多的時候不能直接比大小，'
    + '要自己對照買進日。'
    + '<br><b>這一頁看不到什麼</b>：只有現在還持有的批次。已經整批賣掉的查不到，'
    + '所以這裡回答的是「手上這些是怎麼買起來的」，不是「這段期間買賣過什麼」。'
    + '配息只到券商帳務記的那個數，借券補償另外到帳、不一定記在這裡，含息損益可能略低於實際。'
    + '全部持股的總計在持股庫存那一頁，這裡一次只看一檔。'
    + '</div></details>';
}

function asRenderLots() {
  if (typeof _positions === 'undefined' || !_positions.length) {
    return '<div class="modal-loading">沒有持股</div>';
  }
  var list = _ltCodes();
  if (!list.length) return '<div class="modal-loading">建倉明細還沒到齊，重新整理一次</div>';
  var sel = _ltSel();
  var cur = list.filter(function (x) { return x.code === sel; })[0] || list[0];
  var sid = _ltSort();
  var sort = '<div class="lt-sort"><span class="lt-sortk">排序</span>'
    + LT_SORTS.map(function (s) {
        return '<button class="lt-sbtn' + (s.id === sid ? ' on' : '') + '"'
          + ' onclick="ltSortBy(&quot;' + s.id + '&quot;)">' + s.label + '</button>';
      }).join('') + '</div>';
  var side = list.map(function (x) { return _ltRow(x, x.code === cur.code); }).join('');
  return '<div class="lt-wrap"><div class="lt-sidewrap">' + sort
    + '<div class="lt-side">' + side + '</div></div>'
    + '<div class="lt-main">' + _ltPanel(cur) + '</div></div>';
}
