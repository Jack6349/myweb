// 股利總管 Web — 填息追蹤（股利估算子頁籤）
// 填息定義：基準價 P0 ＝ 除息日前一交易日收盤；除息後首次「收盤 ≥ P0」即填息，天數以交易日計。
// 價格用 Yahoo 未還原收盤價（還原價會抹平除息缺口，算不出填息）；每檔每日快取，無除息紀錄者不抓價。

var RF_YEARS = 2;                 // 統計範圍（近 2 年除息）
var RF_LS = 'refill_px_v1';       // 日K 快取（每日）
var RF_CAL_LS = 'refill_cal_v1';  // TPEx 除權息預告快取（每日）
var RF_MAN_LS = 'refill_manual_v1'; // 手動補登的除息資料（官方公告後自動被覆蓋）

// ── 手動補登：貼上「股利 除息日 發放日」一行自動解析（分隔可為 Tab／空白／逗號）──
// 例：0.153	2026/08/18	2026/09/09
function _rfManLoad() {
  try { return JSON.parse(localStorage.getItem(RF_MAN_LS) || '{}') || {}; } catch (e) { return {}; }
}
function _rfManSave(map) { try { localStorage.setItem(RF_MAN_LS, JSON.stringify(map)); } catch (e) {} }
// 除息資料異動後，同步重算股利估算（沿用當日快取，不會多打 GAS）；換股試算也會因 _divRecMap 更新而同步
function _rfSyncDivEst() {
  if (typeof startDividendEst !== 'function') return;
  if (typeof _divEstResult === 'undefined' || !_divEstResult) return;   // 尚未載入過就不用重算
  try { startDividendEst(); } catch (e) { console.warn('[refill sync divest]', e); }
}
function _rfManStr(r) {
  if (!r) return '';
  return r.amount + '  ' + (r.exDate || '').replace(/-/g, '/') + (r.payDate ? '  ' + r.payDate.replace(/-/g, '/') : '');
}
function _rfParseManual(s) {
  var p = String(s || '').trim().split(/[\s,\t]+/).filter(Boolean);
  if (p.length < 2) return null;
  var amt = parseFloat(p[0]);
  if (isNaN(amt) || amt <= 0) return null;
  var toIso = function (x) {
    var m = String(x || '').match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
    return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
  };
  var ex = toIso(p[1]), pay = p.length >= 3 ? toIso(p[2]) : null;
  if (!ex) return null;
  return { amount: amt, exDate: ex, payDate: pay };
}
function rfManualInput(code, el) {
  var raw = el.value;
  var map = _rfManLoad();
  if (!raw.trim()) { delete map[code]; _rfManSave(map); _rfNote = code + ' 手動資料已清除'; _rfSyncDivEst(); renderRefill(); return; }
  var r = _rfParseManual(raw);
  if (!r) { _rfNote = code + ' 格式無法解析，請貼上如：0.153　2026/08/18　2026/09/09'; renderRefill(); return; }
  map[code] = r;
  _rfManSave(map);
  _rfNote = code + ' 已補登：配息 ' + r.amount + '、除息 ' + r.exDate + (r.payDate ? '、發放 ' + r.payDate : '');
  _rfSyncDivEst();                  // 同步刷新股利估算的預估數字
  startRefill();                    // 重算日曆（併入手動值）
}
var _rfResult = null;             // [{code,name,events:[],filled,total,avgDays,medDays,pending}]
var _rfOpen = {};                 // code -> 是否展開
var _rfCal = null;                // 除息日曆：[{code,name,exDate,amount,payDate,src}]

// ── 上櫃除權息預告表（TPEx OpenAPI，官方 JSON；每日 1 次即涵蓋全市場）──
var _rfTpexFresh = false;          // 本次是否真的向 TPEx 抓了新資料（用來決定要不要同步刷新股利估算）
async function _rfFetchTpex() {
  var day = _divTwDate().iso;
  try { var c = JSON.parse(localStorage.getItem(RF_CAL_LS) || 'null'); if (c && c.day === day) return c.rows; } catch (e) {}
  _rfTpexFresh = true;
  var rows = [];
  try {
    var url = 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost';
    var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
    var j = await r.json();
    (Array.isArray(j) ? j : []).forEach(function (x) {
      var d = String(x.ExRrightsExDividendDate || '');
      if (d.length !== 7) return;                                   // 民國 yyyMMdd
      var iso = (+d.slice(0, 3) + 1911) + '-' + d.slice(3, 5) + '-' + d.slice(5, 7);
      var amt = parseFloat(x.CashDividend);                          // 可能是「尚未公告」
      rows.push({ code: String(x.SecuritiesCompanyCode), name: x.CompanyName || '',
        exDate: iso, amount: isNaN(amt) ? null : amt, payDate: null, src: 'TPEx' });
    });
  } catch (e) { console.warn('[refill tpex]', e); }
  if (rows.length) { try { localStorage.setItem(RF_CAL_LS, JSON.stringify({ day: day, rows: rows })); } catch (e) {} }
  return rows;
}

