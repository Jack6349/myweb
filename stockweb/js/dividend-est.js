// 股利總管 Web — 股利估算（TWSE e添富配息資料；當年 1–12 月已領＋預估）
// 單頁：上「月份總覽」（每月：橫條＋月總額＋該月各檔代號/金額）＋橫線＋下「個股明細」（可折疊）
// 資料源：e添富 dividendList（伺服器渲染 HTML）→ GAS ?urltext= 原文代理 → 前端解析
// 持股/股數：沿用 ensureFeed 的 _sharesMap（含出借補償與 Firestore 後備）

var _divEstRows = null;    // e添富 解析後全 ETF 配息列（每日快取）
var _divEstResult = null;  // 計算結果，供折疊重繪
var _divEstOpen = {};      // code -> 是否展開
var _divByCode = {};       // code -> e添富配息列（本次載入）
var _divRecMap = {};       // code -> 已取得的配息紀錄（e添富 或 Yahoo 後備）；換股試算共用

function _divTwDate() {
  var tw = new Date(Date.now() + 8 * 3600000);
  return { y: tw.getUTCFullYear(), iso: tw.toISOString().slice(0, 10) };
}

// e添富 HTML → [{code,name,exDate(ISO),payDate,amount(number|null)}]
function parseEtfDividendHtml(html) {
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var rocToISO = function (s) {
    var m = (s || '').match(/(\d+)年(\d+)月(\d+)日/);
    return m ? (+m[1] + 1911) + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
  };
  var best = null, bestN = 0;
  doc.querySelectorAll('table').forEach(function (t) {
    var n = t.querySelectorAll('tbody tr').length; if (n > bestN) { bestN = n; best = t; }
  });
  if (!best) return [];
  var out = [];
  best.querySelectorAll('tbody tr').forEach(function (tr) {
    var td = tr.querySelectorAll('td'); if (td.length < 7) return;
    var t = function (i) { return (td[i].textContent || '').trim(); };
    var a = parseFloat(t(5));
    var ex = rocToISO(t(2));
    if (!ex) return;
    out.push({ code: t(0), name: t(1), exDate: ex, payDate: rocToISO(t(4)), amount: isNaN(a) ? null : a });
  });
  return out;
}

async function fetchEtfDividendList(force) {
  var day = _divTwDate().iso;
  var lsKey = 'etf_div_list_v1';
  if (!force) {
    if (_divEstRows && _divEstRows.day === day) return _divEstRows.rows;
    try { var c = JSON.parse(localStorage.getItem(lsKey) || 'null'); if (c && c.day === day) { _divEstRows = c; return c.rows; } } catch (e) {}
  }
  var yr = _divTwDate().y;
  var url = 'https://www.twse.com.tw/zh/ETFortune/dividendList?stkNo=&startDate=' + (yr - 1) + '&endDate=' + yr;
  var r = await fetch(NEWS_GAS_URL + '?urltext=' + encodeURIComponent(url));
  if (!r.ok) throw new Error('e添富 HTTP ' + r.status);
  var text = await r.text();
  // GAS 端錯誤（如 urlfetch 配額爆掉）會回 JSON {"error":...} → 丟出可讀訊息，不要當 HTML 解析
  if (text.charAt(0) === '{') {
    var je = null;
    try { je = JSON.parse(text); } catch (pe) {}
    if (je && je.error) throw new Error(je.error);
  }
  var rows = parseEtfDividendHtml(text);
  if (!rows.length) throw new Error('e添富回應無資料（來源異常，稍後再試）'); // 空結果不可快取成當日資料
  _divEstRows = { day: day, rows: rows };
  try { localStorage.setItem(lsKey, JSON.stringify(_divEstRows)); } catch (e) {}
  return rows;
}

