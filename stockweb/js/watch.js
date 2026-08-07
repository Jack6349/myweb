// 股利總管 Web — 關注股票（非持股的觀察清單，盤中即時報價）
// 搜尋：Shioaji 合約清單（本機 API，零 GAS 配額），濾除權證後約 3,100 檔，每日快取後純本地比對
// 顯示比照持股庫存；〔成份股〕複用 openConstituents、〔除息紀錄〕彈窗走 _divGetRecs（e添富→Yahoo）
// 進頁訂閱 tick、離開退訂；清單存本機 localStorage

var WT_MAX = 30;                    // 關注上限（訂閱額度 200 檔，持股外保留餘裕）
var WT_LS = 'watch_list_v1';        // 關注清單
var WT_CT_LS = 'watch_contracts_v1'; // 合約索引（每日快取）
var WT_YEARS = 2;                   // 除息紀錄顯示年數

var WT_BOND_LS = 'watch_bond_scan_v1';  // 債券篩選結果（永久，按鈕才更新）
var WT_DIV_LS = 'watch_div_v1';         // 除息資料（永久，key = code|年月；當月已公告即不再重抓）
var WT_ACT_LS = 'watch_act_v1';         // 主動式報酬（每日快取）
var WT_TH_LS = 'watch_bond_th';         // 年殖利率門檻
var WT_BATCH = 6;                       // 並行批次大小

var _wtList = null;      // [code]
var _wtIdx = null;       // [{c,n,e}] 合約索引
var _wtSubbed = [];      // 本頁新訂閱的代號（離開退訂）
var _wtSug = [];         // 目前下拉候選
var _wtNote = '';
var _wtTab = 'list';     // list | bond | act
var _wtBond = null;      // 債券篩選結果
var _wtAct = null;       // 主動式報酬結果
var _wtBusy = false;
var _wtPick = {};        // 待加入勾選：code -> true

function _wtLoad() {
  if (_wtList) return _wtList;
  try { _wtList = JSON.parse(localStorage.getItem(WT_LS) || '[]') || []; } catch (e) { _wtList = []; }
  return _wtList;
}
function _wtSave() { try { localStorage.setItem(WT_LS, JSON.stringify(_wtList || [])); } catch (e) {} }

// ── 合約索引：抓一次全量 → 濾權證 → 只留代碼/名稱/交易所，每日快取 ──
// 權證/牛熊證判定：名稱含「購/售」、名稱以「牛/熊＋數字」結尾（如 臺股指元大64牛15）、或純 6 碼數字（066270）
// ETF 的 6 碼含英文字母（00981B）與反向型（00666R 富邦恒生國企反1）不受影響
function _wtIsWarrant(code, name) {
  name = name || '';
  return /[購售]/.test(name) || /[牛熊]\d+$/.test(name) || /^\d{6}$/.test(String(code));
}
async function _wtEnsureContracts() {
  if (_wtIdx && _wtIdx.length) return _wtIdx;
  var day = _divTwDate().iso;
  try {
    var c = JSON.parse(localStorage.getItem(WT_CT_LS) || 'null');
    if (c && c.day === day && c.rows && c.rows.length) { _wtIdx = c.rows; return _wtIdx; }
  } catch (e) {}
  var rows = [];
  try {
    var r = await fetch(API + '/api/v1/data/contracts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', page: 1, page_size: 50000 })
    });
    var j = await r.json();
    (j.contracts || []).forEach(function (x) {
      if (_wtIsWarrant(x.code, x.name)) return;
      rows.push({ c: String(x.code), n: x.name || '', e: x.exchange || 'TSE' });
    });
  } catch (e) { console.warn('[watch contracts]', e); }
  if (rows.length) {
    _wtIdx = rows;
    try { localStorage.setItem(WT_CT_LS, JSON.stringify({ day: day, rows: rows })); } catch (e) {}
  }
  return _wtIdx || [];
}

