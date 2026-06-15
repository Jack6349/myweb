/* travel-v2 第二階段 — 小範圍試點：開機時從 Firestore 讀取資料，
 * 覆寫 data.js 的全域假資料（TRIPS / MEMBERS / EXPENSES / DOCUMENTS / PHOTOS / REMINDERS）。
 *
 * 設計：只在「開機載入」這一個時間點接 Firestore（async），
 * 之後 app.js 仍透過 LocalRepo（js/repo.js）同步存取——
 * 上層 View / Repo 介面完全不變，是最小風險的試點。
 *
 * 第二階段全面改寫時，才會把 Repo.* 逐一換成 RepoFirebase（async + await）。
 * 失敗時（離線/規則/專案未設定）保留 data.js 原本的假資料，不中斷 prototype。
 */

const FirebaseSync = (() => {
  let cloudEnabled = false; // hydrate() 成功後才視為已連線，避免離線/未設定時寫入卡住

  // firebase-init.js 是 module script（deferred 執行），可能晚於呼叫 hydrate() 的
  // 一般 <script>。若 window.FB 尚未就位，等待其 'fb-ready' 事件（含逾時保護）。
  function waitForFB(timeoutMs = 3000) {
    if (window.FB) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(!!window.FB), timeoutMs);
      window.addEventListener('fb-ready', () => { clearTimeout(timer); resolve(true); }, { once: true });
    });
  }

  async function hydrate() {
    await waitForFB();
    if (!window.FB || typeof RepoFirebase === 'undefined') return false;
    RepoFirebase.init(window.FB.db);

    const [trips, members] = await Promise.all([
      RepoFirebase.trips(),
      RepoFirebase.members(),
    ]);
    if (!trips.length) return false; // 雲端無資料則保留本機假資料

    // 逐行程載入子集合
    for (const t of trips) {
      const [expAll, docs, pics, rems] = await Promise.all([
        RepoFirebase.allExpenses(t.id),
        RepoFirebase.documents(t.id),
        RepoFirebase.photos(t.id),
        RepoFirebase.reminders(t.id),
      ]);

      // EXPENSES[tripId] = { all: [...], 1: [...], 2: [...], ... }
      const exp = {};
      const dc = tripDayCount(t);
      for (let d = 1; d <= dc; d++) exp[d] = [];
      exp.all = [];
      expAll.forEach(e => {
        const { _day, ...rest } = e;
        (exp[_day] || (exp[_day] = [])).push(rest);
      });
      EXPENSES[t.id] = exp;
      DOCUMENTS[t.id] = docs;
      PHOTOS[t.id] = pics;
      REMINDERS[t.id] = rems;
    }

    // 覆寫全域陣列內容（保持同一個 const 參考，其他模組已綁定此參考）
    TRIPS.length = 0;
    trips.forEach(t => TRIPS.push(t));
    MEMBERS.length = 0;
    members.forEach(m => MEMBERS.push(m));

    cloudEnabled = true;
    return true;
  }

  /* ---- 寫入操作：與 LocalRepo 寫入並行，失敗只記警告不影響本機操作 ----
   * 範圍：本階段僅「新增費用」「新增/刪除提醒」試點接上 Firestore；
   * 其餘寫入（行程/文件/照片/成員...）仍只寫本機，待下一階段擴大。
   */
  function addExpense(tripId, day, data) {
    if (!cloudEnabled) return;
    RepoFirebase.addExpense(tripId, day, data)
      .catch(e => console.warn('[FirebaseSync] addExpense failed', e));
  }

  // localObj：LocalRepo 已寫入的提醒物件（live 參考）。寫入成功後把其 id
  // 換成 Firestore 文件 ID，後續刪除才能對應到雲端文件。
  function addReminder(tripId, data, localObj) {
    if (!cloudEnabled) return;
    RepoFirebase.addReminder(tripId, data)
      .then(ref => { if (localObj) localObj.id = ref.id; })
      .catch(e => console.warn('[FirebaseSync] addReminder failed', e));
  }

  function addMember(m) {
    if (!cloudEnabled) return;
    RepoFirebase.addMember(m)
      .catch(e => console.warn('[FirebaseSync] addMember failed', e));
  }

  // 改別名沿用 addMember（setDoc 覆寫整份文件）
  function updateMember(m) {
    if (!cloudEnabled) return;
    RepoFirebase.addMember(m)
      .catch(e => console.warn('[FirebaseSync] updateMember failed', e));
  }

  function deleteMember(account) {
    if (!cloudEnabled) return;
    RepoFirebase.deleteMember(account)
      .catch(e => console.warn('[FirebaseSync] deleteMember failed', e));
  }

  function bindMemberUid(account, uid) {
    if (!cloudEnabled) return;
    RepoFirebase.setMemberUid(account, uid)
      .catch(e => console.warn('[FirebaseSync] bindMemberUid failed', e));
  }

  function renameMemberAccount(oldAccount, newAccount, memberObj) {
    if (!cloudEnabled) return;
    RepoFirebase.renameMemberAccount(oldAccount, newAccount, memberObj)
      .catch(e => console.warn('[FirebaseSync] renameMemberAccount failed', e));
  }

  function deleteReminder(tripId, id) {
    if (!cloudEnabled) return;
    // id 須為 Firestore 文件 ID（hydrate 載入的提醒、或 addReminder 已回填者皆符合）
    if (!id || id.startsWith('r-')) return; // 尚未取得雲端 ID，跳過（極少數時間差情況）
    RepoFirebase.deleteReminder(tripId, id)
      .catch(e => console.warn('[FirebaseSync] deleteReminder failed', e));
  }

  return { hydrate, addExpense, addReminder, deleteReminder, addMember, updateMember, deleteMember, renameMemberAccount, bindMemberUid };
})();
