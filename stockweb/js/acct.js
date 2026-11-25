// 股利總管 Web — 帳戶餘額與現金推算
//
// 為什麼要手動輸入：券商 API 給得出交割應收付（settlements），給不出銀行帳戶裡有多少錢。
// 那兩件事在不同機構，沒有任何介面把它們接起來。
//
// ══════════ 日期規則（全站共用，只在這裡定義一次）══════════
//
// 錨點是「每日剩餘總額」裡最新的那一筆，不再是使用者按下 Enter 的那一刻。
// 推算只做錨點那一天「之後」的事。錨點愈新，推的鏈條愈短。
//
//   交割：日期 ≤ 錨點日 → 已經折進錨點，不再扣。之後 → 要扣。
//         一天的交割在當天 10:00 離開帳戶（見 broker.js 的 SETTLE_PAID_HOUR），
//         所以當天要過了 10:00 才定得了案。
//   配息：發放日已經過去的不列（那是歷史，不是預估）；未來的加在另一張表，
//         不併進交割這條線。
//   預計進出：使用者自己維護的提領、入金。過了日期就停止計入，等使用者確認。
//
// 為什麼要有錨點：券商的交割介面只回今天、明天、後天，中間的日子要自己補，
// 補法之一是從建倉明細反推，而反推有一個補不起來的洞 —— 那天買的標的如果
// 到今天已經整批出清，持倉清單裡沒有它，建倉明細就查不到。
// 2026-11-18 實測：過去一年有賣出紀錄的 9 檔裡，6 檔已經不在持倉清單上。
// 錨點把這個洞擋在當天，不讓它跨日累積。
//
// 儲存：與認購成本補正同一份 Firestore 文件（stock_prefs/{uid} 的 acctBalance、
//       acctPlans 欄位，merge 寫入，不動同文件其他偏好）；未登入時退回 localStorage。

var AB_LS = 'acct_balance_v1', AP_LS = 'acct_plans_v1', AD_LS = 'acct_daily_v1';
var _abVal = null;        // 餘額（元）；null＝沒填
var _abAt = '';           // 使用者輸入當下的時間（'YYYY-MM-DDTHH:MM:SS'，台北）
var _abPlans = null;      // [{id, date, amt, memo}]；amt 帶號：負＝提領、正＝入金
var _abLoaded = false, _abStore = 'local', _abErr = '';
var _abSettle = null;     // 最近一次抓到的交割列（供下單視窗、提醒共用，不各自再抓一次）
var _adList = null;       // 每日剩餘總額 [{d, amt, ok}]，由舊到新；ok＝使用者對過銀行

function _abLocal() {
  try { return JSON.parse(localStorage.getItem(AB_LS) || 'null'); } catch (e) { return null; }
}
function _apLocal() {
  try { var a = JSON.parse(localStorage.getItem(AP_LS) || 'null'); return Array.isArray(a) ? a : null; } catch (e) { return null; }
}
function _adLocal() {
  try { var a = JSON.parse(localStorage.getItem(AD_LS) || 'null'); return Array.isArray(a) ? a : null; }
  catch (e) { return null; }
}
function _abRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _abCloud() { return !!(window.FB && window.OWNER_UID); }
function _abApply(o) {
  _abVal = (o && typeof o.amt === 'number') ? o.amt : null;
  _abAt = (o && o.at) || '';
}

