// 股利總管 Web — 除息日借出張數（自動紀錄＋手動補登）
//
// 為什麼需要：借出中的股票在除息基準日登記在借券人名下，配息不由發行公司直接匯入，
// 而是借券人另外付「權益補償」，兩筆分開入帳。2026-10-07 實例 00989B（9/15 除息、每股 0.088）：
//   委代入 3,950 ＝ 45 張 × 0.088 − 10 元匯費（直接入帳）
//   電匯  11,000 ＝ 125 張 × 0.088（借券補償）
// 股利估算原本只顯示合計 14,960，跟任何一筆入帳都對不起來。要拆開，就得知道「除息日當天」借出幾張；
// 券商 API 只給得到現在借出幾張，沒有歷史 → 每次載入券商庫存時自己記一筆。
//
// 查詢優先序（lentAt）：
//   1) 手動補登（code＋除息日）：開始自動紀錄之前的除息、或紀錄有誤時用
//   2) 除息日還沒到：用現在借出的張數
//   3) 自動紀錄：除息日當天（含）之前最近一筆。只有開網頁的日子才有紀錄，
//      上次開網頁到除息日之間改過借出張數就會用到舊值 → 畫面標出紀錄日期
//   都沒有：回 null，畫面維持合併一列（與加這段之前相同）
//
// 儲存：Firestore stock_prefs/{uid} 的 lentLog／lentManual 欄位（merge 寫入，同認購成本補正）；
//       未登入或寫入失敗時退回 localStorage，登入後下次載入自動搬上雲端。
//   lentLog    = { 'YYYY-MM-DD': { code: 借出股數 } }   當天有建倉明細的檔才記（明細讀失敗的檔不記，免得誤記成 0）
//   lentManual = { code: { 除息日: 借出股數 } }

var LENT_LS = 'lent_log_v1';
var LENT_KEEP_DAYS = 800;   // 自動紀錄保留天數：今年與去年的除息都查得到
// 開始自動紀錄之前已確認的那一筆；只有在使用者從未儲存過任何設定時當初始值帶入
var LENT_SEED = { log: {}, manual: { '00989B': { '2026-09-15': 125000 } } };

var _lentData = null, _lentLoaded = false, _lentStore = 'local', _lentErr = '';

function _lentLocal() { try { return JSON.parse(localStorage.getItem(LENT_LS) || 'null'); } catch (e) { return null; } }
function _lentRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _lentCloud() { return !!(window.FB && window.OWNER_UID); }
function _lentToday() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }   // 台灣日期
function _lentNorm(d) { return { log: (d && d.log) || {}, manual: (d && d.manual) || {} }; }

async function lentLoad(force) {
  if (_lentLoaded && !force) return _lentData;
  var local = _lentLocal();
  _lentData = local ? _lentNorm(local) : null; _lentStore = 'local';
  if (_lentCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_lentRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var d = snap.exists() ? snap.data() : {};
      if (d.lentLog || d.lentManual) {
        _lentData = _lentNorm({ log: d.lentLog, manual: d.lentManual }); _lentStore = 'firestore'; _lentErr = '';
        if (local) { try { localStorage.removeItem(LENT_LS); } catch (e) {} }
      } else if (local) {
        await _lentSave();
      }
    } catch (e) { _lentErr = (e && (e.code || e.message)) || String(e); }
  } else { _lentErr = '未登入 Google'; }
  if (_lentData == null) _lentData = JSON.parse(JSON.stringify(LENT_SEED));
  _lentLoaded = true;
  return _lentData;
}
window.addEventListener('owner-ready', function () { _lentLoaded = false; });

async function _lentSave() {
  if (_lentCloud()) {
    try {
      await window.FB.setDoc(_lentRef(), { lentLog: _lentData.log, lentManual: _lentData.manual,
        lentUpdatedAt: new Date().toISOString() }, { merge: true });
      _lentStore = 'firestore'; _lentErr = '';
      try { localStorage.removeItem(LENT_LS); } catch (e) {}
      return;
    } catch (e) { _lentErr = (e && (e.code || e.message)) || String(e); }
  } else { _lentErr = '未登入 Google'; }
  try { localStorage.setItem(LENT_LS, JSON.stringify(_lentData)); } catch (e) {}
  _lentStore = 'local';
}

