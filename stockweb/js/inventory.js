// 股利總管 Web — 持股庫存（券商 position_unit 為準，即時更新現值/損益）
// 每列前置〔明細〕按鈕 → 彈出該檔「交易紀錄」（建倉明細 position_detail）

var _invStarted = false;
// 預設：最近除息由近至遠（配息紀錄載入前全為空，排序維持原順序，載入後自動重排）
// 使用者選的排序存本機，重新整理後維持；表頭沒有這個欄位（欄位改版）時回到預設
var INV_SORT_LS = 'inv_sort_v1';
var _invSort = (function () {
  try {
    var v = localStorage.getItem(INV_SORT_LS) || '';
    var m = v.match(/^([A-Za-z]+)(Asc|Desc)$/);
    if (m && document.querySelector('#inv-view th.sort-th[data-key="' + m[1] + '"]')) return v;
  } catch (e) {}
  return 'exDesc';
})();

// 排序用衍生值
// ══════════ 交易欄：今日的買賣進出 ══════════
//
// 一邊一行：亮色＝已成交、暗色＝還掛著。部分成交時主數字是成交量、上標是在途量
// （委託 5 成交 2 → 「+2」亮紅、上標「3」暗紅）；沒有在途就沒有上標。
// 台股慣例紅買綠賣。
//
// 同一檔今天既有買又有賣時列成兩行，<b>不做淨額</b>：買 5 賣 3 顯示 +2 會把
// 你想抓的狀況藏起來。兩行的列自然會比其他列高，本身就是視覺提示，
// 不另外加外框：那等於用顏色替你判定「這是錯單」，而換股調節、部分停利回補
// 是同一個形狀，程式分辨不了意圖。
//
// 數量單位跟著委託別走：整股以張計、零股以股計，一律標單位字，
// 免得 500 股被看成 500 張（旁邊的「餘額」是股，兩欄單位本來就不同）。
var _invTrd = {};          // code -> { buy:{deal,pend,lot}, sell:{...} }

function invTradeBuild(trades) {
  var m = {};
  (trades || []).forEach(function (t) {
    var o = t.order || {}, s = t.status || {}, st = s.status || '';
    if (st === 'Failed') return;                       // 沒送進市場，不算今日進出
    var code = String((t.contract || {}).code || '');
    if (!code) return;
    var side = o.action === 'Sell' ? 'sell' : 'buy';
    var oq = s.order_quantity != null ? s.order_quantity : (o.quantity || 0);
    var deal = s.deal_quantity || 0;
    var pend = Math.max(0, oq - deal - (s.cancel_quantity || 0));   // 已刪的量不算還掛著
    if (!deal && !pend) return;
    var g = m[code] || (m[code] = {});
    var e = g[side] || (g[side] = { deal: 0, pend: 0, dead: 0, lot: o.order_lot || 'Common',
                                    dSum: 0, plist: [] });
    // 收盤後仍掛著的 ROD 其實已經失效，券商只是還沒改狀態 → 歸到 dead，不算在途
    var expired = (typeof orderExpired === 'function') && orderExpired(o, s);
    e.deal += deal;
    if (expired) e.dead += pend; else e.pend += pend;
    if ((o.order_lot || 'Common') !== 'Common') e.lot = o.order_lot;  // 混用時以零股為準（較小單位）
    // 委託價：改過價的以改後為準。在途的逐筆留著，不做加權平均——
    // 9.83 和 9.84 各 5 張平均出來的 9.835 是一個不存在的價位，無法據以判斷，
    // 而且每一筆離現價的距離不同，要分開看才知道哪一筆快成交了。
    var opx = s.modified_price || o.price || 0;
    if (pend > 0 && opx > 0 && !expired) {
      var hit = null;
      e.plist.forEach(function (x) { if (Math.abs(x.px - opx) < 1e-9) hit = x; });   // 同價合併
      if (hit) hit.q += pend; else e.plist.push({ px: opx, q: pend });
    }
    // 成交均價自逐筆成交回推，不用委託價：限價單可能以更好的價格成交
    (s.deals || []).forEach(function (d) {
      if (d.price > 0 && d.quantity > 0) e.dSum += d.price * d.quantity;
    });
  });
  return m;
}

async function loadInvTrades() {
  if (typeof fetchOrderTrades !== 'function') return;
  var t = [];
  try { t = await fetchOrderTrades() || []; }
  catch (e) { console.warn('[交易欄 trades]', e); }
  // 券商盤後會把 order/trades 清空（實測 14:35 還有、16:37 就沒了，連成交的也不見），
  // 清空後改用事件流水重建，否則下午之後「今日進出」會整欄消失。
  if (!t.length && typeof fetchOrderDealRecords === 'function') {
    try { t = dealRecordsToTrades(await fetchOrderDealRecords()); }
    catch (e) { console.warn('[交易欄 records]', e); }
  }
  _invTrd = invTradeBuild(t);
  if (document.getElementById('inv-tbody')) renderInvTable();
}