async function abLoad(force) {
  if (_abLoaded && !force) return _abVal;
  var local = _abLocal(), lp = _apLocal(), ls = _asLocalRead(), ld = _adLocal();
  _asSeen = ls || {};
  _abApply(local); _abPlans = lp || []; _adList = ld || []; _abStore = 'local';
  if (_abCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_abRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var d = snap.exists() ? snap.data() : {};
      var remote = d.acctBalance || null, rp = Array.isArray(d.acctPlans) ? d.acctPlans : null;
      var rd = Array.isArray(d.acctDaily) ? d.acctDaily : null;
      if (rd) { _adList = rd; try { localStorage.removeItem(AD_LS); } catch (e) {} }
      var rs = (d.acctSettleSeen && typeof d.acctSettleSeen === 'object') ? d.acctSettleSeen : null;
      if (rs) { _asSeen = rs; _asReady = ''; try { localStorage.removeItem(AS_LS); } catch (e) {} }
      if (remote || rp || rd) {
        if (remote) _abApply(remote);
        if (rp) _abPlans = rp;
        _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); localStorage.removeItem(AP_LS); } catch (e) {}
      } else if (local || (lp && lp.length)) {
        var up = {};
        if (local) up.acctBalance = local;
        if (lp && lp.length) up.acctPlans = lp;
        if (ld && ld.length) up.acctDaily = ld;
        if (ls && Object.keys(ls).length) up.acctSettleSeen = ls;
        await window.FB.setDoc(_abRef(), up, { merge: true });
        _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); localStorage.removeItem(AP_LS); } catch (e) {}
      }
    } catch (e) { _abErr = (e && (e.code || e.message)) || String(e); }
  } else { _abErr = '未登入 Google'; }
  _abLoaded = true;
  _adSeed();                                   // 手填的那一筆要先變成錨點，後面才推得動
  return _abVal;
}
window.addEventListener('owner-ready', function () {
  _abLoaded = false;
  abLoad(true).then(abRefreshViews).catch(function (e) { hush('acct', e); });
});

