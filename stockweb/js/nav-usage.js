// 股利總管 Web — 功能使用頻率排序（頂端功能列＋首頁卡片）
//
// 記錄：每次切換進某個功能頁（showView，排除首頁、排除重複進同一頁）計 1 次。
// 衰減：分數以半衰期 30 天遞減（30 天前的 1 次只算 0.5），排序跟著近期使用習慣走，不被早期累計綁住。
// 排序：只在開啟網頁時排一次，使用期間固定不動（即時重排會讓按鈕在眼前換位置、點錯）。
//       同分維持原本 HTML 的預設順序。
// 存放：Firestore stock_prefs/{uid} 的 navUsage 欄位（merge 寫入，保留同文件其他偏好欄位）；
//       未登入或讀寫失敗時暫存本機 localStorage，下次連上雲端時合併上去。

var NAV_LS = 'nav_usage_v1';
var NAV_HALF_LIFE = 30 * 86400000;
var _navUsage = {};          // { view: { s: 分數（記錄當下）, t: 最後更新時間 ms } }
var _navDefault = [];        // 預設順序（HTML 原始順序），同分時的排序依據
var _navFnToView = {};       // onclick 函式名 → view（由功能列按鈕的 data-view 對照而來，首頁卡片共用）
var _navHitsThisSession = 0;
var _navSaveTimer = null;

function _navDecayed(e, now) {
  return e ? e.s * Math.pow(0.5, (now - e.t) / NAV_HALF_LIFE) : 0;
}
function _navLocal() {
  try { return JSON.parse(localStorage.getItem(NAV_LS) || '{}') || {}; } catch (e) { return {}; }
}
// 兩份紀錄合併：同一功能取「最後更新較晚」的那筆（它已包含較早那筆衰減後的累計）
function _navMerge(a, b) {
  var out = {};
  [a || {}, b || {}].forEach(function (src) {
    Object.keys(src).forEach(function (v) {
      var e = src[v];
      if (e && typeof e.s === 'number' && typeof e.t === 'number' && (!out[v] || e.t > out[v].t)) out[v] = e;
    });
  });
  return out;
}

function _navRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _navCloud() { return !!(window.FB && window.OWNER_UID); }

function navUsageHit(view) {
  var now = Date.now(), e = _navUsage[view];
  _navUsage[view] = { s: _navDecayed(e, now) + 1, t: now };
  _navHitsThisSession++;
  try { localStorage.setItem(NAV_LS, JSON.stringify(_navUsage)); } catch (err) {}
  // 雲端寫入去抖：連續切頁只寫一次
  clearTimeout(_navSaveTimer);
  _navSaveTimer = setTimeout(_navSaveCloud, 3000);
}
async function _navSaveCloud() {
  if (!_navCloud()) return;
  try {
    await window.FB.setDoc(_navRef(), { navUsage: _navUsage, navUpdatedAt: new Date().toISOString() }, { merge: true });
  } catch (e) { console.warn('[功能排序] Firestore 寫入失敗，暫存本機', e && (e.code || e.message)); }
}