// ── 交易欄即時更新 ──
// 委託送出、成交、刪單都會由 order_event 推過來。這裡不解析事件內容，
// 收到任何一則就整份重抓 order/trades：事件的欄位形狀會因券商而異，
// 而「有東西變了」這個資訊已經足夠，重抓一次最不會出錯。
// 連續事件（一筆委託會先送出再回報）用 debounce 併成一次查詢。
var _invOrdEs = null, _invOrdTimer = null;

function invOrdBump() {
  clearTimeout(_invOrdTimer);
  _invOrdTimer = setTimeout(function () { loadInvTrades(); }, 400);
}

function startInvOrderStream() {
  if (_invOrdEs) return;
  try {
    _invOrdEs = new EventSource(API + '/api/v1/stream/data/order_event');
    _invOrdEs.addEventListener('order_event', invOrdBump);
    _invOrdEs.onmessage = invOrdBump;               // 事件名稱若不同也接得到
    _invOrdEs.onerror = function () {
      // EventSource 會自己重連；斷線期間可能漏事件，所以重連後補抓一次
      invOrdBump();
    };
  } catch (e) { console.warn('[order_event]', e); }
}
function stopInvOrderStream() {
  if (_invOrdEs) { _invOrdEs.close(); _invOrdEs = null; }
  clearTimeout(_invOrdTimer);
}
// 回到分頁時補一次：瀏覽器在背景分頁可能節流甚至斷開 SSE
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && _invOrdEs) invOrdBump();
});
// 訂閱維持整個 session（委託事件量很小），關頁才收；切到其他功能頁不退訂，
// 這樣切回來時交易欄已經是最新的，不必重查。
window.addEventListener('pagehide', stopInvOrderStream);

function _invTrdSide(e, side) {
  if (!e || (!e.deal && !e.pend && !e.dead)) return '';
  var sign = side === 'buy' ? '+' : '−';
  var unit = e.lot === 'Common' ? '張' : '股';
  var n = function (v) { return v.toLocaleString('zh-TW'); };
  var cls = 'trd-' + side;                              // buy 紅 / sell 綠
  // 有成交 → 主數字用成交量（亮）；在途掛上標（暗）。沒成交 → 整個用暗色顯示在途量
  // 失效的量用灰色另標，不能跟在途同色，否則看起來還掛著
  var dead = e.dead ? '<span class="trd-dead" title="收盤失效">' + n(e.dead) + '</span>' : '';
  if (e.deal) {
    return '<span class="' + cls + ' on">' + sign + n(e.deal) +
      '<em class="trd-u">' + unit + '</em>' +
      (e.pend ? '<sup class="' + cls + '">' + n(e.pend) + '</sup>' : '') + '</span>' + dead;
  }
  if (e.pend) {
    return '<span class="' + cls + '">' + sign + n(e.pend) + '<em class="trd-u">' + unit + '</em></span>' + dead;
  }
  return '<span class="trd-dead">' + sign + n(e.dead) + '<em class="trd-u">' + unit + '</em></span>';
}

// 交易欄排序值：今日動的總量（買＋賣，含已成交、在途、收盤失效），換算成股再比。
// 整股與零股共用同一欄，用張比會把 500 股看成大於 1 張。
// 不做買賣相抵：這一欄本來就分兩行各自顯示，淨額不是它表達的東西，
// 同一檔今天有買有賣時，它動的量就是兩邊相加。
function _invTrdVol(code) {
  var g = _invTrd[String(code)];
  if (!g) return 0;
  var v = 0;
  ['buy', 'sell'].forEach(function (k) {
    var e = g[k];
    if (!e) return;
    v += (e.deal + e.pend + e.dead) * (e.lot === 'Common' ? 1000 : 1);
  });
  return v;
}

