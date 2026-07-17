// 股利總管 Web — 交易資訊（三框：台幣交割 / 今日委託與成交彙整 / 交易紀錄(已實現損益)）
// 上左：settlements（T/T+1/T+2 應收付）；上右：order/trades（委託+成交併一列）；下半：沿用 trades.js

async function startTxinfo() {
  var errEl = document.getElementById('tx-error');
  errEl.style.display = 'none';
  if (!(await checkServer())) { errEl.style.display = 'block'; errEl.innerHTML = serverDownHtml(); return; }
  loadSettleBox();
  loadOrderBox();
  initTradeDates();
  loadTrades(); // 下半框沿用交易紀錄（元素 id 不變）
}
function refreshTxinfo() { loadSettleBox(); loadOrderBox(); }

// ── 上左：台幣交割 ──
async function loadSettleBox() {
  var el = document.getElementById('tx-settle-body');
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    var rows = await fetchSettlements();
    if (!rows || !rows.length) { el.innerHTML = '<div class="modal-loading">無交割資料</div>'; return; }
    var tot = 0, html = '<table class="tx-settle-table">';
    rows.forEach(function (r) {
      var amt = r.amount || 0; tot += amt;
      var cls = amt > 0 ? 'up' : (amt < 0 ? 'down' : '');
      var d = (r.date || '').slice(5).replace('-', '/');
      var tl = r.T === 0 ? 'T' : 'T+' + r.T;
      html += '<tr><td class="tx-sd">' + d + '<span class="tx-st">' + tl + '</span></td>' +
        '<td class="num ' + cls + '">' + (amt === 0 ? '0' : amt.toLocaleString('zh-TW')) + '</td></tr>';
    });
    var tcls = tot > 0 ? 'up' : (tot < 0 ? 'down' : '');
    html += '<tr class="tx-settle-total"><td>合計待交割</td><td class="num ' + tcls + '">' +
      (tot === 0 ? '0' : tot.toLocaleString('zh-TW')) + '</td></tr></table>' +
      '<div class="tx-note">負數＝應付（銀行扣款）、正數＝應收</div>';
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>'; }
}

// ── 上右：今日委託與成交彙整 ──
function _hms(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}
// 狀態膠囊：失敗訊息與取消張數皆併入狀態呈現
function _stPill(t) {
  var s = t.status || {}, st = s.status || '', dq = s.deal_quantity || 0, cq = s.cancel_quantity || 0, oq = (t.order || {}).quantity || 0;
  if (st === 'Filled') return '<span class="st-pill st-ok">全部成交</span>';
  if (st === 'PartFilled' || st === 'Filling') return '<span class="st-pill st-part">部分成交 ' + dq + '/' + oq + '</span>';
  if (st === 'Cancelled') return '<span class="st-pill st-cancel">已取消' + (cq ? ' ' + cq : '') + (dq ? '（成交' + dq + '）' : '') + '</span>';
  if (st === 'Failed') {
    var msg = (s.msg || '').trim();
    return '<span class="st-pill st-fail" title="' + msg.replace(/"/g, '&quot;') + '">失敗' + (msg ? '：' + (msg.length > 12 ? msg.slice(0, 12) + '…' : msg) : '') + '</span>';
  }
  return '<span class="st-pill st-wait">委託中</span>'; // PendingSubmit / PreSubmitted / Submitted
}
async function loadOrderBox() {
  var el = document.getElementById('tx-order-body');
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    var trades = await fetchOrderTrades();
    if (!trades || !trades.length) { el.innerHTML = '<div class="modal-loading">今日無委託</div>'; return; }
    trades.sort(function (a, b) { return ((b.status || {}).order_ts || 0) - ((a.status || {}).order_ts || 0); }); // 新→舊
    // 名稱：_contracts 要等行情引擎啟動才有，缺的代號就地查合約補進共用快取
    var needName = {};
    trades.forEach(function (t) {
      var code = (t.contract || {}).code || '';
      if (code && !(typeof _contracts !== 'undefined' && _contracts[code])) needName[code] = true;
    });
    for (var code in needName) {
      try { _contracts[code] = await fetchContract(code); } catch (e) { console.warn('[txinfo contract]', code, e); }
    }
    var buyAmt = 0, sellAmt = 0;
    var html = '<div class="tx-otable-wrap"><table class="tx-otable"><thead><tr>' +
      '<th>商品</th><th>買賣</th><th class="num">委託</th><th class="num">成交</th>' +
      '<th>狀態</th><th>書號</th><th class="num">委託時間</th></tr></thead><tbody>';
    trades.forEach(function (t) {
      var o = t.order || {}, s = t.status || {}, code = (t.contract || {}).code || '';
      var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
      var buy = o.action === 'Buy';
      var unit = (o.order_lot && o.order_lot !== 'Common') ? '股' : '張';
      var mult = unit === '張' ? 1000 : 1; // 成交金額換算（張→股）
      var tif = (o.order_type && o.order_type !== 'ROD') ? ' ' + o.order_type : ''; // ROD 常態不顯示
      var deals = s.deals || [];
      var dq = 0, dsum = 0;
      deals.forEach(function (d) { dq += d.quantity; dsum += d.price * d.quantity; });
      var avg = dq ? (dsum / dq) : null;
      if (buy) buyAmt += dsum * mult; else sellAmt += dsum * mult;
      var dealTitle = deals.length > 1 ? deals.map(function (d) {
        return d.quantity + unit + ' @' + d.price.toFixed(2) + ' ' + _hms(d.ts);
      }).join('　') : '';
      html += '<tr>' +
        '<td><span class="tx-ocode">' + code + '</span><span class="tx-oname">' + ((c && c.name) || '') + '</span></td>' +
        '<td class="' + (buy ? 'up' : 'down') + '">' + (buy ? '買進' : '賣出') + '</td>' +
        '<td class="num">' + o.quantity + unit + ' @' + (o.price || 0).toFixed(2) + tif + '</td>' +
        '<td class="num"' + (dealTitle ? ' title="' + dealTitle + '"' : '') + '>' +
          (dq ? dq + unit + ' @' + avg.toFixed(2) + (deals.length > 1 ? ' ×' + deals.length : '') : '—') + '</td>' +
        '<td>' + _stPill(t) + '</td>' +
        '<td class="tx-dseq">' + ((o.ordno || '').trim() || '—') + '</td>' +
        '<td class="num">' + _hms(s.order_ts) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
    // 標題右側：今日買進/賣出/合計成交金額（合計＝賣出−買進；正紅負綠，與交割應收付一致）
    var sumEl = document.getElementById('tx-order-sum');
    if (sumEl) {
      var net = sellAmt - buyAmt;
      var ncls = net > 0 ? 'up' : (net < 0 ? 'down' : '');
      sumEl.innerHTML = '買進 <span class="up">' + Math.round(buyAmt).toLocaleString('zh-TW') + '</span>' +
        '｜賣出 <span class="down">' + Math.round(sellAmt).toLocaleString('zh-TW') + '</span>' +
        '｜合計 <span class="' + ncls + '">' + (net > 0 ? '+' : '') + Math.round(net).toLocaleString('zh-TW') + '</span>';
    }
  } catch (e) { el.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>'; }
}
