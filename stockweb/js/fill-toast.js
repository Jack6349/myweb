// ── 委託／成交提示（全站浮動提示，顯示 5 秒）──
// 做法：比對 order/trades 前後兩次的差異：
//   新出現的委託 → 委託成功（狀態 Failed → 委託失敗）；cancel_quantity 增加 → 取消；deals 新增明細 → 成交。
// 觸發：委託事件 SSE（stream.js openOrderEvents）＋盤中每 15 秒保險輪詢（事件漏接時仍會提示，最多慢 15 秒）。
// 開頁第一次查詢只記錄基準，不會把今天稍早的委託／成交全部跳出來。
var _ftSeen = null, _ftOrd = null, _ftBusy = false, _ftTimer = null, _ftDebounce = null;
// 開頁時間（秒）：基準查詢若失敗或晚完成，之後才出現的委託／成交仍以時間判定為「新的」，不會被當成舊資料吞掉
var _ftStartTs = Math.floor(Date.now() / 1000);
function _ftSec(ts) { return !ts ? 0 : (ts > 1e17 ? ts / 1e9 : (ts > 1e14 ? ts / 1e6 : (ts > 1e11 ? ts / 1e3 : ts))); }

function _ftKey(t, d) {
  var o = t.order || {};
  return (o.id || o.seqno || o.ordno || '') + '|' + (d.seq || '') + '|' + (d.ts || '') + '|' + d.quantity + '|' + d.price;
}

async function fillToastCheck() {
  if (_ftBusy || typeof fetchOrderTrades !== 'function') return;
  _ftBusy = true;
  try {
    var trades = await Promise.race([fetchOrderTrades(), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 10000); })]);
    var first = _ftSeen === null, seen = _ftSeen || {}, ord = _ftOrd || {};
    var events = [];          // { kind, t, qty, price, ts }
    var fills = {}, fillList = [];

    (trades || []).forEach(function (t) {
      var o = t.order || {}, s = t.status || {};
      var id = o.id || s.id || o.seqno || '';
      var st = s.status || '', cq = s.cancel_quantity || 0;
      var prev = ord[id];
      if (!first || _ftSec(s.order_ts) >= _ftStartTs) {
        if (!prev) {
          if (st === 'Failed') events.push({ kind: 'fail', t: t, qty: o.quantity, price: o.price, ts: s.order_ts, msg: s.msg });
          else events.push({ kind: 'order', t: t, qty: o.quantity, price: o.price, ts: s.order_ts });
          if (cq > 0) events.push({ kind: 'cancel', t: t, qty: cq, price: o.price, ts: s.modified_ts || s.order_ts });
        } else {
          if (cq > prev.cq) events.push({ kind: 'cancel', t: t, qty: cq - prev.cq, price: o.price, ts: s.modified_ts || s.order_ts });
          if (st === 'Failed' && prev.st !== 'Failed') events.push({ kind: 'fail', t: t, qty: o.quantity, price: o.price, ts: s.modified_ts || s.order_ts, msg: s.msg });
        }
      }
      ord[id] = { cq: cq, st: st };

      // 成交：同一筆委託在同一次檢查內的多筆明細合併成一則（例：1 張＋19 張 → 20 張、均價）
      (s.deals || []).forEach(function (d) {
        var k = _ftKey(t, d);
        if (seen[k]) return;
        seen[k] = true;
        if (first && _ftSec(d.ts) < _ftStartTs) return;
        var g = fills[id];
        if (!g) { g = fills[id] = { kind: 'fill', t: t, qty: 0, amt: 0, ts: 0 }; fillList.push(g); }
        g.qty += d.quantity; g.amt += d.quantity * d.price; g.ts = Math.max(g.ts, d.ts || 0);
      });
    });
    _ftSeen = seen; _ftOrd = ord;

    fillList.forEach(function (g) { g.price = g.amt / g.qty; events.push(g); });
    // 依時間；同秒時「委託 → 成交 → 取消／失敗」
    var rank = { order: 0, fill: 1, cancel: 2, fail: 2 };
    events.sort(function (a, b) { return ((a.ts || 0) - (b.ts || 0)) || (rank[a.kind] - rank[b.kind]); });
    events.forEach(_ftShow);
    if (events.length) {
      var pick = events.filter(function (e) { return e.kind === 'fail'; })[0] ||
        events.filter(function (e) { return e.kind === 'fill'; })[0] ||
        events.filter(function (e) { return e.kind === 'cancel'; })[0] || events[0];
      _ftBeep(pick.kind === 'fill' ? ((pick.t.order || {}).action === 'Buy' ? 'fill_buy' : 'fill_sell') : pick.kind);
    }
  } catch (e) { console.warn('[委託提示] 查詢委託失敗，下次再試', e); }
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
  (async function () {
    if (typeof subscribeTradeEvents === 'function') await subscribeTradeEvents();
    if (typeof openOrderEvents === 'function') openOrderEvents();   // 已開就不重開；庫存重抓在行情未就緒時會自動略過
  })();
  _ftTimer = setInterval(function () {
    var d = new Date(Date.now() + 8 * 3600000), wd = d.getUTCDay();
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (wd === 0 || wd === 6 || m < 8 * 60 + 30 || m > 14 * 60 + 35) return;   // 含盤後零股
    fillToastCheck();
  }, 15000);
}