// ══════════ 每日剩餘總額 ══════════
//
// 一天一筆：日期、當天結束時的帳戶總額、這筆是系統算的還是使用者對過銀行的。
//
// 兩種的意思不一樣，這是整個設計的核心：
//   系統算的 ＝ 前一天的總額 ＋ 當天的交割。只含交割，不含配息也不含帳戶調整。
//              交割是券商給的確定數字，另外兩個是預估與計畫，都可能不發生。
//              把不確定的東西加進一個叫「總額」的數字裡，就再也分不出哪一部分能當真。
//   使用者確認的 ＝ 對過銀行的真實數字。這個什麼都含，因為銀行餘額本來就什麼都含。
//
// 往回推遇到任何一筆就停（確認過的更可靠，但系統算的也已經把交割折進去了），
// 所以鏈條長度等於「最後一筆到今天」，而不是「最初手填那天到今天」。
//
// 只有真的有交割金額的日子才自動寫一筆。沒動的日子寫了只是複製前一天。
function adList() { return _adList || _adLocal() || []; }
function adAnchor() { var l = adList(); return l.length ? l[l.length - 1] : null; }
function adAnchorDay() { var a = adAnchor(); return a ? a.d : ''; }
function adLastOk() {
  var l = adList();
  for (var i = l.length - 1; i >= 0; i--) if (l[i].ok) return l[i];
  return null;
}
async function _adWriteList() {
  // 只留兩年，與交割存檔同一個規則
  var lim = new Date(Date.now() + 8 * 3600000 - 730 * 86400000).toISOString().slice(0, 10);
  _adList = adList().filter(function (x) { return x && x.d >= lim; })
    .sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
  await _abWrite('acctDaily', _adList, AD_LS);
}
// 寫一筆（同一天已經有就覆蓋）。
//
// 改了某一天之後，它後面那些「系統算的」全部作廢：
// 那幾筆是用舊數字一路加上來的，前面換了它們就不成立。
// 下一次折算會重新補回來。後面那些「已確認」的不動，
// 它們是各自對過銀行的數字，不依賴前一天。
async function adPut(d, amt, ok) {
  if (!d || amt == null) return;
  var out = adList().filter(function (x) {
    if (x.d === d) return false;
    if (x.d > d && !x.ok) return false;
    return true;
  });
  out.push({ d: d, amt: Math.round(amt), ok: !!ok });
  _adList = out;
  await _adWriteList();
  // 確認＝這是銀行的真實數字，那一天（含）以前的預計進出本來就含在裡面。
  // 不必再去標記它們：abFlow 用日期跟錨點比，比錨點早的本來就不會再算一次。
}
// 手填的餘額對應到哪一天的「收盤後」。
// 十點前填的那個數字裡還沒有當天的交割，所以它是前一天收盤的總額。
function _adDayOf(at) {
  if (!at) return '';
  var d = at.slice(0, 10), hh = +(at.slice(11, 13) || 0);
  var H = (typeof SETTLE_PAID_HOUR === 'number') ? SETTLE_PAID_HOUR : 10;
  if (hh >= H) return d;
  return new Date(new Date(d + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
}
// 舊資料接進來：手填的那一筆變成最舊的一筆已確認，不必重新輸入
function _adSeed() {
  if (adList().length) return;
  var raw = _abLocal(), v = (_abVal != null) ? _abVal : (raw && typeof raw.amt === 'number' ? raw.amt : null);
  var d = _adDayOf(abAt());
  if (v == null || !d) return;
  _adList = [{ d: d, amt: Math.round(v), ok: true }];
  _adWriteList().catch(function (e) { hush('acct', e); });
}

// 可以定案到哪一天。一天的交割十點才離開帳戶，所以十點前最多只能定到昨天。
function _adLimitDay() {
  var t = new Date(Date.now() + 8 * 3600000);
  var today = t.toISOString().slice(0, 10);
  var H = (typeof SETTLE_PAID_HOUR === 'number') ? SETTLE_PAID_HOUR : 10;
  if (t.getUTCHours() >= H) return today;
  return new Date(t.getTime() - 86400000).toISOString().slice(0, 10);
}
// 某一天的交割金額。券商親口給過的最準，其次是反推出來的，都沒有就是沒動。
function _adSettleOn(d) {
  var seen = asSeen();
  if (seen[d] != null) return { amt: Math.round(seen[d]), src: 'broker' };
  var p = (_asPast || []).filter(function (x) { return x.d === d; })[0];
  if (p) return { amt: p.amt, src: p.src };
  var rows = _abSettle || [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].date === d) return { amt: Math.round(rows[i].amount || 0), src: 'broker' };
  }
  return null;
}
// 把錨點之後、已經可以定案的日子逐日折進來。要在備好過去那段交割之後呼叫。
async function adEnsure() {
  _adSeed();
  var a = adAnchor(), lim = _adLimitDay();
  if (!a || !lim || a.d >= lim) return a;
  var days = _asTradeDaysBetween(a.d, lim);
  if (_asTrade(lim)) days.push(lim);
  var run = a.amt, add = [];
  days.forEach(function (D) {
    var s = _adSettleOn(D);
    if (!s || !s.amt) return;                  // 沒動就不寫，寫了只是複製前一天
    run += s.amt;
    add.push({ d: D, amt: Math.round(run), ok: false });
  });
  if (!add.length) return a;
  _adList = adList().concat(add);
  await _adWriteList();
  return adAnchor();
}

