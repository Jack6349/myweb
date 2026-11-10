// 股利總管 Web — 記事（待辦與觀察事項）
//
// 為什麼用固定分類而不是純文字：分類過的記事才彙總得出「哪一類最常擱著沒做」。
// 這是生管錯誤原因表的用法——分類是為了事後能統計，不是為了打字快。
// 所以「做完」不是刪除，是移到已完成區；刪除只留給打錯要清掉的，
// 否則結案即銷毀，統計價值歸零。
//
// 它刻意不做三件事：不主動提醒（沒有推播，按鈕上的筆數是唯一提示）、
// 不自動盯條件（價格門檻的自動提醒在停損停利頁，兩邊都設會不知道該信哪個）、
// 不自動產生記事（會冒出一堆你沒要的待辦）。

var NOTE_LS = 'notes_v1';

// 分類表：大類 → 中類。用一陣子之後哪一類從來沒用到、哪一類老是落到「其他」，再調。
var NOTE_CATS = [
  ['進場', ['跌深反彈後進場', '除息後進場', '分段接降均價', '等目標價']],
  ['出場', ['到停利門檻', '到停損門檻', '換股', '部位過度集中要減碼']],
  ['配息', ['等除息日', '等發放入帳', '填息未完成要追蹤', '配息政策變化要查']],
  ['出借', ['值得出借', '考慮召回', '費率要確認']],
  ['觀察', ['趨勢轉折', '折溢價異常', '規模與單位數變化', '成份股變動']],
  ['資料', ['來源異常', '數字對不上要核對', '功能待改']],
  ['行政', ['重掛委託', '稅務與對帳', '其他']]
];

var _ntOpen = false, _ntList = null, _ntLoaded = false, _ntStore = 'local';
var _ntSel = {};          // 勾選狀態（只在畫面上，不存）
var _ntFilter = '';       // 大類篩選
var _ntBusy = false;

// ── 頁面清單：直接讀導覽列，不另外維護一份，加了新頁面自動出現 ──
function _ntPages() {
  var out = [];
  document.querySelectorAll('.nav-row [data-view], .nav [data-view], [data-view]').forEach(function (b) {
    var v = b.getAttribute('data-view'), t = (b.textContent || '').trim();
    if (!v || !t) return;
    if (out.some(function (x) { return x.v === v; })) return;
    out.push({ v: v, t: t });
  });
  return out;
}
function _ntPageName(view) {
  var p = _ntPages().filter(function (x) { return x.v === view; })[0];
  return p ? p.t : '';
}

// ── 儲存：與停損停利門檻、認購成本補正同一份雲端文件；未登入時退回本機 ──
function _ntLocal() { try { return JSON.parse(localStorage.getItem(NOTE_LS) || 'null'); } catch (e) { return null; } }
function _ntRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _ntCloud() { return !!(window.FB && window.OWNER_UID); }

async function ntLoad(force) {
  if (_ntLoaded && !force) return _ntList;
  var local = _ntLocal();
  _ntList = local || []; _ntStore = 'local';
  if (_ntCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_ntRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var remote = (snap.exists() && snap.data().notes) || null;
      if (remote) {
        _ntList = remote; _ntStore = 'firestore';
        if (local) { try { localStorage.removeItem(NOTE_LS); } catch (e) {} }
      } else if (local && local.length) {
        await window.FB.setDoc(_ntRef(), { notes: local, notesUpdatedAt: new Date().toISOString() }, { merge: true });
        _ntStore = 'firestore';
        try { localStorage.removeItem(NOTE_LS); } catch (e) {}
      }
    } catch (e) { hush('notes', e); }
  }
  _ntLoaded = true;
  ntBadge();
  return _ntList;
}
async function _ntSave() {
  if (_ntCloud()) {
    try {
      await window.FB.setDoc(_ntRef(), { notes: _ntList, notesUpdatedAt: new Date().toISOString() }, { merge: true });
      _ntStore = 'firestore';
      ntBadge();
      return;
    } catch (e) { hush('notes', e, 1); }
  }
  try { localStorage.setItem(NOTE_LS, JSON.stringify(_ntList)); _ntStore = 'local'; }
  catch (e) { hush('notes', e, 1); }
  ntBadge();
}
window.addEventListener('owner-ready', function () { _ntLoaded = false; ntLoad().then(function () { if (_ntOpen) ntRender(); }); });