function invTradeCell(code) {
  var g = _invTrd[String(code)];
  if (!g) return '';
  var b = _invTrdSide(g.buy, 'buy'), s = _invTrdSide(g.sell, 'sell');
  if (!b && !s) return '';
  // 現價：與表格其他欄同一個來源，每次重繪都是最新
  var r = (typeof _rows !== 'undefined' && _rows[String(code)]) || {};
  var px = (r.close != null && r.close > 0) ? r.close : null;
  var f2 = function (v) { return v.toFixed(2); };
  // 價差＝現價 − 該價格。正負意義由買賣方向自己看，不替使用者判斷好壞：
  // 同樣是正值，買進已成交代表帳面賺、賣出已成交代表賣低了。
  var gap = function (base) {
    if (px == null || !(base > 0)) return '';
    var d = px - base;
    return '　現價 ' + f2(px) + '　價差 ' + (d >= 0 ? '+' : '−') + f2(Math.abs(d)) +
      '（' + (d >= 0 ? '+' : '−') + Math.abs(d / base * 100).toFixed(2) + '%）';
  };
  var tip = [];
  ['buy', 'sell'].forEach(function (k) {
    var e = g[k]; if (!e) return;
    var u = e.lot === 'Common' ? '張' : '股';
    tip.push((k === 'buy' ? '買進' : '賣出') + ' 委託 ' + (e.deal + e.pend + e.dead) + u +
      '：已成交 ' + e.deal + u + '、在途 ' + e.pend + u +
      (e.dead ? '、收盤失效 ' + e.dead + u : ''));
    // 已成交用均價：部位已經在手上，混合後的成本才是有意義的那個數字
    if (e.deal > 0 && e.dSum > 0) {
      tip.push('　成交均價 ' + f2(e.dSum / e.deal) + gap(e.dSum / e.deal));
    }
    // 在途逐筆列：每一筆都還能改、能刪，各自離現價多遠是分開的事
    e.plist.slice().sort(function (x, y) { return y.px - x.px; }).forEach(function (x) {
      tip.push('　在途 ' + x.q + u + ' @ ' + f2(x.px) + gap(x.px));
    });
    if (e.dead) tip.push('　' + e.dead + u + ' 未成交，ROD 當日有效、收盤已失效，明天要重掛');
  });
  if (b && s) tip.push('今日同一檔有買也有賣');
  return '<span class="trd-box" title="' + tip.join('\n') + '">' +
    b + (b && s ? '<br>' : '') + s + '</span>';
}

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
  try { localStorage.setItem(INV_SORT_LS, _invSort); } catch (e) {}
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
    '<td class="inv-name">' + ((c && c.name) || '') + _invFreqTag(code) + '</td>' +
    '<td class="num inv-trd">' + invTradeCell(code) + '</td>' +
    // 餘額是「股」，借出註記用「張」：與股利估算的持有張數同一種寫法。
    // 借出的股數本來就含在餘額裡（出借期間所有權仍是你的），這裡只是標出其中多少在外面。
    '<td class="num">' + shares.toLocaleString('zh-TW') +
      (p.lent && p.lentShares ? ' <span class="dexm-lent">(借出 ' +
        (p.lentShares / 1000).toLocaleString('zh-TW') + ' 張)</span>' : '') + '</td>' +
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
// 配息政策標註（名稱後面的括號）
//   月配 → (月配)；其餘有配息 → 標出實際的除息月份，例 (3,6,9,12月)；查無配息紀錄 → (無)
// 月份取自實際除息紀錄，不是用頻率反推：季配不一定落在 3/6/9/12，
// 00918 實測是 3/6/9/12 以外的月份也有，照它自己的紀錄列才不會騙人。
// 取近 24 個月的除息月去重；紀錄還沒載入時回空字串，不要把「還沒載到」顯示成「不配息」。
function _invFreqWord(step) {
  return step === 1 ? '月配' : (step === 2 ? '雙月配' : (step === 3 ? '季配'
    : (step === 6 ? '半年配' : (step === 12 ? '年配' : '每 ' + step + ' 月'))));
}
function _invFreqTag(code) {
  code = String(code);
  var map = (typeof _divRecMap !== 'undefined' && _divRecMap) || {};
  if (!Object.keys(map).length) {
    _invEnsureDiv();      // 與最近除息欄同一個懶載入：沒進過股利估算頁也會自己補
    return '';
  }
  var recs = (map[code] || []).filter(function (r) { return r.exDate; });
  if (!recs.length) {
    // 沒有除息紀錄 ≠ 不配息。2026-10-07 實測 00402A／00405A／00988A 都是今年才掛牌、
    // 還沒除過息，但 MoneyDJ 的頻率表寫明年配／季配，標「(無)」會變成假的結論。
    var st = (typeof _divMdj !== 'undefined' && _divMdj[code]) || null;
    if (st) {
      return '<span class="inv-freq" title="MoneyDJ 配息頻率；尚未有除息紀錄，月份未定">(' +
        _invFreqWord(st) + ')</span>';
    }
    // 連頻率表也沒有：配息資料來源只收 ETF，個股不在範圍，說「查無」不說「不配息」
    return '<span class="inv-freq" title="配息資料來源（e添富／MoneyDJ 頻率表）只收 ETF，個股不在範圍">(查無)</span>';
  }

  var asc = recs.slice().sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; })
    .map(function (r) { return Object.assign({ code: code }, r); });
  var step = (typeof _divInferStep === 'function') ? _divInferStep(asc) : null;
  if (step === 1) return '<span class="inv-freq">(月配)</span>';

  var from = _divTwDate().iso.slice(0, 4) - 2 + '-' + _divTwDate().iso.slice(5);
  var ms = {};
  asc.forEach(function (r) { if (r.exDate >= from) ms[+r.exDate.slice(5, 7)] = true; });
  var list = Object.keys(ms).map(Number).sort(function (a, b) { return a - b; });
  // 有紀錄但都超過兩年 → 列不出月份，退回頻率詞，不要說「無」
  if (!list.length) return '<span class="inv-freq" title="近兩年無除息紀錄">(' +
    _invFreqWord(step) + '·近兩年無)</span>';
  return '<span class="inv-freq" title="近兩年實際除息月份">(' + list.join(',') + '月)</span>';
}

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
  // 除息在兩天內（今天之後、含第 2 天）→ 前面加閃爍 ★ 提醒：要買就得在除息日前一個交易日之前完成
  var dLeft = e.past ? null : Math.round((Date.parse(e.iso) - Date.parse(_divTwDate().iso)) / 86400000);
  var soon = dLeft != null && dLeft > 0 && dLeft <= 2;
  // 標記放日期前面：欄位靠右對齊，放後面會把日期往左推、與其他列對不齊
  return '<td class="num inv-ex ' + e.cls + '" title="' + tip + (soon ? '　還有 ' + dLeft + ' 天除息' : '') + '">' +
    (soon ? '<span class="inv-ex-star">★</span>' : '') +
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
      // 注意股圓點：已標記優先（降冪）／未標記優先（升冪）；同組維持代號順序
      case 'dotDesc': case 'dotAsc': {
        var marked = (typeof loadWatch === 'function') ? loadWatch() : new Set();
        var da = marked.has(String(a.code)) ? 1 : 0, db = marked.has(String(b.code)) ? 1 : 0;
        if (da !== db) return _invSort === 'dotAsc' ? da - db : db - da;
        return String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
      }
      // 交易：今天有動的排前面，沒動的一律墊底（升冪降冪皆然，跟最近除息一致）
      case 'trdDesc': case 'trdAsc': {
        var ta = _invTrdVol(a.code), tbv = _invTrdVol(b.code);
        if (ta !== tbv) {
          if (!ta) return 1;
          if (!tbv) return -1;
          return _invSort === 'trdAsc' ? ta - tbv : tbv - ta;
        }
        return String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
      }
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
  loadInvSettle();                                   // 待交割（背景查，不阻塞表格）
  loadInvTrades();                                   // 交易欄：今日委託與成交（同上，不阻塞）
  startInvOrderStream();                             // 之後靠 order_event 即時更新，不輪詢
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
    rows.forEach(function (d) {
      var lp = d.last_price != null ? d.last_price : 0;
      // 認購成本補正（參數設定頁維護）：券商端 price=0 的筆用「每股認購價 × 股數」還原成本，損益同步扣回
      var cpx = (d.price === 0 && typeof coGet === 'function') ? coGet(code, d.date) : null;
      var adj = cpx != null ? cpx * d.quantity * 1000 : 0;
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
      '<div class="detail-note nb-keep">累積已配息 ' + Math.round(totDiv).toLocaleString('zh-TW') + ' 元（未計入上方損益）</div>';
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

// ── 合計待交割（券商 settlements：T／T+1／T+2 應收付合計）→ 顯示在頂欄「獲利率」後面，全站可見 ──
// 與交易資訊「台幣交割」同源；正＝應收、負＝應付（銀行扣款）。
// 更新時機：行情引擎啟動（ensureFeed）、進入持股庫存、成交後庫存重抓（refreshPositions）。
var _settleTot = null, _invSettleBusy = false;
async function loadInvSettle() {
  if (_invSettleBusy || typeof fetchSettlements !== 'function') return;
  _invSettleBusy = true;
  try {
    var rows = await fetchSettlements();
    // 交割日當天那筆銀行凌晨已扣，錢已經不在帳上，算進「待交割」會重複計算
    var sp = splitSettlements(rows);
    _settleTot = (rows && rows.length) ? Math.round(sp.pending) : null;
    if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
  } catch (e) {
    console.warn('[待交割]', e);
  } finally { _invSettleBusy = false; }
}
