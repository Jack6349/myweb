// ── 成交提示（全站浮動提示，顯示 5 秒）──
// 做法：比對 order/trades 內各委託的 deals，出現新的成交明細就跳提示。
// 觸發：委託事件 SSE（stream.js openOrderEvents）＋盤中每 30 秒保險輪詢（事件漏接時仍會提示，最多慢 30 秒）。
// 開頁第一次查詢只記錄基準，不會把今天稍早的成交全部跳出來。
var _ftSeen = null, _ftBusy = false, _ftTimer = null, _ftDebounce = null;

function _ftKey(t, d) {
  var o = t.order || {};
  return (o.id || o.seqno || o.ordno || '') + '|' + (d.seq || '') + '|' + (d.ts || '') + '|' + d.quantity + '|' + d.price;
}

async function fillToastCheck() {
  if (_ftBusy || typeof fetchOrderTrades !== 'function') return;
  _ftBusy = true;
  try {
    var trades = await fetchOrderTrades();
    var first = _ftSeen === null, seen = _ftSeen || {}, fresh = [];
    (trades || []).forEach(function (t) {
      ((t.status || {}).deals || []).forEach(function (d) {
        var k = _ftKey(t, d);
        if (seen[k]) return;
        seen[k] = true;
        if (!first) fresh.push({ t: t, d: d });
      });
    });
    _ftSeen = seen;
    var byOrder = {}, order = [];
    fresh.forEach(function (f) {
      var id = (f.t.order || {}).id || _ftKey(f.t, f.d);
      var g = byOrder[id];
      if (!g) { g = byOrder[id] = { t: f.t, d: { quantity: 0, amt: 0, ts: 0 } }; order.push(g); }
      g.d.quantity += f.d.quantity;
      g.d.amt += f.d.quantity * f.d.price;
      g.d.ts = Math.max(g.d.ts, f.d.ts || 0);
    });
    order.forEach(function (g) { g.d.price = g.d.amt / g.d.quantity; });
    order.sort(function (a, b) { return a.d.ts - b.d.ts; });
    order.forEach(function (g) { _ftShow(g.t, g.d); });
  } catch (e) { /* 券商暫時查不到 → 下次再比 */ }
  finally { _ftBusy = false; }
}

// 委託事件進來：等 1.5 秒讓券商端 trades 更新後再查（連續事件只查一次）
function fillToastOnEvent() {
  clearTimeout(_ftDebounce);
  _ftDebounce = setTimeout(fillToastCheck, 1500);
}

function fillToastStart() {
  if (_ftTimer) return;
  fillToastCheck();                                   // 建立基準
  _ftTimer = setInterval(function () {
    var d = new Date(Date.now() + 8 * 3600000), wd = d.getUTCDay();
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (wd === 0 || wd === 6 || m < 8 * 60 + 30 || m > 14 * 60 + 35) return;   // 含盤後零股
    fillToastCheck();
  }, 30000);
}

function _ftShow(t, d) {
  var box = document.getElementById('fill-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fill-toasts';
    document.body.appendChild(box);
  }
  var o = t.order || {}, c = t.contract || {};
  var buy = o.action === 'Buy';
  var unit = (o.order_lot && o.order_lot !== 'Common') ? '股' : '張';
  var name = (typeof _contracts !== 'undefined' && _contracts[c.code] && _contracts[c.code].name) || c.name || '';
  var ts = '';
  if (d.ts) {
    var ms = d.ts > 1e17 ? d.ts / 1e6 : (d.ts > 1e14 ? d.ts / 1e3 : (d.ts > 1e11 ? d.ts : d.ts * 1000));
    ts = new Date(ms + 8 * 3600000).toISOString().slice(11, 19);
  }
  var el = document.createElement('div');
  el.className = 'fill-toast ' + (buy ? 'ft-buy' : 'ft-sell');
  el.innerHTML = '<span class="ft-tag">' + (buy ? '買進成交' : '賣出成交') + '</span>' +
    '<span class="ft-code">' + (c.code || '') + '</span><span class="ft-name">' + name + '</span>' +
    '<span class="ft-qty">' + d.quantity + unit + ' @ ' + (+d.price).toFixed(2) + '</span>' +
    (ts ? '<span class="ft-time">' + ts + '</span>' : '');
  el.title = '點一下關閉';
  el.onclick = function () { el.remove(); };
  box.appendChild(el);
  setTimeout(function () { el.classList.add('ft-out'); setTimeout(function () { el.remove(); }, 300); }, 5000);
}

window.addEventListener('load', function () { setTimeout(fillToastStart, 3000); });
