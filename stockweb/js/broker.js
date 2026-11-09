// 股利總管 Web — 券商帳務（Shioaji /api/v1/portfolio，同源）
// 持股庫存 / 持倉明細 / 已實現損益 / 損益明細 + 回寫 Firestore 供手機版共用

// ── 帳務／委託查詢限流 ──
// 永豐 API 帳務查詢有流量上限（約 5 秒 25 次）。開頁時會一次打出幾十支：
// position_detail × 持股檔數、profit_loss_detail × 近 12 個月每筆賣出……同時送出遠超上限，
// 2026-09-18 盤中連續出現 SessionNotEstablished（12:54、12:56、13:09、13:15、13:17），時間都對得上整頁重新載入。
// → 所有帳務／委託查詢排隊：任 5 秒內最多 BROKER_MAX 次（留空間給同時開著的第二個分頁），同時最多 4 支在途。
var BROKER_MAX = 12, BROKER_WIN = 5000, BROKER_CONC = 4;
var _brkStamps = [], _brkQueue = [], _brkActive = 0, _brkTimer = null;
function _brkPump() {
  _brkTimer = null;
  var now = Date.now();
  while (_brkStamps.length && now - _brkStamps[0] >= BROKER_WIN) _brkStamps.shift();
  while (_brkQueue.length && _brkActive < BROKER_CONC && _brkStamps.length < BROKER_MAX) {
    var job = _brkQueue.shift();
    _brkStamps.push(Date.now());
    _brkActive++;
    job.fn().then(job.ok, job.ng).finally(function () { _brkActive--; _brkPump(); });
  }
  if (_brkQueue.length && !_brkTimer) {
    var wait = _brkStamps.length >= BROKER_MAX ? Math.max(50, BROKER_WIN - (Date.now() - _brkStamps[0]) + 20) : 50;
    _brkTimer = setTimeout(_brkPump, wait);
  }
}
function brokerThrottle(fn) {
  return new Promise(function (ok, ng) { _brkQueue.push({ fn: fn, ok: ok, ng: ng }); _brkPump(); });
}

