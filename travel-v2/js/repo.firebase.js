/* travel-v2 第二階段 — RepoFirebase（Firestore 實作）
 * 對應 _docs/travel-v2/db-schema.md（Travel_ 前綴 collections）。
 * 與 js/repo.js 的 LocalRepo 同介面（函式簽名相同），差異：所有方法回傳 Promise。
 *
 * 使用方式：
 *   import 'firebase-init.js'（已在 index.html 載入，暴露 window.FB）
 *   RepoFirebase.init(window.FB.db)
 *   const trip = await RepoFirebase.getTrip('t-jp')
 *
 * 本檔尚未串接到 app.js（app.js 仍用同步的 LocalRepo）。
 */

const RepoFirebase = (() => {
  let db = null;
  let F = null; // { collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc, query, where }

  function init(firestoreInstance, firestoreFns) {
    db = firestoreInstance;
    F = firestoreFns || window.FB;
  }

  const tripsCol = () => F.collection(db, 'Travel_trips');
  const tripDoc = (id) => F.doc(db, 'Travel_trips', id);
  const subCol = (tripId, name) => F.collection(db, 'Travel_trips', tripId, name);
  const subDoc = (tripId, name, id) => F.doc(db, 'Travel_trips', tripId, name, id);
  const membersCol = () => F.collection(db, 'members');
  const memberDoc = (account) => F.doc(db, 'members', account);

  /* ---- 行程 Travel_trips/{tripId} ---- */
  async function trips() {
    const snap = await F.getDocs(tripsCol());
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async function getTrip(id) {
    const snap = await F.getDoc(tripDoc(id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }

  async function addTrip(trip) {
    const { id, ...data } = trip;
    await F.setDoc(tripDoc(id), data);
  }

  async function deleteTrip(id) {
    // 注意：僅刪除 trip 主文件。子 collection（expenses/documents/photos/reminders）
    // 需另外批次刪除（建議改用 Cloud Function 遞迴刪除，避免前端漏刪／逐筆刪除過慢）。
    for (const name of ['expenses', 'documents', 'photos', 'reminders']) {
      const snap = await F.getDocs(subCol(id, name));
      for (const d of snap.docs) await F.deleteDoc(d.ref);
    }
    await F.deleteDoc(tripDoc(id));
  }

  // 行程日期變更後調整 days/pool（整欄位覆寫）
  async function syncDays(trip) {
    await F.updateDoc(tripDoc(trip.id), { days: trip.days, pool: trip.pool });
  }

  /* ---- 成員（全域通訊錄）members/{account} ---- */
  async function members() {
    const snap = await F.getDocs(membersCol());
    return snap.docs.map(d => ({ account: d.id, ...d.data() }));
  }

  async function addMember(m) {
    const { account, ...data } = m;
    await F.setDoc(memberDoc(account), data);
  }

  async function deleteMember(account) {
    await F.deleteDoc(memberDoc(account));
  }

  // 帳號改名：搬移 members 文件，並改寫所有行程/費用/提醒中對該帳號的引用
  async function renameMemberAccount(oldAccount, newAccount, memberObj) {
    const { account, ...data } = memberObj;
    await F.setDoc(memberDoc(newAccount), data);
    await F.deleteDoc(memberDoc(oldAccount));

    const allTrips = await trips();
    for (const t of allTrips) {
      let members = t.members || [];
      let roles = t.roles || {};
      let tripChanged = false;
      if (members.includes(oldAccount)) {
        members = members.map(a => a === oldAccount ? newAccount : a);
        tripChanged = true;
      }
      if (oldAccount in roles) {
        roles = { ...roles, [newAccount]: roles[oldAccount] };
        delete roles[oldAccount];
        tripChanged = true;
      }
      if (tripChanged) await F.updateDoc(tripDoc(t.id), { members, roles });

      const expSnap = await F.getDocs(subCol(t.id, 'expenses'));
      for (const d of expSnap.docs) {
        const e = d.data();
        const upd = {};
        if (e.payer === oldAccount) upd.payer = newAccount;
        if (Array.isArray(e.split) && e.split.includes(oldAccount)) {
          upd.split = e.split.map(a => a === oldAccount ? newAccount : a);
        }
        if (Array.isArray(e.items)) {
          let itemsChanged = false;
          const items = e.items.map(i => {
            if (Array.isArray(i.split) && i.split.includes(oldAccount)) {
              itemsChanged = true;
              return { ...i, split: i.split.map(a => a === oldAccount ? newAccount : a) };
            }
            return i;
          });
          if (itemsChanged) upd.items = items;
        }
        if (Object.keys(upd).length) await F.updateDoc(d.ref, upd);
      }

      const remSnap = await F.getDocs(subCol(t.id, 'reminders'));
      for (const d of remSnap.docs) {
        const r = d.data();
        if (r.owner === oldAccount) await F.updateDoc(d.ref, { owner: newAccount });
      }
    }
  }

  /* ---- 費用 Travel_trips/{tripId}/expenses/{expenseId} ---- */
  async function expenses(tripId, day) {
    const snap = await F.getDocs(subCol(tripId, 'expenses'));
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => e.day === day);
  }

  async function addExpense(tripId, day, e) {
    const ref = await F.addDoc(subCol(tripId, 'expenses'), { ...e, day });
    return ref;
  }

  // 跨日彙整（結算頁用）：回傳含 _day 欄位的物件陣列
  async function allExpenses(tripId) {
    const snap = await F.getDocs(subCol(tripId, 'expenses'));
    return snap.docs.map(d => {
      const data = d.data();
      return { id: d.id, ...data, _day: data.day };
    });
  }

  /* ---- 文件 Travel_trips/{tripId}/documents/{docId} ---- */
  async function documents(tripId) {
    const snap = await F.getDocs(subCol(tripId, 'documents'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function addDocument(tripId, d) {
    await F.addDoc(subCol(tripId, 'documents'), d);
  }
  async function deleteDocument(tripId, id) {
    await F.deleteDoc(subDoc(tripId, 'documents', id));
  }

  /* ---- 照片 Travel_trips/{tripId}/photos/{photoId} ---- */
  async function photos(tripId) {
    const snap = await F.getDocs(subCol(tripId, 'photos'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function addPhoto(tripId, p) {
    // 第二階段：先上傳至 Storage 取得 URL，再寫入 photos 文件
    await F.addDoc(subCol(tripId, 'photos'), p);
  }

  /* ---- 提醒 Travel_trips/{tripId}/reminders/{reminderId} ---- */
  async function reminders(tripId) {
    const snap = await F.getDocs(subCol(tripId, 'reminders'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function pendingCount(tripId) {
    const all = await reminders(tripId);
    return all.filter(r => !r.done).length;
  }
  async function addReminder(tripId, r) {
    const ref = await F.addDoc(subCol(tripId, 'reminders'), r);
    return ref;
  }
  async function deleteReminder(tripId, id) {
    await F.deleteDoc(subDoc(tripId, 'reminders', id));
  }

  /* ---- 班表庫（全域）Travel_timetableLib/{entryId} ---- */
  const timetableCol = () => F.collection(db, 'Travel_timetableLib');

  async function timetableEntries() {
    const snap = await F.getDocs(timetableCol());
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function importTimetableEntries(entries) {
    // 同 key（line+train+from+to+fromTime）已存在則覆蓋，否則新增
    const existing = await timetableEntries();
    let added = 0, updated = 0;
    for (const e of entries) {
      const key = timetableKey(e);
      const match = existing.find(x => timetableKey(x) === key);
      if (match) {
        await F.setDoc(F.doc(db, 'Travel_timetableLib', match.id), e);
        updated++;
      } else {
        await F.addDoc(timetableCol(), e);
        added++;
      }
    }
    return { added, updated };
  }
  async function deleteTimetableEntry(id) {
    await F.deleteDoc(F.doc(db, 'Travel_timetableLib', id));
  }

  /* ---- 站點別名對照表（全域）Travel_stationAliases/{canonical} ---- */
  const aliasCol = () => F.collection(db, 'Travel_stationAliases');

  async function stationAliases() {
    const snap = await F.getDocs(aliasCol());
    return snap.docs.map(d => ({ canonical: d.id, ...d.data() }));
  }
  async function addStationAlias(a) {
    const { canonical, ...data } = a;
    await F.setDoc(F.doc(db, 'Travel_stationAliases', canonical), data);
  }
  async function deleteStationAlias(canonical) {
    await F.deleteDoc(F.doc(db, 'Travel_stationAliases', canonical));
  }

  return {
    init,
    trips, getTrip, addTrip, deleteTrip, syncDays,
    members, addMember, deleteMember, renameMemberAccount,
    expenses, addExpense, allExpenses, photos, addPhoto,
    documents, addDocument, deleteDocument,
    reminders, pendingCount, addReminder, deleteReminder,
    timetableEntries, importTimetableEntries, deleteTimetableEntry,
    stationAliases, addStationAlias, deleteStationAlias,
  };
})();