// Yahoo 配息後備（GAS ?code=）：e添富（上市）沒有的持股（上櫃/債券 ETF）用此補；每日快取
async function fetchYahooDiv(code, force) {
  var day = _divTwDate().iso, lsKey = 'divest_yf_v1', cache = { day: day, map: {} };
  try { var c = JSON.parse(localStorage.getItem(lsKey) || 'null'); if (c && c.day === day) cache = c; } catch (e) {}
  if (!force && cache.map[code]) return cache.map[code];
  var recs = [];
  try {
    var r = await fetch(NEWS_GAS_URL + '?code=' + encodeURIComponent(code));
    var j = await r.json();
    if (j.stat === 'OK') {
      (j.dividends || []).forEach(function (d) {
        if (!(d.amount > 0)) return;
        var ex = new Date(d.date * 1000 + 8 * 3600000).toISOString().slice(0, 10);
        var pay = d.payDate ? new Date(d.payDate * 1000 + 8 * 3600000).toISOString().slice(0, 10) : null;
        recs.push({ code: code, name: (_contracts[code] && _contracts[code].name) || '', exDate: ex, payDate: pay, amount: d.amount });
      });
    }
  } catch (e) {}
  cache.map[code] = recs;
  try { localStorage.setItem(lsKey, JSON.stringify(cache)); } catch (e) {}
  return recs;
}