// ── 頂欄按鈕與未完成筆數 ──
// 沒有待辦時不顯示數字：每天看到一個 0 會變成視覺雜訊
function ntBadge() {
  var b = document.getElementById('nt-btn');
  if (!b) return;
  var n = (_ntList || []).filter(function (x) { return !x.done; }).length;
  b.innerHTML = (_ntOpen ? '▴' : '▾') + ' 記事' + (n ? '<span class="nt-badge">' + n + '</span>' : '');
  b.className = 'dw-btn' + (_ntOpen ? ' on' : '');
}
function ntToggle() {
  _ntOpen = !_ntOpen;
  // 三個抽屜會疊在一起，一次只開一個
  if (_ntOpen) {
    if (typeof _dwOpen !== 'undefined' && _dwOpen) { _dwOpen = false; if (typeof renderDrawer === 'function') renderDrawer(); }
    if (typeof _pvOpen !== 'undefined' && _pvOpen) { _pvOpen = false; if (typeof pvRender === 'function') pvRender(); }
    if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
  }
  ntRender();
  if (_ntOpen && !_ntLoaded) ntLoad().then(ntRender);
  if (_ntOpen) _ntFillNames();
}
function ntClose() { _ntOpen = false; ntRender(); }

// ── 新增 ──
function ntSubOpts(cat) {
  var g = NOTE_CATS.filter(function (x) { return x[0] === cat; })[0];
  return (g ? g[1] : []).map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('');
}
function ntCatChanged() {
  var c = document.getElementById('nt-cat'), sub = document.getElementById('nt-sub');
  if (!c || !sub) return;
  sub.innerHTML = ntSubOpts(c.value);
  ntSubChanged();
}
// 選完中類自動帶一句，你只要補關鍵字；已經動過的字不覆蓋
function ntSubChanged() {
  var sub = document.getElementById('nt-sub'), tx = document.getElementById('nt-text');
  if (!sub || !tx) return;
  var auto = sub.value ? sub.value + '：' : '';
  if (!tx.value || tx.getAttribute('data-auto') === tx.value) {
    tx.value = auto;
    tx.setAttribute('data-auto', auto);
  }
}
// 代碼候選：持股在前、關注在後，各自標出來。
// 換股是「賣掉持股的某一檔、換成關注清單裡的某一檔」，
// 兩邊都要選得到，而且要分得出來哪一檔是哪一邊。
//
// 名稱來源三道：行情快取（只有持股）→ 關注頁的合約索引 → 該索引的每日快取。
// 沒有第二、三道的話，關注但未持有的那幾檔只有一串代碼，換股時根本認不出來。
function _ntNameMap() {
  var m = {};
  var idx = (typeof _wtIdx !== 'undefined' && _wtIdx) || null;
  if (!idx) {
    try {
      var c = JSON.parse(localStorage.getItem('watch_contracts_v1') || 'null');
      idx = (c && c.rows) || null;
    } catch (e) {}
  }
  (idx || []).forEach(function (x) { if (x && x.c) m[String(x.c)] = x.n || ''; });
  return m;
}
function _ntCodeOpts() {
  var held = {}, watch = {};
  var sm = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  Object.keys(sm).forEach(function (c) { if (sm[c] > 0) held[c] = 1; });
  if (typeof _wtLoad === 'function') {
    try { (_wtLoad() || []).forEach(function (c) { if (!held[c]) watch[c] = 1; }); } catch (e) {}
  }
  var nm = _ntNameMap();
  var label = function (c) {
    return (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || nm[c] || '';
  };
  var opt = function (c, tag) {
    var n = label(c);
    return '<option value="' + c + '">' + (n ? n + ' ' : '') + tag + '</option>';
  };
  return Object.keys(held).sort().map(function (c) { return opt(c, '（持股）'); }).join('')
    + Object.keys(watch).sort().map(function (c) { return opt(c, '（關注）'); }).join('');
}
// 關注但未持有的那幾檔，如果三道來源都沒名稱，就逐檔補查一次合約。
// 不去觸發關注頁的全市場索引（五萬多筆、要翻頁），這裡最多就關注清單那幾檔。
// 查到的寫回共用的合約快取，別頁也用得到。
var _ntNameTried = false;
async function _ntFillNames() {
  if (_ntNameTried || typeof fetchContract !== 'function') return;
  _ntNameTried = true;
  var nm = _ntNameMap(), need = [];
  var sm = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  try {
    (typeof _wtLoad === 'function' ? (_wtLoad() || []) : []).forEach(function (c) {
      if (sm[c] > 0) return;
      if ((typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || nm[c]) return;
      if (need.indexOf(c) < 0) need.push(c);
    });
  } catch (e) { return; }
  if (!need.length) return;
  var got = 0;
  for (var i = 0; i < need.length && i < 40; i++) {
    try {
      var ct = await fetchContract(need[i]);
      if (ct && ct.name) { _contracts[need[i]] = ct; got++; }
    } catch (e) { hush('notes', e); }
  }
  if (got && _ntOpen) ntRender();
}

async function ntAdd() {
  var g = function (id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : ''; };
  var cat = g('nt-cat'), sub = g('nt-sub'), page = g('nt-page'), code = g('nt-code'), text = g('nt-text');
  if (!cat || !sub) return;
  await ntLoad();
  _ntList.push({
    id: 'n' + Date.now() + Math.floor(Math.random() * 1000),
    cat: cat, sub: sub, page: page, code: code.toUpperCase(), text: text,
    created: new Date().toISOString().slice(0, 10), done: 0
  });
  await _ntSave();
  var tx = document.getElementById('nt-text');
  if (tx) { tx.value = ''; tx.removeAttribute('data-auto'); }
  var cd = document.getElementById('nt-code');
  if (cd) cd.value = '';
  ntRender();
}

// ── 勾選與批次 ──
function ntTick(id, on) { if (on) _ntSel[id] = 1; else delete _ntSel[id]; ntRender(); }
function ntSelAll() {
  _ntVisible().forEach(function (x) { _ntSel[x.id] = 1; });
  ntRender();
}
function ntSelClear() { _ntSel = {}; ntRender(); }
async function ntDoneSel() {
  await ntLoad();
  var now = new Date().toISOString().slice(0, 10), n = 0;
  _ntList.forEach(function (x) { if (_ntSel[x.id] && !x.done) { x.done = 1; x.doneAt = now; n++; } });
  if (!n) return;
  _ntSel = {};
  await _ntSave();
  ntRender();
}
async function ntDelSel() {
  await ntLoad();
  var ids = Object.keys(_ntSel);
  if (!ids.length) return;
  if (!confirm('刪除勾選的 ' + ids.length + ' 筆？刪掉就不會留在已完成區，無法復原。')) return;
  _ntList = _ntList.filter(function (x) { return !_ntSel[x.id]; });
  _ntSel = {};
  await _ntSave();
  ntRender();
}
async function ntUndone(id) {
  await ntLoad();
  _ntList.forEach(function (x) { if (x.id === id) { x.done = 0; delete x.doneAt; } });
  await _ntSave();
  ntRender();
}
function ntFilter(v) { _ntFilter = v; _ntSel = {}; ntRender(); }
function _ntVisible() {
  return (_ntList || []).filter(function (x) { return !x.done && (!_ntFilter || x.cat === _ntFilter); });
}

// ── 畫面 ──
function ntRender() {
  var el = document.getElementById('nt');
  if (!el) return;
  el.hidden = !_ntOpen;
  ntBadge();
  if (!_ntOpen) { el.innerHTML = ''; return; }
  if (!_ntLoaded) { el.innerHTML = '<div class="modal-loading">讀取記事…</div>'; return; }

  var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); };
  var cur = (typeof _curView !== 'undefined' && _curView) ? _ntPageName(_curView) : '';
  var h = '<button class="dw-close" onclick="ntClose()" title="收起">✕</button>';

  // 新增
  h += '<div class="dw-sec">新增</div><div class="nt-form">' +
    '<select id="nt-cat" class="nt-in" onchange="ntCatChanged()">' +
      NOTE_CATS.map(function (g) { return '<option value="' + g[0] + '">' + g[0] + '</option>'; }).join('') + '</select>' +
    '<select id="nt-sub" class="nt-in nt-sub" onchange="ntSubChanged()">' + ntSubOpts(NOTE_CATS[0][0]) + '</select>' +
    '<select id="nt-page" class="nt-in">' + '<option value="">（不指定頁面）</option>' +
      _ntPages().map(function (p) {
        return '<option value="' + p.t + '"' + (p.t === cur ? ' selected' : '') + '>' + p.t + '</option>';
      }).join('') + '</select>' +
    '<input id="nt-code" class="nt-in nt-code" list="nt-codes" placeholder="代碼：持股＋關注（可空白）" autocomplete="off">' +
    '<datalist id="nt-codes">' + _ntCodeOpts() + '</datalist>' +
    '<input id="nt-text" class="nt-in nt-text" placeholder="代辦事項" autocomplete="off">' +
    '<button class="btn-query" onclick="ntAdd()">加入</button>' +
    '</div>';

  var all = _ntList || [];
  var openList = _ntVisible();
  var doneList = all.filter(function (x) { return x.done; })
    .sort(function (a, b) { return (b.doneAt || '') < (a.doneAt || '') ? -1 : 1; });
  var selN = Object.keys(_ntSel).length;

  // 工具列
  h += '<div class="dw-sec">待辦（' + openList.length + '）</div>';
  h += '<div class="nt-bar">' +
    '<select class="nt-in" onchange="ntFilter(this.value)">' +
      '<option value="">全部大類</option>' +
      NOTE_CATS.map(function (g) {
        var n = all.filter(function (x) { return !x.done && x.cat === g[0]; }).length;
        return '<option value="' + g[0] + '"' + (_ntFilter === g[0] ? ' selected' : '') + '>' + g[0] + '（' + n + '）</option>';
      }).join('') + '</select>' +
    '<button class="swap-mini" onclick="ntSelAll()">全選</button>' +
    '<button class="swap-mini" onclick="ntSelClear()">清除已勾選</button>' +
    '<button class="swap-mini nt-ok" onclick="ntDoneSel()">標記完成' + (selN ? '（' + selN + '）' : '') + '</button>' +
    '<button class="swap-mini nt-del" onclick="ntDelSel()">刪除已勾選' + (selN ? '（' + selN + '）' : '') + '</button>' +
    '</div>';

  if (!openList.length) {
    h += '<div class="modal-loading">' + (_ntFilter ? '這個大類沒有待辦' : '沒有待辦事項') + '</div>';
  } else {
    h += '<table class="detail-table nt-table"><thead><tr><th class="nt-ck"></th><th>分類</th><th>頁面</th>' +
      '<th>代碼</th><th>代辦事項</th><th>建立</th></tr></thead><tbody>';
    openList.forEach(function (x) {
      h += '<tr><td class="nt-ck"><input type="checkbox"' + (_ntSel[x.id] ? ' checked' : '') +
        ' onchange="ntTick(\'' + x.id + '\', this.checked)"></td>' +
        '<td><span class="nt-cat">' + esc(x.cat) + '</span>' + esc(x.sub) + '</td>' +
        '<td>' + (x.page ? '<span class="nt-page" onclick="ntGo(\'' + esc(x.page) + '\')">' + esc(x.page) + '</span>' : '<span class="dm-dim">—</span>') + '</td>' +
        '<td>' + (x.code ? '<span class="tx-ocode">' + esc(x.code) + '</span>' : '<span class="dm-dim">—</span>') + '</td>' +
        '<td class="nt-tx">' + esc(x.text) + '</td>' +
        '<td class="dm-dim">' + esc(x.created) + '</td></tr>';
    });
    h += '</tbody></table>';
  }

  // 已完成：預設折疊。留著是為了之後能看「哪一類真的做完了幾次」
  h += '<details class="nt-done"><summary>已完成（' + doneList.length + '）</summary>';
  if (!doneList.length) h += '<div class="modal-loading">還沒有完成的項目</div>';
  else {
    h += '<table class="detail-table nt-table"><thead><tr><th>分類</th><th>代碼</th><th>代辦事項</th><th>完成</th><th></th></tr></thead><tbody>';
    doneList.forEach(function (x) {
      h += '<tr><td><span class="nt-cat">' + esc(x.cat) + '</span>' + esc(x.sub) + '</td>' +
        '<td>' + (x.code ? '<span class="tx-ocode">' + esc(x.code) + '</span>' : '<span class="dm-dim">—</span>') + '</td>' +
        '<td class="nt-tx">' + esc(x.text) + '</td>' +
        '<td class="dm-dim">' + esc(x.doneAt || '') + '</td>' +
        '<td><button class="swap-mini" onclick="ntUndone(\'' + x.id + '\')">退回待辦</button></td></tr>';
    });
    h += '</tbody></table>';
  }
  h += '</details>';

  h += '<div class="detail-note nb-keep">分類是為了之後能彙總「哪一類最常擱著」，所以做完是移到已完成區、不是刪除；' +
    '刪除只留給打錯要清掉的。記事不會主動提醒，也不會自動盯價格——價格門檻的提醒在停損停利頁，' +
    '兩邊都設會不知道該信哪一個。存在' + (_ntStore === 'firestore' ? ' Firestore（手機與電腦同一份）' : '本機瀏覽器（未登入）') + '。</div>';

  el.innerHTML = h;
}

// 點頁面名稱跳過去（找導覽列上同名那顆按鈕按下去，不自己維護一份對照表）
function ntGo(name) {
  var hit = _ntPages().filter(function (p) { return p.t === name; })[0];
  if (!hit) return;
  var b = document.querySelector('[data-view="' + hit.v + '"]');
  if (b) { ntClose(); b.click(); }
}
