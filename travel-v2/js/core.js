/* travel-v2 prototype — 橫切核心：Auth（登入身分）/ Permission（權限）
 * 依第八節架構。Auth 為薄佔位（含 prototype 模擬身分切換）；Permission 為真邏輯（角色矩陣）。
 * 第二階段只需把 Auth 來源換成真實登入、加持久化，Permission 與上層 UI 不需改。
 */

// 登入身分。預設 CURRENT_ACCOUNT；prototype 提供模擬切換以驗證權限。第二階段由 Firebase Auth 取代。
const Auth = (() => {
  let acct = CURRENT_ACCOUNT;
  return {
    currentAccount() { return acct; },
    currentAlias() { return aliasOf(acct); },
    isMe(account) { return account === acct; },     // 「(我)」跟隨當前（模擬）身分
    isAdmin() { return isAdminAccount(acct); },      // 當前身分是否為系統管理員
    setAccount(account) { acct = account; },         // prototype 模擬身分切換（第二階段移除）
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