// 依除息日間隔中位數推頻率（月數）：月配1/季配3/半年6/年配12
function _divInferStep(recs) {
  if (recs.length < 2) return 12;
  var gaps = [];
  for (var i = 1; i < recs.length; i++) {
    var a = recs[i - 1].exDate, b = recs[i].exDate;
    var g = (+b.slice(0, 4) * 12 + +b.slice(5, 7)) - (+a.slice(0, 4) * 12 + +a.slice(5, 7));
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 12;
  gaps.sort(function (x, y) { return x - y; });
  var n = gaps.length;
  var med = n % 2 ? gaps[(n - 1) / 2] : (gaps[n / 2 - 1] + gaps[n / 2]) / 2;
  // 放寬分界：季配 gap≈3(2–4)、半年配≈6(5–9)、避免把半年配誤判成年配
  return med <= 1.4 ? 1 : (med <= 4.5 ? 3 : (med <= 9 ? 6 : 12));
}

function _addMonths(iso, n) {
  var y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1, d = iso.slice(8, 10);
  var t = y * 12 + m + n;
  return Math.floor(t / 12) + '-' + ('0' + (t % 12 + 1)).slice(-2) + '-' + d;
}

// 單檔當年 1–12 月，依「發放月」分組（跨年：去年12月除息→今年1月發放算今年）
// 已過發放日=已領(actual)、未來=預估(est)。發放日：有則用，無則「除息月＋1」推導。
function computeEtfYear(recs, shares, todayIso, year) {
  recs = recs.filter(function (r) { return r.exDate; }).sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
  if (!recs.length) return null;
  var lastAmt = 0;
  for (var i = recs.length - 1; i >= 0; i--) { if (recs[i].amount != null) { lastAmt = recs[i].amount; break; } }
  var payOf = function (r) { return r.payDate || _addMonths(r.exDate, 1); };

  var byMonth = {};  // 發放月(1-12) → 資料
  recs.forEach(function (r) {
    var pay = payOf(r); if (!pay) return;
    if (+pay.slice(0, 4) !== year) return;   // 只算發放年為今年者
    var pm = +pay.slice(5, 7);
    byMonth[pm] = {
      exDate: r.exDate, payDate: pay, derivedPay: !r.payDate,
      perShare: r.amount != null ? r.amount : lastAmt,
      status: pay <= todayIso ? 'actual' : 'est'
    };
  });
  // 預估（僅補未填、晚於最後已領月的發放月）
  var lastActualM = 0;
  Object.keys(byMonth).forEach(function (mk) { if (byMonth[mk].status === 'actual' && +mk > lastActualM) lastActualM = +mk; });
  var hasPrior = recs.some(function (r) { var p = payOf(r); return p && +p.slice(0, 4) === year - 1; });
  if (hasPrior) {
    // 有去年同期：以「去年發放月 ＋12」投影（自然吻合不規則配息的實際月份）
    recs.forEach(function (r) {
      var pay = payOf(r); if (!pay || +pay.slice(0, 4) !== year - 1) return;
      var projPay = _addMonths(pay, 12), pm = +projPay.slice(5, 7);
      if (byMonth[pm] || pm <= lastActualM) return;
      byMonth[pm] = { exDate: r.exDate ? _addMonths(r.exDate, 12) : null, payDate: projPay, derivedPay: !r.payDate, perShare: lastAmt, status: 'est' };
    });
  } else {
    // 新配息檔（無去年資料）：依頻率自最近一次發放往後推
    var step = _divInferStep(recs);
    var lastPay = payOf(recs[recs.length - 1]);
    var ym = (+lastPay.slice(0, 4)) * 12 + (+lastPay.slice(5, 7) - 1);
    for (var k = 0; k < 24; k++) {
      ym += step;
      var yy = Math.floor(ym / 12), mm = (ym % 12) + 1;
      if (yy > year) break;
      if (yy === year && !byMonth[mm] && mm > lastActualM) {
        byMonth[mm] = { exDate: null, payDate: yy + '-' + ('0' + mm).slice(-2) + '-15', derivedPay: true, perShare: lastAmt, status: 'est' };
      }
    }
  }

  var months = [];
  Object.keys(byMonth).forEach(function (mk) {
    var e = byMonth[mk];
    months.push({ month: +mk, exDate: e.exDate, payDate: e.payDate, derivedPay: e.derivedPay, perShare: e.perShare, total: e.perShare * shares, status: e.status });
  });
  months.sort(function (a, b) { return a.month - b.month; });
  var actualTotal = 0, estTotal = 0;
  months.forEach(function (mo) { if (mo.status === 'actual') actualTotal += mo.total; else estTotal += mo.total; });
  return { months: months, actualTotal: actualTotal, estTotal: estTotal };
}

async function startDividendEst(force) {
  var errEl = document.getElementById('divest-error');
  var wrap = document.getElementById('divest-wrap');
  var info = document.getElementById('divest-info');
  errEl.style.display = 'none';
  wrap.innerHTML = '<div class="modal-loading">讀取持股與配息資料…</div>';

  // 持股/股數（沿用行情引擎的 _sharesMap；失敗容忍）
  try { await ensureFeed(function (m) { info.textContent = m; }); } catch (e) {}
  var shareMap = (typeof _sharesMap !== 'undefined' && _sharesMap) ? _sharesMap : {};
  var codes = Object.keys(shareMap).filter(isEtfCode);
  if (!codes.length) { wrap.innerHTML = '<div class="modal-loading">無持有 ETF</div>'; return; }

  var rows;
  try { rows = await fetchEtfDividendList(force); }
  catch (e) { errEl.style.display = 'block'; errEl.textContent = 'e添富配息資料讀取失敗：' + e.message; wrap.innerHTML = ''; return; }

  // 依代號分組（e添富＝上市）
  var byCode = {};
  rows.forEach(function (r) { (byCode[r.code] = byCode[r.code] || []).push(r); });
  _divByCode = byCode;

  // e添富 沒有的持股（上櫃/債券 ETF）用 Yahoo 後備補
  var recMap = {}, missing = [];
  codes.forEach(function (code) {
    if (byCode[code] && byCode[code].length) recMap[code] = byCode[code];
    else missing.push(code);
  });
  await Promise.all(missing.map(async function (code) {
    try { var yr = await fetchYahooDiv(code, force); if (yr && yr.length) recMap[code] = yr; } catch (e) {}
  }));
  _divMergeAnnounced(recMap);   // 併入已公告除息（TPEx 預告表／手動補登），估算改採實際公告值
  _divRecMap = recMap;   // 供換股試算與填息追蹤共用

  var tw = _divTwDate();
  var stocks = [];
  codes.forEach(function (code) {
    var recs = recMap[code];
    if (!recs || !recs.length) return; // 不配息／未開始配息 → 不列
    var res = computeEtfYear(recs, shareMap[code], tw.iso, tw.y);
    if (!res || (!res.months.length)) return;
    var name = (recs[0].name) || (_contracts[code] && _contracts[code].name) || '';
    stocks.push({ code: code, name: name, res: res, src: (byCode[code] && byCode[code].length) ? 'e添富' : 'Yahoo' });
  });
  if (!stocks.length) { wrap.innerHTML = '<div class="modal-loading">持有 ETF 皆無配息紀錄</div>'; return; }
  stocks.sort(function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); });

  _divEstResult = { stocks: stocks, year: tw.y };
  info.textContent = tw.y + ' 年・' + stocks.length + ' 檔配息 ETF';
  renderDividendEst();
}

