// 股利總管 Web — 帳戶餘額（使用者自己輸入的銀行交割帳戶餘額）
//
// 為什麼要手動輸入：券商 API 給得出交割應收付（settlements），給不出銀行帳戶裡有多少錢。
// 那兩件事在不同機構，沒有任何介面把它們接起來。
//
// 它拿來做什麼：交易資訊「台幣交割」那一框，把每一筆還沒扣款的交割依日期套上去，
// 算出每個交割日之後帳上剩多少。沒有這個起點就只有「要扣多少」，沒有「扣完還剩多少」。
//
// 儲存：與認購成本補正同一份 Firestore 文件（stock_prefs/{uid} 的 acctBalance 欄位，
//       merge 寫入，不動同文件其他偏好）；未登入或寫入失敗時退回 localStorage。

var AB_LS = 'acct_balance_v1';
var _abVal = null;        // 餘額（元）；null＝沒填
var _abAt = '';           // 使用者輸入當下的時間（ISO，台北）
var _abLoaded = false, _abStore = 'local', _abErr = '';

function _abLocal() {
  try { return JSON.parse(localStorage.getItem(AB_LS) || 'null'); } catch (e) { return null; }
}
function _abRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _abCloud() { return !!(window.FB && window.OWNER_UID); }
function _abApply(o) {
  _abVal = (o && typeof o.amt === 'number') ? o.amt : null;
  _abAt = (o && o.at) || '';
}

async function abLoad(force) {
  if (_abLoaded && !force) return _abVal;
  var local = _abLocal();
  _abApply(local); _abStore = 'local';
  if (_abCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_abRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var remote = (snap.exists() && snap.data().acctBalance) || null;
      if (remote) {
        _abApply(remote); _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); } catch (e) {}
      } else if (local) {
        await window.FB.setDoc(_abRef(), { acctBalance: local }, { merge: true });
        _abStore = 'firestore'; _abErr = '';
        try { localStorage.removeItem(AB_LS); } catch (e) {}
      }
    } catch (e) { _abErr = (e && (e.code || e.message)) || String(e); }
  } else { _abErr = '未登入 Google'; }
  _abLoaded = true;
  return _abVal;
}
window.addEventListener('owner-ready', function () {
  _abLoaded = false;
  abLoad(true).then(function () { abRefreshViews(); }).catch(function (e) { hush('acct', e); });
});

// 同步查詢：尚未載入時先用本機值，載入後自然一致
function abGet() {
  if (_abVal != null) return _abVal;
  var l = _abLocal();
  return (l && typeof l.amt === 'number') ? l.amt : null;
}
function abAt() { return _abAt || ((_abLocal() || {}).at || ''); }
// 輸入當下的日期（台北，YYYY-MM-DD）；交割那一框要用它說明起點是哪一天的餘額
function abAtDay() { return abAt().slice(0, 10); }

async function abSave(v) {
  var o = (v == null) ? null : { amt: v, at: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19) };
  _abApply(o);
  if (_abCloud()) {
    try {
      await window.FB.setDoc(_abRef(), { acctBalance: o }, { merge: true });
      _abStore = 'firestore'; _abErr = '';
      try { localStorage.removeItem(AB_LS); } catch (e) {}
      return;
    } catch (e) { _abErr = (e && (e.code || e.message)) || String(e); }
  }
  try {
    if (o) localStorage.setItem(AB_LS, JSON.stringify(o));
    else localStorage.removeItem(AB_LS);
  } catch (e) {}
  _abStore = 'local';
}

// 兩個用到餘額的畫面：頂欄抽屜的輸入格、交易資訊的台幣交割
function abRefreshViews() {
  if (typeof renderTopbarTotals === 'function' && typeof _dwOpen !== 'undefined' && _dwOpen) renderTopbarTotals();
  if (typeof loadSettleBox === 'function' && document.getElementById('tx-settle-body')) loadSettleBox();
}

// ── 抽屜裡的輸入格 ──
// 跟旁邊幾個數字用同一組字級與對齊（sum-pair），只是值換成可以打字的欄位。
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
