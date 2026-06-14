/* travel-v2 prototype — Repository 資料存取層（第八節 8.3）
 * 唯一知道「儲存形狀」的模組。上層（app.js）只透過 Repo.* 存取，不直接碰
 * TRIPS / EXPENSES / DOCUMENTS / REMINDERS / MEMBERS 全域物件。
 *
 * 本檔為 LocalRepo（本機假資料，同步回傳 live 物件）。
 * 第二階段可替換為 FirebaseRepo（同介面、改為非同步 + 真實持久化/同步），上層 UI 不需改。
 * 註：LocalRepo 回傳的是 live 物件參考，對聚合（trip.days/pool）的就地修改即等於已持久化；
 *     FirebaseRepo 屆時需在這些異動點補上明確的 save/update 呼叫。
 */

const Repo = (() => {
  /* ---- 行程 ---- */
  function trips() { return TRIPS; }
  function getTrip(id) { return TRIPS.find(t => t.id === id); }
  function addTrip(trip) {
    TRIPS.push(trip);
    const dc = Math.max(1, tripDayCount(trip));
    EXPENSES[trip.id] = {};
    for (let d = 1; d <= dc; d++) EXPENSES[trip.id][d] = [];
    DOCUMENTS[trip.id] = [];
    REMINDERS[trip.id] = [];
  }
  function deleteTrip(id) {
    const i = TRIPS.findIndex(t => t.id === id);
    if (i >= 0) TRIPS.splice(i, 1);
    delete EXPENSES[id]; delete DOCUMENTS[id]; delete REMINDERS[id];
  }
  // 行程日期變更後，調整 days / 費用 天數：保留可沿用的天，超出天數的站點退回規劃區
  function syncDays(trip) {
    const dc = Math.max(1, tripDayCount(trip));
    Object.keys(trip.days).map(Number).forEach(d => {
      if (d > dc) { (trip.days[d] || []).forEach(s => trip.pool.push(s)); delete trip.days[d]; }
    });
    for (let d = 1; d <= dc; d++) if (!trip.days[d]) trip.days[d] = [];
    if (!EXPENSES[trip.id]) EXPENSES[trip.id] = {};
    Object.keys(EXPENSES[trip.id]).map(Number).forEach(d => { if (d > dc) delete EXPENSES[trip.id][d]; });
    for (let d = 1; d <= dc; d++) if (!EXPENSES[trip.id][d]) EXPENSES[trip.id][d] = [];
  }

  /* ---- 成員（通訊錄） ---- */
  function members() { return MEMBERS; }
  function addMember(m) { MEMBERS.push(m); }
  function deleteMember(account) {
    const i = MEMBERS.findIndex(x => x.account === account);
    if (i >= 0) MEMBERS.splice(i, 1);
  }

  /* ---- 費用 ---- */
  function expenses(tripId, day) { return (EXPENSES[tripId] && EXPENSES[tripId][day]) || []; }
  function addExpense(tripId, day, e) {
    if (!EXPENSES[tripId]) EXPENSES[tripId] = {};
    if (!EXPENSES[tripId][day]) EXPENSES[tripId][day] = [];
    EXPENSES[tripId][day].push(e);
  }
  // 跨日彙整（結算頁用）：回傳 live 物件參考並附上 _day（'all' 或數字），可直接修改 .settled
  function allExpenses(tripId) {
    const byDay = EXPENSES[tripId] || {};
    const out = [];
    Object.keys(byDay).forEach(d => {
      (byDay[d] || []).forEach(e => { e._day = (d === 'all') ? 'all' : Number(d); out.push(e); });
    });
    return out;
  }

  /* ---- 文件 ---- */
  function documents(tripId) { return DOCUMENTS[tripId] || []; }
  function addDocument(tripId, d) { (DOCUMENTS[tripId] = DOCUMENTS[tripId] || []).push(d); }
  function deleteDocument(tripId, id) {
    const arr = DOCUMENTS[tripId] || [];
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) arr.splice(i, 1);
  }

  /* ---- 照片 ---- */
  function photos(tripId) { return PHOTOS[tripId] || []; }
  function addPhoto(tripId, p) { (PHOTOS[tripId] = PHOTOS[tripId] || []).push(p); }

  /* ---- 提醒 ---- */
  function reminders(tripId) { return REMINDERS[tripId] || []; }
  function pendingCount(tripId) { return (REMINDERS[tripId] || []).filter(r => !r.done).length; } // 待辦數
  function addReminder(tripId, r) { (REMINDERS[tripId] = REMINDERS[tripId] || []).push(r); }
  function deleteReminder(tripId, id) {
    const arr = REMINDERS[tripId] || [];
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) arr.splice(i, 1);
  }

  /* ---- 班表庫（全域，覆蓋式） ---- */
  function timetableEntries() { return MOCK_TIMETABLE_LIB; }
  // 匯入：同 key（line+train+from+to+fromTime）已存在則覆蓋，否則新增。回傳新增/覆蓋筆數。
  function importTimetableEntries(entries) {
    let added = 0, updated = 0;
    entries.forEach(e => {
      const key = timetableKey(e);
      const i = MOCK_TIMETABLE_LIB.findIndex(x => timetableKey(x) === key);
      if (i >= 0) { MOCK_TIMETABLE_LIB[i] = e; updated++; }
      else { MOCK_TIMETABLE_LIB.push(e); added++; }
    });
    return { added, updated };
  }
  function deleteTimetableEntry(id) {
    const i = MOCK_TIMETABLE_LIB.findIndex(x => x.id === id);
    if (i >= 0) MOCK_TIMETABLE_LIB.splice(i, 1);
  }

  /* ---- 站點別名對照表（全域，可手動 CRUD） ---- */
  function stationAliases() { return MOCK_STATION_ALIAS; }
  function addStationAlias(a) { MOCK_STATION_ALIAS.push(a); }
  function deleteStationAlias(canonical) {
    const i = MOCK_STATION_ALIAS.findIndex(x => x.canonical === canonical);
    if (i >= 0) MOCK_STATION_ALIAS.splice(i, 1);
  }

  return {
    trips, getTrip, addTrip, deleteTrip, syncDays,
    members, addMember, deleteMember,
    expenses, addExpense, allExpenses, photos, addPhoto,
    documents, addDocument, deleteDocument,
    reminders, pendingCount, addReminder, deleteReminder,
    timetableEntries, importTimetableEntries, deleteTimetableEntry,
    stationAliases, addStationAlias, deleteStationAlias,
  };
})();
