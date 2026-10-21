// 股利總管 Web — 參數設定頁外殼（左欄分類、右欄內容、搜尋）
//
// 為什麼要改：原本三個區塊平鋪，說明永遠攤開，而且真正的使用者設定有八組、
// 這頁只收三組（停損停利在自己的頁、借券參數在借券頁、配息與填息補登在各自頁面）。
// 版面比照 Windows 設定：分類在左、內容在右，每項一列（標題＋一行說明＋右側狀態），
// 點開才展開明細，長說明收在項目內。
//
// 原則：資料留在原來的模組，這裡只負責擺放與開合。同一份設定不複製第二份狀態。

var SET_LAST_LS = 'set_sec_v1';

// render：第一次展開時呼叫（惰性，避免進頁就掃描建倉明細）
// status：收合時右側顯示的一行摘要，回字串或 null
// link：不在本頁編輯的項目，給一個前往該頁的按鈕
var SET_SECTIONS = [
  { id: 'cost', title: '成本與損益', rows: [
    { key: 'cost-ov', title: '認購成本補正', bodyId: 'params-cost-body',
      desc: '銀行或發行商認購後匯撥進來的批次，券商端成本是 0，在此填回每股認購價',
      render: function (first) { if (typeof renderCostOverride === 'function') renderCostOverride(!first); },
      status: function () {
        if (typeof _coMap === 'undefined' || !_coMap) return null;
        var n = 0;
        Object.keys(_coMap).forEach(function (c) { n += Object.keys(_coMap[c] || {}).length; });
        return n ? n + ' 筆已設定' : '未設定';
      } },
    { key: 'tax', title: '含稅費', inline: _setTaxHtml,
      desc: '損益是否扣除賣出手續費與交易稅（0.997735）。與頂欄的切換是同一個設定' }
  ] },
  { id: 'div', title: '配息與填息', rows: [
    { key: 'lent', title: '除息日借出張數', bodyId: 'params-lent-body',
      desc: '借出中的股數配息改由借券人付權益補償，兩筆分開入帳，需要知道除息日當天借出幾張',
      render: function () { if (typeof renderLentManual === 'function') renderLentManual(); },
      status: function () {
        if (typeof _lentData === 'undefined' || !_lentData) return null;
        var n = 0;
        Object.keys(_lentData.manual || {}).forEach(function (c) { n += Object.keys(_lentData.manual[c] || {}).length; });
        return n ? n + ' 筆手動補登' : '全部自動紀錄';
      } },
    { key: 'div-man', title: '配息手動補登', link: 'openDividendEst()', linkText: '前往股利估算',
      desc: '官方尚未公告時先自行填入金額與日期，公告後自動被覆蓋。在股利估算頁就地編輯' },
    { key: 'rf-man', title: '填息手動補登', link: 'openDividendEst()', linkText: '前往填息追蹤',
      desc: '開始自動紀錄之前的除息，或紀錄有誤時在填息追蹤頁補登' }
  ] },
  { id: 'retire', title: '退休現金流', rows: [
    { key: 'retire-exp', title: '每月預計支出與定存利率', bodyId: 'params-retire-body',
      desc: '月基準加上特定月份覆寫；填好後對照月份總覽的配息入帳，算出逐月淨額與累計餘額',
      render: function () { if (typeof renderRetire === 'function') renderRetire(); },
      status: function () { return (typeof rtStatus === 'function' && typeof _rtCfg !== 'undefined' && _rtCfg) ? rtStatus() : null; } },
    { key: 'retire-spc', title: '總現值管制圖', bodyId: 'params-spc-body',
      desc: '連續天數（兼市場效應均線期數）、目標上下限、90 日平均線。走勢抽屜「管制圖」頁籤用的參數，改完立刻重畫',
      render: function () { if (typeof renderRetireSpc === 'function') renderRetireSpc(); },
      status: function () { return (typeof rtSpcStatus === 'function' && typeof _rtCfg !== 'undefined' && _rtCfg) ? rtSpcStatus() : null; } }
  ] },
  { id: 'alert', title: '停損停利', rows: [
    { key: 'al', title: '各檔停利／停損門檻', link: 'openAlerts()', linkText: '前往停損停利',
      desc: '停利價、停利率、停損價、停損率、買進價。比對的是含息獲利率（價差＋已落袋配息 ÷ 原始成本）。'
          + '那一頁同時顯示現價與含息獲利率，是工作畫面，設定就在那裡改' }
  ] },
  { id: 'sbl', title: '借券', rows: [
    { key: 'sbl-thr', title: '出借篩選門檻', inline: _setSblHtml,
      desc: '費率下限、閒置天數、量能下限。改完借券頁的提醒與試算會跟著重算' }
  ] },
  { id: 'import', title: '資料匯入', rows: [
    { key: 'const', title: '成份股匯入', bodyId: 'params-const-body',
      desc: '只列出自動來源（MoneyDJ／CMoney）抓不到、需手動維護清單的 ETF（境外或主動式）',
      render: function (first) { if (typeof renderConstImport === 'function') renderConstImport(!first); } }
  ] },
  { id: 'cache', title: '快取與儲存', rows: [
    { key: 'cache-list', title: '本機快取', bodyId: 'params-cache-body',
      desc: '各項快取的大小與更新時間，可個別清除。清除只影響下次載入速度，不會刪掉你的設定',
      render: function () { _setRenderCache(); } }
  ] }
];