// ── 除息日曆：上市走 e添富（_divRecMap 已含未來公告）、上櫃走 TPEx；合併後依除息日排序 ──
async function _rfBuildCalendar(codes, todayIso) {
  var cal = {};
  // e添富：_divRecMap 內除息日 ≥ 今天者
  codes.forEach(function (code) {
    ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || []).forEach(function (r) {
      if (!r.exDate || r.exDate < todayIso) return;
      cal[code + '|' + r.exDate] = { code: code, name: _swapName(code) || r.name || '',
        exDate: r.exDate, amount: r.amount, payDate: r.payDate || null,
        src: (typeof _divByCode !== 'undefined' && _divByCode[code]) ? 'e添富' : 'Yahoo' };
    });
  });
  // TPEx：僅補持股中的上櫃標的
  var tp = await _rfFetchTpex();
  var held = {}; codes.forEach(function (c) { held[c] = true; });
  tp.forEach(function (r) {
    if (!held[r.code] || r.exDate < todayIso) return;
    var k = r.code + '|' + r.exDate, cur = cal[k];
    if (!cur) { cal[k] = { code: r.code, name: _swapName(r.code) || r.name, exDate: r.exDate, amount: r.amount, payDate: null, src: 'TPEx' }; }
    else if (cur.amount == null && r.amount != null) { cur.amount = r.amount; cur.src += '＋TPEx'; }
  });
  // 手動補登：只填官方仍缺的欄位；官方公告後即以官方值為準（不覆蓋已有值）
  var man = _rfManLoad();
  Object.keys(man).forEach(function (code) {
    if (!held[code]) return;
    var r = man[code];
    if (!r || !r.exDate || r.exDate < todayIso) return;
    var k = code + '|' + r.exDate, cur = cal[k];
    if (!cur) {
      cal[k] = { code: code, name: _swapName(code) || '', exDate: r.exDate,
        amount: r.amount, payDate: r.payDate || null, src: '手動', manual: true };
    } else {
      if (cur.amount == null && r.amount != null) { cur.amount = r.amount; cur.manual = true; }
      if (!cur.payDate && r.payDate) { cur.payDate = r.payDate; cur.manual = true; }
    }
  });
  return Object.keys(cal).map(function (k) { return cal[k]; })
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : (a.exDate > b.exDate ? 1 : String(a.code).localeCompare(String(b.code))); });
}

var _rfNote = '';   // 頁面提示訊息（手動補登結果）

// ── 日K（含日期、未還原收盤）：Yahoo 2y，經 GAS ?url= 代理；每日快取 ──
async function _rfFetchDaily(code) {
  var day = _divTwDate().iso, cache = { day: day, map: {} };
  try { var c = JSON.parse(localStorage.getItem(RF_LS) || 'null'); if (c && c.day === day) cache = c; } catch (e) {}
  if (cache.map[code]) return cache.map[code];

  var syms = /^\d/.test(String(code)) ? [code + '.TW', code + '.TWO'] : [code];
  var bars = null;
  for (var i = 0; i < syms.length && !bars; i++) {
    try {
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(syms[i]) +
        '?interval=1d&range=' + RF_YEARS + 'y';
      var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
      var j = await r.json();
      var res = j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.timestamp) continue;
      var cl = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
      var out = [];
      for (var k = 0; k < res.timestamp.length; k++) {
        if (cl[k] == null) continue;
        out.push({ d: new Date(res.timestamp[k] * 1000 + 8 * 3600000).toISOString().slice(0, 10), c: cl[k] });
      }
      if (out.length >= 20) bars = out;
    } catch (e) {}
  }
  if (bars) {
    cache.map[code] = bars; cache.day = day;
    try { localStorage.setItem(RF_LS, JSON.stringify(cache)); } catch (e) {}
  }
  return bars;
}

