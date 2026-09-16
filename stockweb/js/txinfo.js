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
// ── 委託排隊前方張數（推估）──
// 交易所與券商都不揭露排隊序位，只能用逐筆成交回推：
//   1) 取委託時間之後第一筆成交，讀當下同價位的委賣（賣單）／委買（買單）總量，扣掉自己未成交張數＝掛單當下前方張數
//   2) 之後累加「成交價＝委託價」的成交量，視為前方隊伍被消化的部分
//   3) 前方張數 − 已消化＝目前推估；已有部分成交代表前面清空，直接回 0
// 誤差：前方有人取消看不到（估計偏高）；委託到第一筆成交之間的變化算在前方；委託價非當時最佳一檔時無法估計。
var _txTicks = {};   // code → 當次查詢的逐筆成交（每次重新整理清空）
async function _txTicksOf(code) {
  if (_txTicks[code] !== undefined) return _txTicks[code];
  try {
    var day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    var r = await fetch('/api/v1/data/ticks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'STK', exchange: ((typeof _contracts !== 'undefined' && _contracts[code]) || {}).exchange || 'TSE', code: code }, date: day })
    });
    _txTicks[code] = r.ok ? await r.json() : null;
  } catch (e) { _txTicks[code] = null; }
  return _txTicks[code];
}
function _txLive(t) {
  var st = (t.status || {}).status || '';
  return st === 'PendingSubmit' || st === 'PreSubmitted' || st === 'Submitted' || st === 'PartFilled' || st === 'Filling';
}
// all＝今日全部委託，用來找「同代號同買賣同價位、比本筆更早且仍未成交」的自己人：
// 基準的價位總量把它們也算在裡面，不扣掉會高估前方張數（同一價位分批掛單時特別明顯）。
function _txOwnEarlier(t, all) {
  var o = t.order || {}, s = t.status || {}, code = (t.contract || {}).code || '';
  var sum = 0;
  (all || []).forEach(function (x) {
    if (x === t || !_txLive(x)) return;
    var xo = x.order || {}, xs = x.status || {};
    if ((x.contract || {}).code !== code || xo.action !== o.action || +xo.price !== +o.price) return;
    if ((xs.order_ts || 0) > (s.order_ts || 0)) return;            // 晚於本筆 → 排在後面，不算前方
    sum += (xo.quantity || 0) - (xs.deal_quantity || 0);
  });
  return sum;
}
async function _txAhead(t, all) {
  var o = t.order || {}, s = t.status || {}, code = (t.contract || {}).code || '';
  var left = (o.quantity || 0) - (s.deal_quantity || 0);
  if (!_txLive(t) || left <= 0) return null;                                  // 已成交／取消／失敗
  if (o.order_lot && o.order_lot !== 'Common') return { na: '盤中零股另一本委託簿，無法用逐筆五檔推估' };
  if (s.deal_quantity > 0) return { ahead: 0, note: '已有部分成交，前方已清空' };
  var j = await _txTicksOf(code);
  var dt = j && j.datetime;
  if (!dt || !dt.length) return { na: '今日尚無逐筆成交資料' };
  var hm = new Date((s.order_ts || 0) * 1000 + 8 * 3600000).toISOString().slice(11, 19);
  var base = -1;
  for (var i = 0; i < dt.length; i++) { if (String(dt[i]).slice(11, 19) >= hm) { base = i; break; } }
  if (base < 0) return { na: '委託後尚無成交，無法取基準' };
  var buy = o.action === 'Buy';
  var lvlP = buy ? j.bid_price : j.ask_price, lvlV = buy ? j.bid_volume : j.ask_volume;
  if (+lvlP[base] !== o.price) return { na: '委託價非當時最佳一檔（逐筆只揭示最佳檔），無法估計' };
  var atOrder = lvlV[base];
  var own = _txOwnEarlier(t, all);                                 // 自己較早、同價位未成交的張數（仍排在前面，但標示出來）
  var ahead0 = Math.max(0, atOrder - left);
  var used = 0;
  for (var k = base; k < dt.length; k++) { if (+j.close[k] === o.price) used += j.volume[k]; }
  var lastLvl = null;
  for (var m = dt.length - 1; m >= 0; m--) { if (+lvlP[m] === o.price) { lastLvl = { t: String(dt[m]).slice(11, 19), v: lvlV[m] }; break; } }
  return { ahead: Math.max(0, ahead0 - used), ahead0: ahead0, used: used, atOrder: atOrder, own: own,
    baseT: String(dt[base]).slice(11, 19), lastLvl: lastLvl };
}
// 顏色分級：越少越快輪到 → 綠；中等 → 黃；很多 → 紅
function _txAheadCls(n) { return n <= 100 ? 'tx-ahead-low' : (n <= 500 ? 'tx-ahead-mid' : 'tx-ahead-high'); }
function _txAheadHtml(a) {
  if (!a) return '<span class="tx-dim">—</span>';
  if (a.na) return '<span class="tx-dim" title="' + a.na + '">無法估計</span>';
  var tip = a.note ? a.note :
    ('掛單當下（' + a.baseT + '）同價位 ' + a.atOrder + ' 張，扣掉自己這筆 ' + (a.atOrder - a.ahead0) + ' 張 → 前方 ' + a.ahead0 + ' 張\n' +
     (a.own ? '其中同價位還有你自己較早的委託 ' + a.own + ' 張\n' : '') +
     '委託後該價位已成交 ' + a.used + ' 張 → 目前前方約 ' + a.ahead + ' 張' +
     (a.lastLvl ? '\n最新（' + a.lastLvl.t + '）該價位總量 ' + a.lastLvl.v + ' 張（含排在你後面的）' : '') +
     '\n推估值：前方有人取消看不到，實際可能更少');
  return '<span class="tx-ahead ' + _txAheadCls(a.ahead) + '" title="' + tip + '">' +
    (a.ahead > 0 ? '約 ' + a.ahead.toLocaleString('zh-TW') : '0') + '</span>';
}

async function loadOrderBox() {
  var el = document.getElementById('tx-order-body');
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    _txTicks = {};                                  // 每次重新整理重抓逐筆（盤中持續增加）
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
      '<th>狀態</th><th class="num" title="推估仍排在你前面的張數：以委託後第一筆逐筆成交的同價位總量為基準，扣掉自己並減去之後該價位的成交量">前方(張)</th>' +
      '<th>書號</th><th class="num">委託時間</th></tr></thead><tbody>';
    var aheads = await Promise.all(trades.map(function (t) { return _txAhead(t, trades).catch(function () { return null; }); }));
    trades.forEach(function (t, ti) {
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
        '<td class="num">' + _txAheadHtml(aheads[ti]) + '</td>' +
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