function renderDividendEst() {
  var wrap = document.getElementById('divest-wrap');
  if (!_divEstResult) return;
  var stocks = _divEstResult.stocks, year = _divEstResult.year;

  // 各月彙總
  var mActual = new Array(13).fill(0), mEst = new Array(13).fill(0);
  var mItems = {}; for (var i = 1; i <= 12; i++) mItems[i] = [];
  var grandActual = 0, grandEst = 0;
  stocks.forEach(function (s) {
    grandActual += s.res.actualTotal; grandEst += s.res.estTotal;
    s.res.months.forEach(function (mo) {
      if (mo.status === 'actual') mActual[mo.month] += mo.total; else mEst[mo.month] += mo.total;
      mItems[mo.month].push({ code: s.code, total: mo.total, status: mo.status, payDate: mo.payDate });
    });
  });
  var grand = grandActual + grandEst;
  var maxTotal = 1;
  for (var m = 1; m <= 12; m++) maxTotal = Math.max(maxTotal, mActual[m] + mEst[m]);

  var money = function (v) { return '$' + Math.round(v).toLocaleString('zh-TW'); };
  var md = function (iso) { return iso ? iso.slice(5).replace('-', '/') : '—'; };

  // ── 合計（頂部帶狀，nav-bar 式一行） ──
  var sp = function (lb, v, c) {
    return '<span class="divest-sp"><span class="divest-sp-lb">' + lb + '</span>' +
      '<span class="divest-sp-v" style="color:' + c + '">' + v + '</span></span>';
  };
  var sumEl = document.getElementById('divest-sumline');
  if (sumEl) sumEl.innerHTML = sp('年估總額', money(grand), 'var(--accent)') +
    sp('已入帳', money(grandActual), 'var(--down)') + sp('月均', money(grand / 12), 'var(--accent2)');

  // ── 月份總覽（依發放月）──
  var html = '<div class="divest-sec-title">月份總覽（依發放月）</div><div class="divest-months">';
  for (var mo = 1; mo <= 12; mo++) {
    var act = mActual[mo], est = mEst[mo], tot = act + est;
    var wPct = tot > 0 ? Math.max(4, Math.round(tot / maxTotal * 100)) : 0;
    var actW = tot > 0 ? Math.round(act / tot * 100) : 0;
    var totColor = tot === 0 ? 'var(--text3)' : (est === 0 ? 'var(--down)' : (act === 0 ? 'var(--accent2)' : 'var(--text)'));
    var items = mItems[mo].sort(function (a, b) { return b.total - a.total; }).map(function (it) {
      return '<div class="divest-item ' + (it.status === 'actual' ? 'dv-act' : 'dv-est') + '">' +
        '<span class="di-code">' + it.code + '</span>' +
        '<span class="di-date">' + md(it.payDate) + '</span>' +
        '<span class="di-amt">' + money(it.total) + '</span></div>';
    }).join('');
    html += '<div class="divest-mrow">' +
      '<span class="divest-mlabel">' + mo + '月</span>' +
      '<span class="divest-track">' + (tot > 0 ? '<span class="divest-bar" style="width:' + wPct + '%">' +
        '<span style="width:' + actW + '%;background:var(--down)"></span><span style="width:' + (100 - actW) + '%;background:var(--accent2)"></span></span>' : '') + '</span>' +
      '<span class="divest-mtot" style="color:' + totColor + '">' + (tot > 0 ? money(tot) : '—') + '</span>' +
      '<span class="divest-mitems">' + items + '</span>' +
    '</div>';
  }
  html += '</div>';

  // ── 個股明細（可折疊）──
  html += '<div class="divest-divider"></div><div class="divest-sec-title">個股明細</div><div class="divest-stocks">';
  stocks.forEach(function (s) {
    var open = !!_divEstOpen[s.code];
    var det = '<div class="divest-drow divest-dhead">' +
        '<span class="divest-dm">發放月</span><span class="divest-dex">除息</span>' +
        '<span class="divest-dpay">發放</span><span class="divest-dps">每股</span>' +
        '<span class="divest-dtot">金額</span><span class="divest-dst">狀態</span></div>' +
      s.res.months.map(function (mo) {
      var stTxt = mo.status === 'actual' ? '已領' : '預估';
      return '<div class="divest-drow ' + (mo.status === 'actual' ? 'dv-act' : 'dv-est') + '">' +
        '<span class="divest-dm">' + mo.month + '月</span>' +
        '<span class="divest-dex">' + md(mo.exDate) + '</span>' +
        '<span class="divest-dpay">' + md(mo.payDate) + '</span>' +
        '<span class="divest-dps">' + mo.perShare.toFixed(4) + '</span>' +
        '<span class="divest-dtot">' + money(mo.total) + '</span>' +
        '<span class="divest-dst">' + stTxt + '</span>' +
      '</div>';
    }).join('');
    // 現價（進頁快照）＋預估年殖利率＝單次配息(每股) × 配息頻率 ÷ 現價 ×100（當前年化殖利率，供換股/調節判斷）
    // 例：00988B 月配、下次預估 0.157、現價 20 → 0.157×12/20 = 9.42%
    var _r = (typeof _rows !== 'undefined') && _rows[s.code];
    var price = (_r && _r.close != null) ? _r.close : ((typeof _contracts !== 'undefined' && _contracts[s.code] && _contracts[s.code].reference) || null);
    var _mos = s.res.months || [];
    // 代表性單次配息（每股）：優先用「下一次預估」，否則用最近一次已領
    var _rep = _mos.filter(function (m) { return m.status === 'est'; })[0] ||
      _mos.filter(function (m) { return m.status === 'actual'; }).slice(-1)[0];
    var repPS = _rep ? _rep.perShare : 0;
    // 配息頻率：由相鄰兩次配息的月份間隔推估（月配→12、季配→4、半年→2、年配→1）
    var freq;
    if (_mos.length >= 2) { var gap = _mos[_mos.length - 1].month - _mos[_mos.length - 2].month; freq = gap > 0 ? Math.max(1, Math.round(12 / gap)) : _mos.length; }
    else freq = _mos.length || 1;
    var annPerShare = repPS * freq;
    var yld = (price && annPerShare) ? annPerShare / price * 100 : null;
    html += '<div class="divest-stock">' +
      '<div class="divest-shead" onclick="toggleDivStock(\'' + s.code + '\')">' +
        '<div><span class="divest-scode">' + s.code + '</span> <span class="divest-sname">' + s.name + '</span>' +
          '<span class="divest-yield">現價 <b>' + (price != null ? price.toFixed(2) : '—') + '</b>　' +
          '預估年殖利率 <b>' + (yld != null ? yld.toFixed(2) + '%' : '—') + '</b></span></div>' +
        '<div class="divest-smeta">已領 <span style="color:var(--down)">' + money(s.res.actualTotal) + '</span>　估算 <span style="color:var(--accent2)">' + money(s.res.estTotal) + '</span>　' +
          '<span class="divest-chev">' + (open ? '▼' : '▶') + '</span></div>' +
      '</div>' +
      (open ? '<div class="divest-detail">' + det + '</div>' : '') +
    '</div>';
  });
  html += '</div>';
  html += '<div class="divest-note">依「發放月」歸戶當月收入；<span style="color:var(--down)">綠＝已發放</span>、<span style="color:var(--accent2)">黃＝預估</span>（依發放日是否已過判定，不受 e添富是否公告發放日影響）。發放日缺漏時以「除息月＋1」推導。除息日供加減碼參考。資料來源：上市 ETF＝TWSE e添富；上櫃/債券 ETF＝Yahoo 歷史推估。</div>';
  wrap.innerHTML = html;
}