// ── 搜尋：代碼開頭符合優先，其次名稱包含 ──
function wtSearch(el) {
  var q = String(el.value || '').trim().toUpperCase();
  if (!q) { _wtSug = []; _wtRenderSug(); return; }
  var idx = _wtIdx || [];
  var byCode = [], byName = [];
  for (var i = 0; i < idx.length && byCode.length + byName.length < 60; i++) {
    var x = idx[i];
    if (x.c.toUpperCase().indexOf(q) === 0) byCode.push(x);
    else if (x.n.toUpperCase().indexOf(q) >= 0) byName.push(x);
  }
  _wtSug = byCode.concat(byName).slice(0, 20);
  _wtRenderSug();
}
function _wtRenderSug() {
  var el = document.getElementById('wt-sug');
  if (!el) return;
  if (!_wtSug.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
  var have = {}; _wtLoad().forEach(function (c) { have[c] = true; });
  el.innerHTML = _wtSug.map(function (x) {
    var added = have[x.c];
    return '<div class="wt-sug-item' + (added ? ' added' : '') + '" onclick="' + (added ? '' : 'wtAdd(\'' + x.c + '\')') + '">' +
      '<span class="wt-sug-c">' + x.c + '</span><span class="wt-sug-n">' + x.n + '</span>' +
      '<span class="wt-sug-a">' + (added ? '已加入' : '＋ 加入') + '</span></div>';
  }).join('');
  el.style.display = '';
}
function wtClearSug() { _wtSug = []; _wtRenderSug(); var i = document.getElementById('wt-inp'); if (i) i.value = ''; }

// ── 清單增刪 ──
async function wtAdd(code) {
  code = String(code);
  var list = _wtLoad();
  if (list.indexOf(code) >= 0) return;
  if (list.length >= WT_MAX) { _wtNote = '關注上限 ' + WT_MAX + ' 檔，請先移除再加入'; renderWatch(); return; }
  list.push(code);
  _wtSave();
  _wtNote = code + ' 已加入關注';
  wtClearSug();
  await startWatch();                       // 重新載入（補合約/報價/訂閱）
}
function wtRemove(code) {
  code = String(code);
  var list = _wtLoad(), i = list.indexOf(code);
  if (i < 0) return;
  list.splice(i, 1);
  _wtSave();
  _wtUnsub(code);
  _wtNote = code + ' 已移除';
  renderWatch();
}

// ── 訂閱／退訂 ──
function _wtUnsub(code) {
  var i = _wtSubbed.indexOf(code);
  if (i < 0) return;                        // 非本頁訂閱（可能是持股）→ 不動
  var c = _contracts[code];
  _wtSubbed.splice(i, 1);
  if (!c) return;
  fetch(API + '/api/v1/stream/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ security_type: 'STK', exchange: c.exchange, code: code, quote_type: 'Tick' })
  }).catch(function () {});
}
function stopWatch() {                      // 離開頁面：退訂本頁新訂閱者，歸還額度
  _wtSubbed.slice().forEach(function (code) { _wtUnsub(code); });
  _wtSubbed = [];
}

// ── 進入頁面 ──
async function startWatch() {
  var wrap = document.getElementById('watch-wrap');
  var info = document.getElementById('watch-info');
  if (!wrap) return;
  if (!(await checkServer())) { wrap.innerHTML = '<div class="stream-error" style="display:block">' + serverDownHtml() + '</div>'; return; }

  info.textContent = '載入合約清單…';
  await _wtEnsureContracts();

  var list = _wtLoad();
  info.textContent = (_wtIdx || []).length.toLocaleString('zh-TW') + ' 檔可搜尋｜關注 ' + list.length + '/' + WT_MAX;
  if (!list.length) { renderWatch(); return; }

  // 補合約 → 初始快照 → 訂閱（已是持股者由 ensureFeed 訂閱過，不重複）
  info.textContent = '取得報價…';
  for (var i = 0; i < list.length; i++) {
    var code = list[i];
    if (!_contracts[code]) { try { _contracts[code] = await fetchContract(code); } catch (e) {} }
    if (!_rows[code]) _rows[code] = { close: null, total_volume: null, time: '' };
  }
  try {
    var cons = list.map(function (c) { return _contracts[c]; }).filter(Boolean);
    if (cons.length) {
      var snaps = await fetchSnapshots(cons);
      snaps.forEach(function (s) { _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) }; });
    }
  } catch (e) {}
  var own = {}; (_positions || []).forEach(function (p) { own[String(p.code)] = true; });
  for (var j = 0; j < list.length; j++) {
    var cd = list[j], ct = _contracts[cd];
    if (ct && !own[cd] && _wtSubbed.indexOf(cd) < 0) {
      try { await subscribeTick(ct); _wtSubbed.push(cd); } catch (e) {}
    }
  }
  info.textContent = (_wtIdx || []).length.toLocaleString('zh-TW') + ' 檔可搜尋｜關注 ' + list.length + '/' + WT_MAX + '｜已連線';
  renderWatch();
}