// ── 單筆除息的填息判定 ──
// 回傳 {exDate, amount, base(P0), filledDate, days, pending, gapPct}
function _rfCheckOne(bars, exDate, amount, todayIso) {
  var iPrev = -1;                                   // 除息日前一交易日
  for (var i = 0; i < bars.length; i++) { if (bars[i].d < exDate) iPrev = i; else break; }
  if (iPrev < 0) return null;                       // 價格資料未涵蓋該除息日
  var base = bars[iPrev].c;
  var iEx = iPrev + 1;
  if (iEx >= bars.length) return null;              // 除息日尚無價格
  for (var j = iEx; j < bars.length; j++) {
    if (bars[j].c >= base) {
      return { exDate: exDate, amount: amount, base: base, filledDate: bars[j].d, days: j - iPrev, pending: false };
    }
  }
  var last = bars[bars.length - 1];
  return { exDate: exDate, amount: amount, base: base, filledDate: null,
    days: bars.length - 1 - iPrev, pending: true, gapPct: (base - last.c) / base * 100, lastPx: last.c };
}

// ── 單檔統計 ──
function _rfComputeCode(code, recs, bars, todayIso) {
  var minDate = (function () {
    var d = new Date(Date.now() - RF_YEARS * 365 * 86400000 + 8 * 3600000);
    return d.toISOString().slice(0, 10);
  })();
  var evs = [];
  (recs || []).filter(function (r) { return r.exDate && r.exDate >= minDate && r.exDate <= todayIso && r.amount != null; })
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; })
    .forEach(function (r) {
      var e = _rfCheckOne(bars, r.exDate, r.amount, todayIso);
      if (e) evs.push(e);
    });
  if (!evs.length) return null;
  var done = evs.filter(function (e) { return !e.pending; });
  var days = done.map(function (e) { return e.days; }).sort(function (a, b) { return a - b; });
  var avg = days.length ? days.reduce(function (a, b) { return a + b; }, 0) / days.length : null;
  var med = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
  var pend = evs.filter(function (e) { return e.pending; });
  return { code: code, name: _swapName(code) || '', events: evs.slice().reverse(),
    filled: done.length, total: evs.length, avgDays: avg, medDays: med, pending: pend[0] || null };
}

// ── 進入頁面 ──
async function startRefill(force) {
  var wrap = document.getElementById('refill-wrap');
  var info = document.getElementById('refill-info');
  if (!wrap) return;
  if (force) { try { localStorage.removeItem(RF_LS); } catch (e) {} }
  wrap.innerHTML = '<div class="modal-loading">載入持股與配息資料…</div>';

  if (!_divEstResult) { try { await startDividendEst(); } catch (e) {} }
  var shareMap = (typeof _sharesMap !== 'undefined' && _sharesMap) ? _sharesMap : {};
  var codes = Object.keys(shareMap).filter(function (c) { return shareMap[c] > 0 && isEtfCode(c); })
    .sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); });
  if (!codes.length) { wrap.innerHTML = '<div class="modal-loading">無持有 ETF</div>'; return; }

  var todayIso = _divTwDate().iso;
  // 先篩掉「無除息紀錄」者（新上市未開始配息）→ 不抓價、不浪費 GAS 配額
  var withDiv = [], noDiv = [];
  codes.forEach(function (code) {
    var recs = (typeof _divRecMap !== 'undefined') && _divRecMap[code];
    var past = (recs || []).filter(function (r) { return r.exDate && r.exDate <= todayIso && r.amount != null; });
    if (past.length) withDiv.push(code); else noDiv.push(code);
  });
  if (!withDiv.length) {
    wrap.innerHTML = '<div class="modal-loading">持有 ETF 皆尚未開始除息（' + noDiv.join('、') + '）</div>';
    return;
  }

  // 除息日曆（未來已公告除息）：上市 e添富＋上櫃 TPEx，缺漏欄位可由使用者手動補登
  info.textContent = '取得除息預告…';
  var cal = [];
  _rfTpexFresh = false;
  try { cal = await _rfBuildCalendar(codes, todayIso); } catch (e) { console.warn('[refill calendar]', e); }
  _rfCal = cal;
  // 首次取得 TPEx 預告表時，股利估算可能是在沒有這些資料前算的 → 同步重算一次
  if (_rfTpexFresh) { _rfTpexFresh = false; _rfSyncDivEst(); }

  var rows = [];
  for (var i = 0; i < withDiv.length; i++) {
    var code = withDiv[i];
    info.textContent = '取得日K ' + (i + 1) + '/' + withDiv.length + '（' + code + '）…';
    var bars = await _rfFetchDaily(code);
    if (!bars) continue;
    var r = _rfComputeCode(code, _divRecMap[code], bars, todayIso);
    if (r) rows.push(r);
  }
  _rfResult = { rows: rows, noDiv: noDiv, day: todayIso };
  info.textContent = '近 ' + RF_YEARS + ' 年除息｜' + rows.length + ' 檔';
  renderRefill();
}

