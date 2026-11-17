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
  var local = _abLocal(), lp = _apLocal(), ls = _asLocalRead();
  _asSeen = ls || {};
  _abApply(local); _abPlans = lp || []; _abStore = 'local';
  if (_abCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_abRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var d = snap.exists() ? snap.data() : {};
      var remote = d.acctBalance || null, rp = Array.isArray(d.acctPlans) ? d.acctPlans : null;
      var rs = (d.acctSettleSeen && typeof d.acctSettleSeen === 'object') ? d.acctSettleSeen : null;
      if (rs) { _asSeen = rs; _asReady = ''; try { localStorage.removeItem(AS_LS); } catch (e) {} }
      if (remote || rp) {
        if (remote) _abApply(remote);
        if (rp) _abPlans = rp;
        _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); localStorage.removeItem(AP_LS); } catch (e) {}
      } else if (local || (lp && lp.length)) {
        var up = {};
        if (local) up.acctBalance = local;
        if (lp && lp.length) up.acctPlans = lp;
        if (ls && Object.keys(ls).length) up.acctSettleSeen = ls;
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


// ══════════ 過去的交割：券商只回三天，缺的自己補 ══════════
//
// 券商的交割介面（新舊兩種格式都一樣）只回今天、明天、後天，沒有日期參數可以往回查。
// 餘額起點一旦早於今天超過一個交易日，中間那幾天的交割就查不到，餘額會一路偏高。
// 2026-11-17 實例：起點是 11/13，11/16 那天扣的 217,586 整個消失，畫面上的
// 「交割走完」多算了 21 萬。
//
// 補法有兩道。
//
// 第一道是記錄。今天看到的 T+1、T+2 就是未來兩天的答案，所以每次抓到就按日期存起來。
// 11/13 開過這一頁的話，11/16 那個金額那天就在畫面上了。這是券商自己算的，最精確。
//
// 第二道是重建，給從來沒看過的日子用。某一天的交割金額
//   ＝ 兩個交易日前那天所有買進 − 當天賣出的淨收入
// 買進金額要從建倉明細取，而且**要把已領配息加回去**：券商在明細裡記的是
// 「付出的錢 − 這批已經領到的配息」，不是當初真的付出去的錢。
// 2026-11-17 實測，不加回去會少算：00934 那批 11/12 買的，明細記 135,855、
// 已領配息 2,500，銀行對帳單是 138,355。加回去之後四個日子全部吻合：
//   成交 11/10 → 143,057（對帳單 11/12）
//   成交 11/12 → 217,586（對帳單 11/16 兩筆合計）
//   成交 11/13 →  97,538（券商說 11/17）
//   成交 11/16 → 458,529（券商說 11/18）
// 認購價還原的那種批次（券商端沒有記成本）本來就沒被扣過配息，不能再加，
// 判斷依據與庫存頁的成本還原同一個。
//
// 重建補不到的洞只有一種：那天買進的批次到今天已經整批賣掉或出借，建倉明細裡找不到。
// 賣出那邊不會漏，已實現損益可以用日期區間查。同一份資料裡找得到洞的例子：
// 2380 持有 9,680 股，建倉明細只有 9,000 股，680 股查無來源。
// 所以查無任何進出的日子一律當作 0，但會排一列寫明是「查無進出」，不靜靜跳過。
var AS_LS = 'acct_settle_seen_v1';
var _asSeen = null;        // { 'YYYY-MM-DD': 金額 }：券商親口給過的，看到就記下來
var _asPast = null;        // 推算用的過去交割列
var _asZero = null;        // 查無進出、當作 0 的日子
var _asReady = '';         // 已經備好的區間，避免同一組重算

function _asLocalRead() {
  try { var o = JSON.parse(localStorage.getItem(AS_LS) || 'null'); return (o && typeof o === 'object') ? o : null; }
  catch (e) { return null; }
}
function asSeen() { return _asSeen || {}; }

// 每次抓到交割就記下來。只有內容真的變了才寫，不每次都寫。
// 同一天後來看到的金額覆蓋先前的：愈晚看到愈接近定案，日期變成過去之後就凍結在最後一次。
function abSettleSeen(rows) {
  if (!Array.isArray(rows) || !rows.length) return Promise.resolve();
  var cur = {}, old = asSeen(), chg = false;
  Object.keys(old).forEach(function (k) { cur[k] = old[k]; });
  rows.forEach(function (r) {
    if (!r || !r.date) return;
    var v = Math.round(r.amount || 0);
    if (cur[r.date] !== v) { cur[r.date] = v; chg = true; }
  });
  if (!chg) return Promise.resolve();
  // 只留兩年。這份資料很小，但沒必要無限累積
  var lim = new Date(Date.now() + 8 * 3600000 - 730 * 86400000).toISOString().slice(0, 10);
  var keep = {};
  Object.keys(cur).forEach(function (k) { if (k >= lim) keep[k] = cur[k]; });
  _asSeen = keep;
  _asReady = '';
  return _abWrite('acctSettleSeen', keep, AS_LS);
}

// 這一天是不是交易日。沒有辦公日曆時退回「不是週末就算」
function _asTrade(iso) {
  var off = (typeof _divIsOff === 'function') ? _divIsOff(iso) : null;
  if (off != null) return !off;
  var w = new Date(iso + 'T00:00:00Z').getUTCDay();
  return w !== 0 && w !== 6;
}
// 往前數 n 個交易日
function _asPrevTrade(iso, n) {
  var d = new Date(iso + 'T00:00:00Z'), left = n;
  for (var i = 0; i < 40 && left > 0; i++) {
    d = new Date(d.getTime() - 86400000);
    if (_asTrade(d.toISOString().slice(0, 10))) left--;
  }
  return d.toISOString().slice(0, 10);
}
// a 之後、b 之前（兩端都不含）的交易日
function _asTradeDaysBetween(a, b) {
  var out = [], d = new Date(a + 'T00:00:00Z');
  for (var i = 0; i < 400; i++) {
    d = new Date(d.getTime() + 86400000);
    var iso = d.toISOString().slice(0, 10);
    if (iso >= b) break;
    if (_asTrade(iso)) out.push(iso);
  }
  return out;
}

// 某一個成交日的買進總額。回 null 代表建倉明細裡完全沒有那一天
function _asBuyOn(iso) {
  if (typeof _lotsMap === 'undefined' || !_lotsMap) return null;
  var tot = 0, hit = false;
  Object.keys(_lotsMap).forEach(function (code) {
    (_lotsMap[code] || []).forEach(function (l) {
      if (l.date !== iso) return;
      tot += (l.cost || 0) + (l.sub ? (l.div || 0) : 0);
      hit = true;
    });
  });
  return hit ? tot : null;
}

// 區間內的賣出淨收入（成交日 → 金額）。清單那層沒有手續費與稅，要再查單筆明細
async function _asSellMap(from, to) {
  var out = {};
  if (typeof fetchProfitLoss !== 'function') return out;
  var list = null;
  try { list = await fetchProfitLoss(from, to); } catch (e) { hush('acct', e); return out; }
  var rows = (list || []).filter(function (r) { return r && r.date >= from && r.date <= to; });
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], net = null;
    if (typeof fetchProfitLossDetail === 'function' && r.id != null) {
      try {
        var d = await fetchProfitLossDetail(r.id);
        var one = Array.isArray(d) ? d[0] : d;
        if (one && one.price > 0 && one.quantity > 0) {
          net = one.price * one.quantity * 1000 - (one.fee || 0) - (one.tax || 0);
        }
      } catch (e) { hush('acct', e); }
    }
    // 明細查不到就退回「價 × 股數」，手續費與稅會少扣，金額略高，不是精確值
    if (net == null && r.price > 0 && r.quantity > 0) net = r.price * r.quantity * 1000;
    if (net != null) out[r.date] = (out[r.date] || 0) + net;
  }
  return out;
}