// ── 確認某一天 ──
//
// 「確認」的意思是使用者去看過銀行，所以只能由他本人按，不能自動。
// 按下去之後，那一天之後的自動筆會作廢重算（見 adPut），所以確認一次
// 等於把推算的鏈條剪斷一次。
//
// 預設填入的是現在算出來的數字，不是空白：多數時候兩者相同，
// 要使用者重打一次只會製造打錯的機會。
function adConfirmDay() { return _adDayOf(_abNow()); }
function adBtnHtml(d, ok, cur) {
  return '<button class="ad-btn' + (ok ? ' ad-btn-ok' : '') + '" title="'
    + (ok ? '這一天已經對過銀行。再按一次可以改。'
          : '去看過銀行之後，把 ' + d + ' 收盤後的實際餘額填進來。'
            + '確認之後推算就從這一天開始，不再往更早的日子推。')
    + '" onclick="adAsk(this,&quot;' + d + '&quot;,' + (cur == null ? 'null' : Math.round(cur)) + ')">'
    + (ok ? '改' : '確認') + '</button>';
}
// 把金額那一格換成輸入框。不用瀏覽器的 prompt：它擋不住貼上千分位，
// 而且在這一頁的深色底上會跳出一個完全不同風格的白框。
function adAsk(btn, d, cur) {
  var tr = btn.closest('tr');
  var td = tr ? tr.querySelector('.ad-amt') : null;
  if (!td || td.querySelector('input')) return;
  td.innerHTML = '<input class="ab-inp ad-inp" type="text" inputmode="numeric"'
    + ' value="' + (cur == null ? '' : Number(cur).toLocaleString('zh-TW')) + '"'
    + ' onkeydown="if(event.key===&quot;Enter&quot;)this.blur();'
    + 'if(event.key===&quot;Escape&quot;){this.value=&quot;&quot;;this.blur();}"'
    + ' onblur="adAskDone(this,&quot;' + d + '&quot;)">';
  var i = td.querySelector('input');
  if (i) { i.focus(); i.select(); }
}
function adAskDone(el, d) {
  var raw = String(el.value || '').replace(/[,\s元]/g, '');
  var v = raw === '' ? null : Number(raw);
  if (v == null || !isFinite(v)) { abRefreshViews(); return; }   // 空白或打錯＝放棄，不改資料
  adPut(d, v, true)
    .then(function () { return adEnsure(); })
    .then(abRefreshViews)
    .catch(function (e) { hush('acct', e); });
}

// ── 歷史區 ──
// 預設收起來。平常要看的是「現在還剩多少」，不是走過的每一天；
// 但要對帳的時候一天都不能少，所以收起來不是刪掉。
var AD_HIST_MAX = 90;
function adHistHtml() {
  var l = adList();
  if (l.length < 2) return '';
  var rows = l.slice().reverse(), more = 0;
  if (rows.length > AD_HIST_MAX) { more = rows.length - AD_HIST_MAX; rows = rows.slice(0, AD_HIST_MAX); }
  var h = '<details class="nbox ad-hist"><summary>每日剩餘總額　' + l.length + ' 筆</summary>'
    + '<table class="tx-settle-table ad-htable"><thead><tr><th>日期</th><th>狀態</th>'
    + '<th class="num">收盤後總額</th><th></th></tr></thead><tbody>';
  rows.forEach(function (x) {
    h += '<tr><td>' + x.d.slice(5).replace('-', '/') + '</td>'
      + '<td>' + (x.ok ? '<span class="tx-st tx-st-ok">已確認</span>'
                       : '<span class="tx-st">系統算的</span>') + '</td>'
      + '<td class="num tx-bal ad-amt"><span class="' + (x.amt < 0 ? 'tx-bal-neg' : '') + '">'
      + abMoney(x.amt) + '</span></td>'
      + '<td class="tx-cf-act">' + adBtnHtml(x.d, x.ok, x.amt) + '</td></tr>';
  });
  h += '</tbody></table>';
  if (more) h += '<div class="ad-hmore">更早的 ' + more + ' 筆沒有列出來。資料保留兩年。</div>';
  return h + '</details>';
}