var _setSec = (function () {
  try {
    var v = localStorage.getItem(SET_LAST_LS);
    if (SET_SECTIONS.some(function (s) { return s.id === v; })) return v;
  } catch (e) {}
  return SET_SECTIONS[0].id;
})();
// 兩個狀態要分開：_setOpen 是「目前展開中」，_setRendered 是「render 過了」。
// 併成一個的話，收合某列之後切換分類，重繪的還原迴圈會把它再打開。
var _setOpen = {}, _setRendered = {};
var _setQuery = '';

function startParams() { setRender(); }

function setGo(id) {
  _setSec = id; _setQuery = '';
  var box = document.getElementById('set-search');
  if (box) box.value = '';
  try { localStorage.setItem(SET_LAST_LS, id); } catch (e) {}
  setRender();
}
function setSearch(q) { _setQuery = (q || '').trim(); setRender(); }

function setToggle(key) {
  var row = document.querySelector('[data-set-row="' + key + '"]');
  if (!row) return;
  var open = row.classList.toggle('open');
  var chev = row.querySelector('.set-chev');
  if (chev) chev.textContent = open ? '▾' : '▸';
  if (!open) { delete _setOpen[key]; return; }
  _setOpen[key] = true;
  var r = _setFindRow(key);
  if (r && r.render) { r.render(!_setRendered[key]); _setRendered[key] = true; }
}
function _setFindRow(key) {
  for (var i = 0; i < SET_SECTIONS.length; i++) {
    var rows = SET_SECTIONS[i].rows;
    for (var j = 0; j < rows.length; j++) if (rows[j].key === key) return rows[j];
  }
  return null;
}

// ── 列內嵌控制項（短設定不需要展開）──
function _setTaxHtml() {
  var on = (typeof _taxMode !== 'undefined') ? !!_taxMode : false;
  return '<label class="set-switch"><input type="checkbox"' + (on ? ' checked' : '') +
    ' onchange="setTaxMode(this.checked)"><span>' + (on ? '扣除' : '不扣除') + '</span></label>';
}
function setTaxMode(on) {
  // 與頂欄共用同一個狀態，不另存一份：只有值不同時才切，避免重複觸發重繪
  if (typeof _taxMode !== 'undefined' && !!_taxMode !== !!on && typeof toggleTaxMode === 'function') toggleTaxMode();
  setRender();
}
function _setSblHtml() {
  var t = (typeof _sblThr === 'function') ? _sblThr() : { fee: 0.5, vol: 10, idle: 6 };
  var f = function (id, v, step, unit) {
    return '<span class="set-inline"><input id="' + id + '" type="number" step="' + step + '" class="al-in" value="' + v +
      '" oninput="sblThrChanged()"><span class="set-unit">' + unit + '</span></span>';
  };
  return '<span class="set-triple">' +
    '<span class="set-lb">費率下限</span>' + f('sbl-fee-min', t.fee, '0.1', '%') +
    '<span class="set-lb">閒置天數</span>' + f('sbl-idle-days', t.idle, '1', '天') +
    '<span class="set-lb">量能下限</span>' + f('sbl-vol-min', t.vol, '1', '張') +
    '</span>';
}