// 由 stream.js 在券商庫存（含建倉明細）載入完成後呼叫：記下今天各檔借出幾張。
// 同一天內容沒變就不寫；Firestore 後備來源（id 為 null）沒有借出資訊，不記。
async function lentLogRecord() {
  if (typeof _positions === 'undefined' || !_positions || !_positions.length) return;
  var today = {};
  _positions.forEach(function (p) {
    var code = String(p.code);
    if (p.id == null || typeof _lotsMap === 'undefined' || !_lotsMap[code]) return;
    today[code] = p.lentShares > 0 ? p.lentShares : 0;
  });
  if (!Object.keys(today).length) return;
  await lentLoad();
  var day = _lentToday();
  if (JSON.stringify(_lentData.log[day] || null) === JSON.stringify(today)) return;
  _lentData.log[day] = today;
  var cut = new Date(Date.now() + 8 * 3600000 - LENT_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  Object.keys(_lentData.log).forEach(function (d) { if (d < cut) delete _lentData.log[d]; });
  await _lentSave();
}

// 除息日借出股數：{ shares, src: 'manual'|'log'|'now', date } 或 null（無從得知）。
// 同步函式（computeEtfYear 不能 await）；startDividendEst 會先 await lentLoad()，尚未載入時用本機值或初始值。
function lentAt(code, exDate, todayIso) {
  if (!exDate) return null;
  code = String(code);
  var d = _lentData || (function () { var l = _lentLocal(); return l ? _lentNorm(l) : LENT_SEED; })();
  var m = d.manual[code];
  if (m && typeof m[exDate] === 'number') return { shares: m[exDate], src: 'manual', date: exDate };
  // 還沒除息：目前庫存比任何紀錄都新
  if (exDate > todayIso && typeof _divLentShares === 'function') return { shares: _divLentShares(code), src: 'now', date: todayIso };
  var best = null;
  Object.keys(d.log).forEach(function (day) {
    if (day <= exDate && d.log[day] && typeof d.log[day][code] === 'number' && (!best || day > best)) best = day;
  });
  if (best) return { shares: d.log[best][code], src: 'log', date: best };
  return null;
}

// 拆分說明（個股明細／本月除息個股的展開列共用）
function lentSrcText(mo) {
  var md = function (iso) { return iso ? iso.slice(5).replace('-', '/') : ''; };
  if (mo.lentSrc === 'manual') return '借出張數為手動補登';
  if (mo.lentSrc === 'log') return '借出張數依 ' + md(mo.lentDate) + ' 庫存紀錄' +
    (mo.lentDate !== mo.exDate ? '（除息日當天沒有紀錄，取之前最近一筆）' : '');
  if (mo.lentSrc === 'now') return '尚未除息，借出張數用目前庫存';
  return '';
}

async function lentSetManual(code, exDate, shares) {
  await lentLoad();
  code = String(code).toUpperCase().trim();
  if (shares == null) {
    if (_lentData.manual[code]) { delete _lentData.manual[code][exDate]; if (!Object.keys(_lentData.manual[code]).length) delete _lentData.manual[code]; }
  } else {
    (_lentData.manual[code] = _lentData.manual[code] || {})[exDate] = shares;
  }
  await _lentSave();
}

// ── 參數設定頁的區塊 ──
function _lentPill() {
  if (_lentStore === 'firestore') return '<span class="st-pill st-ok" title="已同步至 Google 帳號，換裝置也看得到">雲端同步</span>';
  return '<span class="st-pill st-part" title="' + (_lentErr || '') + '">僅存在這台裝置' + (_lentErr ? '（' + _lentErr + '）' : '') + '</span>';
}

async function renderLentManual() {
  var el = document.getElementById('params-lent-body');
  if (!el) return;
  el.innerHTML = '<div class="modal-loading">載入設定…</div>';
  await lentLoad();
  var nameOf = function (c) { return (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || ''; };
  var lots = function (sh) { return (sh / 1000).toLocaleString('zh-TW'); };
  var today = _lentToday();

  var set = [];
  Object.keys(_lentData.manual).forEach(function (code) {
    Object.keys(_lentData.manual[code]).forEach(function (ex) { set.push({ code: code, ex: ex, sh: _lentData.manual[code][ex] }); });
  });
  set.sort(function (a, b) { return b.ex.localeCompare(a.ex) || a.code.localeCompare(b.code); });

  // 待補登：已過的除息日、查不到借出紀錄，而且這檔現在或曾經有借出（從沒借過的檔不列，免得每檔每月都跑出來）
  var everLent = {};
  Object.keys(_lentData.log).forEach(function (d) {
    Object.keys(_lentData.log[d]).forEach(function (c) { if (_lentData.log[d][c] > 0) everLent[c] = true; });
  });
  Object.keys(_lentData.manual).forEach(function (c) { everLent[c] = true; });
  var todo = [];
  ((typeof _divEstResult !== 'undefined' && _divEstResult && _divEstResult.stocks) || []).forEach(function (s) {
    if (!everLent[s.code] && !(typeof _divLentShares === 'function' && _divLentShares(s.code) > 0)) return;
    (s.res.months || []).forEach(function (mo) {
      if (mo.exDate && mo.exDate <= today && mo.shares > 0 && mo.lentSrc == null) todo.push({ code: s.code, ex: mo.exDate, sh: mo.shares });
    });
  });
  todo.sort(function (a, b) { return b.ex.localeCompare(a.ex) || a.code.localeCompare(b.code); });

  var lastDay = Object.keys(_lentData.log).sort().pop();
  var lastTxt = lastDay ? lastDay.slice(5).replace('-', '/') + '（' + (Object.keys(_lentData.log[lastDay]).filter(function (c) { return _lentData.log[lastDay][c] > 0; })
    .map(function (c) { return c + ' 借出 ' + lots(_lentData.log[lastDay][c]) + ' 張'; }).join('、') || '無借出') + '）' : '尚無紀錄';

  var html = '<div class="params-co-head">' + _lentPill() +
    '<span class="params-src">最近自動紀錄：' + lastTxt + '</span></div>';

  var row = function (r, isSet) {
    var id = 'lent-' + r.code + '-' + r.ex;
    return '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + nameOf(r.code) + '</span></td>' +
      '<td>' + r.ex + '</td>' +
      (isSet ? '' : '<td class="num">' + lots(r.sh) + '</td>') +
      '<td class="num"><input class="params-co-px" type="number" step="1" min="0" id="' + id + '"' +
        (isSet ? ' value="' + (r.sh / 1000) + '"' : ' placeholder="張"') + '></td>' +
      '<td style="text-align:center"><button class="btn-query" onclick="lentSaveRow(\'' + r.code + '\',\'' + r.ex + '\')">儲存</button>' +
      (isSet ? ' <button class="btn-query" onclick="lentDelRow(\'' + r.code + '\',\'' + r.ex + '\')">刪除</button>' : '') + '</td></tr>';
  };

  html += '<div class="inv-table-wrap"><table class="inv-table"><thead><tr>' +
    '<th>代號 / 名稱</th><th>除息日</th><th class="num">借出張數</th><th style="text-align:center">動作</th></tr></thead><tbody>';
  if (!set.length) html += '<tr><td colspan="4" class="sbl-dim">尚未手動補登</td></tr>';
  set.forEach(function (r) { html += row(r, true); });
  html += '</tbody></table></div>';

  if (todo.length) {
    html += '<div class="params-co-sub">已除息、但查不到當天借出紀錄（有借出過的檔）</div><div class="inv-table-wrap"><table class="inv-table"><thead><tr>' +
      '<th>代號 / 名稱</th><th>除息日</th><th class="num">除息張數</th><th class="num">借出張數</th><th style="text-align:center">動作</th></tr></thead><tbody>';
    todo.forEach(function (r) { html += row(r, false); });
    html += '</tbody></table></div>';
  }

  html += '<div class="params-co-sub">新增</div><div class="lent-add">' +
    '<input id="lent-new-code" class="params-co-px" placeholder="代號">' +
    '<input id="lent-new-ex" class="params-co-px lent-date" type="date">' +
    '<input id="lent-new-lots" class="params-co-px" type="number" step="1" min="0" placeholder="張">' +
    '<button class="btn-query" onclick="lentAddRow()">儲存</button></div>';
  el.innerHTML = html;
}

async function _lentAfterSave() {
  // 股利估算已算過的話重算一次，畫面上的拆分才會跟著變（同 div-meta.js 儲存後的作法）
  if (typeof _divEstResult !== 'undefined' && _divEstResult && typeof startDividendEst === 'function') {
    try { await startDividendEst(false); } catch (e) {}
  }
  await renderLentManual();
}

async function lentSaveRow(code, ex) {
  var inp = document.getElementById('lent-' + code + '-' + ex);
  if (!inp) return;
  var v = parseFloat(inp.value);
  if (!(v >= 0)) { alert('請輸入除息日當天借出的張數（沒有借出填 0）'); inp.focus(); return; }
  await lentSetManual(code, ex, Math.round(v * 1000));
  await _lentAfterSave();
}

async function lentDelRow(code, ex) {
  if (!confirm('刪除 ' + code + ' ' + ex + ' 的借出張數補登？\n刪除後改用自動紀錄；沒有紀錄的話，股利估算會回到不拆分。')) return;
  await lentSetManual(code, ex, null);
  await _lentAfterSave();
}

async function lentAddRow() {
  var code = (document.getElementById('lent-new-code').value || '').toUpperCase().trim();
  var ex = document.getElementById('lent-new-ex').value;
  var v = parseFloat(document.getElementById('lent-new-lots').value);
  if (!code || !ex || !(v >= 0)) { alert('請填代號、除息日與借出張數'); return; }
  await lentSetManual(code, ex, Math.round(v * 1000));
  await _lentAfterSave();
}