// ── 提示音（Web Audio 合成，不需音效檔）──
// 成交：上揚兩聲（買高→更高、賣略低）；委託成功：短單聲；取消：下降兩聲；失敗：低音三短聲。
// 瀏覽器規定頁面要先有過點擊／按鍵才能出聲 → 第一次互動時解鎖 AudioContext；解鎖前的提示只顯示不出聲。
var _ftAudio = null;
function _ftAudioCtx() {
  if (!_ftAudio) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ftAudio = new AC();
  }
  if (_ftAudio.state === 'suspended') _ftAudio.resume();
  return _ftAudio;
}
['pointerdown', 'keydown'].forEach(function (evn) {
  window.addEventListener(evn, function () { try { _ftAudioCtx(); } catch (e) {} }, { capture: true, passive: true });
});
var FT_SOUND = {
  //        [頻率 Hz, 開始秒, 長度秒]
  fill_buy:  [[880, 0, .12], [1320, .13, .22]],
  fill_sell: [[784, 0, .12], [1047, .13, .22]],
  order:     [[1047, 0, .12]],
  cancel:    [[784, 0, .12], [523, .13, .2]],
  fail:      [[330, 0, .1], [330, .14, .1], [330, .28, .16]]
};
function _ftBeep(key) {
  try {
    var ctx = _ftAudioCtx();
    if (!ctx || ctx.state !== 'running') return;
    var now = ctx.currentTime;
    (FT_SOUND[key] || []).forEach(function (n) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = key === 'fail' ? 'square' : 'sine';
      osc.frequency.value = n[0];
      var t0 = now + n[1], t1 = t0 + n[2];
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(key === 'fail' ? 0.08 : 0.25, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t0); osc.stop(t1 + 0.02);
    });
  } catch (e) {}
}

function _ftShow(ev) {
  var box = document.getElementById('fill-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fill-toasts';
    document.body.appendChild(box);
  }
  var t = ev.t, o = t.order || {}, c = t.contract || {};
  var buy = o.action === 'Buy', side = buy ? '買進' : '賣出';
  var unit = (o.order_lot && o.order_lot !== 'Common') ? '股' : '張';
  var name = (typeof _contracts !== 'undefined' && _contracts[c.code] && _contracts[c.code].name) || c.name || '';
  var ts = '';
  if (ev.ts) {
    var ms = ev.ts > 1e17 ? ev.ts / 1e6 : (ev.ts > 1e14 ? ev.ts / 1e3 : (ev.ts > 1e11 ? ev.ts : ev.ts * 1000));
    ts = new Date(ms + 8 * 3600000).toISOString().slice(11, 19);
  }
  var tag = { order: side + '委託成功', fill: side + '成交', cancel: side + '委託取消', fail: side + '委託失敗' }[ev.kind];
  var px = (o.price_type && o.price_type !== 'LMT' && ev.kind !== 'fill') ? o.price_type : (+ev.price).toFixed(2);
  var el = document.createElement('div');
  el.className = 'fill-toast ft-' + ev.kind + ' ' + (buy ? 'ft-buy' : 'ft-sell');
  el.innerHTML = '<span class="ft-tag">' + tag + '</span>' +
    '<span class="ft-code">' + (c.code || '') + '</span><span class="ft-name">' + name + '</span>' +
    '<span class="ft-qty">' + ev.qty + unit + '<span class="tx-gap"></span>' + px + '</span>' +   // 同委託列表：不用 @，固定間距
    (ev.kind === 'fail' && ev.msg ? '<span class="ft-name">' + String(ev.msg).replace(/</g, '&lt;') + '</span>' : '') +
    (ts ? '<span class="ft-time">' + ts + '</span>' : '');
  el.title = '點一下關閉';
  el.onclick = function () { el.remove(); };
  box.appendChild(el);
  setTimeout(function () { el.classList.add('ft-out'); setTimeout(function () { el.remove(); }, 300); }, 5000);
}

window.addEventListener('load', function () { setTimeout(fillToastStart, 3000); });
