// 股利總管 Web — 下單（階段 1：畫面與流程，不接下單 API）
//
// 進入方式：五檔點價 → 確認框 → 下單單。
// 確認框的預設買賣由「價格落在買方還是賣方」決定，另一邊用一顆按鈕一次切過去，
// 不必先進下單單再切（券商 App 要多一次跳轉，這是這個設計要解決的事）。
// 進到下單單後買賣方向鎖定，只顯示選定的那一邊。
//
// 固定參數（介面上不給選，從源頭杜絕誤觸）：
//   整股 order_lot=Common、現股 order_cond=Cash、ROD order_type=ROD、限價 price_type=LMT
// 可變的只有 action / price / quantity 三項。
//
// 階段 1：按「下單」只組出並顯示要送出的參數，不呼叫 place_order。

var ORD_LOT = 1000;                 // 1 單位＝1000 股
var ORD_TICKS = 5;                  // 底部顯示的成交筆數
var _ord = null;                    // { code, name, action, price, qty, priceMode }

// ── 價格檔位（台股股票／ETF 升降單位）──
// 掛價必須落在合法檔位上，否則券商會退件。ETF 與股票的級距不同，這裡走股票級距，
// 再由 _ordEtfTick 對 ETF 覆寫（ETF 一律 0.01，50 元以上仍 0.01）。
function _ordTick(px, isEtf) {
  if (isEtf) return 0.01;
  if (px < 10) return 0.01;
  if (px < 50) return 0.05;
  if (px < 100) return 0.1;
  if (px < 500) return 0.5;
  if (px < 1000) return 1;
  return 5;
}
function _ordIsEtf(code) {
  return typeof isEtfCode === 'function' ? isEtfCode(code) : /^00/.test(String(code));
}
function _ordRound(px, code) {
  var t = _ordTick(px, _ordIsEtf(code));
  return Math.round(px / t) * t;
}
function _ordFmt(px) { return (Math.round(px * 100) / 100).toFixed(2); }

// ── 進入點：五檔點價 ──
// side 由呼叫端（五檔的買方／賣方欄）給，不在這裡猜。
function ordFromLadder(code, price, side) {
  var px = parseFloat(price);
  if (!(px > 0)) return;
  _ordConfirm(String(code), px, side === 'buy' ? 'Buy' : 'Sell');
}

function _ordName(code) {
  var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
  return (c && c.name) || '';
}