// ── 渲染 ──
function renderWatch() {
  var wrap = document.getElementById('watch-wrap');
  if (!wrap) return;
  var list = _wtLoad();
  var h = '';
  if (_wtNote) h += '<div class="wt-note">' + _wtNote + '</div>';
  if (!list.length) {
    h += '<div class="modal-loading">尚未加入關注股票，請用上方搜尋框以代碼或名稱加入（上限 ' + WT_MAX + ' 檔）。</div>';
    wrap.innerHTML = h;
    return;
  }
  h += '<div class="inv-table-wrap"><table class="inv-table wt-table"><thead><tr>' +
    '<th></th><th></th><th>代號</th><th>名稱</th><th class="num">現價</th><th class="num">漲跌</th>' +
    '<th class="num">成份股漲跌</th><th></th></tr></thead><tbody>';
  list.forEach(function (code) { h += '<tr id="wt-tr-' + code + '">' + _wtRowHtml(code) + '</tr>'; });
  h += '</tbody></table></div>' +
    '<div class="detail-note">現價與漲跌盤中即時（進頁訂閱、離開退訂）。〔成份股〕僅 ETF 提供；' +
    '〔除息紀錄〕取近 ' + WT_YEARS + ' 年（上市 ETF 走 e添富、其餘走 Yahoo，個股可能查無）。清單存於本機瀏覽器。</div>';
  wrap.innerHTML = h;
}

function _wtRowHtml(code) {
  var c = _contracts[code], r = _rows[code];
  var price = (r && r.close != null) ? r.close : null;
  var ref = c && c.reference;
  var chgAmt = (price != null && ref) ? price - ref : null;
  var chgPct = (price != null && ref) ? (price - ref) / ref * 100 : null;
  var ccls = chgPct == null ? 'flat' : colorClass(chgPct);
  var lim = (typeof limitState === 'function') ? limitState(code, price) : '';
  var isEtf = (typeof isEtfCode === 'function') && isEtfCode(code);
  var cm = (typeof constEst === 'function') ? constEst(code) : null;
  var estCls = (cm && cm.est != null) ? colorClass(cm.est) : 'flat';
  var name = (c && c.name) || (function () {
    var f = (_wtIdx || []).filter(function (x) { return x.c === code; })[0]; return f ? f.n : '';
  })();
  return '<td>' + (isEtf ? '<button class="btn-detail" onclick="openConstituents(\'' + code + '\')">成份股</button>' : '') + '</td>' +
    '<td><button class="btn-detail" onclick="wtOpenDiv(\'' + code + '\')">除息紀錄</button></td>' +
    '<td class="inv-code' + (lim ? ' lim-' + lim : '') + '"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + code + '\')">' + code + '</span></td>' +
    '<td class="inv-name">' + name + '</td>' +
    '<td class="num ' + ccls + '">' + (price != null ? price.toFixed(2) : '—') + '</td>' +
    '<td class="num ' + ccls + '">' + (chgAmt == null ? '—' : fmtChg(chgAmt) + '　' + fmtPct(chgPct)) + '</td>' +
    '<td class="num inv-cchg ' + estCls + '"' + (cm ? ' title="報價覆蓋率 ' + cm.covW.toFixed(1) + '%"' : '') + '>' +
      (cm && cm.est != null ? fmtPct(cm.est) : '—') + '</td>' +
    '<td><button class="swap-mini" onclick="wtRemove(\'' + code + '\')">移除</button></td>';
}