// ── 快取清單 ──
// 只列「重抓就能補回來」的快取；設定類（認購成本、借出補登、停損停利、退休現金流）不列，
// 那些清掉會真的掉資料。
var SET_CACHE = [
  ['macro_snap_v1', '盤勢快照'], ['pv_hist_v3', '總現值走勢'], ['refill_px_v1', '填息價格'],
  ['refill_cal_v2', '填息行事曆'], ['divest_px_v1', '配息價格'], ['divest_etfmeta_v1', 'ETF 基本資料'],
  ['divest_offhist_v2', '官方配息歷史'], ['divest_soldlots_v1', '已出清批次'],
  ['tdcc_hist_v1', '集保分布'], ['news_fred_v1', 'FRED 總經'], ['const_list_v1', '成份股清單'],
  ['nav_usage_v1', '淨值用量'], ['etf_screen_v1', 'ETF 篩選']
];
function _setBytes(n) {
  return n < 1024 ? n + ' B' : (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
}
function _setRenderCache() {
  var el = document.getElementById('params-cache-body');
  if (!el) return;
  var rows = '', tot = 0;
  SET_CACHE.forEach(function (c) {
    var v = null;
    try { v = localStorage.getItem(c[0]); } catch (e) {}
    if (v == null) return;
    tot += v.length;
    var day = '';
    try {
      var j = JSON.parse(v);
      day = j.day || j.built || (j.updated ? String(j.updated).slice(0, 10) : '') ||
        (j.at ? new Date(j.at).toISOString().slice(0, 10) : '');
    } catch (e) {}
    rows += '<tr><td>' + c[1] + '<span class="set-key">' + c[0] + '</span></td>' +
      '<td class="num">' + _setBytes(v.length) + '</td>' +
      '<td>' + (day || '—') + '</td>' +
      '<td style="text-align:center"><button class="btn-query" onclick="setClearCache(\'' + c[0] + '\')">清除</button></td></tr>';
  });
  if (!rows) { el.innerHTML = '<div class="modal-loading">目前沒有本機快取</div>'; return; }
  el.innerHTML = '<table class="detail-table"><thead><tr><th>項目</th><th class="num">大小</th><th>資料日</th>' +
    '<th style="text-align:center">動作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="set-hint">合計 ' + _setBytes(tot) + '。清除後下次開啟該頁會重抓，設定類資料不在這份清單裡。</div>';
}
function setClearCache(k) {
  try { localStorage.removeItem(k); } catch (e) {}
  _setRenderCache();
}

// ── 版面 ──
function _setMatch(sec, row) {
  if (!_setQuery) return true;
  var q = _setQuery.toLowerCase();
  return (sec.title + ' ' + row.title + ' ' + (row.desc || '')).toLowerCase().indexOf(q) >= 0;
}

function setRender() {
  var nav = document.getElementById('set-nav'), pane = document.getElementById('set-pane');
  if (!nav || !pane) return;

  nav.innerHTML = SET_SECTIONS.map(function (s) {
    var n = s.rows.filter(function (r) { return _setMatch(s, r); }).length;
    var on = (!_setQuery && s.id === _setSec) ? ' on' : '';
    var dim = (_setQuery && !n) ? ' dim' : '';
    return '<button class="set-navitem' + on + dim + '" onclick="setGo(\'' + s.id + '\')">' + s.title +
      (_setQuery ? '<span class="set-navn">' + n + '</span>' : '') + '</button>';
  }).join('');

  var secs = _setQuery ? SET_SECTIONS : SET_SECTIONS.filter(function (s) { return s.id === _setSec; });
  var html = '';
  secs.forEach(function (s) {
    var rows = s.rows.filter(function (r) { return _setMatch(s, r); });
    if (!rows.length) return;
    html += '<div class="set-sectitle">' + s.title + '</div>';
    rows.forEach(function (r) {
      var st = (r.status && r.status()) || '';
      var right = r.inline ? r.inline()
        : (r.link ? '<button class="btn-query" onclick="' + r.link + '">' + (r.linkText || '前往') + '</button>'
                  : '<span class="set-status" data-set-status="' + r.key + '">' + st + '</span><span class="set-chev">▸</span>');
      var clickable = !r.inline && !r.link;
      html += '<div class="set-row" data-set-row="' + r.key + '">' +
        '<div class="set-head"' + (clickable ? ' onclick="setToggle(\'' + r.key + '\')"' : '') + '>' +
          '<div class="set-main"><div class="set-title">' + r.title + '</div>' +
            '<div class="set-desc">' + (r.desc || '') + '</div></div>' +
          '<div class="set-right">' + right + '</div>' +
        '</div>' +
        (r.bodyId ? '<div class="set-body"><div id="' + r.bodyId + '"></div></div>' : '') +
      '</div>';
    });
  });
  pane.innerHTML = html || '<div class="modal-loading">沒有符合的設定</div>';

  // 重繪後把原本展開的列還原（內容重新 render，不保留舊 DOM）
  Object.keys(_setOpen).forEach(function (k) {
    var row = document.querySelector('[data-set-row="' + k + '"]');
    if (!row) return;
    row.classList.add('open');
    var chev = row.querySelector('.set-chev');
    if (chev) chev.textContent = '▾';
    var r = _setFindRow(k);
    if (r && r.render) { r.render(!_setRendered[k]); _setRendered[k] = true; }
  });

  var store = document.getElementById('set-store');
  if (store) {
    var cloud = !!(window.FB && window.OWNER_UID);
    store.textContent = cloud ? '設定儲存於 Firestore（已登入）' : '設定儲存於本機瀏覽器（未登入）';
    store.className = 'set-store' + (cloud ? ' ok' : '');
  }
}