// ── 確認框 ──
// 預設方向依價格落在哪一邊；另一邊給一顆按鈕，按下去就用那一邊進下單單。
function _ordConfirm(code, px, action) {
  var el = document.getElementById('ord-confirm');
  if (!el) return;
  var buy = action === 'Buy';
  var other = buy ? 'Sell' : 'Buy';
  el.className = 'modal-overlay ord-cf ' + (buy ? 'ord-buy' : 'ord-sell');
  el.innerHTML =
    '<div class="ord-cf-box">' +
      '<div class="ord-cf-msg">確認 <b>' + _ordFmt(px) + '</b> ' + (buy ? '買入' : '賣出') + '</div>' +
      '<div class="ord-cf-sub">' + code + ' ' + _ordName(code) + '</div>' +
      '<div class="ord-cf-btns">' +
        '<button class="ord-b cancel" onclick="ordCloseConfirm()">取消</button>' +
        '<button class="ord-b flip" onclick="ordTicket(\'' + code + '\',' + px + ',\'' + other + '\')">' +
          (buy ? '賣出' : '買進') + '</button>' +
        '<button class="ord-b ok" onclick="ordTicket(\'' + code + '\',' + px + ',\'' + action + '\')">確認</button>' +
      '</div>' +
    '</div>';
  el.style.display = 'flex';
}
function ordCloseConfirm() {
  var el = document.getElementById('ord-confirm');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

// ── 下單單 ──
function ordTicket(code, px, action) {
  ordCloseConfirm();
  _ord = { code: String(code), name: _ordName(code), action: action,
           price: _ordRound(parseFloat(px), code), qty: 1, priceMode: 'limit' };
  _ordRender();
  var el = document.getElementById('ord-modal');
  if (el) el.style.display = 'flex';
}
function ordClose() {
  var el = document.getElementById('ord-modal');
  if (el) el.style.display = 'none';
  _ord = null;
}

// 取價：帶入後就固定，不再跟著行情跳。
// 跳動的話，按下「下單」那一刻送出的價格會跟畫面上看到的不同。
function ordPick(kind) {
  if (!_ord) return;
  var c = (typeof _contracts !== 'undefined' && _contracts[_ord.code]) || {};
  var r = (typeof _rows !== 'undefined' && _rows[_ord.code]) || {};
  var v = null;
  if (kind === 'last') v = (r.close != null ? r.close : c.reference);
  else if (kind === 'up') v = c.limit_up;
  else if (kind === 'flat') v = c.reference;
  else if (kind === 'down') v = c.limit_down;
  if (v == null || !(v > 0)) return;
  _ord.price = _ordRound(parseFloat(v), _ord.code);
  _ord.priceMode = kind;
  _ordRender();
}
function ordStep(field, dir) {
  if (!_ord) return;
  if (field === 'qty') {
    _ord.qty = Math.max(1, (_ord.qty || 1) + dir);
  } else {
    var t = _ordTick(_ord.price, _ordIsEtf(_ord.code));
    var c = (typeof _contracts !== 'undefined' && _contracts[_ord.code]) || {};
    var v = _ordRound(_ord.price + dir * t, _ord.code);
    if (c.limit_up != null && v > c.limit_up) v = c.limit_up;
    if (c.limit_down != null && v < c.limit_down) v = c.limit_down;
    _ord.price = v;
    _ord.priceMode = 'limit';
  }
  _ordRender();
}
function ordInput(field, el) {
  if (!_ord) return;
  var v = parseFloat(el.value);
  if (field === 'qty') _ord.qty = (v > 0) ? Math.floor(v) : 1;
  else if (v > 0) { _ord.price = _ordRound(v, _ord.code); _ord.priceMode = 'limit'; }
  _ordRender();
}

// 送出用的參數：可變的只有 action / price / quantity，其餘固定
function ordPayload() {
  if (!_ord) return null;
  var c = (typeof _contracts !== 'undefined' && _contracts[_ord.code]) || {};
  return {
    contract: { security_type: 'STK', exchange: c.exchange || 'TSE', code: _ord.code },
    stock_order: {
      action: _ord.action, price: _ord.price, quantity: _ord.qty,
      price_type: 'LMT', order_type: 'ROD', order_cond: 'Cash', order_lot: 'Common'
    }
  };
}

// 階段 1：不送單，只把要送的東西攤出來讓你核對
function ordSubmit() {
  var p = ordPayload();
  if (!p) return;
  var el = document.getElementById('ord-dry');
  if (el) {
    el.style.display = 'block';
    el.innerHTML = '<div class="ord-dry-t">階段 1：尚未接下單 API，這是會送出的參數</div>' +
      '<pre>' + JSON.stringify(p, null, 2) + '</pre>';
  }
}

function _ordRender() {
  var el = document.getElementById('ord-body');
  if (!el || !_ord) return;
  var o = _ord, buy = o.action === 'Buy';
  var c = (typeof _contracts !== 'undefined' && _contracts[o.code]) || {};
  var seg = function (txt) { return '<span class="ord-seg on">' + txt + '</span>'; };
  var pickOn = function (k) { return o.priceMode === k ? ' on' : ''; };

  var amt = o.price * o.qty * ORD_LOT;
  var h =
    '<div class="ord-row"><span class="ord-lb">商品</span>' +
      '<span class="ord-code">' + o.code + '</span><span class="ord-nm">' + (o.name || '') + '</span></div>' +
    '<div class="ord-row"><span class="ord-lb">交易</span>' + seg('整股') + '</div>' +
    '<div class="ord-row"><span class="ord-lb">種類</span>' + seg('現股') + '</div>' +
    '<div class="ord-row"><span class="ord-lb">條件</span>' + seg('ROD') + '</div>' +
    '<div class="ord-row"><span class="ord-lb">類別</span>' + seg('限價') +
      '<span class="ord-pick">' +
        '<button class="ord-pk' + pickOn('last') + '" onclick="ordPick(\'last\')">現價</button>' +
        '<button class="ord-pk' + pickOn('up') + '" onclick="ordPick(\'up\')">漲停</button>' +
        '<button class="ord-pk' + pickOn('flat') + '" onclick="ordPick(\'flat\')">平盤</button>' +
        '<button class="ord-pk' + pickOn('down') + '" onclick="ordPick(\'down\')">跌停</button>' +
      '</span></div>' +
    '<div class="ord-row"><span class="ord-lb">買賣</span>' +
      '<span class="ord-side ' + (buy ? 'buy' : 'sell') + '">' + (buy ? '買進' : '賣出') + '</span>' +
      '<span class="ord-fix">已鎖定</span>' +
      '<span class="ord-unit">1 單位<br>1000 股</span></div>' +
    '<div class="ord-row"><span class="ord-lb">單位</span>' +
      '<input class="ord-in" type="number" min="1" step="1" value="' + o.qty + '" onchange="ordInput(\'qty\',this)">' +
      '<button class="ord-pm" onclick="ordStep(\'qty\',-1)">−</button>' +
      '<button class="ord-pm" onclick="ordStep(\'qty\',1)">＋</button></div>' +
    '<div class="ord-row"><span class="ord-lb">價格</span>' +
      '<input class="ord-in" type="number" step="0.01" value="' + _ordFmt(o.price) + '" onchange="ordInput(\'px\',this)">' +
      '<button class="ord-pm" onclick="ordStep(\'px\',-1)">−</button>' +
      '<button class="ord-pm" onclick="ordStep(\'px\',1)">＋</button></div>' +
    '<div class="ord-amt">預估' + (buy ? '價金' : '收入') + ' <b>' +
      Math.round(amt).toLocaleString('zh-TW') + '</b> 元' +
      '<span class="ord-dim">（未計手續費' + (buy ? '' : '與交易稅') + '）</span>' +
      (c.limit_up != null ? '<span class="ord-dim">　漲停 ' + _ordFmt(c.limit_up) +
        '／跌停 ' + _ordFmt(c.limit_down) + '</span>' : '') + '</div>' +
    '<div class="ord-ticks"><div class="ord-ticks-t">整股　最近 ' + ORD_TICKS + ' 筆</div>' +
      _ordTicksHtml() + '</div>' +
    '<div id="ord-dry" class="ord-dry" style="display:none"></div>';
  el.innerHTML = h;

  var box = document.getElementById('ord-box');
  if (box) box.className = 'ord-box ' + (buy ? 'ord-buy' : 'ord-sell');
  var t = document.getElementById('ord-title');
  if (t) t.textContent = (buy ? '買進' : '賣出') + '　' + o.code + ' ' + (o.name || '');
}

// 底部成交資訊：沿用五檔頁籤已訂閱的逐筆（_ticks），不另外訂閱
function _ordTicksHtml() {
  var t = (typeof _ticks !== 'undefined' && _ticks) || [];
  if (!t.length) return '<div class="ord-dim">目前無逐筆資料（非盤中或尚未推送）</div>';
  var ref = ((typeof _contracts !== 'undefined' && _contracts[_ord.code]) || {}).reference;
  var h = '<table class="ord-tick-tb"><tbody>';
  for (var i = 0; i < Math.min(ORD_TICKS, t.length); i++) {
    var x = t[i];
    var cls = (x.price != null && ref != null) ? (x.price > ref ? 'up' : (x.price < ref ? 'down' : 'flat')) : '';
    var d = (x.price != null && ref != null) ? x.price - ref : null;
    h += '<tr><td>' + x.t + '</td>' +
      '<td class="num ' + cls + '">' + (x.price != null ? x.price.toFixed(2) : '—') + '</td>' +
      '<td class="num ' + cls + '">' + (d == null ? '' : (d > 0 ? '+' : '') + d.toFixed(2)) + '</td>' +
      '<td class="num">' + (x.vol != null ? x.vol : '') + '</td><td>張</td>' +
      '<td class="ord-dim">' + (x.mark || '') + '</td></tr>';
  }
  return h + '</tbody></table>';
}