function toggleDivStock(code) {
  _divEstOpen[code] = !_divEstOpen[code];
  renderDividendEst();
}

// 併入「已公告但資料源尚未收錄」的除息：TPEx 除權息預告表（填息追蹤頁快取）＋使用者手動補登
// 目的：剛公告、e添富/Yahoo 還沒更新時，估算即可改採實際除息日與金額，而非以往年推估
// 只讀 localStorage 既有快取，不額外發網路請求；同除息日「已有值優先、缺漏才補」
function _divMergeAnnounced(recMap) {
  var add = {};
  var push = function (code, exDate, payDate, amount) {
    if (!recMap[code] || !exDate) return;          // 僅處理本來就有配息資料的持股
    (add[code] = add[code] || []).push({ exDate: exDate, payDate: payDate || null, amount: amount });
  };
  try {                                            // TPEx 除權息預告（全市場快取，取持股者）
    var cal = JSON.parse(localStorage.getItem('refill_cal_v1') || 'null');
    if (cal && cal.rows) cal.rows.forEach(function (r) { push(String(r.code), r.exDate, r.payDate, r.amount); });
  } catch (e) {}
  try {                                            // 手動補登（後併入，可補上 TPEx 缺的金額/發放日）
    var man = JSON.parse(localStorage.getItem('refill_manual_v1') || '{}');
    Object.keys(man).forEach(function (code) {
      var m = man[code]; if (m) push(String(code), m.exDate, m.payDate, m.amount);
    });
  } catch (e) {}

  Object.keys(add).forEach(function (code) {
    var list = (recMap[code] || []).map(function (x) { return Object.assign({}, x); }); // 複製，避免污染 e添富 快取物件
    var byEx = {};
    list.forEach(function (x) { if (x.exDate) byEx[x.exDate] = x; });
    add[code].forEach(function (n) {
      var cur = byEx[n.exDate];
      if (cur) {                                   // 已有同除息日 → 只補缺漏欄位
        if (cur.amount == null && n.amount != null) cur.amount = n.amount;
        if (!cur.payDate && n.payDate) cur.payDate = n.payDate;
      } else {                                     // 新除息日 → 加入（金額未公告時由估算沿用最近一次）
        var rec = { code: code, name: '', exDate: n.exDate, payDate: n.payDate, amount: n.amount };
        list.push(rec); byEx[n.exDate] = rec;
      }
    });
    recMap[code] = list;
  });
}

