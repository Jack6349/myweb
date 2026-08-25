/* travel-expense — Prototype UI 邏輯。
 * 純畫面驗證：不寫真後端、不做持久化，所有狀態存在記憶體（EXPENSES/TRIPS/MEMBERS 見 data.js）。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    view: 'home', // 'home' | 'list' | 'settle' | 'notes' | 'trips' | 'members'
    currentTripId: TRIPS[0].id, // 目前作用中的行程，費用/結算/記事皆以此為篩選依據
    expenseGroupBy: 'date', // 費用列表分組方式：'date' | 'category' | 'payMethod'
    noteMode: 'date',       // 記事分組方式：'date' | 'category'
  };

  const VIEW_TITLE = { home: '首頁', list: '費用', settle: '結算', notes: '記事', trips: '行程設定', members: '成員設定' };
  const FAB_HIDDEN_VIEWS = new Set(['home', 'settle']);

  /* ================= 主題（日夜模式） =================
   * 比照 travel-v2：深色為預設，html.light 為日間；選擇以 localStorage 記住。
   */
  const Theme = {
    KEY: 'tex-theme',
    get() { try { return localStorage.getItem(this.KEY) || 'dark'; } catch (e) { return 'dark'; } },
    apply(t) { document.documentElement.classList.toggle('light', t === 'light'); },
    set(t) { try { localStorage.setItem(this.KEY, t); } catch (e) {} this.apply(t); },
    toggle() { const n = this.get() === 'dark' ? 'light' : 'dark'; this.set(n); return n; },
    isLight() { return this.get() === 'light'; },
  };

  // 顯示「切換後會變成的模式」：暗色時顯示 ☀️（點了變亮），亮色時顯示 🌙
  function syncThemeIcon() {
    $('btnTheme').textContent = Theme.isLight() ? '🌙' : '☀️';
  }

  // 今天日期字串（YYYY-MM-DD，依本機時區），新增費用時預設帶入
  function todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /* ================= Toast ================= */
  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 1800);
  }

  /* ================= 底部彈出 Sheet 共用元件 ================= */
  const backdrop = $('sheetBackdrop');
  const modalRoot = $('modalRoot');

  function closeSheet() {
    modalRoot.innerHTML = '';
    backdrop.classList.remove('is-open');
  }
  backdrop.addEventListener('click', closeSheet);

  // 開啟一個底部彈出 sheet，innerHtml 為內容，回傳容器供後續綁定事件
  function openSheet(innerHtml) {
    modalRoot.innerHTML = `<div class="sheet">${innerHtml}</div>`;
    backdrop.classList.add('is-open');
    return modalRoot.querySelector('.sheet');
  }

  /* ================= 畫面切換（首頁卡片與底部導覽共用） ================= */
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.bottomnav__tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $('topbarTitle').textContent = VIEW_TITLE[view];
    const trip = tripById(state.currentTripId);
    const showsTripName = view === 'list' || view === 'settle' || view === 'notes' || view === 'home';
    $('topbarSub').textContent = showsTripName && trip ? trip.name : '';
    $('fabAdd').style.display = FAB_HIDDEN_VIEWS.has(view) ? 'none' : '';
    render();
  }

  document.querySelectorAll('.bottomnav__tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  /* ================= FAB：依畫面情境切換 ================= */
  $('fabAdd').addEventListener('click', () => {
    if (state.view === 'members') { openMemberForm(null); return; }
    if (state.view === 'trips') { openTripForm(null); return; }
    if (state.view === 'notes') { openNoteForm(null); return; }
    if (state.view === 'list') {
      const sheet = openSheet(`
        <div class="sheet__handle"></div>
        <div class="sheet__title">新增費用</div>
        <button type="button" class="action-item" id="actCamera"><span class="action-item__icon">📸</span>拍照記帳（開啟相機）</button>
        <button type="button" class="action-item" id="actGallery"><span class="action-item__icon">🖼️</span>從相簿選擇收據</button>
        <button type="button" class="action-item" id="actManual"><span class="action-item__icon">✏️</span>手動輸入</button>
      `);
      sheet.querySelector('#actCamera').addEventListener('click', () => { closeSheet(); pickReceiptImage(true); });
      sheet.querySelector('#actGallery').addEventListener('click', () => { closeSheet(); pickReceiptImage(false); });
      sheet.querySelector('#actManual').addEventListener('click', () => { closeSheet(); openExpenseForm(null); });
    }
  });

  /* ================= 收據拍照／選圖 ================= */
  const cameraInput = $('cameraInput');
  const galleryInput = $('galleryInput');

  // useCamera=true 觸發手機相機；false 觸發相簿/檔案選擇
  function pickReceiptImage(useCamera) {
    const input = useCamera ? cameraInput : galleryInput;
    input.value = ''; // 清空，允許重複選同一張
    input.click();
  }

  function handlePickedFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => startReceiptScan(reader.result);
    reader.readAsDataURL(file);
  }
  cameraInput.addEventListener('change', (e) => handlePickedFile(e.target.files[0]));
  galleryInput.addEventListener('change', (e) => handlePickedFile(e.target.files[0]));

  /* ================= 收據辨識流程（已取得照片後） ================= */
  // imageDataUrl：使用者實際拍攝/選取的照片（base64），交給辨識服務與後續畫面預覽
  function startReceiptScan(imageDataUrl) {
    const sheet = openSheet(`
      <div class="sheet__handle"></div>
      <div class="sheet__title">收據辨識中</div>
      ${imageDataUrl ? `<img src="${imageDataUrl}" class="scan-photo-preview">` : ''}
      <div class="scan-spinner-wrap">
        <div class="scan-spinner"></div>
        <div class="scan-spinner-text">辨識中：OCR 擷取文字 → 翻譯 → 拆解品項…</div>
      </div>
    `);
    ReceiptService.scan(imageDataUrl).then((result) => {
      if (!modalRoot.contains(sheet)) return; // 使用者已關閉
      showScanResult(result, imageDataUrl);
    }).catch((err) => {
      if (!modalRoot.contains(sheet)) return; // 使用者已關閉
      closeSheet();
      toast('辨識失敗：' + err.message);
    });
  }

  // 顯示辨識結果，可編輯品項後帶入費用表單
  function showScanResult(result, imageDataUrl) {
    const items = result.items.map((it, i) => ({
      id: 'ri-' + i, name: it.name, qty: it.qty, amount: it.amount,
    }));
    const lowConf = (result.confidence.items || 1) < 0.75;

    function renderList() {
      const sheet = openSheet(`
        <div class="sheet__handle"></div>
        <div class="sheet__title">確認辨識結果</div>
        ${imageDataUrl ? `<img src="${imageDataUrl}" class="scan-photo-preview scan-photo-preview--sm">` : ''}
        <div class="scan-banner">🧾 店家：${result.merchant}・幣別 ${result.currency}
          ${lowConf ? '<b>（品項辨識信心較低，請仔細核對）</b>' : ''}
        </div>
        <div id="riList"></div>
        <button type="button" class="btn btn--mini" id="riAdd" style="margin-bottom:14px;">＋ 新增品項</button>
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" id="riCancel">取消</button>
          <button type="button" class="btn btn--primary" id="riNext">下一步</button>
        </div>
      `);
      const listEl = sheet.querySelector('#riList');
      items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'item-row';
        row.innerHTML = `
          <div class="item-row__top">
            <input class="item-row__name" value="${it.name}" data-field="name">
          </div>
          <div class="item-row__top" style="margin-top:6px;">
            <span class="item-row__meta">數量</span>
            <input class="item-row__qty" type="number" min="1" value="${it.qty}" data-field="qty">
            <span class="item-row__meta">金額</span>
            <input class="item-row__amount" type="number" value="${it.amount}" data-field="amount">
            <button type="button" class="btn btn--mini btn--danger" data-del="1">✕</button>
          </div>
        `;
        row.querySelector('[data-field="name"]').addEventListener('input', (e) => { it.name = e.target.value; });
        row.querySelector('[data-field="qty"]').addEventListener('input', (e) => { it.qty = parseInt(e.target.value, 10) || 1; });
        row.querySelector('[data-field="amount"]').addEventListener('input', (e) => { it.amount = parseFloat(e.target.value) || 0; });
        row.querySelector('[data-del]').addEventListener('click', () => {
          const idx = items.indexOf(it);
          if (idx >= 0) items.splice(idx, 1);
          renderList();
        });
        listEl.appendChild(row);
      });

      sheet.querySelector('#riAdd').addEventListener('click', () => {
        items.push({ id: 'ri-new-' + Date.now(), name: '新品項', qty: 1, amount: 0 });
        renderList();
      });
      sheet.querySelector('#riCancel').addEventListener('click', closeSheet);
      sheet.querySelector('#riNext').addEventListener('click', () => {
        if (!items.length) { toast('請至少保留一個品項'); return; }
        closeSheet();
        const total = items.reduce((a, i) => a + i.amount, 0);
        openExpenseForm({
          fromReceipt: true,
          merchant: result.merchant,
          currency: result.currency,
          amount: total,
          items: items.map((i) => ({ name: i.name, qty: i.qty, amount: i.amount, split: [] })),
        });
      });
    }
    renderList();
  }

  /* ================= 費用表單（新增/編輯，含分攤指定） ================= */
  // prefill：來自收據辨識的預填資料（含 items），null 表手動新增
  // existing：要編輯的既有費用（EXPENSES 內的物件），有值即為編輯模式
  function openExpenseForm(prefill, existing) {
    const fromScan = !!(prefill && prefill.fromReceipt);
    const hasItems = fromScan && Array.isArray(prefill.items) && prefill.items.length > 0;
    const trip = tripById(state.currentTripId);
    const members = tripMembers(state.currentTripId); // 此行程的參與成員，非全域成員
    const editing = !!existing;

    const sel = editing ? {
      category: existing.category,
      payMethod: existing.payMethod,
      currency: existing.currency,
      payer: existing.payer,
      amount: existing.amount,
      date: existing.date || todayStr(),
      mode: existing.items && existing.items.length ? 'items' : 'simple',
      split: new Set(existing.split),
      items: (existing.items || []).map((it, i) => ({ id: 'fi-' + i, name: it.name, qty: it.qty, amount: it.amount, split: [...it.split] })),
      note: existing.note || '',
    } : {
      category: EXPENSE_CATEGORIES[0].key,
      payMethod: PAYMENT_METHODS[0],
      currency: (prefill && prefill.currency) || (trip ? trip.currency : CURRENCIES[0]),
      payer: members.some((m) => m.account === ME) ? ME : (members[0] ? members[0].account : ME),
      amount: undefined,
      date: todayStr(), // 預設為當日，可手動修改
      mode: hasItems ? 'items' : 'simple',
      split: new Set(members.map((m) => m.account)),
      items: hasItems ? prefill.items.map((it, i) => ({ id: 'fi-' + i, name: it.name, qty: it.qty, amount: it.amount, split: [] })) : [],
      note: fromScan ? (prefill.merchant || '') : '',
    };

    function itemsAssignedCount() { return sel.items.filter((i) => i.split.length > 0).length; }
    function itemsSum() { return sel.items.reduce((a, i) => a + (i.amount || 0), 0); }

    function render() {
      const sheet = openSheet(`
        <div class="sheet__handle"></div>
        <div class="sheet__title">${editing ? '編輯費用' : (fromScan ? '確認費用（收據辨識）' : '新增費用')}</div>
        ${fromScan ? `<div class="scan-banner">🧾 店家：${prefill.merchant || '—'}，欄位已預填，請核對後儲存。</div>` : ''}

        <div class="field">
          <div class="field__label">分類</div>
          <div class="chip-cards" id="f_cats">
            ${EXPENSE_CATEGORIES.map((c) => `<button type="button" class="chip-card ${sel.category === c.key ? 'is-on' : ''}" data-cat="${c.key}">${c.icon} ${c.key}</button>`).join('')}
          </div>
        </div>

        <label class="form-label">日期<input id="f_date" type="date" value="${sel.date}"></label>

        <label class="form-label">備註（可選）<input id="f_note" value="${sel.note}" placeholder="如 午餐 拉麵"></label>

        <div class="field">
          <div class="field__label">付款方式</div>
          <div class="chips" id="f_pm">${PAYMENT_METHODS.map((p) => `<button type="button" class="chip ${sel.payMethod === p ? 'is-on' : ''}" data-pm="${p}">${p}</button>`).join('')}</div>
        </div>

        <div class="amount-row">
          <label class="form-label grow">金額${sel.mode === 'items' ? '（分項加總）' : ''}
            <input id="f_amount" type="number" inputmode="numeric" value="${sel.mode === 'items' ? itemsSum() : (sel.amount != null ? sel.amount : '')}" ${sel.mode === 'items' ? 'readonly' : ''}>
          </label>
          <label class="form-label">幣別
            <select id="f_currency">${CURRENCIES.map((c) => `<option value="${c}" ${c === sel.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
          </label>
        </div>

        <label class="form-label">付款人
          <select id="f_payer">${members.map((m) => `<option value="${m.account}" ${m.account === sel.payer ? 'selected' : ''}>${m.alias}${m.account === ME ? '(我)' : ''}</option>`).join('')}</select>
        </label>

        <div class="field">
          <div class="field__label">分攤方式</div>
          <div class="chip-cards chip-cards--2" id="f_mode">
            <button type="button" class="chip-card ${sel.mode === 'simple' ? 'is-on' : ''}" data-mode="simple">簡單模式</button>
            <button type="button" class="chip-card ${sel.mode === 'items' ? 'is-on' : ''}" data-mode="items">分項模式</button>
          </div>
        </div>

        <div class="field" id="f_split_simple" ${sel.mode !== 'simple' ? 'hidden' : ''}>
          <div class="field__label">分攤對象</div>
          <div class="chip-cards" id="f_split">
            ${members.map((m) => `<button type="button" class="chip-card ${sel.split.has(m.account) ? 'is-on' : ''}" data-acc="${m.account}">${m.alias}${m.account === ME ? '(我)' : ''}</button>`).join('')}
          </div>
        </div>

        <div class="field" id="f_split_items" ${sel.mode !== 'items' ? 'hidden' : ''}>
          <div class="field__label">品項與分攤對象（已分配 ${itemsAssignedCount()}/${sel.items.length} 項）</div>
          <div id="f_items_list"></div>
          <button type="button" class="btn btn--mini" id="f_items_add">＋ 新增品項</button>
        </div>

        <div class="btn-row">
          <button type="button" class="btn btn--ghost" id="f_cancel">取消</button>
          <button type="button" class="btn btn--primary" id="f_save">儲存</button>
        </div>
      `);

      sheet.querySelectorAll('#f_cats [data-cat]').forEach((b) => b.addEventListener('click', () => { sel.category = b.dataset.cat; render(); }));
      sheet.querySelectorAll('#f_pm [data-pm]').forEach((b) => b.addEventListener('click', () => { sel.payMethod = b.dataset.pm; render(); }));
      sheet.querySelector('#f_currency').addEventListener('change', (e) => { sel.currency = e.target.value; });
      sheet.querySelector('#f_payer').addEventListener('change', (e) => { sel.payer = e.target.value; });
      sheet.querySelector('#f_date').addEventListener('change', (e) => { sel.date = e.target.value; });
      sheet.querySelector('#f_note').addEventListener('input', (e) => { sel.note = e.target.value; });

      sheet.querySelectorAll('#f_mode [data-mode]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.mode === 'items' && !sel.items.length) {
          sel.items.push({ id: 'fi-' + Date.now(), name: '品項1', qty: 1, amount: 0, split: [] });
        }
        sel.mode = b.dataset.mode;
        render();
      }));

      if (sel.mode === 'simple') {
        sheet.querySelectorAll('#f_split [data-acc]').forEach((b) => b.addEventListener('click', () => {
          const a = b.dataset.acc;
          if (sel.split.has(a)) sel.split.delete(a); else sel.split.add(a);
          b.classList.toggle('is-on');
        }));
      } else {
        renderItemsList();
        sheet.querySelector('#f_items_add').addEventListener('click', () => {
          sel.items.push({ id: 'fi-' + Date.now(), name: '新品項', qty: 1, amount: 0, split: [] });
          render();
        });
      }

      // 分項模式：直接在表單內編輯每個品項的名稱/數量/金額，並勾選該品項的分攤對象，不再跳子畫面
      function renderItemsList() {
        const listEl = sheet.querySelector('#f_items_list');
        listEl.innerHTML = '';
        sel.items.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'item-row';
          row.innerHTML = `
            <div class="item-row__top">
              <input class="item-row__name" value="${it.name}" data-field="name">
              <button type="button" class="btn btn--mini btn--danger" data-del="1">✕</button>
            </div>
            <div class="item-row__top" style="margin-top:6px;">
              <span class="item-row__meta">數量</span>
              <input class="item-row__qty" type="number" min="1" value="${it.qty}" data-field="qty">
              <span class="item-row__meta">金額</span>
              <input class="item-row__amount" type="number" value="${it.amount}" data-field="amount">
            </div>
            <div class="item-row__split">
              ${members.map((m) => `<button type="button" class="chip-card ${it.split.includes(m.account) ? 'is-on' : ''}" data-acc="${m.account}">${m.alias}${m.account === ME ? '(我)' : ''}</button>`).join('')}
            </div>
          `;
          row.querySelector('[data-field="name"]').addEventListener('input', (e) => { it.name = e.target.value; });
          row.querySelector('[data-field="qty"]').addEventListener('input', (e) => { it.qty = parseInt(e.target.value, 10) || 1; });
          row.querySelector('[data-field="amount"]').addEventListener('input', (e) => {
            it.amount = parseFloat(e.target.value) || 0;
            const amountInput = sheet.querySelector('#f_amount');
            if (amountInput) amountInput.value = itemsSum();
          });
          row.querySelector('[data-del]').addEventListener('click', () => {
            const idx = sel.items.indexOf(it);
            if (idx >= 0) sel.items.splice(idx, 1);
            render();
          });
          row.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', () => {
            const a = b.dataset.acc;
            const i = it.split.indexOf(a);
            if (i >= 0) it.split.splice(i, 1); else it.split.push(a);
            b.classList.toggle('is-on');
            const label = sheet.querySelector('#f_split_items .field__label');
            if (label) label.textContent = `品項與分攤對象（已分配 ${itemsAssignedCount()}/${sel.items.length} 項）`;
          }));
          listEl.appendChild(row);
        });
      }

      sheet.querySelector('#f_cancel').addEventListener('click', closeSheet);
      sheet.querySelector('#f_save').addEventListener('click', () => {
        if (!sel.category) { toast('請選擇分類'); return; }
        let amount, split, items;
        if (sel.mode === 'simple') {
          amount = parseFloat(sheet.querySelector('#f_amount').value);
          if (!(amount > 0)) { toast('請輸入金額'); return; }
          if (sel.split.size === 0) { toast('至少一位分攤對象'); return; }
          split = [...sel.split];
          items = undefined;
        } else {
          if (!sel.items.length) { toast('請至少新增一個品項'); return; }
          if (itemsAssignedCount() < sel.items.length) { toast('尚有品項未指定分攤對象'); return; }
          amount = itemsSum();
          split = [...new Set(sel.items.flatMap((i) => i.split))];
          items = sel.items.map((i) => ({ name: i.name, qty: i.qty, amount: i.amount, split: i.split }));
        }
        if (editing) {
          Object.assign(existing, {
            category: sel.category,
            note: sel.note.trim(),
            amount,
            currency: sel.currency,
            payMethod: sel.payMethod,
            payer: sel.payer,
            date: sel.date,
            split,
            items,
          });
          closeSheet();
          toast('已更新費用');
        } else {
          EXPENSES.push({
            id: 'e-' + Date.now(),
            tripId: state.currentTripId,
            category: sel.category,
            note: sel.note.trim(),
            amount,
            currency: sel.currency,
            payMethod: sel.payMethod,
            payer: sel.payer,
            date: sel.date,
            split,
            items,
            fromReceipt: fromScan || undefined,
          });
          closeSheet();
          toast('已新增費用');
        }
        renderExpenseList();
      });
    }
    render();
  }

  /* ================= 首頁：目前行程 + 功能卡片 ================= */
  function renderHome() {
    const wrap = $('app');
    const trip = tripById(state.currentTripId);
    wrap.innerHTML = `
      <div class="home-trip-banner">
        <div class="home-trip-banner__label">目前行程</div>
        <div class="home-trip-banner__name">${trip ? trip.name : '尚未選擇行程'}</div>
        ${trip ? `<div class="home-trip-banner__dates">${tripDateLabel(trip)}・幣別 ${trip.currency}・${tripMembers(trip.id).length} 人</div>` : ''}
        <button type="button" class="home-trip-banner__switch" id="homeSwitchTrip">切換行程 →</button>
      </div>
      <div class="home-cards">
        <button type="button" class="home-card" data-go="scan">
          <div class="home-card__icon">📷</div>
          <div class="home-card__label">拍照記帳</div>
          <div class="home-card__sub">收據辨識</div>
        </button>
        <button type="button" class="home-card" data-go="list">
          <div class="home-card__icon">🧾</div>
          <div class="home-card__label">費用紀錄</div>
          <div class="home-card__sub">查看／新增</div>
        </button>
        <button type="button" class="home-card" data-go="settle">
          <div class="home-card__icon">📊</div>
          <div class="home-card__label">結算</div>
          <div class="home-card__sub">分攤淨額</div>
        </button>
        <button type="button" class="home-card" data-go="notes">
          <div class="home-card__icon">📝</div>
          <div class="home-card__label">記事</div>
          <div class="home-card__sub">${notePendingCount()} 件未完成</div>
        </button>
        <button type="button" class="home-card" data-go="trips">
          <div class="home-card__icon">🧳</div>
          <div class="home-card__label">行程設定</div>
          <div class="home-card__sub">新增／切換</div>
        </button>
        <button type="button" class="home-card" data-go="members">
          <div class="home-card__icon">👥</div>
          <div class="home-card__label">成員設定</div>
          <div class="home-card__sub">基本資料</div>
        </button>
      </div>
    `;
    wrap.querySelector('#homeSwitchTrip').addEventListener('click', () => switchView('trips'));
    wrap.querySelectorAll('.home-card').forEach((b) => b.addEventListener('click', () => {
      const go = b.dataset.go;
      if (go === 'scan') {
        switchView('list');
        const sheet = openSheet(`
          <div class="sheet__handle"></div>
          <div class="sheet__title">拍照記帳</div>
          <button type="button" class="action-item" id="actCamera2"><span class="action-item__icon">📸</span>開啟相機</button>
          <button type="button" class="action-item" id="actGallery2"><span class="action-item__icon">🖼️</span>從相簿選擇收據</button>
        `);
        sheet.querySelector('#actCamera2').addEventListener('click', () => { closeSheet(); pickReceiptImage(true); });
        sheet.querySelector('#actGallery2').addEventListener('click', () => { closeSheet(); pickReceiptImage(false); });
        return;
      }
      switchView(go);
    }));
  }

  /* ================= 行程設定 ================= */
  function renderTrips() {
    const wrap = $('app');
    let html = '<div class="section-title">我的行程</div>';
    TRIPS.forEach((t) => {
      const isCurrent = t.id === state.currentTripId;
      html += `
        <div class="settings-row ${isCurrent ? 'is-current' : ''}">
          <div class="settings-row__icon">🧳</div>
          <div class="settings-row__body">
            <div class="settings-row__title">${t.name}${isCurrent ? '<span class="badge-current">目前行程</span>' : ''}</div>
            <div class="settings-row__sub">${tripDateLabel(t)}・幣別 ${t.currency}・${tripMembers(t.id).length} 人</div>
          </div>
          <div class="settings-row__actions">
            ${isCurrent ? '' : `<button type="button" class="btn btn--mini" data-switch="${t.id}">切換</button>`}
            <button type="button" class="btn btn--mini" data-edit="${t.id}">編輯</button>
            <button type="button" class="btn btn--mini btn--danger" data-del="${t.id}">刪除</button>
          </div>
        </div>
      `;
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => {
      state.currentTripId = b.dataset.switch;
      toast('已切換行程：' + tripById(state.currentTripId).name);
      renderTrips();
    }));
    wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openTripForm(b.dataset.edit)));
    wrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const r = removeTrip(b.dataset.del);
      if (!r.ok) { toast(r.reason); return; }
      if (state.currentTripId === b.dataset.del) state.currentTripId = TRIPS[0].id;
      toast('已刪除行程');
      renderTrips();
    }));
  }

  // id 為 null 表新增行程，否則為編輯
  function openTripForm(id) {
    const editing = tripById(id);
    const sel = {
      name: editing ? editing.name : '',
      start: editing ? editing.start : '',
      end: editing ? editing.end : '',
      currency: editing ? editing.currency : CURRENCIES[0],
      members: new Set(editing ? editing.members : [ME]),
    };

    function render() {
      const sheet = openSheet(`
        <div class="sheet__handle"></div>
        <div class="sheet__title">${editing ? '編輯行程' : '新增行程'}</div>
        <label class="form-label">行程名稱<input id="t_name" value="${sel.name}" placeholder="如 2026 北海道初夏"></label>
        <div class="amount-row">
          <label class="form-label grow">開始日期<input id="t_start" type="date" value="${sel.start}"></label>
          <label class="form-label grow">結束日期<input id="t_end" type="date" value="${sel.end}"></label>
        </div>
        <label class="form-label">預設幣別
          <select id="t_currency">${CURRENCIES.map((c) => `<option value="${c}" ${c === sel.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </label>
        <div class="field">
          <div class="field__label">參與成員</div>
          <div class="chip-cards" id="t_members">
            ${MEMBERS.map((m) => `<button type="button" class="chip-card ${sel.members.has(m.account) ? 'is-on' : ''}" data-acc="${m.account}" ${m.account === ME ? 'disabled' : ''}>${m.alias}${m.account === ME ? '(我)' : ''}</button>`).join('')}
          </div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" id="t_cancel">取消</button>
          <button type="button" class="btn btn--primary" id="t_save">儲存</button>
        </div>
      `);
      sheet.querySelector('#t_name').addEventListener('input', (e) => { sel.name = e.target.value; });
      sheet.querySelector('#t_start').addEventListener('input', (e) => { sel.start = e.target.value; });
      sheet.querySelector('#t_end').addEventListener('input', (e) => { sel.end = e.target.value; });
      sheet.querySelector('#t_currency').addEventListener('change', (e) => { sel.currency = e.target.value; });
      sheet.querySelectorAll('#t_members [data-acc]').forEach((b) => b.addEventListener('click', () => {
        const a = b.dataset.acc;
        if (sel.members.has(a)) sel.members.delete(a); else sel.members.add(a);
        b.classList.toggle('is-on');
      }));
      sheet.querySelector('#t_cancel').addEventListener('click', closeSheet);
      sheet.querySelector('#t_save').addEventListener('click', () => {
        if (!sel.name.trim()) { toast('請輸入行程名稱'); return; }
        if (!sel.start || !sel.end) { toast('請選擇開始與結束日期'); return; }
        if (sel.start > sel.end) { toast('開始日期不可晚於結束日期'); return; }
        if (sel.members.size === 0) { toast('至少一位參與成員'); return; }
        const data = { name: sel.name.trim(), start: sel.start, end: sel.end, currency: sel.currency, members: [...sel.members] };
        if (editing) updateTrip(id, data);
        else { const t = addTrip(data); state.currentTripId = t.id; }
        closeSheet();
        toast(editing ? '已更新行程' : '已新增行程');
        renderTrips();
      });
    }
    render();
  }

  /* ================= 人員資料設定（全域基本資料） ================= */
  function renderMembers() {
    const wrap = $('app');
    let html = '<div class="section-title">隨行成員（基本資料）</div>';
    MEMBERS.forEach((m) => {
      html += `
        <div class="settings-row">
          <div class="settings-row__icon">👤</div>
          <div class="settings-row__body">
            <div class="settings-row__title">${m.alias}${m.account === ME ? '<span class="badge-current">我</span>' : ''}</div>
            <div class="settings-row__sub">帳號 ${m.account}</div>
          </div>
          <div class="settings-row__actions">
            <button type="button" class="btn btn--mini" data-edit="${m.account}">改名</button>
            ${m.account === ME ? '' : `<button type="button" class="btn btn--mini btn--danger" data-del="${m.account}">刪除</button>`}
          </div>
        </div>
      `;
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openMemberForm(b.dataset.edit)));
    wrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const r = removeMember(b.dataset.del);
      if (!r.ok) { toast(r.reason); return; }
      toast('已刪除成員');
      renderMembers();
    }));
  }

  // account 為 null 表新增成員，否則為改名
  function openMemberForm(account) {
    const editing = MEMBERS.find((m) => m.account === account);
    const sheet = openSheet(`
      <div class="sheet__handle"></div>
      <div class="sheet__title">${editing ? '修改成員別名' : '新增成員'}</div>
      <label class="form-label">別名<input id="mf_alias" value="${editing ? editing.alias : ''}" placeholder="如 妹妹"></label>
      ${editing ? '' : '<div class="scan-banner">新增後可到「行程設定」把此成員加入指定行程。</div>'}
      <div class="btn-row">
        <button type="button" class="btn btn--ghost" id="mf_cancel">取消</button>
        <button type="button" class="btn btn--primary" id="mf_save">儲存</button>
      </div>
    `);
    sheet.querySelector('#mf_cancel').addEventListener('click', closeSheet);
    sheet.querySelector('#mf_save').addEventListener('click', () => {
      const alias = sheet.querySelector('#mf_alias').value.trim();
      if (!alias) { toast('請輸入別名'); return; }
      if (aliasExists(alias, account)) { toast('別名已存在'); return; }
      if (editing) renameMember(account, alias);
      else addMember(alias);
      closeSheet();
      toast(editing ? '已更新別名' : '已新增成員');
      renderMembers();
    });
  }

  const GROUP_BY_OPTIONS = [
    { key: 'date', label: '日期' },
    { key: 'category', label: '類別' },
    { key: 'payMethod', label: '付款方式' },
  ];

  // 依目前分組方式，把費用陣列切成有序的分組（每組含 label 與該組費用清單）
  function groupExpenses(list) {
    if (state.expenseGroupBy === 'date') {
      const byDate = {};
      list.forEach((e) => { (byDate[e.date || '未指定日期'] = byDate[e.date || '未指定日期'] || []).push(e); });
      return Object.keys(byDate).sort((a, b) => b.localeCompare(a)) // 日期新到舊
        .map((d) => ({ label: d, items: byDate[d] }));
    }
    if (state.expenseGroupBy === 'category') {
      const order = EXPENSE_CATEGORIES.map((c) => c.key);
      const byCat = {};
      list.forEach((e) => { (byCat[e.category] = byCat[e.category] || []).push(e); });
      return order.filter((k) => byCat[k]).map((k) => ({ label: `${catIconOf(k)} ${k}`, items: byCat[k] }));
    }
    // payMethod
    const order = PAYMENT_METHODS;
    const byPM = {};
    list.forEach((e) => { (byPM[e.payMethod] = byPM[e.payMethod] || []).push(e); });
    return order.filter((k) => byPM[k]).map((k) => ({ label: k, items: byPM[k] }));
  }

  // 一組費用的各幣別加總，例："JPY 5,300・TWD 1,200"
  function currencyTotalsText(items) {
    const totals = {};
    items.forEach((e) => { totals[e.currency] = (totals[e.currency] || 0) + e.amount; });
    return Object.keys(totals).sort()
      .map((cur) => `${cur} ${Math.round(totals[cur]).toLocaleString()}`)
      .join('・');
  }

  function expenseCardHtml(e) {
    const tags = e.split.map((acc) => `<span class="split-tag">${aliasOf(acc)}</span>`).join('');
    return `
      <div class="exp-card__icon">${catIconOf(e.category)}</div>
      <div class="exp-card__body">
        <div class="exp-card__title">${e.note || e.category}${e.fromReceipt ? ' 📷' : ''}</div>
        <div class="exp-card__sub">付款：${aliasOf(e.payer)}${e.payer === ME ? '(我)' : ''}・${e.payMethod}・分攤 ${e.split.length} 人</div>
        <div class="split-tags">${tags}</div>
      </div>
      <div class="exp-card__amount"><b>${e.amount.toLocaleString()}</b><span>${e.currency}</span></div>
    `;
  }

  /* ================= 費用列表（僅顯示目前行程） ================= */
  function renderExpenseList() {
    const wrap = $('app');
    wrap.innerHTML = `
      <div class="chips" id="expenseGroupBy" style="margin-bottom:14px;">
        ${GROUP_BY_OPTIONS.map((g) => `<button type="button" class="chip ${state.expenseGroupBy === g.key ? 'is-on' : ''}" data-group="${g.key}">依${g.label}</button>`).join('')}
      </div>
      <div id="expenseList"></div>
    `;
    wrap.querySelectorAll('#expenseGroupBy [data-group]').forEach((b) => b.addEventListener('click', () => {
      state.expenseGroupBy = b.dataset.group;
      renderExpenseList();
    }));

    const listEl = $('expenseList');
    const list = EXPENSES.filter((e) => e.tripId === state.currentTripId);
    if (!list.length) {
      listEl.innerHTML = '<div class="empty-hint">此行程還沒有任何費用，點右下角＋新增一筆吧</div>';
      return;
    }
    const groups = groupExpenses([...list].reverse()); // 各組內由新到舊
    groups.forEach((g) => {
      const title = document.createElement('div');
      title.className = 'section-title section-title--with-total';
      title.innerHTML = `<span>${g.label}</span><span class="section-total">${currencyTotalsText(g.items)}</span>`;
      listEl.appendChild(title);
      g.items.forEach((e) => {
        const card = document.createElement('div');
        card.className = 'exp-card exp-card--clickable';
        card.innerHTML = expenseCardHtml(e);
        card.addEventListener('click', () => openExpenseForm(null, e));
        listEl.appendChild(card);
      });
    });
  }

  // 目前行程尚未完成的記事筆數（首頁卡片顯示用）
  function notePendingCount() {
    return NOTES.filter((n) => n.tripId === state.currentTripId && !n.done).length;
  }

  /* ================= 記事（比照 travel-v2 提醒功能） ================= */
  function renderNotes() {
    const wrap = $('app');
    wrap.innerHTML = `
      <div class="seg" id="noteModes">
        <button type="button" class="seg__btn ${state.noteMode === 'date' ? 'is-on' : ''}" data-mode="date">按日期</button>
        <button type="button" class="seg__btn ${state.noteMode === 'category' ? 'is-on' : ''}" data-mode="category">按類別</button>
      </div>
      <div id="noteList"></div>
    `;
    wrap.querySelectorAll('#noteModes .seg__btn').forEach((b) => b.addEventListener('click', () => {
      state.noteMode = b.dataset.mode;
      renderNotes();
    }));

    const listEl = $('noteList');
    const list = NOTES.filter((n) => n.tripId === state.currentTripId);
    if (!list.length) {
      listEl.innerHTML = '<div class="empty-hint">此行程尚無記事，點右下角＋新增一筆吧</div>';
      return;
    }

    // 分組：按類別（依定義序）或按日期（升冪，無日期＝全程置頂）
    const groups = {};
    if (state.noteMode === 'category') {
      list.forEach((n) => { (groups[n.category] = groups[n.category] || []).push(n); });
    } else {
      list.forEach((n) => { const k = n.date || '全程'; (groups[k] = groups[k] || []).push(n); });
    }
    let keys = Object.keys(groups);
    if (state.noteMode === 'category') keys.sort((a, b) => NOTE_CATEGORIES.indexOf(a) - NOTE_CATEGORIES.indexOf(b));
    else keys.sort((a, b) => (a === '全程' ? '' : a).localeCompare(b === '全程' ? '' : b));

    keys.forEach((k) => {
      const head = document.createElement('div');
      head.className = 'note-group';
      head.textContent = state.noteMode === 'category' ? k : (k === '全程' ? '全程（無日期）' : k);
      listEl.appendChild(head);
      groups[k].forEach((n) => listEl.appendChild(noteItem(n)));
    });
  }

  function noteItem(n) {
    const item = document.createElement('div');
    item.className = 'note-item' + (n.done ? ' is-done' : '');
    // 副資訊：日期模式顯示類別，類別模式顯示日期
    const sub = state.noteMode === 'category' ? (n.date || '全程') : n.category;
    item.innerHTML = `
      <button type="button" class="note-check ${n.done ? 'is-done' : ''}" aria-label="切換完成">${n.done ? '✓' : ''}</button>
      <div class="note-item__body">
        <div class="note-item__title">${n.text}</div>
        <div class="note-item__sub">${sub}・建立者 ${aliasOf(n.owner)}${n.owner === ME ? '(我)' : ''}</div>
      </div>
      <button type="button" class="btn btn--mini" data-act="edit">✎</button>
    `;
    item.querySelector('.note-check').addEventListener('click', () => {
      n.done = !n.done;
      renderNotes();
    });
    item.querySelector('[data-act="edit"]').addEventListener('click', () => openNoteForm(n));
    return item;
  }

  // existing 為 null 表新增記事，否則為編輯
  function openNoteForm(existing) {
    const n = existing || {};
    const sheet = openSheet(`
      <div class="sheet__handle"></div>
      <div class="sheet__title">${existing ? '編輯記事' : '新增記事'}</div>
      <label class="form-label">內容<input id="n_text" value="${(n.text || '').replace(/"/g, '&quot;')}" placeholder="如 兌換 JR Pass"></label>
      <label class="form-label">類別
        <select id="n_cat">${NOTE_CATEGORIES.map((c) => `<option ${c === n.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <label class="form-label">日期（留空＝全程）<input id="n_date" type="date" value="${n.date || ''}"></label>
      <label class="chk"><input type="checkbox" id="n_done" ${n.done ? 'checked' : ''}> 已完成</label>
      ${existing ? '<button type="button" class="btn btn--danger" id="n_delete" style="width:100%;margin-top:14px;">刪除此記事</button>' : ''}
      <div class="btn-row">
        <button type="button" class="btn btn--ghost" id="n_cancel">取消</button>
        <button type="button" class="btn btn--primary" id="n_save">儲存</button>
      </div>
    `);
    sheet.querySelector('#n_cancel').addEventListener('click', closeSheet);
    sheet.querySelector('#n_save').addEventListener('click', () => {
      const text = sheet.querySelector('#n_text').value.trim();
      if (!text) { toast('請輸入內容'); return; }
      const data = {
        text,
        category: sheet.querySelector('#n_cat').value,
        date: sheet.querySelector('#n_date').value,
        done: sheet.querySelector('#n_done').checked,
      };
      if (existing) Object.assign(existing, data);
      else addNote(state.currentTripId, data);
      closeSheet();
      toast(existing ? '已更新記事' : '已新增記事');
      renderNotes();
    });
    if (existing) {
      // 兩段式刪除：第一次點擊要求再確認，避免誤刪
      const delBtn = sheet.querySelector('#n_delete');
      let armed = false;
      delBtn.addEventListener('click', () => {
        if (!armed) { armed = true; delBtn.textContent = '確定刪除？再按一次'; return; }
        removeNote(existing.id);
        closeSheet();
        toast('已刪除記事');
        renderNotes();
      });
    }
  }

  /* ================= 結算頁（僅計算目前行程） ================= */
  function renderSettle() {
    const wrap = $('app');
    const list = EXPENSES.filter((e) => e.tripId === state.currentTripId);
    const members = tripMembers(state.currentTripId);
    // 依幣別分組計算：每人「付款總額」與「應分攤總額」
    const byCurrency = {};
    list.forEach((e) => {
      byCurrency[e.currency] = byCurrency[e.currency] || {};
      const bucket = byCurrency[e.currency];
      bucket[e.payer] = bucket[e.payer] || { paid: 0, owed: 0 };
      bucket[e.payer].paid += e.amount;
      const share = e.amount / e.split.length;
      e.split.forEach((acc) => {
        bucket[acc] = bucket[acc] || { paid: 0, owed: 0 };
        bucket[acc].owed += share;
      });
    });

    let html = '';
    const currencies = Object.keys(byCurrency);
    if (!currencies.length) {
      html = '<div class="empty-hint">此行程還沒有費用可結算</div>';
    } else {
      currencies.forEach((cur) => {
        html += `<div class="section-title">幣別 ${cur}</div>`;
        members.forEach((m) => {
          const rec = byCurrency[cur][m.account];
          if (!rec) return;
          const net = rec.paid - rec.owed; // 正 = 應收，負 = 應付
          const netCls = net > 0.5 ? 'is-get' : (net < -0.5 ? 'is-owe' : '');
          const netLabel = net > 0.5 ? `應收 +${Math.round(net).toLocaleString()}` : (net < -0.5 ? `應付 ${Math.round(net).toLocaleString()}` : '已結清');
          html += `
            <div class="settle-person">
              <div>
                <div class="settle-person__name">${m.alias}${m.account === ME ? '(我)' : ''}</div>
                <div class="settle-person__sub">付款 ${Math.round(rec.paid).toLocaleString()}・分攤 ${Math.round(rec.owed).toLocaleString()}</div>
              </div>
              <div class="settle-person__amount ${netCls}">${netLabel}</div>
            </div>
          `;
        });
      });
    }
    wrap.innerHTML = html;
  }

  /* ================= 主渲染分派 ================= */
  function render() {
    if (state.view === 'home') renderHome();
    else if (state.view === 'list') renderExpenseList();
    else if (state.view === 'notes') renderNotes();
    else if (state.view === 'trips') renderTrips();
    else if (state.view === 'members') renderMembers();
    else renderSettle();
  }

  /* ================= 初始化 ================= */
  Theme.apply(Theme.get());  // 套用已記住的主題
  syncThemeIcon();
  $('btnTheme').addEventListener('click', () => { Theme.toggle(); syncThemeIcon(); });

  switchView('home');
})();