// 備好「餘額起點之後、今天之前」那一段的交割列。券商回的三天不在這裡，那邊照原本走
async function abSettlePrepare(force) {
  var from = abAtDay(), today = _abToday();
  if (!from || from >= today) { _asPast = []; _asZero = []; _asReady = from + '|' + today; return _asPast; }
  var key = from + '|' + today;
  if (_asReady === key && !force) return _asPast;
  var days = _asTradeDaysBetween(from, today);
  var sells = {};
  if (days.length) {
    var oldest = _asPrevTrade(days[0], 2);
    sells = await _asSellMap(oldest, today);
  }
  var past = [], zero = [], seen = asSeen();
  days.forEach(function (sd) {
    // 起點那天 10:00 之前填的餘額，當天的交割還沒扣，要照算；之後填的已經含在裡面
    if (_abSettleInBalance({ date: sd })) return;
    if (seen[sd] != null) {
      past.push({ d: sd, amt: Math.round(seen[sd]), src: 'broker', from: _asPrevTrade(sd, 2) });
      return;
    }
    var td = _asPrevTrade(sd, 2);
    var buy = _asBuyOn(td), sell = sells[td] || 0;
    if (buy == null && !sell) { zero.push(sd); return; }
    past.push({ d: sd, amt: Math.round(-(buy || 0) + sell), src: 'rebuild', from: td });
  });
  _asPast = past; _asZero = zero; _asReady = key;
  return past;
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
// 已經發放過的。這張表的題目是「還會進來多少錢」，過去的不算預估。
//
// 為什麼不能只靠 _abDivInBalance：它比的是「你填餘額的那一天」，
// 餘額沒填時 abAtDay() 回空字串，比較恒為 false，整年從一月起全部被當成「未來」列出來，
// 累計欄會做出一個幾百萬的數字。餘額填得很早也一樣，只是沒那麼誇張。
function _abDivPast(payDate) {
  return !!(payDate && payDate < _abToday());
}

// 同一天有沒有自訂進出的備註提到這一檔
var _abDivSkip = [];
function _abDivClash(payDate, code) {
  var hit = abPlans().some(function (p) {
    return p.date === payDate && String(p.memo || '').indexOf(String(code)) >= 0;
  });
  if (hit) _abDivSkip.push({ d: payDate, code: code });
  return hit;
}
function abDivSkipped() { return _abDivSkip; }

// 未來的配息入帳：取自股利估算已經算好的月度結果（可領張數已依建倉明細判定）。
// 那一頁沒載過就回 null —— 回空陣列會讓畫面以為「沒有配息」，那是兩件事。
function abDivIn() {
  _abDivSkip = [];
  var est = (typeof _divEstResult !== 'undefined' && _divEstResult && _divEstResult.stocks) || null;
  if (!est) return null;
  var out = [];
  est.forEach(function (s) {
    (s.res.months || []).forEach(function (m) {
      if (!m.payDate || !(m.total > 0)) return;
      if (_abDivInBalance(m.payDate)) return;        // 已經在餘額裡
      if (_abDivPast(m.payDate)) return;            // 發放日已經過了
      // 使用者自己排了同一天、備註裡提到這一檔的自訂進出，就不要再加一次。
      // 2026-11-17 實例：對帳單上 00981B 配息 6,290 當天入帳，而使用者已經排了一筆
      // 「00981B配息+調整」，估算這邊再加一次就會算兩次。
      // 只能靠備註比對，沒有別的訊號，所以略過的時候要在畫面上講出來，不能靜靜跳過。
      if (_abDivClash(m.payDate, s.code)) return;
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
  // 過去那一段（券商已經不回的日子）要先進來，不然餘額從起點到今天之間是斷的。
  // 這些列一定在今天之前，與券商回的三天不會重疊。
  (_asPast || []).forEach(function (x) {
    items.push({ d: x.d, kind: 'settle', label: (x.from || '').slice(5).replace('-', '/') + ' 成交',
                 amt: x.amt, src: x.src, ref: { date: x.d, amount: x.amt } });
  });
  if (_asZero && _asZero.length) {
    // 查無任何進出的日子當作 0，但要排一列。帳上少一筆該看得見，不是靜靜跳過
    items.push({ d: _asZero[_asZero.length - 1], kind: 'settle', label: '查無進出',
                 amt: 0, src: 'zero', days: _asZero.slice(),
                 ref: { date: _asZero[_asZero.length - 1], amount: 0 } });
  }
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
  try { await abSettlePrepare(force); } catch (e) { hush('acct', e); }
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
