// 股利總管 模組：core — 資料層/狀態/導覽/日期/首頁/持股清單/Modal（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ── DATA LAYER (localStorage, 日後換成 Firebase) ──
const DB_KEY = 'dividend_app_portfolio';

function loadPortfolio() {
  try { return JSON.parse(localStorage.getItem(DB_KEY)) || []; }
  catch { return []; }
}
function savePortfolio(data) {
  localStorage.setItem(DB_KEY, JSON.stringify(data));
  localStorage.setItem(DIV_SYNC_TS_KEY, new Date().toISOString());
  showDivSyncStatus('儲存中…', '#f0cc7a');
  // debounce 1.5s 避免連續操作觸發多次 PUT
  if (_divSyncTimer) clearTimeout(_divSyncTimer);
  _divSyncTimer = setTimeout(function() {
    _divSyncTimer = null;
    divGhWrite(data);
  }, 1500);
}

// ── APP STATE ──
let portfolio = loadPortfolio();
let editingId = null;
let searchedStock = null;

// ── NAVIGATION ──
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const screen = document.getElementById('screen-' + name);
  const nav = document.getElementById('nav-' + name);
  if (screen) screen.classList.add('active');
  if (nav) nav.classList.add('active');
  if (name === 'portfolio') renderPortfolio();
  if (name === 'home') refreshHome();
}

// ── DATE HELPERS ──
function formatMoney(n) {
  return n == null ? '—' : '$\u00a0' + Math.round(n).toLocaleString('zh-TW');
}
function getMonthName(m) { return (m + 1) + ' 月'; }

// ── HOME ──
function refreshHome() {
  const now = new Date();
  document.getElementById('greeting-date').textContent =
    now.getFullYear() + ' 年 ' + String(now.getMonth()+1).padStart(2,'0') + ' 月 ' + String(now.getDate()).padStart(2,'0') + ' 日';
  document.getElementById('month-label').textContent =
    (now.getMonth()+1) + ' 月（入帳月份）';
  const count = portfolio.length;
  document.getElementById('home-stock-count').textContent = count;
  if (count === 0) {
    document.getElementById('home-monthly').innerHTML = '<span style="font-size:16px;color:var(--text2)">請先新增持股</span>';
    document.getElementById('home-ytd').textContent = '—';
    document.getElementById('home-est').textContent = '—';
    return;
  }
  // 若首頁數字尚未載入，顯示載入中並背景計算
  const monthEl = document.getElementById('home-monthly');
  const ytdEl   = document.getElementById('home-ytd');
  const estEl   = document.getElementById('home-est');
  if (monthEl.innerHTML.includes('—') || monthEl.innerHTML.includes('請先')) {
    monthEl.innerHTML = '<span style="font-size:16px;color:var(--text2)">計算中…</span>';
  }
  if (!ytdEl.textContent || ytdEl.textContent === '—') ytdEl.textContent = '計算中…';
  if (!estEl.textContent || estEl.textContent === '—') estEl.textContent = '計算中…';
  // 背景靜默載入（使用快取，不觸發 loading UI）
  setTimeout(() => {
    loadMonthDividends(false);
    loadYtdDividends(false);
    loadEstDividends(false);
  }, 100);
}

// ── PORTFOLIO RENDER ──
function renderPortfolio() {
  const area = document.getElementById('portfolio-list-area');
  const count = portfolio.length;
  document.getElementById('portfolio-count-label').textContent =
    count === 0 ? '目前無持股資料' : '共 ' + count + ' 支股票';
  document.getElementById('portfolio-chip').textContent = count + ' 支';

  if (count === 0) {
    area.innerHTML = `<div class="empty-state">
      <svg class="empty-icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <rect x="8" y="20" width="48" height="36" rx="4"/>
        <path d="M44 20V16a12 12 0 0 0-24 0v4"/>
        <circle cx="32" cy="38" r="5"/>
      </svg>
      <div class="empty-text">無股票資料</div>
      <div class="empty-sub">點右下角 + 新增第一支持股</div>
    </div>`;
    return;
  }

  const sortedPortfolio = [...portfolio].sort((a,b) => String(a.code).localeCompare(String(b.code), undefined, {numeric:true}));
  area.innerHTML = '<div class="stock-list">' +
    sortedPortfolio.map(s => {
      const shares = parseFloat(s.shares);
      const lots = shares.toFixed(3);
      const units = Math.round(shares * 1000).toLocaleString('zh-TW');
      const initials = s.name ? s.name.slice(0,2) : s.code.slice(0,2);
      return `<div class="stock-item" onclick="openEditModal('${s.id}')">
        <div class="stock-avatar">${initials}</div>
        <div class="stock-info">
          <div class="stock-name">${s.code}${s.manualDiv ? '<span class="manual-badge">手動</span>' : ''}</div>
          <div class="stock-code">${s.name || s.code}${s.divFreqType ? ` <span class="div-months-tag">${({monthly:'月配',quarterly:'季配',semiannual:'半年配',annual:'年配',none:'不配息'}[s.divFreqType]||'')}${s.divMonths && s.divFreqType !== 'none' ? ' '+s.divMonths : ''}</span>` : ''}</div>
        </div>
        <div class="stock-shares">
          <div class="stock-shares-val">${lots}<span style="font-size:12px;color:var(--text2);"> 張</span></div>
          <div class="stock-shares-label">${units} 股</div>
        </div>
        <svg class="stock-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`;
    }).join('') + '</div>';
}

// ── MODAL HELPERS ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function handleOverlayClick(e) {
  if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
}

