// 股利總管 Web — 認購成本補正（參數設定頁維護）
//
// 為什麼需要：銀行／發行商認購後匯撥進來的股票，不是在本券商成交，券商端建倉明細的
// price（單筆成本）會是 0。那筆的現值會被整筆當成獲利，總成本、均價、損益率、頂欄獲利率全部失真。
//
// 存「每股認購價」而非「該日總成本」：同一天可能拆成多筆入帳（例 00407A 分 4 張＋6 張兩筆），
// 存總成本會對每一筆各加一次。逐筆用 每股價 × 張數 × 1000 還原成本才正確。
//
// 只在建倉明細確實存在「同日、price=0」的筆時才套用；該筆賣出或券商補登成本後自動失效。
// 儲存：Firestore stock_prefs/{uid} 的 costOverride 欄位（merge 寫入，不動同文件其他偏好）；
//       未登入或寫入失敗時退回 localStorage，登入後下次載入自動搬上雲端。

var CO_LS = 'cost_override_v1';
// 移到本頁之前寫死在 stream.js 的那筆；只有在使用者從未儲存過任何設定時當初始值帶入
var CO_SEED = { '00407A': { '2026-06-23': 10.00 } };

var _coMap = null, _coLoaded = false, _coStore = 'local', _coErr = '';

function _coLocal() { try { return JSON.parse(localStorage.getItem(CO_LS) || 'null'); } catch (e) { return null; } }
function _coRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _coCloud() { return !!(window.FB && window.OWNER_UID); }

async function coLoad(force) {
  if (_coLoaded && !force) return _coMap;
  var local = _coLocal();
  _coMap = local || null; _coStore = 'local';
  if (_coCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_coRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var remote = (snap.exists() && snap.data().costOverride) || null;
      if (remote) {
        _coMap = remote; _coStore = 'firestore'; _coErr = '';
        if (local) { try { localStorage.removeItem(CO_LS); } catch (e) {} }
      } else if (local) {
        await window.FB.setDoc(_coRef(), { costOverride: local, costUpdatedAt: new Date().toISOString() }, { merge: true });
        _coStore = 'firestore'; _coErr = '';
        try { localStorage.removeItem(CO_LS); } catch (e) {}
      }
    } catch (e) { _coErr = (e && (e.code || e.message)) || String(e); }
  } else { _coErr = '未登入 Google'; }
  if (_coMap == null) _coMap = JSON.parse(JSON.stringify(CO_SEED));   // 從未設定過 → 帶入原本寫死的那筆
  _coLoaded = true;
  return _coMap;
}
window.addEventListener('owner-ready', function () { _coLoaded = false; });

// 供 stream.js／inventory.js 查詢：回每股認購價（元），沒有設定回 null。
// 同步函式（補正流程不能等 await）；尚未載入時先用本機值或初始值，載入後自然一致。
function coGet(code, date) {
  var m = _coMap || _coLocal() || CO_SEED;
  var e = m[String(code)];
  var v = e && e[date];
  return (typeof v === 'number' && v >= 0) ? v : null;
}

async function coSet(code, date, px) {
  await coLoad();
  code = String(code).toUpperCase().trim();
  if (px == null) {
    if (_coMap[code]) { delete _coMap[code][date]; if (!Object.keys(_coMap[code]).length) delete _coMap[code]; }
  } else {
    if (!_coMap[code]) _coMap[code] = {};
    _coMap[code][date] = px;
  }
  if (_coCloud()) {
    try {
      await window.FB.setDoc(_coRef(), { costOverride: _coMap, costUpdatedAt: new Date().toISOString() }, { merge: true });
      _coStore = 'firestore'; _coErr = '';
      try { localStorage.removeItem(CO_LS); } catch (e) {}
      return;
    } catch (e) { _coErr = (e && (e.code || e.message)) || String(e); }
  } else { _coErr = '未登入 Google'; }
  try { localStorage.setItem(CO_LS, JSON.stringify(_coMap)); } catch (e) {}
  _coStore = 'local';
}

// 掃描持股的建倉明細，找出券商端 price=0 的批次（需要券商連線）。
// 每檔一次 position_detail，走 broker.js 的限流，11 檔約 2–3 秒。
async function coScanZeroLots() {
  var pos = [];
  try {
    pos = (typeof _positions !== 'undefined' && _positions && _positions.length)
      ? _positions : (await fetchBrokerPositions() || []);
  } catch (e) { return { err: (e && e.message) || String(e), lots: [] }; }
  var out = [];
  for (var i = 0; i < pos.length; i++) {
    var p = pos[i];
    if (p.id == null || !(p.quantity > 0)) continue;
    try {
      var dets = await fetchPositionDetail(p.id);
      (dets || []).forEach(function (d) {
        if (d.quantity > 0 && d.price === 0) {
          out.push({ code: String(p.code), date: d.date, lots: d.quantity, last: d.last_price || 0 });
        }
      });
    } catch (e) { /* 單檔失敗略過，不中斷整批掃描 */ }
  }
  out.sort(function (a, b) { return b.date.localeCompare(a.date) || a.code.localeCompare(b.code); });
  return { err: '', lots: out };
}

// ── 參數設定頁的區塊 ──
var _coScan = null;

function _coPill() {
  if (_coStore === 'firestore') return '<span class="st-pill st-ok" title="已同步至 Google 帳號，換裝置也看得到">雲端同步</span>';
  return '<span class="st-pill st-part" title="' + (_coErr || '') + '">僅存在這台裝置' + (_coErr ? '（' + _coErr + '）' : '') + '</span>';
}