// 同步查詢：錨點優先，沒有錨點才退回手填的那個數字
function abGet() {
  var a = adAnchor();
  if (a) return a.amt;
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

// 使用者自己打進來的數字＝他剛去看過銀行，所以那一天就是已確認。
// 十點前打的算前一天收盤（當天的交割還沒扣）。
async function abSave(v) {
  var o = (v == null) ? null : { amt: v, at: _abNow() };
  _abApply(o);
  await _abWrite('acctBalance', o, AB_LS);
  if (v == null) return;
  var d = _adDayOf(o.at);
  if (d) await adPut(d, v, true);
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
// ── 預計進出：排了就算 ──
//
// 原本這裡有三種狀態（未反映／已反映／沒發生）：過了日期還沒表態的就停止計入餘額，
// 列在畫面下方等使用者按鈕判斷。2026-11-21 使用者指出這是多餘的 ——
// 錢是他自己排進去的，排了就是會發生；真的有變動，補一筆負的就好，
// 不需要一組狀態機去管「到底發生了沒」。
//
// 拿掉之後唯一要守的規則只剩一條：錨點那天（含）以前的不再計入，
// 因為那個數字是使用者對過銀行填進來的，裡面本來就含那些錢。
// 這一條在 abFlow 用日期比對就夠了，不必靠狀態。
//
// 這一區仍然不提供刪除：這些錢只有使用者自己記，交割那邊券商有存檔，這邊沒有。
// 記錯了補一筆相反的，帳才留得出軌跡。
function apSettled() {
  return abPlans().slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
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
  // 從錨點那天往後補，不是從手填那天。錨點愈新，要補的洞愈少。
  var from = adAnchorDay() || abAtDay(), today = _abToday();
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
// 交割那一筆是不是已經折進錨點了。錨點那天（含）以前的都算。
// 沒有錨點時退回舊規則：用手填的那一刻比。
function _abSettleInBalance(r) {
  if (!r || !r.date) return false;
  var ad = adAnchorDay();
  if (ad) return r.date <= ad;
  var at = abAt();
  if (!at) return false;
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
// 這筆配息是不是已經被算進起點了。
//
// 分界是「最後一次對過銀行、按過確認的那一天」，跟預計進出同一條線。
// 不能拿錨點當分界：錨點有兩種，系統算的那種是前一天總額加當天交割推出來的
// （adEnsure 只加交割金額），裡面沒有配息。
//
// 2026-11-25 的實例就是這樣壞的：00984D 的配息 11/25 入帳，發放日當天不進餘額，
// 隔天 _abDivPast 又把它當成過去式整筆丟掉，於是那筆錢從頭到尾沒有任何一欄認列，
// 餘額一路偏低，而且每多一次配息就低一次。
//
// 連餘額都沒填的時候沒有任何起點，過去的配息無從認列，退回原本的作法只留未來的，
// 否則整年從一月起全部被列出來，累計欄會做出一個幾百萬的數字。
function _abDivFolded(payDate) {
  if (!payDate) return true;
  var ok = (typeof adLastOk === 'function' && adLastOk()) ? adLastOk().d : '';
  if (!ok) ok = abAtDay();
  if (!ok) return payDate < _abToday();
  return payDate <= ok;
}

// 每一檔每一次配息，股務代理匯款時扣的手續費。帳上真正進來的是配息減掉它。
// 只用在這一頁：這一頁問的是「帳上會有多少錢」。股利估算問的是「領了多少配息」，
// 那邊要跟股利憑單對得起來，所以維持毛額。
var AB_DIV_FEE = 10;

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
      if (_abDivFolded(m.payDate)) return;          // 已經算進起點了
      // 使用者自己排了同一天、備註裡提到這一檔的自訂進出，就不要再加一次。
      // 2026-11-17 實例：對帳單上 00981B 配息 6,290 當天入帳，而使用者已經排了一筆
      // 「00981B配息+調整」，估算這邊再加一次就會算兩次。
      // 只能靠備註比對，沒有別的訊號，所以略過的時候要在畫面上講出來，不能靜靜跳過。
      if (_abDivClash(m.payDate, s.code)) return;
      out.push({ d: m.payDate, kind: 'div', label: s.code,
                 amt: Math.round(m.total) - AB_DIV_FEE, gross: Math.round(m.total) });
    });
  });
  return out;
}