// 取單檔配息紀錄（e添富 優先、Yahoo 後備），結果併入 _divRecMap 快取；供換股試算查「指定代碼」
async function _divGetRecs(code, force) {
  code = String(code);
  if (!force && _divRecMap[code] && _divRecMap[code].length) return _divRecMap[code];
  if (!Object.keys(_divByCode).length) {
    try {
      var rows = await fetchEtfDividendList(force);
      var bc = {};
      rows.forEach(function (r) { (bc[r.code] = bc[r.code] || []).push(r); });
      _divByCode = bc;
    } catch (e) {}
  }
  if (_divByCode[code] && _divByCode[code].length) { _divRecMap[code] = _divByCode[code]; return _divRecMap[code]; }
  var yr = [];
  try { yr = await fetchYahooDiv(code, force); } catch (e) {}
  _divRecMap[code] = yr || [];
  return _divRecMap[code];
}

// 只刷新現價快照（重抓持股 ETF 快照後重繪，不重抓配息資料、不動 GAS）
async function refreshDivPrices() {
  var btn = document.getElementById('divest-refpx');
  if (btn) btn.textContent = '刷新中…';
  try {
    var cons = Object.keys((typeof _sharesMap !== 'undefined' && _sharesMap) || {}).filter(isEtfCode)
      .map(function (c) { return _contracts[c]; }).filter(Boolean);
    if (cons.length) {
      var snaps = await fetchSnapshots(cons);
      snaps.forEach(function (s) { _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) }; });
    }
  } catch (e) { console.warn('[divest refresh px]', e); }
  if (btn) btn.textContent = '↻ 刷新現價';
  if (typeof _divEstResult !== 'undefined' && _divEstResult) renderDividendEst();
}
