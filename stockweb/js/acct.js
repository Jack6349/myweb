// 股利總管 Web — 帳戶餘額與現金推算
//
// 為什麼要手動輸入：券商 API 給得出交割應收付（settlements），給不出銀行帳戶裡有多少錢。
// 那兩件事在不同機構，沒有任何介面把它們接起來。
//
// ══════════ 日期規則（全站共用，只在這裡定義一次）══════════
// 帳戶餘額是「使用者按下 Enter 那一刻」的銀行餘額。要往前推，只能加減
// 那一刻「之後」才會動的錢。判斷基準一律是輸入時間（abAt），不是今天：
//
//   交割：扣款發生在輸入之前 → 已經在餘額裡，不再扣。之後 → 要扣。
//         門檻是交割日當天 10:00（銀行營業時間，見 broker.js 的 SETTLE_PAID_HOUR）。
//         注意這跟「現在是否已扣款」不是同一件事：11/13 填的餘額，到 11/17 來看，
//         11/16 那筆現在已扣款，但它不在 11/13 的餘額裡，照樣要扣。
//   配息：發放日 ≤ 輸入日 → 已經入帳，不再加。之後 → 要加（發放日已含假日順延）。
//   預計進出：使用者自己維護的提領、入金。過了日期就停止計入，等使用者確認。
//
// 儲存：與認購成本補正同一份 Firestore 文件（stock_prefs/{uid} 的 acctBalance、
//       acctPlans 欄位，merge 寫入，不動同文件其他偏好）；未登入時退回 localStorage。

var AB_LS = 'acct_balance_v1', AP_LS = 'acct_plans_v1';
var _abVal = null;        // 餘額（元）；null＝沒填
var _abAt = '';           // 使用者輸入當下的時間（'YYYY-MM-DDTHH:MM:SS'，台北）
var _abPlans = null;      // [{id, date, amt, memo}]；amt 帶號：負＝提領、正＝入金
var _abLoaded = false, _abStore = 'local', _abErr = '';
var _abSettle = null;     // 最近一次抓到的交割列（供下單視窗、提醒共用，不各自再抓一次）

function _abLocal() {
  try { return JSON.parse(localStorage.getItem(AB_LS) || 'null'); } catch (e) { return null; }
}
function _apLocal() {
  try { var a = JSON.parse(localStorage.getItem(AP_LS) || 'null'); return Array.isArray(a) ? a : null; } catch (e) { return null; }
}
function _abRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _abCloud() { return !!(window.FB && window.OWNER_UID); }
function _abApply(o) {
  _abVal = (o && typeof o.amt === 'number') ? o.amt : null;
  _abAt = (o && o.at) || '';
}

async function abLoad(force) {
  if (_abLoaded && !force) return _abVal;
  var local = _abLocal(), lp = _apLocal();
  _abApply(local); _abPlans = lp || []; _abStore = 'local';
  if (_abCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_abRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var d = snap.exists() ? snap.data() : {};
      var remote = d.acctBalance || null, rp = Array.isArray(d.acctPlans) ? d.acctPlans : null;
      if (remote || rp) {
        if (remote) _abApply(remote);
        if (rp) _abPlans = rp;
        _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); localStorage.removeItem(AP_LS); } catch (e) {}
      } else if (local || (lp && lp.length)) {
        var up = {};
        if (local) up.acctBalance = local;
        if (lp && lp.length) up.acctPlans = lp;
        await window.FB.setDoc(_abRef(), up, { merge: true });
        _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); localStorage.removeItem(AP_LS); } catch (e) {}
      }
    } catch (e) { _abErr = (e && (e.code || e.message)) || String(e); }
  } else { _abErr = '未登入 Google'; }
  _abLoaded = true;
  return _abVal;
}
window.addEventListener('owner-ready', function () {
  _abLoaded = false;
  abLoad(true).then(abRefreshViews).catch(function (e) { hush('acct', e); });
});

// 同步查詢：尚未載入時先用本機值，載入後自然一致
function abGet() {
  if (_abVal != null) return _abVal;
  var l = _abLocal();
  return (l && typeof l.amt === 'number') ? l.amt : null;
}
function abAt() { return _abAt || ((_abLocal() || {}).at || ''); }
function abAtDay() { return abAt().slice(0, 10); }
function abPlans() {
  if (_abPlans) return _abPlans;
  return _apLocal() || [];
}

async function _abWrite(field, val, lsKey) {
  if (_abCloud()) {
    try {
      var up = {}; up[field] = val;
      await window.FB.setDoc(_abRef(), up, { merge: true });
      _abStore = 'firestore'; _abErr = '';
      try { localStorage.removeItem(lsKey); } catch (e) {}
      return;
    } catch (e) { _abErr = (e && (e.code || e.message)) || String(e); }
  }
  try {
    if (val == null || (Array.isArray(val) && !val.length)) localStorage.removeItem(lsKey);
    else localStorage.setItem(lsKey, JSON.stringify(val));
  } catch (e) {}
  _abStore = 'local';
}
function _abNow() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19); }
function _abToday() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