function toggleRefill(code) { _rfOpen[code] = !_rfOpen[code]; renderRefill(); }

function renderRefill() {
  var wrap = document.getElementById('refill-wrap');
  if (!wrap || !_rfResult) return;
  var rows = _rfResult.rows;
  if (!rows.length) { wrap.innerHTML = '<div class="modal-loading">近 ' + RF_YEARS + ' 年無可判定的除息紀錄</div>'; return; }

  // 整體統計
  var tFilled = 0, tTotal = 0, allDays = [], pendN = 0;
  rows.forEach(function (r) {
    tFilled += r.filled; tTotal += r.total;
    r.events.forEach(function (e) { if (!e.pending) allDays.push(e.days); });
    if (r.pending) pendN++;
  });
  allDays.sort(function (a, b) { return a - b; });
  var avgAll = allDays.length ? allDays.reduce(function (a, b) { return a + b; }, 0) / allDays.length : null;
  var medAll = allDays.length ? (allDays.length % 2 ? allDays[(allDays.length - 1) / 2] : (allDays[allDays.length / 2 - 1] + allDays[allDays.length / 2]) / 2) : null;
  var rate = tTotal ? tFilled / tTotal * 100 : null;

  var sp = function (lb, v, color) {
    return '<span class="divest-sp"><span class="divest-sp-lb">' + lb + '</span>' +
      '<span class="divest-sp-v"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span></span>';
  };
  var html = '<div class="swap-sumbar">' +
    sp('填息率', (rate != null ? tFilled + '/' + tTotal + '（' + rate.toFixed(0) + '%）' : '—'), 'var(--accent2)') +
    sp('平均填息', avgAll != null ? avgAll.toFixed(1) + ' 天' : '—', 'var(--text)') +
    sp('中位填息', medAll != null ? medAll + ' 天' : '—', 'var(--text)') +
    sp('貼息中', pendN + ' 檔', pendN ? 'var(--up)' : 'var(--down)') +
    '</div>';

  // 除息日曆（未來已公告）
  html += _rfCalHtml();

  // 逐檔
  html += '<div class="divest-sec-title">逐檔填息（近 ' + RF_YEARS + ' 年，點列展開歷次）</div><div class="rf-list">';
  rows.forEach(function (r) {
    var open = !!_rfOpen[r.code];
    var pr = r.total ? r.filled / r.total * 100 : 0;
    var prCls = pr >= 80 ? 'down' : (pr >= 50 ? 'flat' : 'up');   // 台股慣例：好＝綠
    var latest = r.events[0];
    var lastTxt;
    if (!latest) lastTxt = '—';
    else if (latest.pending) {
      lastTxt = '<span class="up">貼息中 ' + latest.days + ' 天　距填息 ' + latest.gapPct.toFixed(2) + '%</span>';
    } else {
      lastTxt = '<span class="down">' + latest.days + ' 天填息</span>';
    }
    html += '<div class="rf-item">' +
      '<div class="rf-head" onclick="toggleRefill(\'' + r.code + '\')">' +
        '<span class="rf-code">' + r.code + '</span>' +
        '<span class="rf-name">' + r.name + '</span>' +
        '<span class="rf-rate ' + prCls + '">' + r.filled + '/' + r.total + '（' + pr.toFixed(0) + '%）</span>' +
        '<span class="rf-avg">平均 ' + (r.avgDays != null ? r.avgDays.toFixed(1) + ' 天' : '—') + '</span>' +
        '<span class="rf-last">最近 ' + (latest ? _rfMd(latest.exDate) + ' 除息 ' + latest.amount.toFixed(3) + '　' + lastTxt : '—') + '</span>' +
        '<span class="divest-chev">' + (open ? '▼' : '▶') + '</span>' +
      '</div>' +
      (open ? _rfDetailHtml(r) : '') +
    '</div>';
  });
  html += '</div>';

  if (_rfResult.noDiv.length) {
    html += '<div class="rf-nodiv">尚未開始除息（未抓取價格）：' + _rfResult.noDiv.join('、') + '</div>';
  }
  html += '<div class="tx-note">基準價＝除息日前一交易日收盤；除息後首次收盤 ≥ 基準價即為填息，天數以交易日計。' +
    '價格為 Yahoo 未還原收盤（還原價會抹平除息缺口）。統計範圍近 ' + RF_YEARS + ' 年已除息紀錄，資料每日快取，按「重新整理」強制更新。' +
    '<b>本頁為歷史統計，不預測未來填息表現，非投資建議。</b></div>';
  wrap.innerHTML = html;
}

