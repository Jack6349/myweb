// 股利總管 — 持股雲端同步：Firestore（Phase 2）
// 取代 sync.github.js（GitHub 直存）。資料存於 users/{uid}，僅本人可讀寫。
// 為了不更動 core.js 的 savePortfolio，沿用相同的函式/變數名稱：
//   showDivSyncStatus / divGhWrite / DIV_SYNC_TS_KEY / _divSyncTimer
//
// 需在 Firebase Console 部署安全規則：
//   match /databases/{db}/documents {
//     match /stock_portfolio/{userId} {
//       allow read, write: if request.auth != null && request.auth.uid == userId;
//     }
//   }

var DIV_SYNC_TS_KEY = 'div_sync_ts';
var _divSyncTimer = null; // core.js savePortfolio 的 debounce 計時器（此處宣告供其讀取）

// 一次性遷移來源：舊版 GitHub 持股資料（公開 repo，raw 端點支援 CORS）
var DIV_MIGRATION_URL = 'https://raw.githubusercontent.com/Jack6349/myweb/main/dividend/data.json';

function showDivSyncStatus(msg, color) {
  var el = document.getElementById('div-sync-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--text3)';
}

function fbUserDocRef() {
  if (!window.FB || !window.FB.db || !window.OWNER_UID) return null;
  return window.FB.doc(window.FB.db, 'stock_portfolio', window.OWNER_UID);
}

// 讀 Firestore：回傳 { portfolio, totalCost, updatedAt } 或 null
async function repoRead() {
  var ref = fbUserDocRef();
  if (!ref) return null;
  try {
    var snap = await window.FB.getDoc(ref);
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.warn('[repoRead]', e);
    return null;
  }
}

// 寫 Firestore（保留 divGhWrite 名稱，core.js savePortfolio 直接呼叫，不需改）
async function divGhWrite(data) {
  var ref = fbUserDocRef();
  if (!ref) return; // 未以本人身分登入 → 不寫雲端
  try {
    var ts = new Date().toISOString();
    var cost = parseInt(localStorage.getItem('stock_total_cost') || '0') || 0;
    await window.FB.setDoc(ref, { portfolio: data, totalCost: cost, updatedAt: ts });
    localStorage.setItem(DIV_SYNC_TS_KEY, ts);
    showDivSyncStatus('已同步', 'var(--success)');
    setTimeout(function () { showDivSyncStatus('', ''); }, 2000);
  } catch (e) {
    console.warn('[divGhWrite]', e);
    showDivSyncStatus('同步失敗', '#ff6b6b');
    setTimeout(function () { showDivSyncStatus('', ''); }, 3000);
  }
}

// 把雲端資料套用到本機狀態（較新或本機為空時才覆蓋）
function applyRemote(remote) {
  var remoteTs = remote.updatedAt || '';
  var localTs = localStorage.getItem(DIV_SYNC_TS_KEY) || '';
  if (!localTs || remoteTs > localTs || (typeof portfolio !== 'undefined' && portfolio.length === 0)) {
    portfolio = remote.portfolio || [];
    localStorage.setItem(DB_KEY, JSON.stringify(portfolio));
    if (typeof remote.totalCost === 'number') {
      localStorage.setItem('stock_total_cost', String(remote.totalCost));
    }
    localStorage.setItem(DIV_SYNC_TS_KEY, remoteTs);
    if (typeof renderPortfolio === 'function') renderPortfolio();
    if (typeof refreshHome === 'function') refreshHome();
  }
}

// 開機：本人登入後從 Firestore 取回；雲端尚無資料時，從舊 GitHub data.json 一次性遷移
async function bootFromFirestore() {
  showDivSyncStatus('同步中…', '#f0cc7a');
  var remote = await repoRead();
  if (remote && remote.portfolio) {
    applyRemote(remote);
    showDivSyncStatus('已同步', 'var(--success)');
    setTimeout(function () { showDivSyncStatus('', ''); }, 2000);
    return;
  }
  // 雲端無資料 → 嘗試從舊版 GitHub 持股資料遷移
  try {
    var res = await fetch(DIV_MIGRATION_URL, { cache: 'no-store' });
    if (res.ok) {
      var json = await res.json();
      var pf = Array.isArray(json) ? json : (json.portfolio || []);
      if (Array.isArray(pf) && pf.length) {
        portfolio = pf;
        localStorage.setItem(DB_KEY, JSON.stringify(portfolio));
        if (typeof renderPortfolio === 'function') renderPortfolio();
        if (typeof refreshHome === 'function') refreshHome();
        await divGhWrite(portfolio); // 種子寫入 Firestore
        showDivSyncStatus('已從舊資料匯入', 'var(--success)');
        setTimeout(function () { showDivSyncStatus('', ''); }, 2500);
        return;
      }
    }
  } catch (e) {
    console.warn('[migration]', e);
  }
  showDivSyncStatus('', '');
}

// 本人登入後啟動開機載入（auth.js 於本人登入時 dispatch 'owner-ready'）
if (window.OWNER_UID) {
  bootFromFirestore();
} else {
  window.addEventListener('owner-ready', function () { bootFromFirestore(); });
}