async function abSave(v) {
  var o = (v == null) ? null : { amt: v, at: _abNow() };
  _abApply(o);
  await _abWrite('acctBalance', o, AB_LS);
}

// ── 預計進出 ──
async function apSave() { await _abWrite('acctPlans', abPlans(), AP_LS); }
async function apAdd(date, amt, memo) {
  var list = abPlans().slice();
  list.push({ id: 'p' + Date.now() + Math.floor(Math.random() * 1000), date: date, amt: amt, memo: memo || '' });
  _abPlans = list;
  await apSave();
}
async function apSet(id, patch) {
  var list = abPlans().map(function (p) { return p.id === id ? Object.assign({}, p, patch) : p; });
  _abPlans = list;
  await apSave();
}
async function apDel(id) {
  _abPlans = abPlans().filter(function (p) { return p.id !== id; });
  await apSave();
}
// 過期那一筆：使用者按「已扣」＝那筆錢真的動了，把它併進帳戶餘額並刪掉這筆。
// 不自動做：自動做等於替使用者假設「排進去的一定發生」，錯的時候數字沒有任何跡象。
async function apApply(id) {
  var p = abPlans().filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  var bal = abGet();
  if (bal != null) await abSave(bal + (p.amt || 0));
  await apDel(id);
}
function apOverdue() {
  var t = _abToday();
  return abPlans().filter(function (p) { return p.date && p.date < t; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

// ══════════ 推算 ══════════
// 交割那一筆在「輸入餘額的那一刻」是否已經扣掉了。
// 用輸入時間比，不是用現在比——差別見檔頭的日期規則。
function _abSettleInBalance(r) {
  var at = abAt();
  if (!at || !r || !r.date) return false;
  var d = at.slice(0, 10);
  if (r.date < d) return true;
  if (r.date > d) return false;
  var hh = +(at.slice(11, 13) || 0);
  return hh >= (typeof SETTLE_PAID_HOUR === 'number' ? SETTLE_PAID_HOUR : 10);
}
// 這筆配息在輸入餘額的那一刻是否已經入帳
function _abDivInBalance(payDate) {
  var d = abAtDay();
  return !!(d && payDate && payDate <= d);
}

// 未來的配息入帳：取自股利估算已經算好的月度結果（可領張數已依建倉明細判定）。
// 那一頁沒載過就回 null —— 回空陣列會讓畫面以為「沒有配息」，那是兩件事。
function abDivIn() {
  var est = (typeof _divEstResult !== 'undefined' && _divEstResult && _divEstResult.stocks) || null;
  if (!est) return null;
  var out = [];
  est.forEach(function (s) {
    (s.res.months || []).forEach(function (m) {
      if (!m.payDate || !(m.total > 0)) return;
      if (_abDivInBalance(m.payDate)) return;        // 已經在餘額裡
      out.push({ d: m.payDate, kind: 'div', label: s.code, amt: Math.round(m.total) });
    });
  });
  return out;
}

// 主推算：回 { start, rows, end, hasDiv }
// rows 依日期排序，每一列帶推算後的餘額。start 為 null 代表沒填帳戶餘額。
function abFlow(settleRows, opts) {
  opts = opts || {};
  var start = abGet(), today = _abToday(), items = [];
  (settleRows || []).forEach(function (r) {
    if (_abSettleInBalance(r)) return;
    items.push({ d: r.date, kind: 'settle', label: 'T' + (r.T ? '+' + r.T : ''),
                 amt: Math.round(r.amount || 0), ref: r });
  });
  abPlans().forEach(function (p) {
    if (!p.date || p.date < today) return;           // 過期的停止計入，等使用者確認
    items.push({ d: p.date, kind: 'plan', label: p.memo || ((p.amt || 0) < 0 ? '提領' : '入金'),
                 amt: Math.round(p.amt || 0), id: p.id });
  });
  var divs = opts.divs === false ? null : abDivIn();
  if (divs) divs.forEach(function (x) { items.push(x); });
  items.sort(function (a, b) {
    if (a.d !== b.d) return a.d < b.d ? -1 : 1;
    var k = { settle: 0, div: 1, plan: 2 };           // 同一天：先交割、再入帳、最後自訂
    return k[a.kind] - k[b.kind];
  });
  var run = start;
  items.forEach(function (x) {
    if (run == null) { x.bal = null; return; }
    run += x.amt;
    x.bal = run;
  });
  return { start: start, rows: items, end: run, hasDiv: !!divs };
}

// 某一天結束時的預估餘額（下單視窗、提醒用）。沒填帳戶餘額回 null。
function abBalAt(settleRows, iso, opts) {
  var f = abFlow(settleRows, opts);
  if (f.start == null) return null;
  var b = f.start;
  f.rows.forEach(function (x) { if (x.d <= iso) b = x.bal; });
  return b;
}

// 交割日：今天下的單是 T+2 個「交易日」，不是兩天。
// 用辦公日曆（含國定假日與補班），週末跳法算不出連假。
function abSettleDay(n) {
  var d = new Date(_abToday() + 'T00:00:00Z'), left = (n == null ? 2 : n);
  for (var i = 0; i < 30 && left > 0; i++) {
    d = new Date(d.getTime() + 86400000);
    var iso = d.toISOString().slice(0, 10), w = d.getUTCDay();
    var off = (typeof _divIsOff === 'function') ? _divIsOff(iso) : null;
    var isOff = (off == null) ? (w === 0 || w === 6) : off;
    if (!isOff) left--;
  }
  return d.toISOString().slice(0, 10);
}

// 交割列快取：下單視窗與提醒都要用，不各自再抓一次
async function abSettleRows(force) {
  if (_abSettle && !force) return _abSettle;
  if (typeof fetchSettlements !== 'function') return [];
  try { _abSettle = await fetchSettlements(); } catch (e) { hush('acct', e); _abSettle = []; }
  return _abSettle;
}

// 用到餘額的畫面，資料一變就一起更新
function abRefreshViews() {
  if (typeof renderTopbarTotals === 'function' && typeof _dwOpen !== 'undefined' && _dwOpen) renderTopbarTotals();
  if (typeof loadSettleBox === 'function' && document.getElementById('tx-settle-body')) loadSettleBox();
  if (typeof _ordRender === 'function' && typeof _ord !== 'undefined' && _ord) _ordRender();
  // 退休現金流那張表要先載支出設定才畫得出來。
  // 直接呼叫會在設定還沒載的時候炸掉（實測 14:01:59：讀不到 base），
  // 而且是被吞掉的錯——畫面只會停在舊內容，不會有人知道。
  var cash = document.getElementById('dv-cash');
  if (cash && cash.style.display !== 'none' && typeof rtCashHtml === 'function') {
    if (typeof rtLoad === 'function') {
      rtLoad().then(function () { cash.innerHTML = rtCashHtml(); }).catch(function (e) { hush('acct', e); });
    } else { cash.innerHTML = rtCashHtml(); }
  }
}

function abMoney(v) { return (v == null) ? '—' : Math.round(v).toLocaleString('zh-TW'); }
function abSigned(v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + Math.round(v).toLocaleString('zh-TW'); }

// ── 抽屜裡的輸入格 ──
function abInputHtml() {
  var v = abGet(), day = abAtDay();
  return '<span class="sum-pair ab-pair" title="'
    + (day ? '於 ' + day + ' 輸入。券商給不出銀行帳戶餘額，這個數字要自己維護' : '券商給不出銀行帳戶餘額，這個數字要自己維護')
    + '"><span class="sum-plabel">帳戶餘額</span>'
    + '<input id="ab-inp" class="ab-inp" type="text" inputmode="numeric" placeholder="未填"'
    + ' value="' + (v == null ? '' : v.toLocaleString('zh-TW')) + '"'
    + ' onkeydown="if(event.key===\'Enter\')this.blur()" onblur="abInputDone(this)">'
    + (day ? '<span class="ab-at">' + day.slice(5).replace('-', '/') + '</span>' : '')
    + '</span>';
}
function abInputDone(el) {
  var raw = String(el.value || '').replace(/[,\s元]/g, '');
  var v = raw === '' ? null : Number(raw);
  if (v != null && !isFinite(v)) { el.value = (abGet() == null ? '' : abGet().toLocaleString('zh-TW')); return; }
  if (v === abGet()) return;                       // 沒改就不寫，也不更新輸入日期
  abSave(v).then(abRefreshViews).catch(function (e) { hush('acct', e); });
}
// 抽屜：交割後餘額（帳戶餘額扣掉還沒扣的交割，不含配息與自訂進出——
// 那兩項有日期先後，一行放不下，完整的在交易資訊「台幣交割」）
function abNetHtml() {
  var bal = abGet();
  if (bal == null || typeof _settleTot === 'undefined' || _settleTot == null) return '';
  var net = bal + _settleTot;
  return '<span class="sum-pair"><span class="sum-plabel">交割後餘額</span>'
    + '<span class="sum-pval" style="color:' + (net < 0 ? 'var(--warn)' : 'var(--accent2)') + '">'
    + abMoney(net) + '</span></span>';
}