function _rfMd(iso) { return iso ? iso.slice(5).replace('-', '/') : '—'; }

// 除息日曆：未來已公告的除息日；缺金額或發放日的列附手動補登輸入框（貼上整行自動解析）
function _rfCalHtml() {
  var cal = _rfCal || [];
  var h = '<div class="divest-sec-title">除息日曆（未來已公告）' +
    (_rfNote ? '<span class="rf-cmnote">' + _rfNote + '</span>' : '') + '</div>';
  if (!cal.length) {
    return h + '<div class="rf-cal-empty">目前無已公告的未來除息日（上市查 e添富、上櫃查 TPEx 預告表）。</div>';
  }
  var man = _rfManLoad();
  h += '<div class="inv-table-wrap"><table class="inv-table swap-table rf-cal"><thead><tr>' +
    '<th>除息日</th><th>代號</th><th>名稱</th><th class="num">預估配息</th><th>發放日</th>' +
    '<th class="num">持有(張)</th><th class="num">預估可領</th><th>來源</th>' +
    '<th title="貼上整行自動解析">手動補登</th></tr></thead><tbody>';
  cal.forEach(function (e) {
    var sh = _swapHeld(e.code);
    var amt = e.amount;
    var get = (amt != null && sh) ? amt * sh : null;
    var lack = (amt == null) || !e.payDate;
    h += '<tr>' +
      '<td class="rf-cal-date">' + e.exDate + '</td>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + e.code + '\')">' + e.code + '</span></td>' +
      '<td class="inv-name">' + (e.name || '') + '</td>' +
      '<td class="num' + (amt == null ? ' swap-warn' : '') + '">' + (amt != null ? amt.toFixed(4) : '待公告') + '</td>' +
      '<td' + (e.payDate ? '' : ' class="swap-warn"') + '>' + (e.payDate || '待公告') + '</td>' +
      '<td class="num">' + _swapLots(sh) + '</td>' +
      '<td class="num">' + (get != null ? fmtMoney(get) : '—') + '</td>' +
      '<td class="rf-src">' + e.src + (e.manual ? '＋手動' : '') + '</td>' +
      '<td>' + (lack || e.manual
        ? '<input class="sbl-inp rf-man-inp" type="text" placeholder="貼上：0.153　2026/08/18　2026/09/09"' +
          ' title="從券商App或看盤網站複製整行貼上，自動解析股利/除息日/發放日；官方公告後會自動改用官方值。清空可移除" value="' +
          (man[e.code] ? _rfManStr(man[e.code]) : '') + '" onchange="rfManualInput(\'' + e.code + '\',this)">'
        : '') + '</td>' +
    '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="rf-cal-note">上市 ETF 取自 e添富、上櫃取自 TPEx 除權息預告表（每日更新一次）。' +
    '投信剛公告、官方資料尚未同步時會顯示「待公告」，此時可在該列「手動補登」貼上整行（例：<code>0.153　2026/08/18　2026/09/09</code>），' +
    '自動解析股利／除息日／發放日；官方公告後即改用官方值，手動值僅為暫時填補，清空輸入框可移除。' +
    '預估可領＝預估配息 × 持有股數，未扣二代健保與稅。</div>';
  return h;
}

function _rfDetailHtml(r) {
  var h = '<div class="rf-detail"><table class="inv-table swap-table"><thead><tr>' +
    '<th>除息日</th><th class="num">配息</th><th class="num">基準價</th>' +
    '<th>填息日</th><th class="num">天數</th><th>狀態</th></tr></thead><tbody>';
  r.events.forEach(function (e) {
    h += '<tr>' +
      '<td>' + e.exDate + '</td>' +
      '<td class="num">' + e.amount.toFixed(3) + '</td>' +
      '<td class="num">' + e.base.toFixed(2) + '</td>' +
      '<td>' + (e.filledDate || '—') + '</td>' +
      '<td class="num">' + e.days + '</td>' +
      '<td class="' + (e.pending ? 'up' : 'down') + '">' +
        (e.pending ? '貼息中　現價 ' + e.lastPx.toFixed(2) + ' < 基準 ' + e.base.toFixed(2) : '已填息') +
      '</td></tr>';
  });
  h += '</tbody></table></div>';
  return h;
}