// ── 重排 ──
function _navOrder() {
  var now = Date.now();
  return _navDefault.slice().sort(function (a, b) {
    return (_navDecayed(_navUsage[b], now) - _navDecayed(_navUsage[a], now)) ||
      (_navDefault.indexOf(a) - _navDefault.indexOf(b));
  });
}
function _navFnName(el) {
  var m = String(el.getAttribute('onclick') || '').match(/^\s*(\w+)\s*\(/);
  return m ? m[1] : '';
}
function _navApply() {
  var order = _navOrder();
  var rank = {}; order.forEach(function (v, i) { rank[v] = i; });
  var nav = document.getElementById('nav-bar');
  if (nav) {
    Array.prototype.slice.call(nav.querySelectorAll('button[data-view]'))
      .sort(function (a, b) { return rank[a.getAttribute('data-view')] - rank[b.getAttribute('data-view')]; })
      .forEach(function (btn) { nav.appendChild(btn); });
  }
  var home = document.getElementById('home-cards');
  if (home) {
    var cards = Array.prototype.slice.call(home.querySelectorAll('.func-card'));
    var known = cards.filter(function (c) { return _navFnToView[_navFnName(c)] != null; });
    var others = cards.filter(function (c) { return _navFnToView[_navFnName(c)] == null; });   // 對不到功能的卡片維持在最後
    known.sort(function (a, b) { return rank[_navFnToView[_navFnName(a)]] - rank[_navFnToView[_navFnName(b)]]; })
      .concat(others).forEach(function (c) { home.appendChild(c); });
  }
}

// ── 初始化 ──
function _navInit() {
  var nav = document.getElementById('nav-bar');
  if (!nav || typeof showView !== 'function') return;
  Array.prototype.forEach.call(nav.querySelectorAll('button[data-view]'), function (b) {
    var v = b.getAttribute('data-view');
    _navDefault.push(v);
    var fn = _navFnName(b);
    if (fn) _navFnToView[fn] = v;
  });

  // 記錄點：包住 showView（各 openXxx 皆經由它切頁）
  var orig = showView;
  showView = function (name) {
    // 開頁自動回到上次頁面（_navRestoring）不算一次使用，避免重新整理灌高次數
    if (!_navRestoring && name && name !== 'home' && name !== _curView && _navDefault.indexOf(name) >= 0) navUsageHit(name);
    try { localStorage.setItem(LAST_VIEW_LS, name || 'home'); } catch (e) {}   // 記住目前所在頁面
    return orig.apply(this, arguments);
  };

  _navUsage = _navLocal();
  _navApply();                                     // 先用本機紀錄排（開頁當下）
  if (_navCloud()) _navLoadCloud();
}
async function _navLoadCloud() {
  if (!_navCloud()) return;
  try {
    var snap = await window.FB.getDoc(_navRef());
    var remote = (snap.exists() && snap.data().navUsage) || {};
    var merged = _navMerge(remote, _navUsage);
    var changed = JSON.stringify(merged) !== JSON.stringify(remote);
    _navUsage = merged;
    try { localStorage.setItem(NAV_LS, JSON.stringify(_navUsage)); } catch (e) {}
    // 雲端紀錄晚於開頁才到：使用者還沒切過頁（仍在首頁）才重排，否則等下次開頁，避免使用中按鈕移位
    if (!_navHitsThisSession) _navApply();
    if (changed) _navSaveCloud();                  // 本機有雲端沒有的次數 → 補寫上去
  } catch (e) {
    console.warn('[功能排序] Firestore 讀取失敗，使用本機紀錄', e && (e.code || e.message));
  }
}
window.addEventListener('owner-ready', _navLoadCloud);   // 登入晚於頁面載入完成時

// ── 開頁回到上次所在的頁面 ──
// 登入完成（owner-ready）後，若使用者還停在首頁，就呼叫該頁的 openXxx()（與點功能列相同，會照常載入資料）。
// 上次停在首頁、或頁面已不存在時維持首頁。子頁籤／排序由各頁自己的記錄還原。
var LAST_VIEW_LS = 'last_view_v1';
var _navRestoring = false, _navRestored = false;
function _navRestoreLastView() {
  if (_navRestored) return;
  _navRestored = true;
  var v = null;
  try { v = localStorage.getItem(LAST_VIEW_LS); } catch (e) {}
  if (!v || v === 'home' || _curView !== 'home') return;
  var fn = null;
  Object.keys(_navFnToView).forEach(function (f) { if (_navFnToView[f] === v) fn = f; });
  if (!fn || typeof window[fn] !== 'function') return;
  _navRestoring = true;
  try { window[fn](); } catch (e) { console.warn('[回到上次頁面]', e); }
  finally { _navRestoring = false; }
}
window.addEventListener('owner-ready', function () { setTimeout(_navRestoreLastView, 0); });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _navInit);
else _navInit();