// 主推算：回 { start, rows, end, hasDiv }
// rows 依日期排序，每一列帶推算後的餘額。start 為 null 代表沒填帳戶餘額。
function abFlow(settleRows, opts) {
  opts = opts || {};
  var start = abGet(), today = _abToday(), items = [];
  var anchor = adAnchorDay();
  // 錨點那天（含）以前的都已經折進去了，再列一次就是算兩遍
  var after = function (d) { return !anchor || d > anchor; };
  // 補出來的那幾天（券商已經不回）要進來，不然餘額是斷的。
  // 這些列一定在今天之前，與券商回的三天不會重疊。
  (_asPast || []).forEach(function (x) {
    if (!after(x.d)) return;
    items.push({ d: x.d, kind: 'settle', label: (x.from || '').slice(5).replace('-', '/') + ' 成交',
                 amt: x.amt, src: x.src, ref: { date: x.d, amount: x.amt } });
  });
  if (_asZero && _asZero.length && after(_asZero[_asZero.length - 1])) {
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
  // ── 預計進出的分界：最後一筆「確認過的」，不是最後一筆錨點 ──
  //
  // 錨點有兩種，含的東西不一樣：
  //   使用者確認的＝對過銀行的真實數字，什麼都含，所以那天以前的預計進出不能再算一次。
  //   系統算的＝前一天的總額 ＋ 當天的交割，只含交割，裡面沒有預計進出。
  //
  // 拿錨點當分界就會把第二種也算成「已經含了」。2026-11-23 實例：
  // 錨點是系統算的 11/23，11/20 匯進來的 382,000 日期比它早，整筆被跳過，
  // 餘額顯示 −381,684，實際上是 +316。
  var okDay = (typeof adLastOk === 'function' && adLastOk()) ? adLastOk().d : '';
  abPlans().forEach(function (p) {
    if (!p.date) return;
    if (okDay && p.date <= okDay) return;      // 對過銀行的那個數字裡已經有它
    items.push({ d: p.date, kind: 'plan', label: p.memo || ((p.amt || 0) < 0 ? '提領' : '入金'),
                 amt: Math.round(p.amt || 0), id: p.id,
                 // 日期比錨點早，但錨點是系統算的所以沒含它。列的時候要講，
                 // 否則使用者會看到起點 11/23 底下掛一列 11/20，不知道為什麼。
                 preAnc: !!(anchor && p.date <= anchor) });
  });
  // divs:false 的意思是「不要把還沒到手的錢算進去」，不是「配息一概不算」。
  // 已經發放的配息是事實，錢就在帳戶裡，排除它會讓下單視窗與提醒算出來的餘額
  // 比交易帳務那一頁低，兩個畫面對同一個帳戶講出不同的數字。
  var divs = abDivIn();
  if (divs) divs.forEach(function (x) {
    if (opts.divs === false && x.d > today) return;
    items.push(x);
  });
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

// 交割列快取：下單視窗與提醒都要用，不各自再抓一次。
// 順序不能換：先備好過去那段，才折得出每日總額，折完錨點才是新的。
async function abSettleRows(force) {
  if (_abSettle && !force) return _abSettle;
  if (typeof fetchSettlements !== 'function') return [];
  try { _abSettle = await fetchSettlements(); } catch (e) { hush('acct', e); _abSettle = []; }
  try { await abSettlePrepare(force); } catch (e) { hush('acct', e); }
  try { await adEnsure(); } catch (e) { hush('acct', e); }
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

// ── 帳戶餘額的輸入格搬走了 ──
//
// 原本總覽抽屜「部位與配置」有一格可以直接打帳戶餘額，另一格顯示交割後餘額。
// 2026-11-24 整組移除：那一格寫進去的是「今天（十點前算前一天）已確認」，
// 跟交易資訊「台幣交割」第一列那顆確認鈕完全等價，同一份資料兩個入口。
// 留下的那一個比較好：旁邊就寫著日期與「已確認／系統算的」，底下整條線跟著重算。
// 顯示用的交割後餘額也一起拿掉，它沒算預計進出，跟那條線的尾數對不起來。
//
// 唯一要補的洞是冷啟動：完全沒有紀錄時那顆確認鈕原本不畫，現在改成一律畫。
