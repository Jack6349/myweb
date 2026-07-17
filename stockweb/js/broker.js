// 股利總管 Web — 券商帳務（Shioaji /api/v1/portfolio，同源）
// 持股庫存 / 持倉明細 / 已實現損益 / 損益明細 + 回寫 Firestore 供手機版共用

async function brokerPost(path, body) {
  var r = await fetch('/api/v1/portfolio/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
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
// 今日委託含成交回報：[{contract, order, status:{status, deals:[{price,quantity,ts}], ...}}]
async function fetchOrderTrades() {
  var r = await fetch('/api/v1/order/trades', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
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
      upd.cost = Math.round(p.price * p.quantity); // 總成本（元）＝每股成本 × 股數
      merged.push(upd);
    });
    // 新增券商有、手機版沒有的
    positions.forEach(function (p) {
      if (byCode[String(p.code)]) return;
      merged.push({
        code: String(p.code),
        name: (_contracts[p.code] && _contracts[p.code].name) || '',
        shares: p.quantity / 1000,
        cost: Math.round(p.price * p.quantity)
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