async function brokerPost(path, body) {
  var r = await brokerThrottle(function () { return fetch('/api/v1/portfolio/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }); });
  if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
  return r.json();
}

// 庫存（股，含零股）：[{id, code, quantity(股), price(每股成本均價), last_price, pnl, ...}]
// 用 unit:Share 取得「股」為單位的餘額，才不會漏掉零股（Common 只給整張、零股被截掉）
async function fetchBrokerPositions() {
  return brokerPost('position_unit', { unit: 'Share' });
}
// 單檔持倉明細（需先呼叫過 position_unit 填快取；detail_id = 該檔 position 的 id）
async function fetchPositionDetail(detailId) {
  return brokerPost('position_detail', { detail_id: detailId });
}
// 台幣交割（T/T+1/T+2 應收付）：[{date:'YYYY-MM-DD', amount, T:0|1|2}]
async function fetchSettlements() {
  return brokerPost('settlements', {});
}
// 交割扣款的時間門檻。
//
// 舊版只比日期：日期 ≤ 今天就算已扣款，等於把門檻設在 00:00。
// 那是錯的 —— 00:00 不是銀行營業時間，凌晨看到的「合計待交割」會把當天那筆漏掉，
// 拿來算「還有多少錢可以下單」就會算錯。舊註解記的「實測 01:19 已扣款」應該是券商帳務
// 狀態的變更，不是銀行真的動錢；使用者對自己的銀行餘額的觀察優先於那筆記錄。
//
// 門檻取 10:00：依據是銀行營業時間，不是某一次觀測到的時刻。
var SETTLE_PAID_HOUR = 10;
function _brTwToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
// 台北時間是否已過扣款門檻
function settleHourPassed(nowMs) {
  var t = new Date((nowMs == null ? Date.now() : nowMs) + 8 * 3600000);
  return t.getUTCHours() >= SETTLE_PAID_HOUR;
}
// 三態：昨天以前一定已扣、明天以後一定未扣、今天看時間
function settleIsPaid(r, todayIso, nowMs) {
  if (!r || !r.date) return false;
  var today = todayIso || _brTwToday();
  if (r.date < today) return true;
  if (r.date > today) return false;
  return settleHourPassed(nowMs);
}
// 今天要扣、但還沒到 10:00 的那一筆（仍計入待交割，但要標出來，
// 否則它看起來跟後天的 T+2 一樣，會漏掉「今天上午就會動」這件事）
function settleIsDueToday(r, todayIso, nowMs) {
  if (!r || !r.date) return false;
  return r.date === (todayIso || _brTwToday()) && !settleHourPassed(nowMs);
}
// 台股整股 ROD 收盤即失效，但券商不會即時改狀態：實測 2026-09-30 收盤後 9 分鐘，
// 一筆未成交的 ROD 仍回 status=Submitted、cancel_quantity=0。照它顯示的話，
// 整個晚上都會說那些張數「還掛著」，而它們已經死了，也不可能再改單或刪單。
// 這裡只比時間、不猜券商何時補狀態，作法與 settleIsPaid 一致。
// 13:30 收盤，留 5 分鐘給最後的成交回報進來再視為結束。
function twSessionOver(nowMs) {
  var t = new Date((nowMs == null ? Date.now() : nowMs) + 8 * 3600000);
  return t.getUTCHours() * 60 + t.getUTCMinutes() >= 13 * 60 + 35;
}
// 這筆委託的未成交量是否已經因為收盤而失效（只對當日有效的整股 ROD）
function orderExpired(order, status, nowMs) {
  var o = order || {}, s = status || {};
  if ((o.order_type || 'ROD') !== 'ROD') return false;          // IOC/FOK 當下就結束，不會留到收盤
  if ((o.order_lot || 'Common') !== 'Common') return false;     // 零股盤時段不同，不套用
  var st = s.status || '';
  if (st === 'Filled' || st === 'Cancelled' || st === 'Failed') return false;
  return twSessionOver(nowMs);
}

// 拆成 {paid, pending, paidRows, pendRows}，供交易資訊與頂欄共用同一套判定
function splitSettlements(rows) {
  var today = _brTwToday(), now = Date.now();
  var paid = 0, pending = 0, dueToday = 0, paidRows = [], pendRows = [], dueRows = [];
  (rows || []).forEach(function (r) {
    var a = r.amount || 0;
    if (settleIsPaid(r, today, now)) { paid += a; paidRows.push(r); return; }
    pending += a; pendRows.push(r);
    if (settleIsDueToday(r, today, now)) { dueToday += a; dueRows.push(r); }
  });
  return {
    paid: paid, pending: pending, paidRows: paidRows, pendRows: pendRows,
    dueToday: dueToday, dueRows: dueRows, today: today
  };
}
// 距離下一個 10:00 還有幾毫秒（已過就回 null）。用來排自動重算：
// 09:55 打開放著、0:05 畫面還是舊的的話，恰好是要看錢夠不夠下單的那段時間。
function msUntilSettleHour(nowMs) {
  var ms = (nowMs == null ? Date.now() : nowMs);
  var t = new Date(ms + 8 * 3600000);
  var mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  var target = SETTLE_PAID_HOUR * 60;
  if (mins >= target) return null;
  return (target - mins) * 60000 - t.getUTCSeconds() * 1000 + 5000;   // 過門檻 5 秒再算
}
// 今日委託／成交事件流水：[{StockOrder:{operation,order,status,contract}} | {StockDeal:{...}}]
// 為什麼需要它：券商會在盤後把 order/trades 清空。實測 2026-09-30，14:35 還回 2 筆，
// 16:37 就回 0 筆，連已成交那筆也不見了。只靠 order/trades 的話，下午之後
// 「今日進出」就整個消失。order_deal_records 是事件流水，清除後仍在。
async function fetchOrderDealRecords() {
  return brokerPost2('order/order_deal_records', {});
}
async function brokerPost2(path, body) {
  var r = await brokerThrottle(function () { return fetch('/api/v1/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }); });
  if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
  return r.json();
}
// 把事件流水折成 order/trades 的形狀，讓使用端只認一種資料結構。
// StockOrder(New) → 一筆委託；StockDeal → 累加到同書號的成交。
function dealRecordsToTrades(recs) {
  var by = {}, out = [];
  (recs || []).forEach(function (e) {
    var v = e.StockOrder;
    if (!v) return;
    var o = v.order || {}, st = v.status || {}, c = v.contract || {};
    var no = (o.ordno || '').trim();
    if (!no || by[no]) return;                      // 同書號只取第一筆 New
    var t = { contract: { code: c.code }, order: o,
      status: { id: st.id, status: 'Submitted', order_quantity: st.order_quantity != null ? st.order_quantity : o.quantity,
                deal_quantity: 0, cancel_quantity: st.cancel_quantity || 0,
                modified_price: st.modified_price || 0, order_ts: st.exchange_ts, deals: [] } };
    by[no] = t; out.push(t);
  });
  (recs || []).forEach(function (e) {
    var d = e.StockDeal;
    if (!d) return;
    var t = by[(d.ordno || '').trim()];
    if (!t) return;
    t.status.deals.push({ price: d.price, quantity: d.quantity, ts: d.ts });
    t.status.deal_quantity += d.quantity;
  });
  out.forEach(function (t) {
    var s = t.status, oq = s.order_quantity || 0;
    s.status = s.deal_quantity >= oq ? 'Filled' : (s.deal_quantity > 0 ? 'PartFilled' : 'Submitted');
  });
  return out;
}

// 今日委託含成交回報：[{contract, order, status:{status, deals:[{price,quantity,ts}], ...}}]
async function fetchOrderTrades() {
  var r = await brokerThrottle(function () { return fetch('/api/v1/order/trades', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  }); });
  if (!r.ok) throw new Error('order/trades HTTP ' + r.status);
  return r.json();
}
// 已實現損益（日期區間 YYYY-MM-DD）
async function fetchProfitLoss(beginDate, endDate) {
  return brokerPost('profit_loss', { begin_date: beginDate, end_date: endDate, unit: 'Common' });
}
// 單筆已實現損益明細（需先呼叫過 profit_loss）
async function fetchProfitLossDetail(detailId) {
  return brokerPost('profit_loss_detail', { detail_id: detailId, unit: 'Common' });
}

// ── 券商持倉回寫 Firestore（手機版沿用同一份資料）──
// 規則：以券商為準 — 更新張數/總成本、新增新持股、移除已出清；保留手機版自設欄位（divFreqType、manualDiv 等）
var _lastSyncSig = null;
async function syncPositionsToFirestore(positions) {
  if (!window.FB || !window.OWNER_UID || !positions || !positions.length) return;
  var sig = JSON.stringify(positions.map(function (p) { return [p.code, p.quantity, p.price]; }));
  if (sig === _lastSyncSig) return; // 本次 session 已同步且無變化
  try {
    var ref = window.FB.doc(window.FB.db, 'stock_portfolio', window.OWNER_UID);
    var snap = await window.FB.getDoc(ref);
    var old = snap.exists() ? (snap.data().portfolio || []) : [];
    var byCode = {};
    old.forEach(function (s) { byCode[String(s.code)] = s; });

    var posMap = {};
    positions.forEach(function (p) { posMap[String(p.code)] = p; });

    // 券商 quantity 為「股」；手機版 shares 欄位以「張」計，故 ÷1000（零股會是小數張，手機版 ×1000 仍正確）
    var merged = [];
    // 先保留原順序中的仍持有者
    old.forEach(function (s) {
      var p = posMap[String(s.code)];
      if (!p) return; // 已出清 → 移除
      var upd = Object.assign({}, s);
      upd.shares = p.quantity / 1000; // 張（含零股小數）
      // 原始成本（元）：券商的成本已扣掉累積配息，逐筆還原才是實際付出（見 inventory.js invOrigCost）
      upd.cost = Math.round((typeof invOrigCost === 'function') ? invOrigCost(p).cost : p.price * p.quantity);
      merged.push(upd);
    });
    // 新增券商有、手機版沒有的
    positions.forEach(function (p) {
      if (byCode[String(p.code)]) return;
      merged.push({
        code: String(p.code),
        name: (_contracts[p.code] && _contracts[p.code].name) || '',
        shares: p.quantity / 1000,
        cost: Math.round((typeof invOrigCost === 'function') ? invOrigCost(p).cost : p.price * p.quantity)
      });
    });

    var totalCost = 0;
    merged.forEach(function (s) { totalCost += (parseFloat(s.cost) || 0); });
    var changed = JSON.stringify(merged.map(function (s) { return [s.code, s.shares, s.cost]; })) !==
                  JSON.stringify(old.map(function (s) { return [s.code, s.shares, s.cost]; }));
    if (changed) {
      await window.FB.setDoc(ref, {
        portfolio: merged,
        totalCost: Math.round(totalCost),
        updatedAt: new Date().toISOString()
      });
      console.log('[sync] 券商持倉已回寫 Firestore（' + merged.length + ' 檔）');
    }
    _lastSyncSig = sig;
  } catch (e) { console.warn('[syncPositionsToFirestore]', e); }
}
