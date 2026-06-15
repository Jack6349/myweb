/* travel-v2 prototype — 主程式：各頁渲染與互動
 * 不接後端、不接真實資料；登入身分由 Auth 提供（本階段固定帳號 jack）。
 * 成員引用一律以「帳號」為鍵，別名僅渲染時以 aliasOf() 查表（改別名全站含歷史同步）。
 */

const App = (() => {
  // 今天（prototype 固定基準，方便驗證 P0 判定與 P3 當日高亮）
  const TODAY = '2026-06-07';
  const ALL_DAY = 'all';   // 費用「全程／未歸日」分頁的特殊 key

  const state = {
    currentTripId: null,   // 當前工作行程（具黏性）
    expenseDay: null,      // P3 目前選中的 Day（數字，或 ALL_DAY）
    reminderMode: 'date',  // P6 提醒檢視：'date' | 'category'
    docMode: 'date',       // P5 文件檢視：'date' | 'category'
    timetableMode: 'entries', // 班表庫檢視：'entries' | 'alias'
    settleTab: 'total',      // 結算頁目前分頁
    settleMember: null,     // 結算頁目前選定成員
    settleSelected: new Set(), // 結算頁勾選中的費用 id
    settleAssignTargets: new Set(), // 結算頁指定的分攤對象（帳號）
    settleRates: { JPY: 0.2, USD: 31, KRW: 0.023 }, // 結算頁匯率（1 該幣別 = N TWD），可調整
  };

  /* ---------- 工具 ---------- */
  const $ = (id) => document.getElementById(id);
  const trip = (id) => Repo.getTrip(id);

  function tripStatus(t) {
    if (TODAY >= t.start && TODAY <= t.end) return 'live';   // 進行中
    if (TODAY < t.start) return 'plan';                       // 規劃中
    return 'done';                                            // 已結束
  }
  const STATUS_LABEL = { live: '進行中', plan: '規劃中', done: '已結束' };

  // P0 當前工作行程判定：① 進行中 → ② 規劃中(最近) → ③ 已結束(由近到遠)
  // 手動選定具黏性：state.currentTripId 一旦設定即沿用。
  function resolveCurrentTrip() {
    if (state.currentTripId && trip(state.currentTripId)) return state.currentTripId;
    const all = Repo.trips();
    if (all.length === 0) return null;
    const live = all.filter(t => tripStatus(t) === 'live');
    if (live.length) return live[0].id;
    const plan = all.filter(t => tripStatus(t) === 'plan').sort((a, b) => a.start.localeCompare(b.start));
    if (plan.length) return plan[0].id;
    const done = all.filter(t => tripStatus(t) === 'done').sort((a, b) => b.start.localeCompare(a.start));
    return done.length ? done[0].id : null;
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.hidden = true, 1800);
  }

  /* ---------- 頂列 ---------- */
  const VIEW_META = {
    'view-home':      { title: '旅程', home: true },
    'view-trips':     { title: '選定行程' },
    'view-newtrip':   { title: '新增行程' },
    'view-editor':    { title: '編修行程' },
    'view-expense':   { title: '費用' },
    'view-settlement': { title: '結算' },
    'view-photo':     { title: '照片紀錄' },
    'view-docs':      { title: '文件' },
    'view-reminders': { title: '提醒' },
    'view-timetable': { title: '班表庫' },
    'view-members':   { title: '成員管理' },
    'view-settings':  { title: '使用者設定' },
    'view-admin':     { title: '系統管理設定' },
  };
  function setTopbar(viewId) {
    const meta = VIEW_META[viewId] || { title: '' };
    $('topbarTitle').textContent = meta.title;
    $('topbar').classList.toggle('is-home', !!meta.home);
    // ⚙ 管理者設定：僅首頁且當前身分為管理員時顯示
    $('btnSettings').hidden = !(meta.home && Auth.isAdmin());
  }

  /* ---------- P0 首頁 ---------- */
  const HOME_CARDS = [
    { key: 'expense',  name: '費用',     icon: '💴', view: 'view-expense',   hot: true,  needTrip: true },
    { key: 'photo',    name: '照片',     icon: '📷', view: 'view-photo',     hot: true,  needTrip: true },
    { key: 'docs',     name: '文件',     icon: '📄', view: 'view-docs',                  needTrip: true },
    { key: 'select',   name: '選定行程', icon: '🧭', view: 'view-trips',                 needTrip: false },
    { key: 'edit',     name: '編修行程', icon: '🗂️', view: 'view-editor',                needTrip: true },
    { key: 'timetable', name: '班表庫', icon: '🚆', view: 'view-timetable',              needTrip: false },
    { key: 'reminder', name: '提醒',     icon: '🔔', view: 'view-reminders',             needTrip: true },
    { key: 'settings', name: '使用者設定', icon: '👤', view: 'view-settings',            needTrip: false },
    { key: 'settlement', name: '結算',  icon: '🧮', view: 'view-settlement',            needTrip: true },
  ];

  function renderHome() {
    $('meBadge').textContent = Auth.currentAlias();
    const curId = resolveCurrentTrip();
    const hasTrip = !!curId;

    $('homeEmpty').hidden = hasTrip;
    $('tripSwitcher').hidden = !hasTrip;
    $('homeCards').hidden = !hasTrip;
    document.querySelector('.cards-custom-hint')?.remove();

    // 行程切換條：以 < > 按鈕切換（手機/PC 通用），一次只顯示當前一張
    const sw = $('tripSwitcher');
    if (hasTrip) {
      const order = Repo.trips().map(t => t.id);    // 固定顯示順序
      const idx = order.indexOf(curId);            // 當前位置
      const hasPrev = idx > 0;
      const hasNext = idx < order.length - 1;
      const t = trip(curId); const st = tripStatus(t);
      sw.innerHTML = `
        <div class="swipe-hint">切換當前工作行程（${idx + 1} / ${order.length}・內容不可點擊）</div>
        <div class="trip-nav">
          <button class="trip-nav__btn" id="tripPrev" aria-label="上一個行程" ${hasPrev ? '' : 'disabled'}>‹</button>
          <div class="trip-chip is-current">
            <div class="trip-chip__label">當前工作行程</div>
            <div class="trip-chip__name">${t.name}</div>
            <div class="trip-chip__meta">${t.start} ～ ${t.end}・${t.members.length} 人・${t.currency}</div>
            <span class="trip-chip__status status-${st}">${STATUS_LABEL[st]}</span>
          </div>
          <button class="trip-nav__btn" id="tripNext" aria-label="下一個行程" ${hasNext ? '' : 'disabled'}>›</button>
        </div>`;
      const go = (delta) => {
        const ni = idx + delta;
        if (ni < 0 || ni >= order.length) return;
        state.currentTripId = order[ni];   // 切換即設為當前（黏性）
        renderHome();
      };
      if (hasPrev) $('tripPrev').addEventListener('click', () => go(-1));
      if (hasNext) $('tripNext').addEventListener('click', () => go(1));
    }

    // 功能卡
    const wrap = $('homeCards');
    wrap.innerHTML = '';
    HOME_CARDS.forEach(c => {
      const el = document.createElement('div');
      el.className = 'fcard' + (c.hot ? ' fcard--hot' : '');
      let badge = '';
      if (c.key === 'reminder' && hasTrip) {
        const n = Repo.pendingCount(curId);   // 待辦數
        if (n) badge = `<span class="fcard__badge">${n}</span>`;
      }
      el.innerHTML = `${badge}<div class="fcard__icon">${c.icon}</div><div class="fcard__name">${c.name}</div>`;
      el.addEventListener('click', () => onCardClick(c));
      wrap.appendChild(el);
    });
    const hint = document.createElement('p');
    hint.className = 'cards-custom-hint';
    hint.textContent = '卡片順序可自訂（本階段未開放）';
    wrap.after(hint);
  }

  function onCardClick(c) {
    const curId = resolveCurrentTrip();
    if (c.needTrip && !curId) { toast('請先建立行程'); return; }
    // 權限檢查：編修行程需 trip.edit
    const me = Auth.currentAccount();
    if (c.view === 'view-editor' && !Permission.can(me, 'trip.edit', trip(curId))) {
      toast('你的角色無編修權限（唯讀）'); return;
    }
    if (c.view === 'view-expense') state.expenseDay = null;
    if (c.view === 'view-settlement') { state.settleMember = null; state.settleSelected.clear(); state.settleAssignTargets.clear(); }
    Router.show(c.view);
  }

  /* ---------- P1 行程清單 ---------- */
  function renderTrips() {
    const curId = resolveCurrentTrip();
    const wrap = $('tripList'); wrap.innerHTML = '';
    const all = Repo.trips();
    if (all.length === 0) {
      wrap.innerHTML = `<p class="day-hint">尚無行程，點下方新增。</p>`;
    }
    all.forEach(t => {
      const st = tripStatus(t);
      const item = document.createElement('div');
      item.className = 'list-item' + (t.id === curId ? ' is-current' : '');
      item.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${t.name}</div>
          <div class="list-item__sub">${t.start} ～ ${t.end}・${STATUS_LABEL[st]}・${t.members.length} 人・我的角色：${Permission.roleOf(t, Auth.currentAccount()) || '非成員'}</div>
        </div>
        <button class="btn btn--mini" data-act="edit" aria-label="編輯行程">✎</button>
        <button class="btn btn--mini list-item__action" data-act="select">${t.id === curId ? '當前' : '選定'}</button>`;
      item.querySelector('[data-act="select"]').addEventListener('click', () => {
        state.currentTripId = t.id;       // 手動選定 → 黏性
        toast(`已設為當前工作行程：${t.name}`);
        Router.reset('view-home');
      });
      item.querySelector('[data-act="edit"]').addEventListener('click', () => {
        if (!Permission.can(Auth.currentAccount(), 'trip.edit', t)) { toast('你的角色無編輯權限'); return; }
        state.editingTripId = t.id;
        Router.show('view-newtrip');
      });
      wrap.appendChild(item);
    });
  }

  /* ---------- PN 新增 / 編輯行程 ---------- */
  function renderNewTrip() {
    const editing = state.editingTripId ? trip(state.editingTripId) : null;
    const f = $('newTripForm');
    f.reset();

    const cur = $('newTripCurrency'); cur.innerHTML = '';
    CURRENCIES.forEach(c => cur.appendChild(new Option(c, c)));

    // 角色設定權限：新行程的建立者即 Owner（可設）；編輯時需 trip.roles 權限
    const canSetRoles = editing ? Permission.can(Auth.currentAccount(), 'trip.roles', editing) : true;
    const rolesSrc = editing ? (editing.roles || {}) : { [Auth.currentAccount()]: 'owner' };
    const ROLE_OPTS = [['owner', 'Owner'], ['editor', 'Editor'], ['viewer', 'Viewer']];

    const mWrap = $('newTripMembers'); mWrap.innerHTML = '';
    const checkedMembers = editing ? editing.members : [Auth.currentAccount()];
    Repo.members().forEach(m => {
      const checked = checkedMembers.includes(m.account);
      const role = rolesSrc[m.account] || (m.account === Auth.currentAccount() ? 'owner' : 'editor');
      const row = document.createElement('div'); row.className = 'member-row';
      row.innerHTML = `
        <label class="chk"><input type="checkbox" value="${m.account}" ${checked ? 'checked' : ''}> ${m.alias}${Auth.isMe(m.account) ? '（我）' : ''}</label>
        <select class="role-sel" data-acc="${m.account}" ${(!checked || !canSetRoles) ? 'disabled' : ''}>
          ${ROLE_OPTS.map(([v, t]) => `<option value="${v}" ${v === role ? 'selected' : ''}>${t}</option>`).join('')}
        </select>`;
      // 勾選連動角色下拉的可用狀態
      const cb = row.querySelector('input');
      const sel = row.querySelector('.role-sel');
      cb.addEventListener('change', () => { sel.disabled = !cb.checked || !canSetRoles; });
      mWrap.appendChild(row);
    });

    // 依模式調整標題、欄位、按鈕
    $('topbarTitle').textContent = editing ? '編輯行程' : '新增行程';
    $('newTripSubmit').textContent = editing ? '儲存變更' : '完成，設為當前工作行程';
    // 刪除行程：僅有 trip.delete 權限（Owner）才顯示
    $('newTripDelete').hidden = !editing || !Permission.can(Auth.currentAccount(), 'trip.delete', editing);
    if (editing) {
      f.name.value = editing.name;
      f.start.value = editing.start;
      f.end.value = editing.end;
      f.currency.value = editing.currency;
    }
  }

  function bindNewTripForm() {
    $('newTripForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const name = f.name.value.trim();
      const start = f.start.value, end = f.end.value;
      const members = [...$('newTripMembers').querySelectorAll('input:checked')].map(i => i.value);
      if (!name) { toast('請輸入行程名稱'); return; }
      if (!start || !end) { toast('請選擇起訖日期'); return; }
      if (end < start) { toast('結束日不可早於起始日'); return; }
      if (members.length === 0) { toast('至少選一位成員'); return; }

      // 由角色下拉收集已選成員的角色；確保至少一位 Owner
      const roles = {};
      members.forEach(acc => {
        const sel = $('newTripMembers').querySelector(`.role-sel[data-acc="${acc}"]`);
        roles[acc] = sel ? sel.value : 'editor';
      });
      if (!Object.values(roles).includes('owner')) {
        roles[members.includes(Auth.currentAccount()) ? Auth.currentAccount() : members[0]] = 'owner';
        toast('已自動指定一位 Owner');
      }

      const editing = state.editingTripId ? trip(state.editingTripId) : null;
      if (editing) {
        editing.name = name; editing.members = members; editing.currency = f.currency.value;
        editing.start = start; editing.end = end; editing.roles = roles;
        Repo.syncDays(editing);           // 依新日期調整天數（保留既有、超出的站點退回規劃區）
        state.editingTripId = null;
        toast('行程已更新');
        Router.reset('view-trips');
      } else {
        const id = 't-' + Date.now();
        const t = { id, name, start, end, members, roles, currency: f.currency.value, days: {}, pool: [] };
        const dc = Math.max(1, tripDayCount(t));
        for (let d = 1; d <= dc; d++) t.days[d] = [];
        Repo.addTrip(t);                   // 建立行程並初始化費用/文件/提醒
        state.currentTripId = id;          // 完成 → 自動設為當前工作行程
        toast('行程已建立並設為當前');
        Router.reset('view-home');
      }
    });

    $('newTripDelete').addEventListener('click', () => {
      const t = state.editingTripId ? trip(state.editingTripId) : null;
      if (!t) return;
      if (!Permission.can(Auth.currentAccount(), 'trip.delete', t)) { toast('無權限刪除此行程'); return; }
      Confirm.open(`確定刪除行程「${t.name}」？其站點、費用、文件、提醒都會一併刪除，且無法復原。`, () => {
        const id = t.id;
        Repo.deleteTrip(id);
        if (state.currentTripId === id) state.currentTripId = null; // 交回自動判定
        state.editingTripId = null;
        toast('行程已刪除');
        Router.reset('view-home');
      });
    });
  }

  /* ---------- P2 編輯器 ---------- */
  function renderEditor() {
    const t = trip(resolveCurrentTrip());
    if (!t) { Router.reset('view-home'); return; }
    // 左側 pool
    const pool = $('poolList'); pool.innerHTML = '';
    if (t.pool.length === 0) pool.innerHTML = `<div class="day-drop__empty">規劃區為空，可從右側拖站點回來</div>`;
    t.pool.forEach(s => pool.appendChild(stationEl(s, 'pool')));
    // 左側整欄可作為「拖回規劃區」的落點
    DragDrop.attachPool($('editorPool'));

    // 右側 board
    const board = $('editorBoard'); board.innerHTML = '';
    const dc = tripDayCount(t);
    for (let d = 1; d <= dc; d++) {
      const list = t.days[d] || (t.days[d] = []);
      const block = document.createElement('div'); block.className = 'day-block';
      block.innerHTML = `<div class="day-block__head">D${d}</div>`;
      const drop = document.createElement('div'); drop.className = 'day-drop';
      if (list.length === 0) {
        const empty = document.createElement('div'); empty.className = 'day-drop__empty';
        empty.textContent = '拖站點到這裡';
        drop.appendChild(empty);
      }
      // gap(0) → 站點 → gap(1) → 站點 ... gap(n)
      drop.appendChild(gapEl(d, 0));
      list.forEach((s, i) => {
        drop.appendChild(stationEl(s, d));
        if (i < list.length - 1) drop.appendChild(legEl(t, s, list[i + 1]));
        drop.appendChild(gapEl(d, i + 1));
      });
      DragDrop.attachDayContainer(drop, d, () => (t.days[d] || []).length);
      block.appendChild(drop);
      board.appendChild(block);
    }
  }

  function stationEl(s, from) {
    const el = document.createElement('div');
    el.className = 'station';
    const tp = STATION_TYPES[s.type] || { label: s.type, icon: '•' };
    let extra = '';
    if (s.type === 'airport') extra = s.leg === 'arrive' ? '去程' : '回程';
    else if (s.type === 'hotel') extra = s.stay === 'in' ? 'Check-In' : s.stay === 'out' ? 'Check-Out' : 'Stay';
    else if (s.type === 'overnight') extra = '跨日';
    const arriveTxt = (s.arrive || '—') + (s.fixedArrive ? ' 🔒' : '');
    const departTxt = (s.depart || '—') + (s.fixedDepart ? ' 🔒' : '');
    const time = (s.arrive || s.depart) ? `${arriveTxt} ~ ${departTxt}` : (s.note || '');
    el.innerHTML = `
      ${s.place ? '<button class="station__map" type="button" draggable="false" aria-label="開啟地圖">🗺</button>' : ''}
      <button class="station__edit" type="button" draggable="false" aria-label="編修站點">✎</button>
      <div class="station__type">${tp.icon} ${tp.label}${extra ? '・' + extra : ''}</div>
      <div class="station__name">${s.name}</div>
      ${time ? `<div class="station__time">${time}</div>` : ''}`;
    DragDrop.attachStation(el, from, s.id);
    // 編修鈕：PC 點擊 / 手機觸控皆同一行為；阻止冒泡避免誤觸發拖曳
    const editBtn = el.querySelector('.station__edit');
    editBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditStation(s, from); });
    // 開圖鈕：用 place 的 placeId/座標（語言無關），不用顯示名
    const mapBtn = el.querySelector('.station__map');
    if (mapBtn) {
      mapBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      mapBtn.addEventListener('click', (e) => { e.stopPropagation(); openMap(s.place); });
    }
    return el;
  }

  /* ---------- 站點間交通段（Leg） ---------- */
  function legKey(a, b) { return a + '__' + b; }

  function legEl(t, fromS, toS) {
    if (!t.legs) t.legs = {};
    const key = legKey(fromS.id, toS.id);
    const leg = t.legs[key];
    const sel = leg && leg.candidates.find(c => c.id === leg.selectedId);
    const el = document.createElement('div');
    if (!sel) {
      el.className = 'leg-card leg-card--empty';
      el.innerHTML = `<span class="leg-card__plus">+ 交通</span>`;
    } else {
      el.className = 'leg-card';
      const m = TRANSPORT_MODES[sel.mode] || TRANSPORT_MODES.other;
      const transferTag = (sel.transfers && sel.transfers.length > 1)
        ? `<span class="split-tag">轉乘${sel.transfers.length - 1}次</span>` : '';
      const bufferTag = leg.bufferMinutes ? `<span class="split-tag">緩衝${leg.bufferMinutes}分</span>` : '';
      el.innerHTML = `
        <span class="leg-card__icon">${m.icon}</span>
        <span class="leg-card__info">
          <span class="leg-card__line">${[sel.line, sel.train].filter(Boolean).join('・') || m.label}${sel.note ? '・' + sel.note : ''}</span>
          <span class="leg-card__time">${sel.fromTime || '--:--'} → ${sel.toTime || '--:--'}</span>
        </span>
        ${transferTag}${bufferTag}`;
    }
    el.addEventListener('click', () => openLegEditor(t, fromS, toS));
    return el;
  }

  // 套用選定候選的時間到前後站點（直接覆蓋，不提示——實務上站點時間本就常隨交通方式變動）
  function applySelectedLeg(fromS, toS, leg) {
    const sel = leg.candidates.find(c => c.id === leg.selectedId);
    if (!sel) return;
    if (sel.fromTime && !fromS.fixedDepart) fromS.depart = sel.fromTime;
    if (sel.toTime && !toS.fixedArrive) toS.arrive = sel.toTime;
  }

  function openLegEditor(t, fromS, toS) {
    const key = legKey(fromS.id, toS.id);
    const existing = t.legs[key];
    const draft = existing ? JSON.parse(JSON.stringify(existing)) : { bufferMinutes: 10, candidates: [], selectedId: null };
    const lib = Timetable.findCandidates(fromS.name, toS.name);

    const candHtml = () => draft.candidates.length ? draft.candidates.map(c => {
      const m = TRANSPORT_MODES[c.mode] || TRANSPORT_MODES.other;
      const isSel = c.id === draft.selectedId;
      const transferTag = (c.transfers && c.transfers.length > 1) ? `<span class="split-tag">轉乘${c.transfers.length - 1}次</span>` : '';
      return `<div class="leg-cand ${isSel ? 'is-selected' : ''}" data-id="${c.id}">
        <span class="leg-cand__main">${m.icon} ${[c.line, c.train].filter(Boolean).join('・') || m.label}${c.note ? '・' + c.note : ''}　${c.fromTime || '--:--'} → ${c.toTime || '--:--'} ${transferTag}</span>
        <span class="leg-cand__status">${isSel ? '預定' : '備用'}</span>
        <button type="button" class="btn btn--mini" data-act="del">🗑</button>
      </div>`;
    }).join('') : '<p class="day-hint">尚無候選，請從下方加入。</p>';

    // 班表庫支援的交通方式（新幹線/列車/巴士）：以卡片選擇後再列出該方式的班次
    const LIB_MODES = ['shinkansen', 'train', 'bus'];
    // 手動新增常用三種放一行，其餘以下拉「更多」選擇
    const MANUAL_FRONT_MODES = ['walk', 'taxi', 'shuttle'];
    const MANUAL_MORE_MODES = ['localbus', 'tram', 'ferry', 'other'];

    if (draft.libMode === undefined) {
      draft.libMode = LIB_MODES.find(mk => lib.entries.some(e => e.mode === mk)) || LIB_MODES[0];
    }
    draft.manualMode = draft.manualMode || MANUAL_FRONT_MODES[0];

    const libModeChipsHtml = () => `<div class="chip-cards chip-cards--3" id="leg_lib_modes">${LIB_MODES.map(mk => {
      const m = TRANSPORT_MODES[mk];
      const has = lib.entries.some(e => e.mode === mk);
      return `<button type="button" class="chip-card ${draft.libMode === mk ? 'is-on' : ''}" data-mode="${mk}">${m.icon} ${m.label}${has ? '' : '<span class="chip-card__none" title="無班次">✕</span>'}</button>`;
    }).join('')}</div>`;

    const libEntriesHtml = () => {
      const entries = lib.entries.filter(e => e.mode === draft.libMode);
      if (!entries.length) return '<p class="day-hint">查無此區間／方式的班次</p>';
      const hint = lib.fuzzy ? '<p class="day-hint">模糊比對結果，請確認站名是否相符：</p>' : '<p class="day-hint">依站名找到以下班次：</p>';
      return hint + entries.map(e => {
        const m = TRANSPORT_MODES[e.mode] || TRANSPORT_MODES.other;
        const transferTag = (e.transfers && e.transfers.length > 1) ? `<span class="split-tag">轉乘${e.transfers.length - 1}次</span>` : '';
        return `<div class="leg-cand" data-lib-id="${e.id}">
          <span class="leg-cand__main">${m.icon} ${[e.line, e.train].filter(Boolean).join('・')}　${e.fromTime} → ${e.toTime}（${e.fromStation} → ${e.toStation}）${transferTag}</span>
          <button type="button" class="btn btn--mini" data-act="add">+ 加入</button>
        </div>`;
      }).join('');
    };

    const manualModeChipsHtml = () => `<div class="chip-cards chip-cards--3" id="leg_manual_modes">${MANUAL_FRONT_MODES.map(mk => {
      const m = TRANSPORT_MODES[mk];
      return `<button type="button" class="chip-card ${draft.manualMode === mk ? 'is-on' : ''}" data-mode="${mk}">${m.icon} ${m.label}</button>`;
    }).join('')}</div>
    <select id="leg_manual_more" class="more-sel">
      <option value="">更多方式…</option>
      ${MANUAL_MORE_MODES.map(mk => `<option value="${mk}" ${draft.manualMode === mk ? 'selected' : ''}>${TRANSPORT_MODES[mk].icon} ${TRANSPORT_MODES[mk].label}</option>`).join('')}
    </select>`;

    Modal.open(`交通：${fromS.name} → ${toS.name}`, `
      <div class="field"><div class="field__label">已加入候選（點選設為預定）</div>
        <div id="leg_candidates">${candHtml()}</div>
      </div>
      <div class="field"><div class="field__label">班表庫（選擇交通方式查看班次）</div>
        ${libModeChipsHtml()}
        <div id="leg_lib">${libEntriesHtml()}</div>
      </div>
      <div class="field"><div class="field__label">手動新增候選</div>
        ${manualModeChipsHtml()}
        <div class="time-wheel-row">
          ${timeWheelHtml('出發時間', 'leg_from', '')}
          ${timeWheelHtml('到達時間', 'leg_to', '')}
        </div>
        <label>備註<input id="leg_note" placeholder="如 飯店接送"></label>
        <button type="button" class="btn btn--mini" id="leg_add_manual">+ 加入</button>
      </div>
      <div class="field"><div class="field__label">換乘/緩衝時間（分鐘）</div>
        <div class="stepper">
          <button type="button" class="btn btn--mini" id="leg_buffer_dec">－</button>
          <input type="number" id="leg_buffer" min="0" value="${draft.bufferMinutes ?? 10}">
          <button type="button" class="btn btn--mini" id="leg_buffer_inc">＋</button>
        </div>
      </div>
      ${existing ? '<button class="btn btn--danger" id="leg_delete" type="button">移除此交通段</button>' : ''}
    `, () => {
      draft.bufferMinutes = parseInt($('leg_buffer').value, 10) || 0;
      delete draft.libMode; delete draft.manualMode;
      if (!draft.candidates.length) { delete t.legs[key]; renderEditor(); toast('已清除交通段'); return; }
      if (!draft.selectedId || !draft.candidates.some(c => c.id === draft.selectedId)) draft.selectedId = draft.candidates[0].id;
      t.legs[key] = draft;
      applySelectedLeg(fromS, toS, draft);
      renderEditor();
      toast('已更新交通段，前後站點時間已套用');
    });

    wireTimeWheel('leg_from', '出發時間');
    wireTimeWheel('leg_to', '到達時間');

    function bindCandidateEvents() {
      $('leg_candidates').querySelectorAll('.leg-cand').forEach(elc => {
        elc.querySelector('[data-act="del"]').addEventListener('click', (e) => {
          e.stopPropagation();
          draft.candidates = draft.candidates.filter(c => c.id !== elc.dataset.id);
          if (draft.selectedId === elc.dataset.id) draft.selectedId = draft.candidates[0]?.id || null;
          refreshCandidates();
        });
        elc.addEventListener('click', () => { draft.selectedId = elc.dataset.id; refreshCandidates(); });
      });
    }
    function refreshCandidates() {
      $('leg_candidates').innerHTML = candHtml();
      bindCandidateEvents();
    }
    bindCandidateEvents();

    function bindLibAddEvents() {
      $('leg_lib').querySelectorAll('[data-act="add"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const libId = btn.closest('[data-lib-id]').dataset.libId;
          const e = lib.entries.find(x => x.id === libId);
          if (!e) return;
          const id = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
          draft.candidates.push({ id, mode: e.mode, source: 'imported', line: e.line, train: e.train, fromTime: e.fromTime, toTime: e.toTime, transfers: e.transfers });
          if (!draft.selectedId) draft.selectedId = id;
          refreshCandidates();
          toast('已加入候選');
        });
      });
    }
    bindLibAddEvents();

    $('leg_lib_modes').querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        draft.libMode = btn.dataset.mode;
        $('leg_lib_modes').querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('is-on', b.dataset.mode === draft.libMode));
        $('leg_lib').innerHTML = libEntriesHtml();
        bindLibAddEvents();
      });
    });

    function syncManualModeChips() {
      $('leg_manual_modes').querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('is-on', b.dataset.mode === draft.manualMode));
      $('leg_manual_more').value = MANUAL_MORE_MODES.includes(draft.manualMode) ? draft.manualMode : '';
    }
    $('leg_manual_modes').querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => { draft.manualMode = btn.dataset.mode; syncManualModeChips(); });
    });
    $('leg_manual_more').addEventListener('change', (e) => {
      if (e.target.value) { draft.manualMode = e.target.value; syncManualModeChips(); }
    });

    $('leg_buffer_dec').addEventListener('click', () => {
      const v = Math.max(0, (parseInt($('leg_buffer').value, 10) || 0) - 5);
      $('leg_buffer').value = v;
    });
    $('leg_buffer_inc').addEventListener('click', () => {
      const v = (parseInt($('leg_buffer').value, 10) || 0) + 5;
      $('leg_buffer').value = v;
    });

    $('leg_add_manual').addEventListener('click', () => {
      const mode = draft.manualMode;
      const fromTime = readTimeWheel('leg_from');
      const toTime = readTimeWheel('leg_to');
      const note = $('leg_note').value.trim();
      const id = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      draft.candidates.push({ id, mode, source: 'manual', fromTime, toTime, note, transfers: [] });
      if (!draft.selectedId) draft.selectedId = id;
      refreshCandidates();
      toast('已加入候選');
    });

    if (existing) {
      $('leg_delete').addEventListener('click', () => {
        Confirm.open('確定移除此交通段？（不影響已套用的站點時間）', () => {
          delete t.legs[key];
          Modal.close(); renderEditor();
          toast('已移除交通段');
        });
      });
    }
  }

  function gapEl(day, index) {
    const g = document.createElement('div');
    g.className = 'drop-gap';
    DragDrop.attachGap(g, day, index);
    return g;
  }

  // 由 dragdrop.js 呼叫：把站點搬到 day 的 index 位置
  function moveStation(dragInfo, day, index) {
    const t = trip(resolveCurrentTrip());
    if (!t) return;
    let s;
    if (dragInfo.from === 'pool') {
      const i = t.pool.findIndex(x => x.id === dragInfo.id);
      if (i < 0) return;
      s = t.pool.splice(i, 1)[0];               // 拖入後從規劃區消失
    } else {
      const src = t.days[dragInfo.from] || [];
      const i = src.findIndex(x => x.id === dragInfo.id);
      if (i < 0) return;
      s = src.splice(i, 1)[0];
      // 同一天往後移時，移除後 index 需修正
      if (dragInfo.from === day && i < index) index--;
    }
    const dest = t.days[day] || (t.days[day] = []);
    index = Math.max(0, Math.min(index, dest.length));
    dest.splice(index, 0, s);
    renderEditor();
  }

  // 由 dragdrop.js 呼叫：把右側時間軸的站點拖回左側規劃區
  function moveStationToPool(dragInfo) {
    if (dragInfo.from === 'pool') return;          // 本來就在規劃區
    const t = trip(resolveCurrentTrip());
    if (!t) return;
    const src = t.days[dragInfo.from] || [];
    const i = src.findIndex(x => x.id === dragInfo.id);
    if (i < 0) return;
    const s = src.splice(i, 1)[0];
    t.pool.push(s);                                // 回到規劃區可重新取用
    renderEditor();
    toast('已移回站點規劃區');
  }

  function bindEditor() {
    $('btnAddStation').addEventListener('click', () => openAddStation());
  }

  /* ---- 地點選擇（假 Autocomplete + 地圖選點 + 開圖；存 place 欄位） ---- */
  function placeLabel(p) {
    if (!p) return '';
    const coord = (p.lat != null) ? ` (${p.lat.toFixed(3)},${p.lng.toFixed(3)})` : '';
    return (p.mapName || p.name || '已選地點') + coord;
  }
  function placePickerHtml(place) {
    return `
      <div class="field"><div class="field__label">地點（地圖解析）</div>
        <div class="pl-chosen" id="pl_chosen" ${place ? '' : 'hidden'}>
          🗺 <span id="pl_chosen_txt">${placeLabel(place)}</span>
          <button type="button" class="btn btn--mini" id="pl_open">開圖</button>
          <button type="button" class="btn btn--mini" id="pl_clear">✕</button>
        </div>
        <p class="day-hint" id="pl_none" ${place ? 'hidden' : ''}>依站點名稱解析；找不到時可「在地圖上選點」校正。</p>
        <div class="pl-actions">
          <button type="button" class="btn btn--mini" id="pl_resolve">🔎 依名稱查找</button>
          <button type="button" class="btn btn--mini" id="pl_pick">📍 在地圖上選點</button>
        </div>
      </div>`;
  }
  // getName：回傳目前站點名稱欄位值（地點以名稱帶入，非手動搜尋選擇）
  function wirePlacePicker(holder, getName) {
    const chosen = $('pl_chosen'), none = $('pl_none');
    const refresh = () => {
      const has = !!holder.place;
      chosen.hidden = !has; none.hidden = has;
      if (has) $('pl_chosen_txt').textContent = placeLabel(holder.place);
    };
    const resolveByName = (silent) => {
      const term = (getName() || '').trim();
      if (!term) { if (!silent) toast('請先輸入站點名稱'); return; }
      // 以名稱去地圖找：先精確、再包含
      const p = MOCK_PLACES.find(x => x.display === term || x.mapName === term)
        || MOCK_PLACES.find(x => x.display.includes(term) || x.mapName.includes(term) || term.includes(x.display));
      if (p) { holder.place = { mapName: p.mapName, placeId: p.placeId, lat: p.lat, lng: p.lng }; refresh(); if (!silent) toast('已依名稱解析地點'); }
      else if (!silent) { toast('地圖找不到此名稱，請用「在地圖上選點」校正'); }
    };
    $('pl_resolve').addEventListener('click', () => resolveByName(false));
    $('pl_pick').addEventListener('click', () => {
      holder.place = { mapName: '地圖選定位置', placeId: '', lat: +(43.05 + Math.random() * 0.1).toFixed(4), lng: +(141.3 + Math.random() * 0.1).toFixed(4) };
      refresh(); toast('已在地圖上選點（prototype）');
    });
    chosen.addEventListener('click', (e) => {
      if (e.target.id === 'pl_open') openMap(holder.place);
      if (e.target.id === 'pl_clear') { holder.place = null; refresh(); }
    });
    if (!holder.place) resolveByName(true);   // 開啟時依名稱自動帶入
    refresh();
  }
  /* ---- 時間欄位：手動輸入 + 滾輪 pop up（24 小時制，可上下循環）並存 ---- */
  const WHEEL_ITEM_H = 36;
  function timeWheelHtml(label, fieldId, value) {
    return `
      <div class="field"><div class="field__label">${label}</div>
        <div class="time-input-row">
          <input type="text" id="${fieldId}_input" value="${value || ''}" placeholder="HH:MM" inputmode="numeric" maxlength="5">
          <button type="button" class="btn btn--mini" id="${fieldId}_pop">🕐</button>
        </div>
      </div>`;
  }
  function wireTimeWheel(fieldId, label) {
    const input = $(fieldId + '_input');
    // 手動輸入：固定 24 小時制 HH:MM，僅輸入數字，自動補上「:」
    input.addEventListener('input', () => {
      let digits = input.value.replace(/\D/g, '').slice(0, 4);
      if (digits.length >= 3) input.value = digits.slice(0, 2) + ':' + digits.slice(2);
      else input.value = digits;
    });
    // 離開欄位時整理格式並限制範圍（HH 0-23、MM 0-59）
    input.addEventListener('blur', () => {
      const digits = input.value.replace(/\D/g, '');
      if (!digits) { input.value = ''; return; }
      let h = parseInt(digits.slice(0, 2) || '0', 10);
      let mi = parseInt(digits.slice(2, 4) || '0', 10);
      h = Math.min(23, h);
      mi = Math.min(59, mi);
      input.value = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
    });
    $(fieldId + '_pop').addEventListener('click', () => openTimeWheelPopup(label, input));
  }
  function readTimeWheel(fieldId) {
    return $(fieldId + '_input').value.trim();
  }

  function openTimeWheelPopup(label, input) {
    const [h, m] = (input.value.trim() || '00:00').split(':').map(n => parseInt(n, 10) || 0);
    const overlay = document.createElement('div');
    overlay.className = 'time-popup-overlay';
    overlay.innerHTML = `
      <div class="time-popup">
        <div class="time-popup__title">${label || '選擇時間'}</div>
        <div class="time-wheel">
          <div class="time-wheel__highlight"></div>
          <div class="time-wheel__col" id="tw_pop_h"></div>
          <div class="time-wheel__colon">:</div>
          <div class="time-wheel__col" id="tw_pop_m"></div>
        </div>
        <div class="time-popup__actions">
          <button type="button" class="btn" id="tw_pop_cancel">取消</button>
          <button type="button" class="btn btn--primary" id="tw_pop_ok">完成</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let curH = h, curM = m;
    buildWheelColumn(overlay.querySelector('#tw_pop_h'), 24, h, v => curH = v);
    buildWheelColumn(overlay.querySelector('#tw_pop_m'), 60, m, v => curM = v);
    const close = () => overlay.remove();
    overlay.querySelector('#tw_pop_cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('#tw_pop_ok').addEventListener('click', () => {
      input.value = String(curH).padStart(2, '0') + ':' + String(curM).padStart(2, '0');
      close();
    });
  }
  function buildWheelColumn(el, max, initial, onChange) {
    const items = [];
    for (let loop = 0; loop < 3; loop++) for (let v = 0; v < max; v++) items.push(v);
    el.innerHTML = items.map(v => `<div class="time-wheel__item">${String(v).padStart(2, '0')}</div>`).join('');
    const children = el.children;
    const settle = () => {
      const i = Math.round((el.scrollTop + WHEEL_ITEM_H / 2) / WHEEL_ITEM_H);
      let target = i;
      if (target < max) target += max;
      else if (target >= max * 2) target -= max;
      if (target !== i) el.scrollTop = (target - 1) * WHEEL_ITEM_H;
      else if (Math.abs(el.scrollTop - (i - 1) * WHEEL_ITEM_H) > 1) el.scrollTop = (i - 1) * WHEEL_ITEM_H;
      const value = target % max;
      for (let k = 0; k < children.length; k++) children[k].classList.toggle('is-center', k === target);
      onChange(value);
    };
    let timer = null;
    el.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(settle, 120); });
    for (let k = 0; k < children.length; k++) {
      children[k].addEventListener('click', () => {
        el.scrollTo({ top: (k - 1) * WHEEL_ITEM_H, behavior: 'smooth' });
      });
    }
    // 初始定位於中段
    el.scrollTop = (max + initial - 1) * WHEEL_ITEM_H;
    for (let k = 0; k < children.length; k++) children[k].classList.toggle('is-center', k === max + initial);
    onChange(initial);
  }

  function openMap(place) {
    const url = Platform.placeUrl(place);
    if (!url) { toast('尚未選地點'); return; }
    window.open(url, '_blank');
  }

  function openAddStation() {
    const t = trip(resolveCurrentTrip());
    const holder = { place: null };
    Modal.open('新增站點', `
      <label>型別<select id="ms_type">${Object.entries(STATION_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
      <label>名稱<input id="ms_name" placeholder="站點名稱"></label>
      ${placePickerHtml(null)}
      <div class="time-wheel-row">
        ${timeWheelHtml('到達時間', 'ms_arrive', '')}
        ${timeWheelHtml('出發時間', 'ms_depart', '')}
      </div>
    `, () => {
      const name = $('ms_name').value.trim();
      if (!name) { toast('請輸入名稱'); return false; }
      t.pool.push({
        id: 'p-' + Date.now(), type: $('ms_type').value, name,
        arrive: readTimeWheel('ms_arrive'), depart: readTimeWheel('ms_depart'),
        place: holder.place || undefined,
      });
      renderEditor();
      toast('已加入規劃區，拖到右側時間軸');
    });
    wirePlacePicker(holder, () => $('ms_name').value);
    wireTimeWheel('ms_arrive', '到達時間');
    wireTimeWheel('ms_depart', '出發時間');
  }

  // 編修站點：from = 'pool' 或天數。PC 點擊 / 手機觸控同一入口（站點卡 ✎ 鈕）
  function openEditStation(s, from) {
    const typeOpts = Object.entries(STATION_TYPES)
      .map(([k, v]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${v.label}</option>`).join('');
    const holder = { place: s.place || null };
    Modal.open('編修站點', `
      <label>型別<select id="es_type">${typeOpts}</select></label>
      <label>名稱<input id="es_name" value="${(s.name || '').replace(/"/g, '&quot;')}"></label>
      ${placePickerHtml(s.place)}
      <div class="time-wheel-row">
        ${timeWheelHtml('到達時間', 'es_arrive', s.arrive)}
        ${timeWheelHtml('出發時間', 'es_depart', s.depart)}
      </div>
      <div class="chip-cards chip-cards--2" id="es_fixed_chips">
        <button type="button" class="chip-card ${s.fixedArrive ? 'is-on' : ''}" data-fixed="arrive">🔒 到達時間固定</button>
        <button type="button" class="chip-card ${s.fixedDepart ? 'is-on' : ''}" data-fixed="depart">🔒 出發時間固定</button>
      </div>
      <p class="day-hint">固定時間不會隨交通段調整套用，如登機/集合時間</p>
      <button class="btn btn--danger" id="es_delete" type="button">刪除此站點</button>
    `, () => {
      const name = $('es_name').value.trim();
      if (!name) { toast('請輸入名稱'); return false; }
      s.type = $('es_type').value;
      s.name = name;
      s.arrive = readTimeWheel('es_arrive');
      s.depart = readTimeWheel('es_depart');
      s.fixedArrive = fixed.arrive;
      s.fixedDepart = fixed.depart;
      s.place = holder.place || undefined;
      renderEditor();
      toast('已更新站點');
    });
    const fixed = { arrive: !!s.fixedArrive, depart: !!s.fixedDepart };
    $('es_fixed_chips').querySelectorAll('[data-fixed]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.fixed;
        fixed[k] = !fixed[k];
        btn.classList.toggle('is-on', fixed[k]);
      });
    });
    wirePlacePicker(holder, () => $('es_name').value);
    wireTimeWheel('es_arrive', '到達時間');
    wireTimeWheel('es_depart', '出發時間');
    // 刪除：依所在位置移除
    $('es_delete').addEventListener('click', () => {
      Confirm.open(`確定刪除站點「${s.name}」？此動作無法復原。`, () => {
        const t = trip(resolveCurrentTrip());
        const arr = from === 'pool' ? t.pool : (t.days[from] || []);
        const i = arr.findIndex(x => x.id === s.id);
        if (i >= 0) arr.splice(i, 1);
        Modal.close();
        renderEditor();
        toast('已刪除站點');
      });
    });
  }

  /* ---------- P3 費用 ---------- */
  function currentDayOfTrip(t) {
    // 進行中時，今天對應第幾天
    if (tripStatus(t) !== 'live') return null;
    const s = new Date(t.start + 'T00:00:00');
    const today = new Date(TODAY + 'T00:00:00');
    return Math.round((today - s) / 86400000) + 1;
  }

  function renderExpense() {
    const t = trip(resolveCurrentTrip());
    if (!t) { Router.reset('view-home'); return; }
    const dc = tripDayCount(t);
    const todayDay = currentDayOfTrip(t);

    // 進行中 → 自動高亮並選當日；非當日 → 須先手動選 Day
    if (state.expenseDay == null) state.expenseDay = todayDay; // 可能為 null

    const tabs = $('expenseDayTabs'); tabs.innerHTML = '';
    // 「全程」分頁：機票、網卡、機場停車等未歸屬到某天的費用
    const allTab = document.createElement('div');
    allTab.className = 'day-tab day-tab--all' + (state.expenseDay === ALL_DAY ? ' is-active' : '');
    allTab.textContent = '全程';
    allTab.addEventListener('click', () => { state.expenseDay = ALL_DAY; renderExpense(); });
    tabs.appendChild(allTab);
    for (let d = 1; d <= dc; d++) {
      const tab = document.createElement('div');
      tab.className = 'day-tab'
        + (d === state.expenseDay ? ' is-active' : '')
        + (d === todayDay ? ' is-today' : '');
      tab.textContent = 'D' + d;
      tab.addEventListener('click', () => { state.expenseDay = d; renderExpense(); });
      tabs.appendChild(tab);
    }

    const hint = $('expenseDayHint');
    if (state.expenseDay === ALL_DAY) hint.textContent = '全程費用：機票、網卡、機場停車等未歸屬到某天的項目。';
    else if (todayDay) hint.textContent = `行程進行中，已自動高亮今天 D${todayDay}（綠框）。`;
    else if (state.expenseDay == null) hint.textContent = '此行程非進行中，請先選擇 Day 或「全程」才能新增／編輯。';
    else hint.textContent = `目前編輯 D${state.expenseDay}（非當日，手動選定）。`;

    renderExpenseList(t);

    // 把選中的分頁捲到可見處，並更新左右箭頭可用狀態
    const strip = $('expenseDayTabs');
    const active = strip.querySelector('.day-tab.is-active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
    updateDayArrows();
  }

  function updateDayArrows() {
    const s = $('expenseDayTabs');
    const atStart = s.scrollLeft <= 1;
    const atEnd = s.scrollLeft >= s.scrollWidth - s.clientWidth - 1;
    $('dayPrev').disabled = atStart;
    $('dayNext').disabled = atEnd;
  }

  const catIconOf = (k) => (EXPENSE_CATEGORIES.find(c => c.key === k) || {}).icon || '🧾';

  function renderExpenseList(t) {
    const wrap = $('expenseList'); wrap.innerHTML = '';
    const d = state.expenseDay;
    if (d == null) { wrap.innerHTML = `<p class="day-hint">尚未選擇 Day 或「全程」。</p>`; return; }
    const label = d === ALL_DAY ? '全程' : 'D' + d;
    const list = Repo.expenses(t.id, d);
    if (list.length === 0) { wrap.innerHTML = `<p class="day-hint">${label} 尚無費用。</p>`; return; }
    const me = Auth.currentAccount();
    list.forEach(e => {
      const item = document.createElement('div'); item.className = 'list-item';
      const tags = e.split.map(acc => {
        const settlement = e.settlements && e.settlements[acc];
        const cls = `split-tag ${acc === me ? 'is-me' : ''} ${settlement ? 'is-settled' : ''}`.trim();
        const label = `${aliasOf(acc)}${acc === me ? '(我)' : ''}`;
        const arrow = settlement ? ` → ${settlement.assignedTo.map(aliasOf).join('、')}` : '';
        return `<span class="${cls}">${label}${arrow}</span>`;
      }).join('');
      item.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
          <div class="list-item__sub">付款：${aliasOf(e.payer)}${e.payer === me ? '(我)' : ''}・${e.payMethod || '—'}・分攤 ${e.split.length} 人</div>
          <div class="split-tags">${tags}</div>
        </div>
        <div class="amount">${e.currency || t.currency} ${e.amount.toLocaleString()}</div>`;
      wrap.appendChild(item);
    });
  }

  function bindExpense() {
    // 手動新增
    $('btnAddExpense').addEventListener('click', () => {
      const t = trip(resolveCurrentTrip());
      if (!Permission.can(Auth.currentAccount(), 'expense.edit', t)) { toast('你的角色無記帳權限（唯讀）'); return; }
      if (state.expenseDay == null) { toast('請先選擇一個 Day'); return; }
      openAddExpense(t);
    });
    // 拍收據辨識 → 預填「新增費用」表單供確認（辨識服務見 receipt.js）
    $('btnScanReceipt').addEventListener('click', async () => {
      const t = trip(resolveCurrentTrip());
      if (!Permission.can(Auth.currentAccount(), 'expense.edit', t)) { toast('你的角色無記帳權限（唯讀）'); return; }
      if (state.expenseDay == null) { toast('請先選擇一個 Day'); return; }
      const btn = $('btnScanReceipt'); const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '辨識中…';
      try {
        const extracted = await ReceiptScanService.scan(/* image */);
        openAddExpense(t, extracted);     // 預填 + 確認
      } catch (e) {
        toast('辨識失敗，請改用手動輸入');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  }

  // prefill：來自收據辨識的 ExtractedExpense（含 confidence）；null 表手動新增
  function openAddExpense(t, prefill) {
    const fromScan = !!prefill;
    // 分類：MFU 全域排序，前 4 為卡片、其餘收下拉
    const orderedCats = UsageStats.ordered('category', EXPENSE_CATEGORIES.map(c => c.key));
    const frontCats = orderedCats.slice(0, 4);
    const moreCats = orderedCats.slice(4);
    // 付款方式：MFU 全域
    const orderedPM = UsageStats.ordered('payMethod', PAYMENT_METHODS);
    // 幣別：MFU per-trip，種子＝行程幣別優先
    const curSeed = [t.currency, ...CURRENCIES.filter(c => c !== t.currency)];
    const orderedCur = UsageStats.ordered('currency:' + t.id, curSeed);

    const hasItems = fromScan && Array.isArray(prefill.items) && prefill.items.length > 0;
    const sel = {
      category: fromScan && prefill.category ? prefill.category : frontCats[0],
      payMethod: fromScan && prefill.payMethod ? prefill.payMethod : orderedPM[0],
      split: new Set(t.members),
      mode: hasItems ? 'items' : 'simple',
      items: hasItems ? prefill.items.map((it, i) => ({ id: 'ix-' + Date.now() + '-' + i, name: it.name, amount: it.amount, split: [] })) : [],
    };

    // 收據辨識橫幅：列出低信心欄位提醒確認
    let banner = '';
    if (fromScan) {
      const labelMap = { category: '分類', amount: '金額', currency: '幣別', payMethod: '付款方式', note: '備註' };
      const low = Object.keys(prefill.confidence || {}).filter(k => prefill.confidence[k] < 0.7).map(k => labelMap[k] || k);
      banner = `<div class="scan-banner">🧾 由收據辨識（店家：${prefill.merchant || '—'}）。${low.length ? '<b>建議確認：' + low.join('、') + '</b>' : '辨識信心高，仍請快速核對。'}</div>`;
    }

    const itemsAssigned = () => sel.items.filter(i => i.split.length > 0).length;

    function renderModal() {
      const itemsSum = sel.items.reduce((a, i) => a + (i.amount || 0), 0);
      Modal.open(fromScan ? '確認費用（收據辨識）' : '新增費用', `
      ${banner}
      <div class="field"><div class="field__label">分類</div>
        <div class="chip-cards" id="ex_cats">
          ${frontCats.map(k => `<button type="button" class="chip-card" data-cat="${k}">${catIconOf(k)} ${k}</button>`).join('')}
        </div>
        ${moreCats.length ? `<select id="ex_cat_more" class="more-sel"><option value="">更多分類…</option>${moreCats.map(k => `<option value="${k}">${catIconOf(k)} ${k}</option>`).join('')}</select>` : ''}
      </div>
      <label>備註（可選）<input id="ex_note" placeholder="如 午餐 拉麵"></label>
      <div class="field"><div class="field__label">付款方式</div>
        <div class="chips" id="ex_pm">${orderedPM.map(p => `<button type="button" class="chip" data-pm="${p}">${p}</button>`).join('')}</div>
      </div>
      <div class="amount-row">
        <label class="grow">金額<input id="ex_amount" type="number" inputmode="numeric" placeholder="0" ${sel.mode === 'items' ? `readonly value="${itemsSum}"` : ''}></label>
        <label>幣別<select id="ex_currency">${orderedCur.map(c => `<option value="${c}">${c}</option>`).join('')}</select></label>
      </div>
      <label>付款人<select id="ex_payer">${t.members.map(acc => `<option value="${acc}" ${acc === Auth.currentAccount() ? 'selected' : ''}>${aliasOf(acc)}</option>`).join('')}</select></label>
      <div class="field"><div class="field__label">分攤方式</div>
        <div class="chip-cards chip-cards--2" id="ex_mode">
          <button type="button" class="chip-card ${sel.mode === 'simple' ? 'is-on' : ''}" data-mode="simple">簡單模式</button>
          <button type="button" class="chip-card ${sel.mode === 'items' ? 'is-on' : ''}" data-mode="items">分項模式</button>
        </div>
      </div>
      <div class="field" id="ex_split_simple" ${sel.mode !== 'simple' ? 'hidden' : ''}>
        <div class="field__label">分攤對象</div>
        <div class="chip-cards" id="ex_split">${t.members.map(acc => `<button type="button" class="chip-card ${sel.split.has(acc) ? 'is-on' : ''}" data-acc="${acc}">${aliasOf(acc)}${Auth.isMe(acc) ? '(我)' : ''}</button>`).join('')}</div>
      </div>
      <div class="field" id="ex_split_items" ${sel.mode !== 'items' ? 'hidden' : ''}>
        <div class="field__label">分項分配（已分配 ${itemsAssigned()}/${sel.items.length} 項）</div>
        <button type="button" class="btn btn--mini" id="ex_open_items">📋 開啟分項分配</button>
      </div>
    `, () => {
        const currency = $('ex_currency').value;
        if (!sel.category) { toast('請選擇分類'); return false; }
        if (sel.mode === 'simple') {
          const amount = parseFloat($('ex_amount').value);
          if (!(amount > 0)) { toast('請輸入金額'); return false; }
          if (sel.split.size === 0) { toast('至少一位分攤'); return false; }
          UsageStats.bump('category', sel.category);
          UsageStats.bump('payMethod', sel.payMethod);
          UsageStats.bump('currency:' + t.id, currency);
          const exData = {
            id: 'e-' + Date.now(), category: sel.category, note: $('ex_note').value.trim(),
            amount, currency, payMethod: sel.payMethod, payer: $('ex_payer').value, split: [...sel.split],
            fromReceipt: fromScan || undefined,
          };
          Repo.addExpense(t.id, state.expenseDay, exData);
          FirebaseSync.addExpense(t.id, state.expenseDay, exData);
        } else {
          if (!sel.items.length) { toast('請至少新增一個品項'); return false; }
          if (itemsAssigned() < sel.items.length) { toast('尚有品項未指定分攤對象'); return false; }
          const amount = sel.items.reduce((a, i) => a + (i.amount || 0), 0);
          const split = [...new Set(sel.items.flatMap(i => i.split))];
          UsageStats.bump('category', sel.category);
          UsageStats.bump('payMethod', sel.payMethod);
          UsageStats.bump('currency:' + t.id, currency);
          const exData2 = {
            id: 'e-' + Date.now(), category: sel.category, note: $('ex_note').value.trim(),
            amount, currency, payMethod: sel.payMethod, payer: $('ex_payer').value, split,
            items: sel.items.map(i => ({ name: i.name, amount: i.amount, split: i.split })),
            fromReceipt: fromScan || undefined,
          };
          Repo.addExpense(t.id, state.expenseDay, exData2);
          FirebaseSync.addExpense(t.id, state.expenseDay, exData2);
        }
        renderExpense();
        toast('已新增費用');
      });

      // 開啟後綁定互動
      const body = $('modalBody');
      const setCat = (k) => { sel.category = k; body.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('is-on', b.dataset.cat === k)); };
      body.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { const m = body.querySelector('#ex_cat_more'); if (m) m.value = ''; setCat(b.dataset.cat); }));
      const more = body.querySelector('#ex_cat_more');
      if (more) more.addEventListener('change', () => { if (more.value) { sel.category = more.value; body.querySelectorAll('[data-cat]').forEach(b => b.classList.remove('is-on')); } });
      const setPM = (p) => { sel.payMethod = p; body.querySelectorAll('[data-pm]').forEach(b => b.classList.toggle('is-on', b.dataset.pm === p)); };
      body.querySelectorAll('[data-pm]').forEach(b => b.addEventListener('click', () => setPM(b.dataset.pm)));
      body.querySelectorAll('#ex_split [data-acc]').forEach(b => b.addEventListener('click', () => {
        const a = b.dataset.acc;
        if (sel.split.has(a)) { sel.split.delete(a); b.classList.remove('is-on'); }
        else { sel.split.add(a); b.classList.add('is-on'); }
      }));
      body.querySelectorAll('#ex_mode [data-mode]').forEach(b => b.addEventListener('click', () => {
        if (sel.mode === b.dataset.mode) return;
        sel.mode = b.dataset.mode;
        // 保留已輸入的備註/金額/分類等，重繪整個 Modal
        const note = $('ex_note').value, amount = $('ex_amount').value, currency = $('ex_currency').value, payer = $('ex_payer').value;
        renderModal();
        $('ex_note').value = note; $('ex_currency').value = currency; $('ex_payer').value = payer;
        if (sel.mode === 'simple') $('ex_amount').value = amount;
      }));
      const openItemsBtn = body.querySelector('#ex_open_items');
      if (openItemsBtn) openItemsBtn.addEventListener('click', () => {
        const note = $('ex_note').value, currency = $('ex_currency').value, payer = $('ex_payer').value;
        openExpenseItemsModal(t, sel, () => {
          renderModal();
          $('ex_note').value = note; $('ex_currency').value = currency; $('ex_payer').value = payer;
        });
      });

      // 套用初始/預填值
      if (frontCats.includes(sel.category)) setCat(sel.category);
      else if (more) { more.value = sel.category; }   // 分類落在「更多」下拉
      setPM(sel.payMethod);
      if (fromScan) {
        if (prefill.note != null) $('ex_note').value = prefill.note;
        if (prefill.amount != null && sel.mode === 'simple') $('ex_amount').value = prefill.amount;
        if (prefill.currency && orderedCur.includes(prefill.currency)) $('ex_currency').value = prefill.currency;
      }
    }

    renderModal();
  }

  // 分項分配子 Modal：勾選品項 → 指定分攤對象（可複選）→ 套用；可手動新增/刪除品項
  function openExpenseItemsModal(t, sel, onDone) {
    const checked = new Set();
    const assignTo = new Set();

    function itemRow(it) {
      const splitTxt = it.split.length ? it.split.map(aliasOf).join('、') : '<span class="chip-card__none" style="border-radius:4px;width:auto;padding:0 4px;">未指定</span>';
      return `<div class="leg-cand" data-id="${it.id}">
        <span class="leg-cand__main">
          <input type="checkbox" class="ix_pick" data-id="${it.id}" ${checked.has(it.id) ? 'checked' : ''}>
          ${it.name}　${it.amount.toLocaleString()}　→ ${splitTxt}
        </span>
        <button type="button" class="btn btn--mini" data-act="del">🗑</button>
      </div>`;
    }

    function bodyHtml() {
      return `
      <div class="field"><div class="field__label">品項列表（已分配 ${sel.items.filter(i => i.split.length > 0).length}/${sel.items.length} 項）</div>
        <div id="ix_list">${sel.items.map(itemRow).join('') || '<p class="day-hint">尚無品項，請於下方新增。</p>'}</div>
      </div>
      <div class="field"><div class="field__label">新增品項</div>
        <div class="amount-row">
          <label class="grow">名稱<input id="ix_name" placeholder="如 護手霜"></label>
          <label>金額<input id="ix_amount" type="number" inputmode="numeric" placeholder="0"></label>
        </div>
        <button type="button" class="btn btn--mini" id="ix_add">+ 加入</button>
      </div>
      <div class="field"><div class="field__label">將勾選項目分攤給（可複選）</div>
        <div class="chip-cards" id="ix_assign">${t.members.map(acc => `<button type="button" class="chip-card ${assignTo.has(acc) ? 'is-on' : ''}" data-acc="${acc}">${aliasOf(acc)}${Auth.isMe(acc) ? '(我)' : ''}</button>`).join('')}</div>
        <button type="button" class="btn btn--mini" id="ix_apply">套用到已勾選項目</button>
      </div>`;
    }

    function render() {
      Modal.open('分項分配', bodyHtml(), () => { onDone(); return false; });
      const body = $('modalBody');
      body.querySelectorAll('.ix_pick').forEach(cb => cb.addEventListener('change', () => {
        if (cb.checked) checked.add(cb.dataset.id); else checked.delete(cb.dataset.id);
      }));
      body.querySelectorAll('#ix_list [data-act="del"]').forEach(btn => btn.addEventListener('click', () => {
        const id = btn.closest('[data-id]').dataset.id;
        sel.items = sel.items.filter(i => i.id !== id);
        checked.delete(id);
        render();
      }));
      $('ix_add').addEventListener('click', () => {
        const name = $('ix_name').value.trim();
        const amount = parseFloat($('ix_amount').value);
        if (!name) { toast('請輸入品項名稱'); return; }
        if (!(amount > 0)) { toast('請輸入金額'); return; }
        sel.items.push({ id: 'ix-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), name, amount, split: [] });
        render();
      });
      body.querySelectorAll('#ix_assign [data-acc]').forEach(b => b.addEventListener('click', () => {
        const a = b.dataset.acc;
        if (assignTo.has(a)) { assignTo.delete(a); b.classList.remove('is-on'); }
        else { assignTo.add(a); b.classList.add('is-on'); }
      }));
      $('ix_apply').addEventListener('click', () => {
        if (!checked.size) { toast('請先勾選品項'); return; }
        if (!assignTo.size) { toast('請選擇分攤對象'); return; }
        sel.items.forEach(i => { if (checked.has(i.id)) i.split = [...assignTo]; });
        checked.clear();
        render();
        toast('已套用');
      });
    }
    render();
  }

  // 夜間配色方案選擇（極光青 A / 溫潤琥珀 B），含即時預覽色塊
  function openPaletteSettings() {
    const SCHEMES = {
      a: { label: '方案 A · 極光青', accent: '#0ea5e9', accentOn: '#0f172a', accent2: '#1e3a8a', accent2On: '#fff', accent2Border: '#0ea5e9', cta: '#f97316', ctaOn: '#fff' },
      b: { label: '方案 B · 溫潤琥珀', accent: '#d97706', accentOn: '#0f172a', accent2: '#a16207', accent2On: '#fff', accent2Border: '#a16207', cta: '#f97316', ctaOn: '#fff' },
    };
    const swatchHtml = (s) => `
      <div style="display:flex; gap:6px; margin-top:8px;">
        <span style="flex:1; background:${s.accent}; color:${s.accentOn}; border-radius:8px; padding:6px 0; text-align:center; font-size:12px;">分類</span>
        <span style="flex:1; background:${s.accent2}; color:${s.accent2On}; border:1px solid ${s.accent2Border}; border-radius:8px; padding:6px 0; text-align:center; font-size:12px;">分攤對象</span>
        <span style="flex:1; background:${s.cta}; color:${s.ctaOn}; border-radius:8px; padding:6px 0; text-align:center; font-size:12px; font-weight:700;">確定</span>
      </div>`;

    function render() {
      const cur = Palette.get();
      Modal.open('夜間配色方案', `
        <p class="day-hint">套用於夜間模式；日間模式配色固定（丹寧藍／薄荷綠）。</p>
        <div class="field"><div class="field__label">${SCHEMES.a.label}</div>
          <button type="button" class="chip-card ${cur === 'a' ? 'is-on' : ''}" data-pal="a" style="width:100%; padding:8px;">選用方案 A</button>
          ${swatchHtml(SCHEMES.a)}
        </div>
        <div class="field" style="margin-top:14px;"><div class="field__label">${SCHEMES.b.label}</div>
          <button type="button" class="chip-card ${cur === 'b' ? 'is-on' : ''}" data-pal="b" style="width:100%; padding:8px;">選用方案 B</button>
          ${swatchHtml(SCHEMES.b)}
        </div>
      `, () => {});
      $('modalBody').querySelectorAll('[data-pal]').forEach(b => b.addEventListener('click', () => {
        Palette.set(b.dataset.pal);
        render();
      }));
    }
    render();
  }

  /* ---------- 結算（費用報表 + 分攤指定） ---------- */
  // 計算每人最終負擔：依 split 平均分攤，若該成員此筆有 settlements，則其份額改由 assignedTo 平均分擔
  // filterFn 可選：僅納入符合條件的費用（例如僅共用費用）
  function computeBurdens(tripId, filterFn) {
    const burdens = {}; // currency -> account -> amount
    Repo.allExpenses(tripId).forEach(e => {
      if (filterFn && !filterFn(e)) return;
      const n = e.split.length;
      if (n === 0) return;
      const share = e.amount / n;
      e.split.forEach(acc => {
        const settlement = e.settlements && e.settlements[acc];
        const targets = (settlement && settlement.assignedTo.length) ? settlement.assignedTo : [acc];
        const per = share / targets.length;
        targets.forEach(tgt => {
          burdens[e.currency] = burdens[e.currency] || {};
          burdens[e.currency][tgt] = (burdens[e.currency][tgt] || 0) + per;
        });
      });
    });
    return burdens;
  }

  // 結算統一以台幣（TWD）為基礎幣別顯示換算金額
  const HOME = 'TWD';

  // 將 amt（cur 幣別）換算為 base 幣別；無匯率時回傳 null
  // settleRates[cur] = 1 cur 兌換多少 base（例如 1 JPY = 0.2 TWD 時，settleRates['JPY'] = 0.2）
  function toBase(amt, cur, base) {
    if (cur === base) return amt;
    const r = state.settleRates[cur];
    return (r > 0) ? amt * r : null;
  }

  // 格式化單一幣別金額：非台幣時附加「≈ TWD ...」換算，或標註「無匯率」
  function fmtAmt(amt, cur) {
    const main = `${cur} ${Math.round(amt).toLocaleString()}`;
    if (cur === HOME) return main;
    const tb = toBase(amt, cur, HOME);
    return tb == null ? `${main}（無匯率）` : `${main}　≈　${HOME} ${Math.round(tb).toLocaleString()}`;
  }

  function renderSettleRates(t) {
    const wrap = $('settleRates'); wrap.innerHTML = '';
    const base = HOME;
    const currencies = new Set();
    Repo.allExpenses(t.id).forEach(e => currencies.add(e.currency));
    const foreign = [...currencies].filter(c => c !== base);
    if (!foreign.length) return;
    const item = document.createElement('div'); item.className = 'list-item';
    let html = `<div class="list-item__main" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;"><div class="list-item__title">💱 匯率設定</div>`;
    foreign.forEach(cur => {
      const rv = state.settleRates[cur] != null ? state.settleRates[cur] : '';
      html += `<div class="list-item__sub" style="display:flex;align-items:center;gap:6px;margin:0;">1 ${cur} = <input type="number" step="0.0001" value="${rv}" data-rate-cur="${cur}" style="width:90px;"> ${base}</div>`;
    });
    html += `</div>`;
    item.innerHTML = html;
    wrap.appendChild(item);
    item.querySelectorAll('[data-rate-cur]').forEach(inp => {
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        state.settleRates[inp.dataset.rateCur] = isNaN(v) ? 0 : v;
        renderSettlement();
      });
    });
  }

  // 區段標題（field__label 樣式），插入清單前提供層級感
  function addSectionTitle(wrap, text) {
    const h = document.createElement('div');
    h.className = 'field__label';
    h.style.margin = '14px 2px 6px';
    h.textContent = text;
    wrap.appendChild(h);
  }

  // ── 總覽：各幣別總費用 + 換算合計 + 分類明細 ──
  function renderSettleTotal(t) {
    const wrap = $('settleTotalList'); wrap.innerHTML = '';
    const all = Repo.allExpenses(t.id);
    if (!all.length) { wrap.innerHTML = `<p class="day-hint">尚無費用記錄。</p>`; return; }
    const base = HOME;

    addSectionTitle(wrap, '總費用');
    const curTotals = {};
    all.forEach(e => { curTotals[e.currency] = (curTotals[e.currency] || 0) + e.amount; });
    Object.keys(curTotals).forEach(cur => {
      const item = document.createElement('div'); item.className = 'list-item';
      item.innerHTML = `<div class="list-item__main"><div class="list-item__title">${cur} 總費用</div></div><div class="amount">${fmtAmt(curTotals[cur], cur)}</div>`;
      wrap.appendChild(item);
    });

    let grand = 0, missing = false;
    Object.keys(curTotals).forEach(cur => {
      const tb = toBase(curTotals[cur], cur, base);
      if (tb == null) missing = true; else grand += tb;
    });
    const sumItem = document.createElement('div'); sumItem.className = 'list-item';
    sumItem.innerHTML = `<div class="list-item__main"><div class="list-item__title">換算 ${base} 合計</div></div><div class="amount" style="color:var(--ok)">${base} ${Math.round(grand).toLocaleString()}${missing ? '+' : ''}</div>`;
    wrap.appendChild(sumItem);

    addSectionTitle(wrap, '分類明細');
    const catTotals = {};
    all.forEach(e => {
      catTotals[e.category] = catTotals[e.category] || { count: 0, byCur: {} };
      catTotals[e.category].count++;
      catTotals[e.category].byCur[e.currency] = (catTotals[e.category].byCur[e.currency] || 0) + e.amount;
    });
    EXPENSE_CATEGORIES.forEach(c => {
      const ct = catTotals[c.key];
      if (!ct) return;
      const parts = Object.keys(ct.byCur).map(cur => fmtAmt(ct.byCur[cur], cur)).join('　·　');
      const item = document.createElement('div'); item.className = 'list-item';
      item.innerHTML = `<div class="list-item__main"><div class="list-item__title">${c.icon} ${c.key}</div><div class="list-item__sub">${ct.count} 筆</div></div><div class="amount">${parts}</div>`;
      wrap.appendChild(item);
    });
  }

  // ── 每人：付款／分攤（已套用分攤指定）淨額，個人花費，總金額 ──
  function renderSettlePerson(t) {
    const wrap = $('settlePersonList'); wrap.innerHTML = '';
    const all = Repo.allExpenses(t.id);
    if (!all.length) { wrap.innerHTML = `<p class="day-hint">尚無費用記錄。</p>`; return; }
    const base = HOME;
    const isShared = e => e.split.length > 1;
    const owedBurdens = computeBurdens(t.id, isShared);
    const dayLabel = d => d === ALL_DAY ? '全程' : 'D' + d;

    addSectionTitle(wrap, '共用費用清算（已套用分攤指定）');
    t.members.forEach(acc => {
      let paid = 0, paidMissing = false;
      all.filter(isShared).filter(e => e.payer === acc).forEach(e => {
        const tb = toBase(e.amount, e.currency, base);
        if (tb == null) paidMissing = true; else paid += tb;
      });
      let owed = 0, owedMissing = false;
      Object.keys(owedBurdens).forEach(cur => {
        const amt = owedBurdens[cur][acc];
        if (!amt) return;
        const tb = toBase(amt, cur, base);
        if (tb == null) owedMissing = true; else owed += tb;
      });
      const net = paid - owed;

      const expanded = state.settlePersonExpanded === acc;
      const head = document.createElement('div'); head.className = 'list-item';
      head.style.cursor = 'pointer';
      head.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${aliasOf(acc)}${Auth.isMe(acc) ? '(我)' : ''} <span style="color:var(--text-dim);font-size:12px;">${expanded ? '▾' : '▸'}</span></div>
          <div class="list-item__sub">付款 ${base} ${Math.round(paid).toLocaleString()}${paidMissing ? '+' : ''}・分攤 ${base} ${Math.round(owed).toLocaleString()}${owedMissing ? '+' : ''}</div>
        </div>
        <div class="amount" style="color:${net >= 0 ? 'var(--ok)' : 'var(--danger)'}">${net >= 0 ? '+' : '-'}${base} ${Math.round(Math.abs(net)).toLocaleString()} ${net > 0 ? '應收' : (net < 0 ? '應付' : '打平')}</div>`;
      head.addEventListener('click', () => {
        state.settlePersonExpanded = expanded ? null : acc;
        renderSettlement();
      });
      wrap.appendChild(head);

      if (expanded) {
        const shared = all.filter(isShared).filter(e => e.split.includes(acc));
        const sharedBurden = shared.filter(e => {
          const settlement = e.settlements && e.settlements[acc];
          const targets = (settlement && settlement.assignedTo.length) ? settlement.assignedTo : [acc];
          return targets.includes(acc);
        });
        if (sharedBurden.length) {
          const sub = document.createElement('div');
          sub.style.cssText = 'font-size:12px;color:var(--text-dim);margin:4px 2px 4px 12px';
          sub.textContent = `↳ ${aliasOf(acc)} 參與的共用費用`;
          wrap.appendChild(sub);
        }
        sharedBurden.forEach(e => {
          const settlement = e.settlements && e.settlements[acc];
          const targets = (settlement && settlement.assignedTo.length) ? settlement.assignedTo : [acc];
          const share = (e.amount / e.split.length) / targets.length;
          const item = document.createElement('div'); item.className = 'list-item list-item--sub';
          item.innerHTML = `
            <div class="list-item__main">
              <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
              <div class="list-item__sub">${dayLabel(e._day)}・付款：${aliasOf(e.payer)}${e.payer === acc ? '(自己)' : ''}・分攤 ${e.split.length} 人${targets.includes(acc) ? '' : '（已轉移分攤）'}</div>
            </div>
            <div class="amount">${fmtAmt(share, e.currency)}</div>`;
          wrap.appendChild(item);
        });

        const personal = all.filter(e => e.split.length === 1 && e.split[0] === acc && e.payer === acc);
        if (personal.length) {
          const sub = document.createElement('div');
          sub.style.cssText = 'font-size:12px;color:var(--text-dim);margin:4px 2px 4px 12px';
          sub.textContent = `↳ ${aliasOf(acc)} 的個人花費（未分攤）`;
          wrap.appendChild(sub);
        }
        personal.forEach(e => {
          const item = document.createElement('div'); item.className = 'list-item list-item--sub';
          item.innerHTML = `
            <div class="list-item__main">
              <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
              <div class="list-item__sub">${dayLabel(e._day)}・個人花費</div>
            </div>
            <div class="amount">${fmtAmt(e.amount, e.currency)}</div>`;
          wrap.appendChild(item);
        });
      }
    });

    let grand = 0, gmissing = false;
    const curTotals = {};
    all.forEach(e => { curTotals[e.currency] = (curTotals[e.currency] || 0) + e.amount; });
    Object.keys(curTotals).forEach(cur => {
      const tb = toBase(curTotals[cur], cur, base);
      if (tb == null) gmissing = true; else grand += tb;
    });
    addSectionTitle(wrap, '總金額');
    const sumItem = document.createElement('div'); sumItem.className = 'list-item';
    sumItem.innerHTML = `<div class="list-item__main"><div class="list-item__title">本次旅行所有費用總金額</div></div><div class="amount" style="color:var(--ok)">${base} ${Math.round(grand).toLocaleString()}${gmissing ? '+' : ''}</div>`;
    wrap.appendChild(sumItem);
  }

  // ── 每日：依日期分組的費用清單 + 小計 ──
  function renderSettleDay(t) {
    const wrap = $('settleDayList'); wrap.innerHTML = '';
    const all = Repo.allExpenses(t.id);
    if (!all.length) { wrap.innerHTML = `<p class="day-hint">尚無費用記錄。</p>`; return; }
    const groups = {};
    all.forEach(e => { (groups[e._day] = groups[e._day] || []).push(e); });
    const days = Object.keys(groups).sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : Number(a) - Number(b)));
    addSectionTitle(wrap, '每日費用明細');
    days.forEach(d => {
      const list = groups[d];
      const label = d === 'all' ? '全程' : 'D' + d;
      const totals = {};
      list.forEach(e => { totals[e.currency] = (totals[e.currency] || 0) + e.amount; });
      const group = document.createElement('div'); group.className = 'settle-group';
      const head = document.createElement('div'); head.className = 'list-item';
      head.innerHTML = `<div class="list-item__main"><div class="list-item__title">${label}</div><div class="list-item__sub">${list.length} 筆</div></div>
        <div class="amount">${Object.keys(totals).map(c => fmtAmt(totals[c], c)).join('　')}</div>`;
      group.appendChild(head);
      list.forEach(e => {
        const item = document.createElement('div'); item.className = 'list-item list-item--sub';
        item.innerHTML = `
          <div class="list-item__main">
            <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
            <div class="list-item__sub">付款：${aliasOf(e.payer)}${e.payer === Auth.currentAccount() ? '(我)' : ''}</div>
          </div>
          <div class="amount">${fmtAmt(e.amount, e.currency)}</div>`;
        group.appendChild(item);
      });
      wrap.appendChild(group);
    });
  }

  // ── 付款方式統計（可點開看明細，樣式比照「總覽」） ──
  function renderSettlePay(t) {
    const wrap = $('settlePayList'); wrap.innerHTML = '';
    const all = Repo.allExpenses(t.id);
    if (!all.length) { wrap.innerHTML = `<p class="day-hint">尚無費用記錄。</p>`; return; }
    const dayLabel = d => d === ALL_DAY ? '全程' : 'D' + d;
    const groups = {};
    all.forEach(e => {
      const pm = e.payMethod || '未指定';
      (groups[pm] = groups[pm] || []).push(e);
    });
    addSectionTitle(wrap, '依付款方式統計');
    [...PAYMENT_METHODS, '未指定'].forEach(pm => {
      const list = groups[pm];
      if (!list) return;
      const byCur = {};
      list.forEach(e => { byCur[e.currency] = (byCur[e.currency] || 0) + e.amount; });
      const parts = Object.keys(byCur).map(cur => fmtAmt(byCur[cur], cur));
      const expanded = state.settlePayExpanded === pm;

      const head = document.createElement('div'); head.className = 'list-item';
      head.style.cursor = 'pointer';
      head.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${pm} <span style="color:var(--text-dim);font-size:12px;">${expanded ? '▾' : '▸'}</span></div>
          <div class="list-item__sub">${list.length} 筆</div>
        </div>
        <div class="amount">${parts.join('　·　')}</div>`;
      head.addEventListener('click', () => {
        state.settlePayExpanded = expanded ? null : pm;
        renderSettlement();
      });
      wrap.appendChild(head);

      if (expanded) {
        list.forEach(e => {
          const item = document.createElement('div'); item.className = 'list-item list-item--sub';
          item.innerHTML = `
            <div class="list-item__main">
              <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
              <div class="list-item__sub">${dayLabel(e._day)}・付款：${aliasOf(e.payer)}${e.payer === Auth.currentAccount() ? '(我)' : ''}</div>
            </div>
            <div class="amount">${fmtAmt(e.amount, e.currency)}</div>`;
          wrap.appendChild(item);
        });
      }
    });
  }

  function renderSettleSummary(t) {
    const burdens = computeBurdens(t.id);
    const wrap = $('settleSummary'); wrap.innerHTML = '';
    const currencies = Object.keys(burdens);
    if (currencies.length === 0) { wrap.innerHTML = `<p class="day-hint">尚無費用。</p>`; return; }

    t.members.forEach(acc => {
      const byCur = currencies.filter(cur => burdens[cur][acc]);
      if (byCur.length === 0) return;
      const curParts = byCur.map(cur => fmtAmt(burdens[cur][acc], cur));
      const item = document.createElement('div'); item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${aliasOf(acc)}${Auth.isMe(acc) ? '(我)' : ''}</div>
          <div class="list-item__sub">${curParts.join('　·　')}</div>
        </div>`;
      wrap.appendChild(item);
    });
  }

  const SETTLE_TABS = ['total', 'person', 'day', 'pay', 'assign'];
  function renderSettlement() {
    const t = trip(resolveCurrentTrip());
    if (!t) return;
    if (!state.settleMember || !t.members.includes(state.settleMember)) state.settleMember = Auth.currentAccount();

    renderSettleRates(t);

    $('settleTabs').querySelectorAll('.seg__btn').forEach(b => b.classList.toggle('is-on', b.dataset.tab === state.settleTab));
    SETTLE_TABS.forEach(tab => { $('settlePane-' + tab).hidden = (tab !== state.settleTab); });

    if (state.settleTab === 'total') { renderSettleTotal(t); return; }
    if (state.settleTab === 'person') { renderSettlePerson(t); return; }
    if (state.settleTab === 'day') { renderSettleDay(t); return; }
    if (state.settleTab === 'pay') { renderSettlePay(t); return; }

    renderSettleAssign(t);
  }

  function renderSettleAssign(t) {
    renderSettleSummary(t);

    const mWrap = $('settleMembers'); mWrap.innerHTML = '';
    t.members.forEach(acc => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-card' + (state.settleMember === acc ? ' is-on' : '');
      b.textContent = aliasOf(acc) + (Auth.isMe(acc) ? '(我)' : '');
      b.addEventListener('click', () => {
        state.settleMember = acc;
        state.settleSelected.clear();
        state.settleAssignTargets.clear();
        renderSettlement();
      });
      mWrap.appendChild(b);
    });

    const member = state.settleMember;
    const all = Repo.allExpenses(t.id).filter(e => e.split.includes(member));
    const unassigned = all.filter(e => !(e.settlements && e.settlements[member]));
    const assigned = all.filter(e => e.settlements && e.settlements[member]);
    const dayLabel = (d) => d === ALL_DAY ? '全程' : 'D' + d;

    const wrap = $('settleList'); wrap.innerHTML = '';
    if (unassigned.length === 0) {
      wrap.innerHTML = `<p class="day-hint">${aliasOf(member)} 目前沒有可指定的費用。</p>`;
    } else {
      unassigned.forEach(e => {
        const item = document.createElement('div');
        item.className = 'list-item' + (state.settleSelected.has(e.id) ? ' is-selected' : '');
        item.innerHTML = `
          <div class="list-item__main">
            <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
            <div class="list-item__sub">${dayLabel(e._day)}・付款：${aliasOf(e.payer)}${e.payer === member ? '(自己)' : ''}・分攤 ${e.split.length} 人</div>
          </div>
          <div class="amount">${fmtAmt(e.amount, e.currency)}</div>`;
        item.addEventListener('click', () => {
          if (state.settleSelected.has(e.id)) state.settleSelected.delete(e.id);
          else state.settleSelected.add(e.id);
          renderSettlement();
        });
        wrap.appendChild(item);
      });
    }

    $('settleHint').textContent = `${aliasOf(member)}：共 ${unassigned.length} 筆未指定，已選 ${state.settleSelected.size} 筆。`;

    // 分攤對象選擇：僅在已選取項目時顯示，候選為「除自己以外」的行程成員
    const assignField = $('settleAssignField');
    const targetsWrap = $('settleAssignTargets');
    if (state.settleSelected.size === 0) {
      assignField.hidden = true;
      targetsWrap.innerHTML = '';
      state.settleAssignTargets.clear();
    } else {
      assignField.hidden = false;
      targetsWrap.innerHTML = '';
      const others = t.members.filter(acc => acc !== member);
      const allOn = others.length > 0 && others.every(acc => state.settleAssignTargets.has(acc));
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'chip-card' + (allOn ? ' is-on' : '');
      allBtn.textContent = '全選';
      allBtn.addEventListener('click', () => {
        if (allOn) others.forEach(acc => state.settleAssignTargets.delete(acc));
        else others.forEach(acc => state.settleAssignTargets.add(acc));
        renderSettlement();
      });
      targetsWrap.appendChild(allBtn);
      others.forEach(acc => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip-card' + (state.settleAssignTargets.has(acc) ? ' is-on' : '');
        b.textContent = aliasOf(acc) + (Auth.isMe(acc) ? '(我)' : '');
        b.addEventListener('click', () => {
          if (state.settleAssignTargets.has(acc)) state.settleAssignTargets.delete(acc);
          else state.settleAssignTargets.add(acc);
          renderSettlement();
        });
        targetsWrap.appendChild(b);
      });
    }
    $('btnSettleConfirm').hidden = state.settleSelected.size === 0 || state.settleAssignTargets.size === 0;

    const doneWrap = $('settledList'); doneWrap.innerHTML = '';
    if (assigned.length === 0) {
      doneWrap.innerHTML = `<p class="day-hint">尚無已指定紀錄。</p>`;
    } else {
      assigned.forEach(e => {
        const targets = e.settlements[member].assignedTo.map(aliasOf).join('、');
        const item = document.createElement('div'); item.className = 'list-item';
        item.innerHTML = `
          <div class="list-item__main">
            <div class="list-item__title">${catIconOf(e.category)} ${e.category}${e.note ? ` <span class="exp-note">${e.note}</span>` : ''}</div>
            <div class="list-item__sub">${dayLabel(e._day)}・付款：${aliasOf(e.payer)}・改由 ${targets} 分攤</div>
          </div>
          <div class="amount">${fmtAmt(e.amount, e.currency)}</div>
          <button class="btn btn--mini list-item__action" data-act="revert">復原</button>`;
        item.querySelector('[data-act="revert"]').addEventListener('click', () => {
          delete e.settlements[member];
          renderSettlement();
        });
        doneWrap.appendChild(item);
      });
    }
  }

  function bindSettlement() {
    $('settleTabs').querySelectorAll('.seg__btn').forEach(b => {
      b.addEventListener('click', () => { state.settleTab = b.dataset.tab; renderSettlement(); });
    });
    $('btnSettleConfirm').addEventListener('click', () => {
      const t = trip(resolveCurrentTrip());
      if (!Permission.can(Auth.currentAccount(), 'expense.edit', t)) { toast('你的角色無記帳權限（唯讀）'); return; }
      const member = state.settleMember;
      const targets = [...state.settleAssignTargets];
      Repo.allExpenses(t.id).forEach(e => {
        if (state.settleSelected.has(e.id)) {
          e.settlements = e.settlements || {};
          e.settlements[member] = { assignedTo: targets };
        }
      });
      state.settleSelected.clear();
      state.settleAssignTargets.clear();
      toast('已指定分攤對象');
      renderSettlement();
    });
  }

  /* ---------- P4 照片（相簿式：依拍攝日期分組） ---------- */
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  function fmtPhotoDate(d) {
    const [y, m, day] = d.split('-');
    const w = WEEKDAYS[new Date(d + 'T00:00:00').getDay()];
    return `${y}年${+m}月${+day}日（週${w}）`;
  }
  function renderPhotos() {
    const t = trip(resolveCurrentTrip());
    const wrap = $('photoGrid'); wrap.innerHTML = '';
    const photos = (t ? Repo.photos(t.id) : []).slice().sort((a, b) => a.datetime.localeCompare(b.datetime));
    if (photos.length === 0) { wrap.innerHTML = `<p class="day-hint">此行程尚無照片。</p>`; return; }
    // 依日期分組
    const groups = {};
    photos.forEach(p => { const d = p.datetime.slice(0, 10); (groups[d] = groups[d] || []).push(p); });
    Object.keys(groups).sort().forEach(date => {
      const head = document.createElement('div'); head.className = 'photo-date';
      head.textContent = fmtPhotoDate(date);
      wrap.appendChild(head);
      const row = document.createElement('div'); row.className = 'photo-row';
      groups[date].forEach(p => {
        const tile = document.createElement('div'); tile.className = 'photo-tile';
        tile.innerHTML = `
          <div class="photo-tile__img">${p.emoji}</div>
          <div class="photo-tile__cap">${p.caption}</div>
          <div class="photo-tile__day">${p.datetime.slice(11, 16)}</div>`;
        tile.addEventListener('click', () => toast('照片檢視（佔位）'));
        row.appendChild(tile);
      });
      wrap.appendChild(row);
    });
  }

  // 拍照 / 選擇照片 → 加入相簿（prototype：記錄標題與拍攝時間，第二階段接相機/相簿）
  function openAddPhoto() {
    const t = trip(resolveCurrentTrip());
    if (!t) { toast('請先建立行程'); return; }
    if (!Permission.can(Auth.currentAccount(), 'photo.edit', t)) { toast('你的角色無新增照片權限'); return; }
    Modal.open('拍照 / 選擇照片', `
      <label>選擇照片<input id="ph_file" type="file" accept="image/*" capture="environment"></label>
      <label>說明<input id="ph_cap" placeholder="如 小樽運河"></label>
      <label>拍攝時間<input id="ph_dt" type="datetime-local" value="${TODAY}T12:00"></label>
      <p class="day-hint">prototype 以圖示佔位、不實際存圖；第二階段接相機/相簿並讀 EXIF 時間。</p>
    `, () => {
      const dt = $('ph_dt').value;
      if (!dt) { toast('請選擇拍攝時間'); return false; }
      const f = $('ph_file').files[0];
      const cap = $('ph_cap').value.trim() || (f ? f.name : '新照片');
      Repo.addPhoto(t.id, { id: 'ph-' + Date.now(), datetime: dt.slice(0, 16), caption: cap, emoji: '📷' });
      renderPhotos();
      toast('已加入照片');
    });
  }

  // 共用：依 mode（'date'|'category'）把項目分組並回傳已排序的 [key, items[]]
  function groupByMode(items, mode, categories) {
    const groups = {};
    if (mode === 'category') {
      items.forEach(x => { (groups[x.category] = groups[x.category] || []).push(x); });
      return Object.keys(groups).filter(k => groups[k].length)
        .sort((a, b) => categories.indexOf(a) - categories.indexOf(b))
        .map(k => [k, groups[k]]);
    }
    items.forEach(x => { const k = x.date || '全程'; (groups[k] = groups[k] || []).push(x); });
    return Object.keys(groups)
      .sort((a, b) => (a === '全程' ? '' : a).localeCompare(b === '全程' ? '' : b))
      .map(k => [k === '全程' ? '全程（無日期）' : k, groups[k]]);
  }

  /* ---------- P5 文件（上傳 + 類別/日期 + 兩種檢視） ---------- */
  function renderDocs() {
    const t = trip(resolveCurrentTrip());
    const wrap = $('docList'); wrap.innerHTML = '';
    $('docModes').querySelectorAll('.seg__btn').forEach(b => b.classList.toggle('is-on', b.dataset.mode === state.docMode));
    const docs = t ? Repo.documents(t.id) : [];
    if (docs.length === 0) { wrap.innerHTML = `<p class="day-hint">此行程尚無文件。</p>`; return; }
    const canEdit = Permission.can(Auth.currentAccount(), 'doc.edit', t);
    groupByMode(docs, state.docMode, DOCUMENT_CATEGORIES).forEach(([head, list]) => {
      const h = document.createElement('div'); h.className = 'rem-group'; h.textContent = head;
      wrap.appendChild(h);
      list.forEach(d => {
        const sub = state.docMode === 'category' ? (d.date || '全程') : d.category;
        const item = document.createElement('div'); item.className = 'list-item';
        item.innerHTML = `
          <div class="list-item__main">
            <div class="list-item__title">📄 ${d.name}</div>
            <div class="list-item__sub">${sub}・${d.size}</div>
          </div>
          <button class="btn btn--mini" data-act="view">檢視</button>
          ${canEdit ? '<button class="btn btn--mini btn--danger" data-act="del">🗑</button>' : ''}`;
        item.querySelector('[data-act="view"]').addEventListener('click', () => toast('文件檢視（佔位）'));
        if (canEdit) item.querySelector('[data-act="del"]').addEventListener('click', () => {
          Confirm.open(`確定刪除文件「${d.name}」？`, () => {
            Repo.deleteDocument(t.id, d.id); renderDocs(); toast('已刪除文件');
          });
        });
        wrap.appendChild(item);
      });
    });
  }

  function humanSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  function openUploadDoc() {
    const t = trip(resolveCurrentTrip());
    if (!Permission.can(Auth.currentAccount(), 'doc.edit', t)) { toast('你的角色無上傳權限'); return; }
    Modal.open('上傳文件', `
      <label>選擇檔案<input id="dc_file" type="file"></label>
      <label>類別<select id="dc_cat">${DOCUMENT_CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select></label>
      <label>日期（可空＝全程）<input id="dc_date" type="date"></label>
      <p class="day-hint">prototype 僅記錄檔名/大小，不實際上傳；第二階段接雲端儲存。</p>
    `, () => {
      const f = $('dc_file').files[0];
      if (!f) { toast('請選擇檔案'); return false; }
      Repo.addDocument(t.id, {
        id: 'd-' + Date.now(), name: f.name, category: $('dc_cat').value,
        date: $('dc_date').value, size: humanSize(f.size),
      });
      renderDocs();
      toast('已上傳文件');
    });
  }

  /* ---------- P6 提醒（CRUD + 狀態/類別/日期 + 兩種檢視） ---------- */
  function renderReminders() {
    const t = trip(resolveCurrentTrip());
    const wrap = $('reminderList'); wrap.innerHTML = '';
    // 切換鈕狀態
    $('reminderModes').querySelectorAll('.seg__btn').forEach(b =>
      b.classList.toggle('is-on', b.dataset.mode === state.reminderMode));
    const rs = t ? Repo.reminders(t.id) : [];
    if (rs.length === 0) { wrap.innerHTML = `<p class="day-hint">此行程尚無提醒。</p>`; return; }

    // 分組：按日期（無日期=全程，置頂）或 按類別
    const groups = {};
    if (state.reminderMode === 'category') {
      REMINDER_CATEGORIES.forEach(c => { groups[c] = []; });
      rs.forEach(r => { (groups[r.category] = groups[r.category] || []).push(r); });
    } else {
      rs.forEach(r => { const k = r.date || '全程'; (groups[k] = groups[k] || []).push(r); });
    }
    // 群組排序：類別依定義序；日期升冪、「全程」置頂
    let keys = Object.keys(groups).filter(k => groups[k].length);
    if (state.reminderMode === 'category') keys.sort((a, b) => REMINDER_CATEGORIES.indexOf(a) - REMINDER_CATEGORIES.indexOf(b));
    else keys.sort((a, b) => (a === '全程' ? '' : a).localeCompare(b === '全程' ? '' : b));

    keys.forEach(k => {
      const head = document.createElement('div'); head.className = 'rem-group';
      head.textContent = state.reminderMode === 'category' ? k : (k === '全程' ? '全程（無日期）' : k);
      wrap.appendChild(head);
      groups[k].forEach(r => wrap.appendChild(reminderItem(r)));
    });
  }

  function reminderItem(r) {
    const item = document.createElement('div'); item.className = 'list-item rem-item' + (r.done ? ' is-done' : '');
    // 副資訊：日期模式顯示類別，類別模式顯示日期
    const sub = state.reminderMode === 'category' ? (r.date || '全程') : r.category;
    item.innerHTML = `
      <button class="rem-check ${r.done ? 'is-done' : ''}" aria-label="切換完成">${r.done ? '✓' : ''}</button>
      <div class="list-item__main">
        <div class="list-item__title">${r.text}</div>
        <div class="list-item__sub">${sub}・建立者 ${aliasOf(r.owner)}${Auth.isMe(r.owner) ? '(我)' : ''}</div>
      </div>
      <button class="btn btn--mini" data-act="edit">✎</button>`;
    item.querySelector('.rem-check').addEventListener('click', () => {
      if (!Permission.can(Auth.currentAccount(), 'reminder.edit', trip(resolveCurrentTrip()))) { toast('你的角色無編輯權限'); return; }
      r.done = !r.done; renderReminders(); renderHome();
    });
    item.querySelector('[data-act="edit"]').addEventListener('click', () => openReminderForm(r));
    return item;
  }

  function openReminderForm(existing) {
    const t = trip(resolveCurrentTrip());
    if (!Permission.can(Auth.currentAccount(), 'reminder.edit', t)) { toast('你的角色無編輯權限'); return; }
    const r = existing || {};
    Modal.open(existing ? '編輯提醒' : '新增提醒', `
      <label>內容<input id="rm_text" value="${(r.text || '').replace(/"/g, '&quot;')}" placeholder="如 兌換 JR Pass"></label>
      <label>類別<select id="rm_cat">${REMINDER_CATEGORIES.map(c => `<option ${c === r.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>日期（可空＝全程）<input id="rm_date" type="date" value="${r.date || ''}"></label>
      <label class="chk"><input type="checkbox" id="rm_done" ${r.done ? 'checked' : ''}> 已完成</label>
      ${existing ? '<button class="btn btn--danger" id="rm_delete" type="button">刪除此提醒</button>' : ''}
    `, () => {
      const text = $('rm_text').value.trim();
      if (!text) { toast('請輸入內容'); return false; }
      const data = { text, category: $('rm_cat').value, date: $('rm_date').value, done: $('rm_done').checked };
      if (existing) { Object.assign(existing, data); }
      else {
        const newRem = { id: 'r-' + Date.now(), owner: Auth.currentAccount(), ...data };
        Repo.addReminder(t.id, newRem);
        FirebaseSync.addReminder(t.id, data, newRem);
      }
      renderReminders(); renderHome();
      toast(existing ? '已更新提醒' : '已新增提醒');
    });
    if (existing) {
      $('rm_delete').addEventListener('click', () => {
        Confirm.open(`確定刪除提醒「${existing.text}」？`, () => {
          Repo.deleteReminder(t.id, existing.id);
          FirebaseSync.deleteReminder(t.id, existing.id);
          Modal.close(); renderReminders(); renderHome();
          toast('已刪除提醒');
        });
      });
    }
  }

  /* ---------- 使用者設定（所有人，由首頁卡片進入） ---------- */
  function renderSettings() {
    const sel = $('simIdentity'); sel.innerHTML = '';
    Repo.members().forEach(m => {
      const label = `${m.alias}（${m.account}${m.admin ? '・管理員' : ''}）`;
      sel.appendChild(new Option(label, m.account, false, m.account === Auth.currentAccount()));
    });
  }

  /* ---------- 班表庫（全域共用，不分日期） ---------- */
  function renderTimetable() {
    $('timetableEntryPane').hidden = state.timetableMode !== 'entries';
    $('timetableAliasPane').hidden = state.timetableMode !== 'alias';
    $('timetableModes').querySelectorAll('.seg__btn').forEach(b =>
      b.classList.toggle('is-on', b.dataset.mode === state.timetableMode));
    if (state.timetableMode === 'alias') renderAliasList();
    else renderTimetableList();
  }

  function renderTimetableList() {
    const wrap = $('timetableList'); wrap.innerHTML = '';
    const entries = Repo.timetableEntries();
    if (!entries.length) { wrap.innerHTML = '<p class="day-hint">尚無班表，請匯入。</p>'; return; }
    entries.forEach(e => {
      const item = document.createElement('div'); item.className = 'list-item';
      const transferTag = e.transfers && e.transfers.length > 1
        ? `<span class="split-tag">轉乘 ${e.transfers.length - 1} 次</span>` : '';
      item.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${STATION_TYPES[e.mode === 'shinkansen' || e.mode === 'train' ? 'station' : 'spot']?.icon || '🚆'} ${e.line}${e.train ? '・' + e.train : ''}</div>
          <div class="list-item__sub">${e.fromStation} ${e.fromTime} → ${e.toStation} ${e.toTime} ${transferTag}</div>
        </div>
        <button class="btn btn--mini btn--danger" data-act="del">🗑</button>`;
      item.querySelector('[data-act="del"]').addEventListener('click', () => {
        Confirm.open(`確定刪除班次「${e.line}${e.train ? '・' + e.train : ''}」？`, () => {
          Repo.deleteTimetableEntry(e.id); renderTimetableList(); toast('已刪除班次');
        });
      });
      wrap.appendChild(item);
    });
  }

  function openImportTimetable() {
    Modal.open('貼上時刻表 JSON 匯入', `
      <p class="day-hint">貼上 AI 轉換後的時刻表 JSON（格式同 routes/legs）。同班次（路線/班次/起訖站/出發時間相同）將以本次匯入為準覆蓋。</p>
      <textarea id="tt_json" rows="8" placeholder='{ "routes": [ ... ] }' style="width:100%; box-sizing:border-box; font-family:monospace; font-size:12px;"></textarea>
    `, () => {
      const text = $('tt_json').value.trim();
      if (!text) { toast('請貼上 JSON'); return false; }
      let entries;
      try { entries = Timetable.parseImportJson(text); }
      catch (e) { toast(e.message); return false; }
      const { added, updated } = Repo.importTimetableEntries(entries);
      renderTimetableList();
      toast(`已匯入：新增 ${added} 筆、覆蓋 ${updated} 筆`);
    });
  }

  /* ---------- 站點別名對照表（全域，可手動 CRUD） ---------- */
  function renderAliasList() {
    const wrap = $('aliasList'); wrap.innerHTML = '';
    const list = Repo.stationAliases();
    if (!list.length) { wrap.innerHTML = '<p class="day-hint">尚無別名群組。</p>'; return; }
    list.forEach(a => {
      const item = document.createElement('div'); item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${a.canonical}</div>
          <div class="list-item__sub">${a.aliases.join('、') || '（無別名）'}</div>
        </div>
        <button class="btn btn--mini" data-act="edit">✎</button>
        <button class="btn btn--mini btn--danger" data-act="del">🗑</button>`;
      item.querySelector('[data-act="edit"]').addEventListener('click', () => openAliasForm(a));
      item.querySelector('[data-act="del"]').addEventListener('click', () => {
        Confirm.open(`確定刪除別名群組「${a.canonical}」？`, () => {
          Repo.deleteStationAlias(a.canonical); renderAliasList(); toast('已刪除');
        });
      });
      wrap.appendChild(item);
    });
  }

  function openAliasForm(existing) {
    Modal.open(existing ? '編輯別名群組' : '新增別名群組', `
      <label>標準名稱（canonical）<input id="al_canonical" value="${(existing?.canonical || '').replace(/"/g, '&quot;')}" placeholder="如 札幌"></label>
      <label>其他別名（以、或逗號分隔）<input id="al_aliases" value="${(existing?.aliases || []).join('、')}" placeholder="如 Sapporo、さっぽろ、札幌駅"></label>
    `, () => {
      const canonical = $('al_canonical').value.trim();
      if (!canonical) { toast('請輸入標準名稱'); return false; }
      const aliases = $('al_aliases').value.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
      if (existing) { existing.canonical = canonical; existing.aliases = aliases; }
      else {
        if (Repo.stationAliases().some(x => x.canonical === canonical)) { toast('此標準名稱已存在'); return false; }
        Repo.addStationAlias({ canonical, aliases });
      }
      renderAliasList();
      toast(existing ? '已更新別名群組' : '已新增別名群組');
    });
  }

  /* ---------- 成員管理（全域通訊錄，由設定進入） ---------- */
  function renderMembers() {
    const wrap = $('memberList'); wrap.innerHTML = '';
    Repo.members().forEach(m => {
      const isMe = Auth.isMe(m.account);
      const item = document.createElement('div'); item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item__main">
          <div class="list-item__title">${m.alias}${isMe ? ' <span class="me-tag">(我)</span>' : ''}</div>
          <div class="list-item__sub">帳號：${m.account}</div>
        </div>
        <button class="btn btn--mini" data-act="rename">✎ 編輯</button>
        ${isMe ? '' : '<button class="btn btn--mini btn--danger" data-act="del">🗑</button>'}`;
      item.querySelector('[data-act="rename"]').addEventListener('click', () => renameMember(m));
      if (!isMe) item.querySelector('[data-act="del"]').addEventListener('click', () => deleteMember(m));
      wrap.appendChild(item);
    });
  }

  // 別名驗證：非空、不可與其他成員別名重複（排除自己）
  function validAlias(alias, exceptAccount) {
    if (!alias) { toast('請輸入別名'); return false; }
    if (aliasExists(alias, exceptAccount)) { toast('別名已被使用，不可重複'); return false; }
    return true;
  }

  // 帳號驗證：非空、不可與其他成員帳號重複（排除自己原帳號）
  function validAccount(account, exceptAccount) {
    if (!account) { toast('請輸入帳號'); return false; }
    if (account !== exceptAccount && accountExists(account)) { toast('帳號已存在'); return false; }
    return true;
  }

  // 將舊帳號在所有行程/費用/提醒中的引用改為新帳號（含「我」的登入身分）
  function renameAccountEverywhere(oldAccount, newAccount) {
    TRIPS.forEach(t => {
      if (Array.isArray(t.members)) {
        t.members = t.members.map(a => a === oldAccount ? newAccount : a);
      }
      if (t.roles && oldAccount in t.roles) {
        t.roles[newAccount] = t.roles[oldAccount];
        delete t.roles[oldAccount];
      }
    });
    Object.values(EXPENSES).forEach(byDay => {
      Object.values(byDay).forEach(list => {
        list.forEach(e => {
          if (e.payer === oldAccount) e.payer = newAccount;
          if (Array.isArray(e.split)) e.split = e.split.map(a => a === oldAccount ? newAccount : a);
          if (Array.isArray(e.items)) e.items.forEach(i => {
            if (Array.isArray(i.split)) i.split = i.split.map(a => a === oldAccount ? newAccount : a);
          });
        });
      });
    });
    Object.values(REMINDERS).forEach(list => {
      list.forEach(r => { if (r.owner === oldAccount) r.owner = newAccount; });
    });
    if (Auth.currentAccount() === oldAccount) Auth.setAccount(newAccount);
  }

  function addMember() {
    Modal.open('新增成員', `
      <label>登入帳號<input id="mm_account" placeholder="如 jack（可省略 @gmail.com）"></label>
      <label>別名（顯示名稱）<input id="mm_alias" placeholder="如 Jack"></label>
    `, () => {
      let account = $('mm_account').value.trim().toLowerCase();
      const alias = $('mm_alias').value.trim();
      account = account.replace(/@gmail\.com$/i, '');   // 登入可省略 @gmail.com
      if (!account) { toast('請輸入登入帳號'); return false; }
      if (accountExists(account)) { toast('帳號已存在'); return false; }
      if (!validAlias(alias, null)) return false;
      Repo.addMember({ account, alias });
      FirebaseSync.addMember({ account, alias });
      renderMembers();
      toast('已新增成員');
    });
  }

  function renameMember(m) {
    Modal.open('編輯成員', `
      <label>登入帳號<input id="mm_account" value="${m.account}"></label>
      <p class="day-hint">變更帳號將同步更新此成員在所有行程／費用／提醒中的引用。</p>
      <label>別名<input id="mm_alias" value="${m.alias.replace(/"/g, '&quot;')}"></label>
    `, () => {
      let account = $('mm_account').value.trim().toLowerCase().replace(/@gmail\.com$/i, '');
      const alias = $('mm_alias').value.trim();
      if (!validAccount(account, m.account)) return false;
      if (!validAlias(alias, m.account)) return false;
      const oldAccount = m.account;
      if (account !== oldAccount) {
        renameAccountEverywhere(oldAccount, account);
        m.account = account;
        m.alias = alias;
        FirebaseSync.renameMemberAccount(oldAccount, account, m);
      } else {
        m.alias = alias;               // 僅改別名；引用以帳號為鍵，故全站含歷史同步
        FirebaseSync.updateMember(m);
      }
      renderMembers();
      renderHome();                  // 若改的是「我」，首頁標記同步
      toast('已更新成員');
    });
  }

  function deleteMember(m) {
    if (!Permission.can(Auth.currentAccount(), 'member.manage')) { toast('無權限'); return; }
    if (Auth.isMe(m.account)) { toast('「我」不可刪除'); return; }
    const used = memberInUse(m.account);
    if (used) { toast(`此成員已被${used}引用，無法刪除`); return; }
    Confirm.open(`確定刪除成員「${m.alias}」（帳號 ${m.account}）？`, () => {
      Repo.deleteMember(m.account);
      FirebaseSync.deleteMember(m.account);
      renderMembers();
      toast('已刪除成員');
    });
  }

  /* ---------- 視圖切換時的渲染分派 ---------- */
  function onShow(viewId) {
    setTopbar(viewId);
    switch (viewId) {
      case 'view-home':      renderHome(); break;
      case 'view-trips':     renderTrips(); break;
      case 'view-newtrip':   renderNewTrip(); break;
      case 'view-editor':    renderEditor(); break;
      case 'view-expense':   renderExpense(); break;
      case 'view-settlement': renderSettlement(); break;
      case 'view-photo':     renderPhotos(); break;
      case 'view-docs':      renderDocs(); break;
      case 'view-reminders': renderReminders(); break;
      case 'view-timetable': renderTimetable(); break;
      case 'view-members':   renderMembers(); break;
      case 'view-settings':  renderSettings(); break;
    }
  }

  /* ---------- 初始化 ---------- */
  function syncThemeIcon() {
    // 顯示「切換後會變成的模式」：暗色時顯示 ☀️（點了變亮），亮色時顯示 🌙
    $('btnTheme').textContent = Theme.isLight() ? '🌙' : '☀️';
  }

  async function init() {
    // 小範圍試點：開機時嘗試從 Firestore 載入資料覆寫假資料；失敗則沿用 data.js 假資料。
    try {
      const ok = await FirebaseSync.hydrate();
      if (ok) toast('已從雲端載入資料');
    } catch (e) {
      console.warn('[FirebaseSync] hydrate failed, fallback to local mock data', e);
    }

    Theme.apply(Theme.get());           // 套用已記住的主題
    Palette.apply(Palette.get());       // 套用已記住的夜間配色方案
    syncThemeIcon();
    $('btnTheme').addEventListener('click', () => { Theme.toggle(); syncThemeIcon(); });
    $('btnBack').addEventListener('click', () => Router.back());
    $('btnCreateFirst').addEventListener('click', () => { state.editingTripId = null; Router.show('view-newtrip'); });
    $('btnAddTrip').addEventListener('click', () => { state.editingTripId = null; Router.show('view-newtrip'); });
    $('btnSettings').addEventListener('click', () => {
      if (!Auth.isAdmin()) { toast('僅管理員可進入系統管理設定'); return; }
      Router.show('view-admin');
    });
    document.querySelectorAll('.settings-item[data-go]').forEach(el =>
      el.addEventListener('click', () => Router.show(el.dataset.go)));
    $('btnPaletteSettings').addEventListener('click', () => openPaletteSettings());
    $('btnAddMember').addEventListener('click', () => addMember());
    // 班表庫：班表/別名 切換 + 匯入/新增
    $('timetableModes').querySelectorAll('.seg__btn').forEach(b =>
      b.addEventListener('click', () => { state.timetableMode = b.dataset.mode; renderTimetable(); }));
    $('btnImportTimetable').addEventListener('click', () => openImportTimetable());
    $('btnAddAlias').addEventListener('click', () => openAliasForm(null));
    $('simIdentity').addEventListener('change', (e) => {
      Auth.setAccount(e.target.value);    // prototype 模擬身分切換
      renderSettings();
      toast(`已切換為 ${Auth.currentAlias()}`);
    });
    // 費用日切換：左右箭頭捲動 + 滑動時更新箭頭狀態
    $('dayPrev').addEventListener('click', () => $('expenseDayTabs').scrollBy({ left: -160, behavior: 'smooth' }));
    $('dayNext').addEventListener('click', () => $('expenseDayTabs').scrollBy({ left: 160, behavior: 'smooth' }));
    $('expenseDayTabs').addEventListener('scroll', updateDayArrows);
    // 提醒：檢視切換 + 新增
    $('reminderModes').querySelectorAll('.seg__btn').forEach(b =>
      b.addEventListener('click', () => { state.reminderMode = b.dataset.mode; renderReminders(); }));
    $('btnAddReminder').addEventListener('click', () => openReminderForm(null));
    // 文件：檢視切換 + 上傳
    $('docModes').querySelectorAll('.seg__btn').forEach(b =>
      b.addEventListener('click', () => { state.docMode = b.dataset.mode; renderDocs(); }));
    $('btnUploadDoc').addEventListener('click', () => openUploadDoc());
    $('btnAddPhoto').addEventListener('click', () => openAddPhoto());
    bindNewTripForm();
    bindEditor();
    bindExpense();
    bindSettlement();
    Router.reset('view-home');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { onShow, moveStation, moveStationToPool, state };
})();

/* ---------- 簡易 Modal ---------- */
const Modal = (() => {
  let onOk = null;
  function open(title, bodyHtml, okHandler) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modal').hidden = false;
    onOk = okHandler;
  }
  function close() { document.getElementById('modal').hidden = true; onOk = null; }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('modalCancel').addEventListener('click', close);
    document.getElementById('modalOk').addEventListener('click', () => {
      if (onOk && onOk() === false) return; // 驗證失敗不關閉
      close();
    });
  });
  return { open, close };
})();

/* ---------- 全域刪除確認（統一所有刪除動作） ---------- */
const Confirm = (() => {
  let onOk = null;
  function open(message, okHandler) {
    document.getElementById('confirmMsg').textContent = message;
    document.getElementById('confirmModal').hidden = false;
    onOk = okHandler;
  }
  function close() { document.getElementById('confirmModal').hidden = true; onOk = null; }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('confirmCancel').addEventListener('click', close);
    document.getElementById('confirmOk').addEventListener('click', () => {
      const fn = onOk; close(); if (fn) fn();
    });
  });
  return { open, close };
})();