// SSE tick：單列即時更新
function renderWatchRow(code) {
  var tr = document.getElementById('wt-tr-' + String(code));
  if (tr) tr.innerHTML = _wtRowHtml(String(code));
}

// ── 除息紀錄彈窗（近 2 年）──
async function wtOpenDiv(code) {
  code = String(code);
  var title = document.getElementById('detail-title');
  var body = document.getElementById('detail-body');
  document.getElementById('detail-modal').style.display = 'flex';
  var c = _contracts[code];
  title.textContent = code + ' ' + ((c && c.name) || '') + ' — 除息紀錄（近 ' + WT_YEARS + ' 年）';
  body.innerHTML = '<div class="modal-loading">讀取配息資料…</div>';

  var recs = [];
  try { if (typeof _divGetRecs === 'function') recs = await _divGetRecs(code); } catch (e) {}
  if (!recs || !recs.length) {
    body.innerHTML = '<div class="modal-loading">查無配息紀錄（上市 ETF 取自 e添富，其餘取自 Yahoo；個股或未配息標的可能沒有資料）。</div>';
    return;
  }
  var tw = _divTwDate(), today = tw.iso;
  var minDate = new Date(Date.now() - WT_YEARS * 365 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  var list = recs.filter(function (r) { return r.exDate && r.exDate >= minDate; })
    .sort(function (a, b) { return a.exDate < b.exDate ? 1 : -1; });   // 新→舊
  if (!list.length) { body.innerHTML = '<div class="modal-loading">近 ' + WT_YEARS + ' 年無除息紀錄。</div>'; return; }

  // 配息期數：由除息間隔推得（月配12／季配4／半年2／年配1），與換股試算同一套邏輯
  var asc = list.slice().reverse();
  var step = (typeof _divInferStep === 'function') ? _divInferStep(asc) : 12;
  var freq = 12 / step;
  var px = (typeof _swapPrice === 'function') ? _swapPrice(code)
    : ((_rows[code] && _rows[code].close != null) ? _rows[code].close : (c && c.reference) || null);

  var h = '<div class="detail-note" style="margin:0 0 8px">現價 <b>' + (px != null ? px.toFixed(2) : '—') +
    '</b>｜配息頻率：' + (step === 1 ? '月配' : step === 3 ? '季配' : step === 6 ? '半年配' : '年配') +
    '（年 ' + freq + ' 次）｜共 ' + list.length + ' 筆</div>' +
    '<div class="detail-scroll"><table class="detail-table"><thead><tr>' +
    '<th>發放月</th><th>除息</th><th>除息日</th><th>發放日</th><th class="num">每股金額</th>' +
    '<th class="num" title="每股金額 ÷ 現價">月殖利率</th>' +
    '<th class="num" title="每股金額 × 配息期數 ÷ 現價">預估年殖利率</th></tr></thead><tbody>';
  list.forEach(function (r) {
    var pay = r.payDate || _addMonths(r.exDate, 1);
    var amt = r.amount;
    var mY = (amt != null && px > 0) ? amt / px * 100 : null;
    var yY = (amt != null && px > 0) ? amt * freq / px * 100 : null;
    var done = r.exDate <= today;
    h += '<tr>' +
      '<td>' + (pay ? pay.slice(0, 7).replace('-', '/') : '—') + '</td>' +
      '<td class="' + (done ? 'down' : 'flat') + '">' + (done ? '已除息' : '未除息') + '</td>' +
      '<td>' + r.exDate + '</td>' +
      '<td>' + (r.payDate || (pay + ' *')) + '</td>' +
      '<td class="num">' + (amt != null ? amt.toFixed(4) : '待公告') + '</td>' +
      '<td class="num swap-yield">' + (mY != null ? mY.toFixed(2) + '%' : '—') + '</td>' +
      '<td class="num swap-yield">' + (yY != null ? yY.toFixed(2) + '%' : '—') + '</td>' +
    '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="detail-note">月殖利率＝每股金額 ÷ 現價；預估年殖利率＝每股金額 × 配息期數 ÷ 現價（期數由除息間隔推得）。' +
    '發放日標「*」為未公告、以「除息月＋1」推導。資料來源：上市 ETF＝TWSE e添富，其餘＝Yahoo。</div>';
  body.innerHTML = h;
}

// ══════════ 頁籤：關注清單 / 債券 ETF / 主動式 ETF ══════════
function wtShowTab(tab) {
  _wtTab = tab;
  ['list', 'bond', 'act'].forEach(function (t) {
    var b = document.getElementById('wt-subtab-' + t);
    if (b) b.classList.toggle('active', t === tab);
  });
  document.getElementById('wt-search-bar').style.display = (tab === 'list') ? '' : 'none';
  document.getElementById('watch-wrap').style.display = (tab === 'list') ? '' : 'none';
  document.getElementById('wt-bond-wrap').style.display = (tab === 'bond') ? '' : 'none';
  document.getElementById('wt-act-wrap').style.display = (tab === 'act') ? '' : 'none';
  if (tab === 'bond') { _wtBondLoad(); renderWatchBond(); }
  else if (tab === 'act') { _wtActLoadCache(); renderWatchAct(); }
  else renderWatch();
}

// ── 候選池（依代號末碼分類；債券再以名稱鎖定高息類，避免掃描投等債/公債浪費配額）──
var WT_HY_RE = /非投等|非投債|高收益|高息|優先|新興/;
function _wtBondPool() {
  return (_wtIdx || []).filter(function (x) { return /^00\d+B$/.test(x.c) && WT_HY_RE.test(x.n); });
}
function _wtActPool() {
  return (_wtIdx || []).filter(function (x) { return /^00\d+A$/.test(x.c); });
}

// ── 除息資料永久快取：key = code|年月；當月除息日已公告即命中，不再呼叫 Yahoo ──
function _wtDivCache() {
  try { return JSON.parse(localStorage.getItem(WT_DIV_LS) || '{}') || {}; } catch (e) { return {}; }
}
function _wtDivSave(map) { try { localStorage.setItem(WT_DIV_LS, JSON.stringify(map)); } catch (e) {} }

// 取單檔配息並算殖利率；優先讀永久快取（當月已公告者）
async function _wtDivOf(code, ym, cache) {
  var key = code + '|' + ym;
  if (cache[key]) return cache[key];
  var recs = [];
  try { if (typeof _divGetRecs === 'function') recs = await _divGetRecs(code); } catch (e) {}
  recs = (recs || []).filter(function (r) { return r.exDate && r.amount != null; })
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
  if (!recs.length) return { code: code, none: true };
  var last = recs[recs.length - 1];
  var step = (typeof _divInferStep === 'function') ? _divInferStep(recs) : 12;
  var rec = { code: code, amount: last.amount, exDate: last.exDate, payDate: last.payDate || null,
              freq: 12 / step, step: step };
  // 只有「該檔最近一次除息落在本月」才永久存檔（符合：當月已公佈除息日的先存檔、不再重複讀取）
  if (last.exDate.slice(0, 7) === ym) { cache[key] = rec; _wtDivSave(cache); }
  return rec;
}

// ── 債券 ETF 掃描（按鈕觸發；分批並行）──
function _wtBondTh() {
  var v = parseFloat(localStorage.getItem(WT_TH_LS));
  return isNaN(v) ? 7 : v;
}
function wtBondThChanged(el) {
  var v = parseFloat(el.value);
  if (!isNaN(v) && v >= 0) localStorage.setItem(WT_TH_LS, String(v));
}
function _wtBondLoad() {
  if (_wtBond) return _wtBond;
  try { _wtBond = JSON.parse(localStorage.getItem(WT_BOND_LS) || 'null'); } catch (e) { _wtBond = null; }
  return _wtBond;
}
async function wtScanBond() {
  if (_wtBusy) return;
  _wtBusy = true;
  var th = _wtBondTh(), pool = _wtBondPool(), ym = _divTwDate().iso.slice(0, 7);
  var info = document.getElementById('wt-bond-info');
  var cache = _wtDivCache(), rows = [], done = 0;

  // 現價：Shioaji 批次快照（本機、零 GAS）
  var px = {};
  try {
    for (var i = 0; i < pool.length; i++) {
      var cd = pool[i].c;
      if (!_contracts[cd]) { try { _contracts[cd] = await fetchContract(cd); } catch (e) {} }
    }
    var cons = pool.map(function (x) { return _contracts[x.c]; }).filter(Boolean);
    if (cons.length) {
      var snaps = await fetchSnapshots(cons);
      snaps.forEach(function (s) { if (s.close != null) { px[String(s.code)] = s.close; _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) }; } });
    }
  } catch (e) { console.warn('[watch bond px]', e); }

  for (var b = 0; b < pool.length; b += WT_BATCH) {
    var batch = pool.slice(b, b + WT_BATCH);
    if (info) info.textContent = '掃描中 ' + Math.min(b + WT_BATCH, pool.length) + '/' + pool.length + '…';
    var got = await Promise.all(batch.map(function (x) { return _wtDivOf(x.c, ym, cache); }));
    got.forEach(function (r, k) {
      done++;
      if (!r || r.none) return;
      var p = px[r.code] != null ? px[r.code] : (_contracts[r.code] && _contracts[r.code].reference);
      if (!(p > 0)) return;
      rows.push({ code: r.code, name: batch[k].n, px: p, amount: r.amount, exDate: r.exDate, payDate: r.payDate,
        freq: r.freq, mY: r.amount / p * 100, yY: r.amount * r.freq / p * 100 });
    });
  }
  var pass = rows.filter(function (r) { return r.yY >= th; }).sort(function (a, b2) { return b2.yY - a.yY; });
  _wtBond = { at: new Date().toISOString(), th: th, scanned: pool.length, got: rows.length, rows: pass };
  try { localStorage.setItem(WT_BOND_LS, JSON.stringify(_wtBond)); } catch (e) {}
  _wtBusy = false;
  renderWatchBond();
}

// ── 主動式 ETF 報酬（Yahoo 日K；每日快取）──
function _wtActLoadCache() {
  if (_wtAct) return _wtAct;
  try {
    var c = JSON.parse(localStorage.getItem(WT_ACT_LS) || 'null');
    if (c && c.day === _divTwDate().iso) _wtAct = c;
  } catch (e) {}
  return _wtAct;
}
async function _wtActFetch(code) {
  var syms = [code + '.TW', code + '.TWO'];
  for (var i = 0; i < syms.length; i++) {
    try {
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(syms[i]) + '?interval=1d&range=2y';
      var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
      var j = await r.json();
      var res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) continue;
      var cl = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [])
        .filter(function (x) { return x != null; });
      if (cl.length >= 5) return cl;
    } catch (e) {}
  }
  return null;
}
async function wtLoadAct(force) {
  if (_wtBusy) return;
  if (!force && _wtActLoadCache()) { renderWatchAct(); return; }
  _wtBusy = true;
  var pool = _wtActPool(), info = document.getElementById('wt-act-info'), rows = [];
  for (var b = 0; b < pool.length; b += WT_BATCH) {
    var batch = pool.slice(b, b + WT_BATCH);
    if (info) info.textContent = '取得日K ' + Math.min(b + WT_BATCH, pool.length) + '/' + pool.length + '…';
    var got = await Promise.all(batch.map(function (x) { return _wtActFetch(x.c); }));
    got.forEach(function (cl, k) {
      if (!cl) return;
      var n = cl.length, last = cl[n - 1];
      var ret = function (d) { return n > d ? (last - cl[n - 1 - d]) / cl[n - 1 - d] * 100 : null; };
      rows.push({ code: batch[k].c, name: batch[k].n, px: last, days: n,
        r1: ret(20), r3: ret(60), rAll: cl[0] ? (last - cl[0]) / cl[0] * 100 : null });
    });
  }
  rows.sort(function (a, b2) { return (b2.rAll == null ? -1e9 : b2.rAll) - (a.rAll == null ? -1e9 : a.rAll); });
  _wtAct = { day: _divTwDate().iso, at: new Date().toISOString(), rows: rows, pool: pool.length };
  try { localStorage.setItem(WT_ACT_LS, JSON.stringify(_wtAct)); } catch (e) {}
  _wtBusy = false;
  renderWatchAct();
}

