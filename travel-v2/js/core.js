/* travel-v2 prototype — 橫切核心：Auth（登入身分）/ Permission（權限）
 * 依第八節架構。Auth 為薄佔位（含 prototype 模擬身分切換）；Permission 為真邏輯（角色矩陣）。
 * 第二階段只需把 Auth 來源換成真實登入、加持久化，Permission 與上層 UI 不需改。
 */

// 登入身分。第二階段：Firebase Authentication（Google 登入）+ uid → account 對應。
// acct 為 null 代表「尚未登入」或「已登入但尚未綁定成員」。
const Auth = (() => {
  let acct = null;     // 目前身分對應的帳號（members.account）
  let fbUser = null;    // Firebase Auth user（{ uid, email, displayName }）或 null
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  // 依 fbUser.uid 在 MEMBERS 中找對應帳號；找不到則 acct = null（待綁定）
  function resolveAccount() {
    if (!fbUser) { acct = null; return; }
    const m = MEMBERS.find(x => x.uid === fbUser.uid);
    acct = m ? m.account : null;
  }

  // 等待 window.FB（firebase-init.js 為 deferred module，可能晚於本檔執行）
  function waitForFB(timeoutMs = 3000) {
    if (window.FB) return Promise.resolve(!!window.FB);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(!!window.FB), timeoutMs);
      window.addEventListener('fb-ready', () => { clearTimeout(timer); resolve(true); }, { once: true });
    });
  }

  // app.js 開機時呼叫一次：等待 Firebase 就緒、訂閱登入狀態，並在第一次狀態確定後 resolve ready
  async function init() {
    await waitForFB();
    if (!window.FB || !window.FB.auth) { readyResolve(); return; }
    let first = true;
    window.FB.onAuthStateChanged(window.FB.auth, (user) => {
      fbUser = user;
      resolveAccount();
      if (first) { first = false; readyResolve(); }
    });
  }

  return {
    ready,
    init,
    currentAccount() { return acct; },
    currentAlias() { return acct ? aliasOf(acct) : null; },
    currentUser() { return fbUser; },
    isSignedIn() { return !!fbUser; },
    isBound() { return !!acct; },
    isMe(account) { return account === acct; },     // 「(我)」跟隨當前登入身分
    isAdmin() { return acct ? isAdminAccount(acct) : false; }, // 當前身分是否為系統管理員
    setAccount(account) { acct = account; },         // 僅供 admin 除錯用的模擬身分切換
    // hydrate() 可能在 MEMBERS 載入雲端資料後更新 uid 對照，需重新比對一次
    refresh() { resolveAccount(); },
    // 將目前登入的 Google 帳號綁定到指定 member（寫入 uid）
    bindAccount(account) {
      if (!fbUser) return false;
      const m = MEMBERS.find(x => x.account === account);
      if (!m) return false;
      m.uid = fbUser.uid;
      acct = account;
      return true;
    },
    signIn() {
      return window.FB.signInWithPopup(window.FB.auth, new window.FB.GoogleAuthProvider());
    },
    signOut() {
      return window.FB.signOut(window.FB.auth);
    },
  };
})();

// 角色 → 可執行的 action 集合（Trip 層級）
const ROLE_PERMS = {
  owner:  ['trip.delete', 'trip.edit', 'trip.roles', 'station.edit', 'expense.edit', 'reminder.edit', 'doc.edit', 'photo.edit'],
  editor: ['trip.edit', 'station.edit', 'expense.edit', 'reminder.edit', 'doc.edit', 'photo.edit'],
  viewer: [],
};

// 某帳號在某行程的角色；有成員但未指定角色者預設 editor；非成員回 null
function roleOf(trip, account) {
  if (!trip || !trip.roles) return null;
  if (trip.roles[account]) return trip.roles[account];
  return (trip.members || []).includes(account) ? 'editor' : null;
}

// 主題（日夜模式）。屬「使用者自訂設定」，以 localStorage 記住（純前端，不接後端）。
const Theme = {
  KEY: 'tv2-theme',
  get() { try { return localStorage.getItem(this.KEY) || 'dark'; } catch (e) { return 'dark'; } },
  apply(t) { document.documentElement.classList.toggle('light', t === 'light'); },
  set(t) { try { localStorage.setItem(this.KEY, t); } catch (e) {} this.apply(t); },
  toggle() { const n = this.get() === 'dark' ? 'light' : 'dark'; this.set(n); return n; },
  isLight() { return this.get() === 'light'; },
};

// 夜間配色方案：'a'（極光青家族，預設）/ 'b'（溫潤琥珀家族）。日間配色固定（丹寧藍／薄荷綠）。
const Palette = {
  KEY: 'tv2-palette',
  get() { try { return localStorage.getItem(this.KEY) || 'a'; } catch (e) { return 'a'; } },
  apply(p) { document.documentElement.classList.toggle('palette-b', p === 'b'); },
  set(p) { try { localStorage.setItem(this.KEY, p); } catch (e) {} this.apply(p); },
};

const Permission = {
  roleOf,
  // action 例：'trip.delete' | 'trip.edit' | 'trip.roles' | 'station.edit' | 'expense.edit' | 'reminder.edit' | 'member.manage'
  can(account, action, trip) {
    if (action === 'member.manage') return true;     // 全域通訊錄 CRUD，本階段一律允許
    const role = roleOf(trip, account);
    if (!role) return false;
    return ROLE_PERMS[role].includes(action);
  },
};