async function renderCostOverride(rescan) {
  var el = document.getElementById('params-cost-body');
  if (!el) return;
  el.innerHTML = '<div class="modal-loading">載入設定…</div>';
  await coLoad();
  if (rescan || _coScan == null) {
    el.innerHTML = '<div class="modal-loading">掃描建倉明細中（需券商連線）…</div>';
    _coScan = await coScanZeroLots();
  }
  var nameOf = function (c) { return (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || ''; };

  // 已設定：把 map 攤平成列，並標示目前是否還對得上一筆 price=0 的批次
  var set = [];
  Object.keys(_coMap).forEach(function (code) {
    Object.keys(_coMap[code]).forEach(function (date) {
      var hit = (_coScan.lots || []).filter(function (x) { return x.code === code && x.date === date; });
      var lots = hit.reduce(function (a, x) { return a + x.lots; }, 0);
      set.push({ code: code, date: date, px: _coMap[code][date], lots: lots, live: hit.length > 0 });
    });
  });
  set.sort(function (a, b) { return b.date.localeCompare(a.date) || a.code.localeCompare(b.code); });

  var html = '<div class="params-co-head">' + _coPill() +
    '<button class="btn-query" onclick="renderCostOverride(true)" style="margin-left:8px">↻ 重新掃描</button></div>';

  html += '<div class="inv-table-wrap"><table class="inv-table"><thead><tr>' +
    '<th>代號 / 名稱</th><th>入帳日</th><th class="num">張數</th>' +
    '<th class="num">每股認購價</th><th class="num">還原成本</th><th>狀態</th>' +
    '<th style="text-align:center">動作</th></tr></thead><tbody>';

  if (!set.length) {
    html += '<tr><td colspan="7" class="sbl-dim">尚未設定任何認購成本</td></tr>';
  }
  set.forEach(function (r) {
    var cost = r.live ? r.px * r.lots * 1000 : null;
    html += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + nameOf(r.code) + '</span></td>' +
      '<td>' + r.date + '</td>' +
      '<td class="num">' + (r.live ? r.lots : '—') + '</td>' +
      '<td class="num"><input class="params-co-px" type="number" step="0.01" min="0" value="' + r.px +
      '" id="co-px-' + r.code + '-' + r.date + '"></td>' +
      '<td class="num">' + (cost == null ? '—' : Math.round(cost).toLocaleString('zh-TW')) + '</td>' +
      '<td>' + (r.live ? '<span class="st-pill st-ok">套用中</span>'
        : '<span class="st-pill st-part" title="目前建倉明細找不到同代號同日、且券商端成本為 0 的批次；該批次可能已賣出，或券商已補登成本">未對應</span>') + '</td>' +
      '<td style="text-align:center">' +
      '<button class="btn-query" onclick="coSaveRow(\'' + r.code + '\',\'' + r.date + '\')">儲存</button> ' +
      '<button class="btn-query" onclick="coDelRow(\'' + r.code + '\',\'' + r.date + '\')">刪除</button></td></tr>';
  });
  html += '</tbody></table></div>';

  // 偵測到、但還沒設定的零成本批次
  var todo = (_coScan.lots || []).filter(function (x) { return coGet(x.code, x.date) == null; });
  var agg = {};
  todo.forEach(function (x) { var k = x.code + '|' + x.date; (agg[k] = agg[k] || { code: x.code, date: x.date, lots: 0 }).lots += x.lots; });
  var todoRows = Object.keys(agg).map(function (k) { return agg[k]; });

  if (_coScan.err) {
    html += '<div class="tx-note up">掃描失敗：' + _coScan.err + '（需要券商連線；連線後按「重新掃描」）</div>';
  } else if (todoRows.length) {
    html += '<div class="params-co-sub">偵測到券商端成本為 0 的批次（尚未設定）</div><div class="inv-table-wrap"><table class="inv-table"><thead><tr>' +
      '<th>代號 / 名稱</th><th>入帳日</th><th class="num">張數</th><th class="num">每股認購價</th><th style="text-align:center">動作</th></tr></thead><tbody>';
    todoRows.forEach(function (r) {
      html += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + nameOf(r.code) + '</span></td>' +
        '<td>' + r.date + '</td><td class="num">' + r.lots + '</td>' +
        '<td class="num"><input class="params-co-px" type="number" step="0.01" min="0" placeholder="例 10.00" id="co-px-' + r.code + '-' + r.date + '"></td>' +
        '<td style="text-align:center"><button class="btn-query" onclick="coSaveRow(\'' + r.code + '\',\'' + r.date + '\')">儲存</button></td></tr>';
    });
    html += '</tbody></table></div>';
  } else {
    html += '<div class="tx-note">目前建倉明細中沒有未設定的零成本批次。</div>';
  }
  el.innerHTML = html;
}

async function coSaveRow(code, date) {
  var inp = document.getElementById('co-px-' + code + '-' + date);
  if (!inp) return;
  var v = parseFloat(inp.value);
  if (!(v >= 0)) { alert('請輸入每股認購價（例 10.00）'); inp.focus(); return; }
  await coSet(code, date, v);
  if (typeof refreshPositions === 'function') { try { await refreshPositions(); } catch (e) {} }
  await renderCostOverride(false);
}

async function coDelRow(code, date) {
  if (!confirm('刪除 ' + code + ' ' + date + ' 的認購成本設定？\n刪除後該批次會回到券商端的原始值（成本 0），持股成本與損益率會再次失真。')) return;
  await coSet(code, date, null);
  if (typeof refreshPositions === 'function') { try { await refreshPositions(); } catch (e) {} }
  await renderCostOverride(false);
}