// ── 勾選與批次加入 ──
function wtPick(code, el) { if (el.checked) _wtPick[code] = true; else delete _wtPick[code]; _wtPickInfo(); }
function _wtPickInfo() {
  var n = Object.keys(_wtPick).length, el = document.getElementById('wt-pick-info');
  if (el) el.textContent = n ? '已勾選 ' + n + ' 檔' : '';
}
async function wtAddPicked() {
  var picks = Object.keys(_wtPick), list = _wtLoad(), added = 0, full = false;
  picks.forEach(function (c) {
    if (list.indexOf(c) >= 0) return;
    if (list.length >= WT_MAX) { full = true; return; }
    list.push(c); added++;
  });
  _wtSave(); _wtPick = {};
  _wtNote = '已加入 ' + added + ' 檔' + (full ? '（達上限 ' + WT_MAX + ' 檔，其餘未加入）' : '');
  wtShowTab('list');
  await startWatch();
}

// ── 渲染：債券 ETF ──
function renderWatchBond() {
  var wrap = document.getElementById('wt-bond-wrap');
  if (!wrap) return;
  var th = _wtBondTh(), d = _wtBondLoad();
  var have = {}; _wtLoad().forEach(function (c) { have[c] = true; });
  var h = '<div class="wt-bar">年殖利率 ≥ <input id="wt-bond-th" class="sbl-inp" type="number" min="0" step="0.5" value="' + th +
    '" onchange="wtBondThChanged(this)"> %' +
    '<button class="btn-query" onclick="wtScanBond()">↻ 重新篩選</button>' +
    '<span id="wt-bond-info" class="wt-dim">' +
      (d ? '上次篩選 ' + String(d.at).replace('T', ' ').slice(0, 16) + '（門檻 ' + d.th + '%｜掃 ' + d.scanned + ' 檔、取得 ' + d.got + ' 檔、通過 ' + d.rows.length + ' 檔）'
         : '尚未篩選，按「重新篩選」開始（約 ' + _wtBondPool().length + ' 檔，數秒）') + '</span>' +
    '<span id="wt-pick-info" class="wt-dim"></span>' +
    '<button class="btn-query" onclick="wtAddPicked()">＋ 加入關注</button></div>';

  if (!d || !d.rows.length) {
    h += '<div class="modal-loading">' + (d ? '沒有年殖利率 ≥ ' + d.th + '% 的標的，可調低門檻後重新篩選。' : '尚未篩選。') + '</div>';
    wrap.innerHTML = h; return;
  }
  h += '<div class="inv-table-wrap"><table class="inv-table wt-table"><thead><tr>' +
    '<th></th><th>代號</th><th>名稱</th><th class="num">現價</th><th class="num">每股金額</th>' +
    '<th class="num">月殖利率</th><th class="num">預估年殖利率</th><th>除息日</th><th>發放日</th></tr></thead><tbody>';
  d.rows.forEach(function (r) {
    h += '<tr>' +
      '<td>' + (have[r.code] ? '<span class="wt-dim">已關注</span>'
        : '<input type="checkbox"' + (_wtPick[r.code] ? ' checked' : '') + ' onchange="wtPick(\'' + r.code + '\',this)">') + '</td>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + r.code + '\')">' + r.code + '</span></td>' +
      '<td class="inv-name">' + r.name + '</td>' +
      '<td class="num">' + r.px.toFixed(2) + '</td>' +
      '<td class="num">' + r.amount.toFixed(4) + '</td>' +
      '<td class="num swap-yield">' + r.mY.toFixed(2) + '%</td>' +
      '<td class="num swap-yield"><b>' + r.yY.toFixed(2) + '%</b></td>' +
      '<td>' + r.exDate + '</td>' +
      '<td>' + (r.payDate || '—') + '</td>' +
    '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="detail-note">掃描範圍：代號末碼 B 且名稱含「非投等／非投債／高收益／高息／優先／新興」者（' + _wtBondPool().length +
    ' 檔）；投等債與公債殖利率普遍低於門檻，不掃以節省配額。預估年殖利率＝最近一次配息 × 配息期數 ÷ 現價，依此由高至低排序。' +
    '結果與「當月已公告除息」永久存檔，進頁不重抓，按「重新篩選」才更新。</div>';
  wrap.innerHTML = h;
  _wtPickInfo();
}

// ── 渲染：主動式 ETF ──
var _wtActSort = 'rAll';
function wtActSort(k) {
  _wtActSort = k;
  if (_wtAct && _wtAct.rows) {
    _wtAct.rows.sort(function (a, b) {
      var x = a[k], y = b[k];
      return (y == null ? -1e9 : y) - (x == null ? -1e9 : x);
    });
  }
  renderWatchAct();
}
function renderWatchAct() {
  var wrap = document.getElementById('wt-act-wrap');
  if (!wrap) return;
  var d = _wtAct;
  var have = {}; _wtLoad().forEach(function (c) { have[c] = true; });
  var h = '<div class="wt-bar"><button class="btn-query" onclick="wtLoadAct(true)">↻ 重新計算</button>' +
    '<span id="wt-act-info" class="wt-dim">' +
      (d ? d.rows.length + ' / ' + d.pool + ' 檔有資料｜更新 ' + String(d.at).replace('T', ' ').slice(0, 16) + '（每日快取）'
         : '尚未載入，按「重新計算」開始（' + _wtActPool().length + ' 檔，約 10 秒）') + '</span>' +
    '<span id="wt-pick-info" class="wt-dim"></span>' +
    '<button class="btn-query" onclick="wtAddPicked()">＋ 加入關注</button></div>';
  if (!d || !d.rows.length) { h += '<div class="modal-loading">尚未載入報酬資料。</div>'; wrap.innerHTML = h; return; }

  var sh = function (k, label) {
    return '<th class="num sort-th" onclick="wtActSort(\'' + k + '\')">' + label +
      '<span class="sort-ind">' + (_wtActSort === k ? '▼' : '↕') + '</span></th>';
  };
  var pct = function (v) { return v == null ? '<span class="flat">—</span>' : '<span class="' + colorClass(v) + '">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</span>'; };
  h += '<div class="inv-table-wrap"><table class="inv-table wt-table"><thead><tr>' +
    '<th></th><th>代號</th><th>名稱</th><th class="num">現價</th>' +
    sh('r1', '近1月') + sh('r3', '近3月') + sh('rAll', '成立以來') +
    '<th class="num" title="Yahoo 可取得的交易日數，越短代表上市越新">資料天數</th></tr></thead><tbody>';
  d.rows.forEach(function (r) {
    h += '<tr>' +
      '<td>' + (have[r.code] ? '<span class="wt-dim">已關注</span>'
        : '<input type="checkbox"' + (_wtPick[r.code] ? ' checked' : '') + ' onchange="wtPick(\'' + r.code + '\',this)">') + '</td>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + r.code + '\')">' + r.code + '</span></td>' +
      '<td class="inv-name">' + r.name + '</td>' +
      '<td class="num">' + (r.px != null ? r.px.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + pct(r.r1) + '</td>' +
      '<td class="num">' + pct(r.r3) + '</td>' +
      '<td class="num"><b>' + pct(r.rAll) + '</b></td>' +
      '<td class="num' + (r.days < 60 ? ' swap-warn' : '') + '">' + r.days + '</td>' +
    '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="detail-note">報酬以 Yahoo 日收盤價計（主動式 ETF 目前多未配息或配息少，價格報酬≈總報酬）。' +
    '<b>務必同時看「資料天數」</b>：主動式 ETF 多為新上市，49 天的報酬與 194 天的報酬不可直接比較；天數不足者近1月/近3月顯示「—」。' +
    '點欄位可排序，預設依成立以來由高至低。每日快取，按「重新計算」強制更新。</div>';
  wrap.innerHTML = h;
  _wtPickInfo();
}
