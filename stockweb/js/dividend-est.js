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
// fetch 加逾時：GAS 偶發卡住不回應；但正常回應也可能慢到 28 秒（實測 2026-09-13），逾時取 40 秒。
// 各檔並行抓取，所以最壞情況是整頁多等 40 秒，不是每檔累加。
// 沒有逾時的 await 會讓整個股利估算頁停在「讀取中」；逾時即丟錯，由呼叫端的 try/catch 當作抓取失敗。
function _divFetchT(url, ms) {
  var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;
  return fetch(url, ctl ? { signal: ctl.signal } : undefined)
    .finally(function () { if (timer) clearTimeout(timer); });
}

async function fetchYahooDiv(code, force) {
  var day = _divTwDate().iso, lsKey = 'divest_yf_v1', cache = { day: day, map: {} };
  try { var c = JSON.parse(localStorage.getItem(lsKey) || 'null'); if (c && c.day === day) cache = c; } catch (e) {}
  // 空陣列在 JS 為 truthy → 需明確檢查長度，否則一次抓取失敗會讓該檔整天都讀到空快取
  if (!force && cache.map[code] && cache.map[code].length) return cache.map[code];
  var recs = [];
  try {
    var r = await _divFetchT(NEWS_GAS_URL + '?code=' + encodeURIComponent(code), 40000);
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
  // 只快取有內容的結果；抓取失敗（空）不寫入，下次進頁面會自動重試
  if (recs.length) {
    cache.map[code] = recs;
    try { localStorage.setItem(lsKey, JSON.stringify(cache)); } catch (e) {}
  }
  return recs;
}

// 依除息日間隔中位數推頻率（月數）：月配1/季配3/半年6/年配12
// 紀錄不足 2 筆時無從推算：債券 ETF（代號末碼 B）新上市幾乎都是月配 → 回月配，
// 否則沿用年配保守值。避免新上市月配債 ETF 的年殖利率被低估 12 倍。
function _divInferStepFallback(recs) {
  var code = (recs && recs[0] && recs[0].code) || '';
  return /^00\d+B$/.test(String(code)) ? 1 : 12;
}
function _divInferStep(recs) {
  var ov = _divFreqOverride(recs && recs[0] && recs[0].code);
  if (ov) return ov;
  if (recs.length < 2) return _divInferStepFallback(recs);
  var gaps = [];
  for (var i = 1; i < recs.length; i++) {
    var a = recs[i - 1].exDate, b = recs[i].exDate;
    var g = (+b.slice(0, 4) * 12 + +b.slice(5, 7)) - (+a.slice(0, 4) * 12 + +a.slice(5, 7));
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return _divInferStepFallback(recs);   // 有多筆但同月除息等情況，同樣無從推算
  gaps.sort(function (x, y) { return x - y; });
  var n = gaps.length;
  var med = n % 2 ? gaps[(n - 1) / 2] : (gaps[n / 2 - 1] + gaps[n / 2]) / 2;
  // 放寬分界：季配 gap≈3(2–4)、半年配≈6(5–9)、避免把半年配誤判成年配
  return med <= 1.4 ? 1 : (med <= 4.5 ? 3 : (med <= 9 ? 6 : 12));
}

// 缺發放日時的推算值：除息日 ＋ 28 天。
// 實際間隔多為 27–30 天（例：00988B 9/15→10/15、00918 9/18→10/15、00404A 9/16→10/13）。
// 原本用「＋1 個月」：月初除息會被推到下個月（00981B 3/3 除息被算成 4 月發放，並與 3/19 那次撞在同月），
// 月底除息還會產生 2026-02-31 這種不存在的日期。
function _divDerivePay(exIso) {
  if (!exIso) return null;
  return new Date(Date.parse(exIso) + 28 * 86400000).toISOString().slice(0, 10);
}
function _addMonths(iso, n) {
  var y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1, d = iso.slice(8, 10);
  var t = y * 12 + m + n;
  return Math.floor(t / 12) + '-' + ('0' + (t % 12 + 1)).slice(-2) + '-' + d;
}

// 單檔當年 1–12 月，依「發放月」分組（跨年：去年12月除息→今年1月發放算今年）
// 已過發放日=已領(actual)、未來=預估(est)。發放日：有則用，無則「除息月＋1」推導。
// 某次除息可領股數＝除息日當時實際持有的股數，由兩部分組成：
//   1) 目前仍持有的批次（建倉明細 _lotsMap）：建倉日早於除息日才算
//      （除息日當天（含）之後才買進的領不到，例：9/1 除息、9/1 買進 → 不計）
//   2) 已賣出的批次（已實現損益明細 _soldLotsMap）：建倉日早於除息日、且賣出日在除息日當天（含）之後才算
//      （除息日當天賣出仍可領；除息日前就賣掉的領不到）
// 少了第 2 部分時，除息後才賣掉的張數會被漏算（00981B：7/21 除息時持有 322 張，8/25、9/1 各賣 50 張，
// 原本只算到現存 222 張，8 月發放估 $13,986，實際 $20,286）。
// 無建倉明細（Firestore 後備、或該檔查不到）時退回總股數，行為與加這段之前相同。
function _divSharesAsOf(code, exDate, fallback) {
  var lots = (typeof _lotsMap !== 'undefined') && _lotsMap[String(code)];
  if (!lots || !lots.length || !exDate) return fallback;
  var s = 0;
  lots.forEach(function (l) { if (l.date < exDate) s += l.shares; });
  (_soldLotsMap[String(code)] || []).forEach(function (l) {
    if (l.buy < exDate && l.sell >= exDate) s += l.shares;
  });
  return s;
}

// 券商實領核對：每個已賣出批次，券商有「持有期間實領股利」；拿我們的除息紀錄重算同一段期間應領金額比對。
// 不符代表除息紀錄缺漏或金額錯（例：少一次除息 → 每股差額剛好是那次的金額）。只能發現「有缺」，不知道缺哪天。
// 建倉早於我們最早一筆除息紀錄的批次無從比對（資料不足），略過不計。
function _divBrokerCheck(code) {
  var lots = (_soldLotsMap[String(code)] || []).filter(function (l) { return l.exdiv != null; });
  var recs = ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || []).filter(function (r) { return r.exDate && r.amount > 0; });
  if (!lots.length || !recs.length) return null;
  var first = recs.reduce(function (m, r) { return r.exDate < m ? r.exDate : m; }, recs[0].exDate);
  var bad = [], n = 0;
  lots.forEach(function (l) {
    if (l.buy < _addMonths(first, -1)) return;                // 資料涵蓋不到該批的全部持有期間
    n++;
    var ps = recs.filter(function (r) { return r.exDate > l.buy && r.exDate <= l.sell; })
      .reduce(function (a, r) { return a + r.amount; }, 0);
    var diff = l.exdiv - ps * l.shares;
    if (Math.abs(diff) > Math.max(2, l.shares * 0.0005)) bad.push({ buy: l.buy, sell: l.sell, shares: l.shares, broker: l.exdiv, ours: Math.round(ps * l.shares), perShare: diff / l.shares });
  });
  return n ? { n: n, bad: bad } : null;
}

// 已賣出批次：券商已實現損益（近 12 個月，API 查詢區間上限即 12 個月）逐筆展開明細，
// 明細列出該次賣出所沖銷的各買進批次（買進日、股數）。
// 12 個月足夠：今年度估算最早的除息在 1 月，更早賣掉的批次不可能在今年除息日還持有。
// 結果 → _soldLotsMap[code] = [{ buy, sell, shares }]；查詢失敗時維持空表（退回只算現存批次）。
var _soldLotsMap = {}, _soldLotsDay = null;
async function _divLoadSoldLots(force) {
  var today = _divTwDate().iso;
  if (!force && _soldLotsDay === today) return;
  var begin = new Date(Date.parse(today) - 364 * 86400000).toISOString().slice(0, 10);
  try {
    var pl = await brokerPost('profit_loss', { begin_date: begin, end_date: today, unit: 'Share' });
    var sells = (pl || []).filter(function (x) { return x && x.quantity > 0 && isEtfCode(String(x.code)); });
    var map = {};
    await Promise.all(sells.map(async function (x) {
      try {
        var det = await brokerPost('profit_loss_detail', { detail_id: x.id, unit: 'Share' });
        (det || []).forEach(function (d) {
          if (!(d.quantity > 0) || !d.date) return;
          var code = String(x.code);
          (map[code] = map[code] || []).push({ buy: d.date, sell: x.date, shares: d.quantity,
            exdiv: d.ex_dividend_amt != null ? +d.ex_dividend_amt : null });   // 券商記錄該批持有期間實領股利
        });
      } catch (e) { console.warn('[已實現損益明細] ' + x.code + ' ' + x.date, e); }
    }));
    _soldLotsMap = map;
    _soldLotsDay = today;
  } catch (e) { console.warn('[已實現損益] 讀取失敗，過去月份僅以現存批次計算', e); }
}

function computeEtfYear(recs, shares, todayIso, year, code) {
  recs = recs.filter(function (r) { return r.exDate; }).sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
  if (!recs.length) return null;
  var lastAmt = 0;
  for (var i = recs.length - 1; i >= 0; i--) { if (recs[i].amount != null) { lastAmt = recs[i].amount; break; } }
  var payOf = function (r) { return r.payDate || _divDerivePay(r.exDate); };

  // 一個發放月可能有兩次除息（00981B：3/3、3/19 兩次除息分別在 3、4 月發放；推算發放日若撞月不能互相覆蓋）
  // → 以「發放月｜除息日」為鍵；taken 記錄已有資料的月份，供下方預估判斷是否補月
  var byMonth = {}, taken = {};
  recs.forEach(function (r) {
    var pay = payOf(r); if (!pay) return;
    if (+pay.slice(0, 4) !== year) return;   // 只算發放年為今年者
    var pm = +pay.slice(5, 7);
    byMonth[pm + '|' + r.exDate] = {
      month: pm, exDate: r.exDate, payDate: pay, derivedPay: !r.payDate,
      perShare: r.amount != null ? r.amount : lastAmt,
      status: pay <= todayIso ? 'actual' : 'est'
    };
    taken[pm] = true;
  });
  // 預估（僅補未填、晚於最後已領月的發放月）
  var lastActualM = 0;
  Object.keys(byMonth).forEach(function (k) { var e = byMonth[k]; if (e.status === 'actual' && e.month > lastActualM) lastActualM = e.month; });
  var hasPrior = recs.some(function (r) { var p = payOf(r); return p && +p.slice(0, 4) === year - 1; });
  if (hasPrior) {
    // 有去年同期：以「去年發放月 ＋12」投影（自然吻合不規則配息的實際月份）
    recs.forEach(function (r) {
      var pay = payOf(r); if (!pay || +pay.slice(0, 4) !== year - 1) return;
      var projPay = _addMonths(pay, 12), pm = +projPay.slice(5, 7);
      if (taken[pm] || pm <= lastActualM) return;
      byMonth[pm + '|proj'] = { month: pm, exDate: r.exDate ? _addMonths(r.exDate, 12) : null, payDate: projPay, derivedPay: !r.payDate, perShare: lastAmt, status: 'est' };
      taken[pm] = true;
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
      if (yy === year && !taken[mm] && mm > lastActualM) {
        byMonth[mm + '|proj'] = { month: mm, exDate: null, payDate: yy + '-' + ('0' + mm).slice(-2) + '-15', derivedPay: true, perShare: lastAmt, status: 'est' };
        taken[mm] = true;
      }
    }
  }

  var months = [];
  Object.keys(byMonth).forEach(function (mk) {
    var e = byMonth[mk];
    var sh = _divSharesAsOf(code, e.exDate, shares);   // 逐次除息各自判定可領股數
    months.push({ month: e.month, exDate: e.exDate, payDate: e.payDate, derivedPay: e.derivedPay,
      perShare: e.perShare, shares: sh, partial: sh !== shares, total: e.perShare * sh, status: e.status });
  });
  months.sort(function (a, b) { return (a.month - b.month) || ((a.exDate || '') < (b.exDate || '') ? -1 : 1); });
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
  }).concat([
    divMetaLoad(codes).catch(function () {}),        // 官方 ETF 規格＋手動輸入（配息頻率估算要用，須在 computeEtfYear 前就緒；見 div-meta.js）
    _divLoadSoldLots(force)                           // 已賣出批次：過去除息日的實際持股
  ]));
  // 官方除權息歷史（補 e添富／Yahoo 漏掉的除息）：GAS 慢時 8 段要抓到一分鐘，不擋畫面——
  // 今日快取就緒 → 同步併入；否則先用現有資料顯示，背景抓完（完整）再重算一次，第二次即命中快取。
  if (!force && _divOffHistReady(codes)) {
    _divMergeOfficialHist(recMap, codes);
  } else if (!_divOffHistBusy) {
    _divOffHistBusy = true;
    if (_divOffHistStored()) _divMergeOfficialHist(recMap, codes);   // 前次完整資料先頂著（過去的除息不會變）
    _divLoadOfficialHist(codes, true).catch(function () {}).then(function () {
      _divOffHistBusy = false;
      if (_divOffHistReady(codes)) startDividendEst(false);
    });
  }
  // 上櫃 ETF 的未來除息只有 TPEx 有；先確保當日快取存在（每日 1 次全市場），股利估算不再相依填息追蹤頁
  try { await fetchTpexExright(); } catch (e) {}
  _divMergeAnnounced(recMap);   // 併入已公告除息（TPEx 預告表／手動補登），估算改採實際公告值
  _divRecMap = recMap;   // 供換股試算與填息追蹤共用

  var tw = _divTwDate();
  var stocks = [];
  codes.forEach(function (code) {
    var recs = recMap[code];
    if (!recs || !recs.length) return; // 不配息／未開始配息 → 不列
    var res = computeEtfYear(recs, shareMap[code], tw.iso, tw.y, code);
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
  var grandActual = 0, grandEst = 0;
  stocks.forEach(function (s) { grandActual += s.res.actualTotal; grandEst += s.res.estTotal; });
  var grand = grandActual + grandEst;

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

  // ── 本月除息個股（按除息日由近至遠）──
  var html = _divExMonthHtml(stocks, money, md);

  // ── 個股明細（可折疊）──
  html += '<div class="divest-divider"></div><div class="divest-sec-title">個股明細</div><div class="divest-stocks">';
  stocks.forEach(function (s) {
    var open = !!_divEstOpen[s.code];
    var det = '<div class="divest-drow divest-dhead">' +
        '<span class="divest-dm">發放月</span><span class="divest-dex">除息</span>' +
        '<span class="divest-dpay">發放</span><span class="divest-dps">每股</span>' +
        '<span class="divest-dtot">金額</span><span class="divest-dst">狀態</span></div>' +
      s.res.months.map(function (mo) {
      // 除息日後才買進的批次領不到 → 金額會小於「全部持股×每股」，於狀態註明實際計入張數
      var stTxt = mo.status === 'actual' ? '已領' : '預估';
      if (mo.partial) {
        // 完全沒領到就不能寫「已領」；只領到一部分則註明實際計入張數
        if (mo.shares > 0) stTxt += '（計 ' + (mo.shares / 1000) + ' 張）';
        else stTxt = '除息後才買進，未持有';
      }
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
    // 配息頻率：與估算、換股試算共用 _divInferStep（含頻率覆寫與「紀錄不足」規則），不再另用發放月間隔自算
    var _recsAsc = ((typeof _divRecMap !== 'undefined' && _divRecMap[s.code]) || [{ code: s.code }])
      .slice().sort(function (a, b) { return (a.exDate || '') < (b.exDate || '') ? -1 : 1; });
    if (!_recsAsc[0].code) _recsAsc[0] = Object.assign({ code: s.code }, _recsAsc[0]);
    var freq = 12 / _divInferStep(_recsAsc);
    var annPerShare = repPS * freq;
    var yld = (price && annPerShare) ? annPerShare / price * 100 : null;
    // 當月已公告除息（含 TPEx 預告與手動補登，由 _divMergeAnnounced 併入）；無則不顯示
    var _ym = _divTwDate().iso.slice(0, 7);
    var _exNow = ((typeof _divRecMap !== 'undefined' && _divRecMap[s.code]) || [])
      .filter(function (r) { return r.exDate && r.exDate.slice(0, 7) === _ym; })
      .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; })[0];
    var exHtml = _exNow
      ? '　<span class="divest-exnow">本月除息 <b>' + md(_exNow.exDate) + '</b>　每股 <b>' +
        (_exNow.amount != null ? _exNow.amount.toFixed(4) : '待公告') + '</b></span>'
      : '';
    html += '<div class="divest-stock">' +
      '<div class="divest-shead" onclick="toggleDivStock(\'' + s.code + '\')">' +
        '<div><span class="divest-scode">' + s.code + '</span> <span class="divest-sname">' + s.name + '</span>' +
          '<span class="divest-yield">現價 <b>' + (price != null ? price.toFixed(2) : '—') + '</b>　' +
          '預估年殖利率 <b>' + (yld != null ? yld.toFixed(2) + '%' : '—') + '</b>' + exHtml + '</span></div>' +
        '<div class="divest-smeta">已領 <span style="color:var(--down)">' + money(s.res.actualTotal) + '</span>　估算 <span style="color:var(--accent2)">' + money(s.res.estTotal) + '</span>　' +
          '<span class="divest-chev">' + (open ? '▼' : '▶') + '</span></div>' +
      '</div>' +
      (open ? '<div class="divest-detail">' + det +
        '<div class="divest-hist" data-code="' + s.code + '"></div>' +
        '</div>' : '') +
    '</div>';
  });
  html += '</div>';
  // ── 月份總覽（依發放月）：縱向個股、橫向 1–12 月＋總計 ──
  html += _divStatTableHtml(stocks, money);

  html += '<div class="divest-note">依「發放月」歸戶當月收入；<span style="color:var(--down)">綠＝已發放</span>、<span style="color:var(--accent2)">黃＝預估</span>（依發放日是否已過判定，不受 e添富是否公告發放日影響）。發放日缺漏時以「除息月＋1」推導。除息日供加減碼參考。<b>各次配息依建倉明細判定可領張數：除息日當天（含）之後才買進的批次不計</b>（含近 12 個月內已賣出、但除息日當時仍持有的批次，依券商已實現損益明細計入）。資料來源：上市 ETF＝TWSE e添富；上櫃/債券 ETF＝Yahoo 歷史推估。</div>';
  wrap.innerHTML = html;
  _divHistDrawAll();   // 圖要量容器實際寬度，必須在插入 DOM 之後畫
}

// ── 歷年配息圖（個股明細展開後顯示）──
// 直條＝每股除息金額（頂端標數字）；折線＝當次年化殖利率＝每股 × 年配息次數 ÷ 除息前一交易日收盤。
// 區間＝當月往前兩年；上市不足兩年則從第一次除息開始（直接取區間內有的紀錄即可）。
// 資料：除息紀錄沿用 _divRecMap（已併 TPEx 預告／手動補登）；收盤價由 Yahoo 2 年日 K（經 GAS，每檔每日 1 次）。
// 價格抓不到時仍畫直條，只是不畫折線。
var DIV_PX_LS = 'divest_px_v1';
var _divPx = {}, _divPxBusy = {};
function _divHistPrices(code) {
  var day = _divTwDate().iso;
  var mem = _divPx[code];
  if (mem && mem.day === day && (mem.bars.length || Date.now() - mem.failTs < 60000)) return mem.bars;
  try {
    var c = JSON.parse(localStorage.getItem(DIV_PX_LS) || 'null');
    if (c && c.day === day && c.map && c.map[code]) { _divPx[code] = { day: day, bars: c.map[code] }; return c.map[code]; }
  } catch (e) {}
  if (_divPxBusy[code]) return null;
  _divPxBusy[code] = true;
  (async function () {
    var ex = (_contracts[code] && _contracts[code].exchange) || '';
    var syms = ex === 'OTC' ? [code + '.TWO', code + '.TW'] : [code + '.TW', code + '.TWO'];
    var bars = [];
    for (var i = 0; i < syms.length && !bars.length; i++) {
      try {
        var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + syms[i] + '?interval=1d&range=2y';
        var r = await _divFetchT(NEWS_GAS_URL + '?url=' + encodeURIComponent(url), 40000);
        var j = await r.json();   // GAS 偶發回 HTML 錯誤頁 → 這裡丟錯，換下一個代號或放棄
        var res = j.chart && j.chart.result && j.chart.result[0];
        var ts = (res && res.timestamp) || [], cl = (res && res.indicators.quote[0].close) || [];
        for (var k = 0; k < ts.length; k++) {
          if (cl[k] != null) bars.push([new Date(ts[k] * 1000 + 8 * 3600000).toISOString().slice(0, 10), cl[k]]);
        }
      } catch (e) {}
    }
    _divPxBusy[code] = false;
    // 失敗記空陣列＋時間：60 秒內重繪不重打 GAS，之後再開明細會重試（GAS 是偶發失敗，不能整天放棄）
    _divPx[code] = { day: day, bars: bars, failTs: bars.length ? 0 : Date.now() };
    if (bars.length) {
      try {
        var c = JSON.parse(localStorage.getItem(DIV_PX_LS) || 'null');
        if (!c || c.day !== day) c = { day: day, map: {} };
        c.map[code] = bars;
        localStorage.setItem(DIV_PX_LS, JSON.stringify(c));
      } catch (e) {}
    }
    if (_divEstOpen[code]) _divHistDrawAll();
  })();
  return null;
}

function _divHistDrawAll() {
  document.querySelectorAll('#divest-wrap .divest-hist[data-code]').forEach(function (el) {
    _divHistDraw(el, el.getAttribute('data-code'));
  });
}
window.addEventListener('resize', function () {
  if (document.querySelector('#divest-wrap .divest-hist')) _divHistDrawAll();
});

// 除息紀錄（圖用）：_divRecMap 為主。上市 ETF 的主來源 e添富 只保留約 2025/01 之後的資料，
// 畫兩年區間會缺前面幾次 → 以 Yahoo 歷史（fetchYahooDiv，當日快取）補「早於 e添富 第一筆」的部分。
// 只補更早的日期，不覆蓋重疊區間（兩邊金額在重疊期間實測一致，e添富 另含發放日，以它為準）。
var _divHistYf = {}, _divHistYfBusy = {};
function _divHistRecs(code) {
  var base = ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || []).filter(function (r) { return r.exDate; });
  var fromEtf = (typeof _divByCode !== 'undefined') && _divByCode && _divByCode[code] && _divByCode[code].length;
  if (fromEtf && base.length) {
    if (_divHistYf[code]) {
      var first = base.reduce(function (m, r) { return r.exDate < m ? r.exDate : m; }, base[0].exDate);
      base = base.concat(_divHistYf[code].filter(function (r) { return r.exDate < first; }));
    } else if (!_divHistYfBusy[code]) {
      _divHistYfBusy[code] = true;
      fetchYahooDiv(code, false).then(function (recs) { _divHistYf[code] = recs || []; })
        .catch(function () { _divHistYf[code] = []; })
        .then(function () { _divHistYfBusy[code] = false; if (_divEstOpen[code]) _divHistDrawAll(); });
    }
  }
  return base.slice().sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
}

function _divHistDraw(el, code) {
  var W = el.clientWidth;
  if (!W) return;
  var tw = _divTwDate(), today = tw.iso;
  var y = +today.slice(0, 4), m = +today.slice(5, 7);
  var startIso = (y - 2) + '-' + ('0' + m).slice(-2) + '-01';
  var endIso = y + '-' + ('0' + m).slice(-2) + '-31';
  var all = _divHistRecs(code);
  var ev = all.filter(function (r) { return r.exDate >= startIso && r.exDate <= endIso && r.amount > 0; });
  if (!ev.length) { el.innerHTML = '<div class="divest-hist-note">兩年內尚無已公布金額的除息紀錄</div>'; return; }

  // 上市 ETF 要等 Yahoo 補完早期紀錄，才能判斷「區間前真的沒有紀錄」；補抓中或補抓失敗時不下「未滿兩年」的結論
  var fromEtf = (typeof _divByCode !== 'undefined') && _divByCode && _divByCode[code] && _divByCode[code].length;
  var histComplete = !fromEtf || (_divHistYf[code] && _divHistYf[code].length);
  var bars = _divHistPrices(code);          // null＝抓取中；[]＝抓不到
  var step = _divInferStep(all), perYear = 12 / step;
  var closeBefore = function (iso) {
    if (!bars || !bars.length) return null;
    var px = null;
    for (var i = 0; i < bars.length && bars[i][0] < iso; i++) px = bars[i][1];
    return px;
  };
  var pts = ev.map(function (r) {
    var px = closeBefore(r.exDate);
    return { ex: r.exDate, amt: r.amount, future: r.exDate > today, px: px,
      yld: px ? r.amount * perYear / px * 100 : null };
  });

  // 版面
  var H = 220, mt = 34, mb = 26, ml = 46, mr = 52;
  var pw = W - ml - mr, ph = H - mt - mb, n = pts.length;
  var slot = pw / n, bw = Math.min(38, slot * 0.6);
  // 左軸取「整齊刻度」：四等分的每格取 1/2/2.5/5×10^k，否則 0.0864 會標成 0.00/0.02/0.04/0.06/0.09 看起來不等距
  var rawMax = Math.max.apply(null, pts.map(function (p) { return p.amt; })) * 1.15;
  var mag = Math.pow(10, Math.floor(Math.log10(rawMax / 4)));
  var stepA = [1, 2, 2.5, 5, 10].map(function (k) { return k * mag; }).filter(function (v) { return v * 4 >= rawMax; })[0];
  var maxAmt = stepA * 4;
  var axDp = Math.max(0, -Math.floor(Math.log10(stepA) + 1e-9)) + (String(stepA / mag).indexOf('.') >= 0 ? 1 : 0);
  var yA = function (v) { return mt + ph - v / maxAmt * ph; };
  var ys = pts.filter(function (p) { return p.yld != null; }).map(function (p) { return p.yld; });
  var yMin = ys.length ? Math.min.apply(null, ys) : 0, yMax = ys.length ? Math.max.apply(null, ys) : 1;
  var pad = Math.max(0.5, (yMax - yMin) * 0.25); yMin = Math.max(0, yMin - pad); yMax = yMax + pad;
  var yY = function (v) { return mt + ph - (v - yMin) / (yMax - yMin) * ph; };
  var cx = function (i) { return ml + slot * (i + 0.5); };
  var f3 = function (v) { return v.toFixed(3); };
  var LINE = '#5aa9ff';

  var g = '';
  // 左軸（每股金額）格線 4 等分
  for (var t = 0; t <= 4; t++) {
    var v = maxAmt / 4 * t, yy = yA(v);
    g += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--border)" stroke-opacity=".45" stroke-width="1"/>' +
      '<text x="' + (ml - 6) + '" y="' + (yy + 4) + '" text-anchor="end" class="dh-ax">' + v.toFixed(axDp) + '</text>';
  }
  // 右軸（殖利率 %）
  if (ys.length) {
    for (var t2 = 0; t2 <= 4; t2++) {
      var v2 = yMin + (yMax - yMin) / 4 * t2;
      g += '<text x="' + (W - mr + 6) + '" y="' + (yY(v2) + 4) + '" class="dh-ax" fill="' + LINE + '">' + v2.toFixed(1) + '%</text>';
    }
  }
  // 直條＋頂端金額＋X 軸月份
  pts.forEach(function (p, i) {
    var x = cx(i) - bw / 2, top = yA(p.amt);
    var col = p.future ? 'var(--accent2)' : 'var(--down)';
    var tip = p.ex + (p.future ? '（已公告）' : '') + '　除息 ' + f3(p.amt) +
      (p.yld != null ? '　年化殖利率 ' + p.yld.toFixed(2) + '%（除息前收盤 ' + p.px.toFixed(2) + '）' : '');
    g += '<g><title>' + tip + '</title>' +
      '<rect x="' + x + '" y="' + top + '" width="' + bw + '" height="' + (mt + ph - top) + '" rx="2" fill="' + col + '" fill-opacity="' + (p.future ? '.55' : '.8') + '"/>' +
      '<text x="' + cx(i) + '" y="' + (top - 5) + '" text-anchor="middle" class="dh-val" fill="' + col + '">' + f3(p.amt) + '</text>' +
      '<text x="' + cx(i) + '" y="' + (H - 8) + '" text-anchor="middle" class="dh-ax">' + p.ex.slice(2, 4) + '/' + p.ex.slice(5, 7) + '</text></g>';
  });
  // 折線＋點
  var lp = pts.map(function (p, i) { return p.yld != null ? [cx(i), yY(p.yld)] : null; }).filter(Boolean);
  if (lp.length >= 2) {
    g += '<polyline points="' + lp.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ') +
      '" fill="none" stroke="' + LINE + '" stroke-width="2" stroke-linejoin="round"/>';
  }
  lp.forEach(function (q) {
    g += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="3" fill="var(--bg2)" stroke="' + LINE + '" stroke-width="2"/>';
  });
  // 圖例
  var lg = '<rect x="' + ml + '" y="8" width="10" height="10" rx="2" fill="var(--down)" fill-opacity=".8"/>' +
    '<text x="' + (ml + 14) + '" y="17" class="dh-lg">每股除息金額</text>' +
    '<rect x="' + (ml + 100) + '" y="8" width="10" height="10" rx="2" fill="var(--accent2)" fill-opacity=".55"/>' +
    '<text x="' + (ml + 114) + '" y="17" class="dh-lg">已公告未除息</text>' +
    '<line x1="' + (ml + 204) + '" x2="' + (ml + 224) + '" y1="13" y2="13" stroke="' + LINE + '" stroke-width="2"/>' +
    '<circle cx="' + (ml + 214) + '" cy="13" r="3" fill="var(--bg2)" stroke="' + LINE + '" stroke-width="2"/>' +
    '<text x="' + (ml + 230) + '" y="17" class="dh-lg">年化殖利率（右軸）</text>';

  var note = bars === null ? '收盤價載入中，殖利率折線稍後出現…'
    : (!bars.length ? '收盤價暫時抓不到（Yahoo／GAS），僅顯示除息金額。' : '');
  if (_divHistYfBusy[code]) note = (note ? note + '　' : '') + '較早的除息紀錄補抓中…';
  var span = ev[0].exDate.slice(0, 7).replace('-', '/') + '–' + ev[ev.length - 1].exDate.slice(0, 7).replace('-', '/');
  el.innerHTML = '<div class="divest-hist-title">歷年配息　<span>' + span + '・' + n + ' 次' +
      (histComplete && all[0].exDate >= startIso ? '（上市未滿兩年，自首次除息起）' : '') + '</span></div>' +   // 區間前完全沒有紀錄才算；半年配剛好落在區間外不算
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="divest-hist-svg">' + lg + g + '</svg>' +
    (note ? '<div class="divest-hist-note">' + note + '</div>' : '');
}

// 出借中股數（股）：從 _positions 的 lentShares 取（與持股庫存「借出」欄同一來源）。
// 借券期間仍可由券商補償股利，所以借出張數本來就包含在持有張數內，此處只是標註。
function _divLentShares(code) {
  if (typeof _positions === 'undefined' || !_positions) return 0;
  var n = 0;
  _positions.forEach(function (p) {
    if (String(p.code) !== String(code) || !p.lent) return;
    n += (p.lentShares != null ? p.lentShares : p.quantity);
  });
  return n;
}

// ── 本月除息個股 ──
// 來源：各檔 computeEtfYear 產生的 months（已含 TPEx 預告與手動補登），取「除息日落在本月」者。
// 排序：除息日由近至遠（月初→月底）。持有張數＝該次除息實際可領股數（除息日當天之後買進的批次已排除）。
function _divExMonthHtml(stocks, money, md) {
  var ym = _divTwDate().iso.slice(0, 7);
  var list = [];
  stocks.forEach(function (s) {
    (s.res.months || []).forEach(function (mo) {
      if (!mo.exDate || mo.exDate.slice(0, 7) !== ym) return;
      var _r = (typeof _rows !== 'undefined') && _rows[s.code];
      var price = (_r && _r.close != null) ? _r.close
        : ((typeof _contracts !== 'undefined' && _contracts[s.code] && _contracts[s.code].reference) || null);
      // 持股成本（每股成本均價，同持股庫存「成本均價」）；預估年殖利率＝每股配息 × 年配息次數 ÷ 現價（同個股明細標頭）
      var pos = (typeof _positions !== 'undefined' && _positions || []).filter(function (p) { return String(p.code) === s.code; })[0];
      var recsAsc = ((typeof _divRecMap !== 'undefined' && _divRecMap[s.code]) || [])
        .filter(function (x) { return x.exDate; }).slice()
        .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; })
        .map(function (x) { return Object.assign({ code: s.code }, x); });
      var known = recsAsc.filter(function (x) { return x.amount > 0; }).slice(-1)[0];
      var ps = mo.perShare > 0 ? mo.perShare : (known ? known.amount : 0);   // 本次待公告 → 用最近一次已知金額
      var yld = (price && ps && recsAsc.length) ? ps * (12 / _divInferStep(recsAsc)) / price * 100 : null;
      list.push({ code: s.code, price: price, exDate: mo.exDate, payDate: mo.payDate,
        cost: pos && pos.price > 0 ? pos.price : null, yld: yld, yldGuess: !(mo.perShare > 0),
        shares: mo.shares, lent: _divLentShares(s.code),
        after: !!(mo.partial && !mo.shares),   // 除息日當天（含）之後才買進 → 領不到這次配息
        perShare: mo.perShare, total: mo.total, status: mo.status });
    });
  });
  list.sort(function (a, b) { return a.exDate < b.exDate ? -1 : (a.exDate > b.exDate ? 1 : 0); });

  var h = '<div class="divest-sec-title">本月除息個股</div>';
  if (!list.length) return h + '<div class="divest-note">本月無除息個股。</div>';

  h += '<div class="dstat-wrap dexm-wrap"><table class="dstat dexm"><thead><tr>' +
    '<th class="dstat-code">代號</th><th class="num">現價</th>' +
    '<th class="num">除息日</th><th class="num">發放日</th>' +
    '<th class="num" title="每股成本均價（同持股庫存）">持股成本</th>' +
    '<th class="num" title="每股配息 × 年配息次數 ÷ 現價">預估年殖利率</th>' +
    '<th class="num">持有張數</th>' +
    '<th class="num">除息金額</th><th class="num dstat-tot">總金額</th></tr></thead><tbody>';
  var sum = 0;
  list.forEach(function (it) {
    sum += it.total;
    var c = it.status === 'actual' ? ' dv-act' : ' dv-est';
    h += '<tr><td class="dstat-code">' + it.code + '</td>' +
      '<td class="num">' + (it.price != null ? it.price.toFixed(2) : '—') + '</td>' +
      '<td class="num' + c + '">' + md(it.exDate) + '</td>' +
      '<td class="num">' + md(it.payDate) + '</td>' +
      '<td class="num">' + (it.cost != null ? it.cost.toFixed(2) : '<span style="color:var(--text3)">—</span>') + '</td>' +
      '<td class="num dexm-yld"' + (it.yldGuess && it.yld != null ? ' title="本次金額待公告，以最近一次已知配息估算"' : '') + '>' +
        (it.yld != null ? it.yld.toFixed(2) + '%' + (it.yldGuess ? '<span class="dexm-lent">*</span>' : '') : '<span style="color:var(--text3)">—</span>') + '</td>' +
      '<td class="num">' + (it.shares / 1000).toLocaleString('zh-TW') +
        (it.lent ? ' <span class="dexm-lent">(借出 ' + (it.lent / 1000).toLocaleString('zh-TW') + ' 張)</span>' : '') +
        (it.after ? ' <span class="dexm-lent">(除息後買進)</span>' : '') + '</td>' +
      '<td class="num">' + (it.perShare ? it.perShare.toFixed(4) : '<span style="color:var(--text3)">待公告</span>') + '</td>' +
      '<td class="num dstat-tot">' + (it.perShare ? money(it.total) : '<span style="color:var(--text3)">—</span>') + '</td></tr>';
  });
  h += '</tbody><tfoot><tr><td class="dstat-code">合計</td><td class="num"></td><td class="num"></td>' +
    '<td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td>' +
    '<td class="num dstat-tot">' + money(sum) + '</td></tr></tfoot></table></div>';
  return h;
}

// ── 月份總覽（依發放月）──
// 縱向＝個股（依總計高→低，可點代號改排序）、橫向＝1–12 月＋總計。
// 綠＝已發放、黃＝預估；空月留白不填 0；全年為 0 的個股不列入。
var _divStatSort = 'totDesc';
function divStatSort(key) {
  _divStatSort = (_divStatSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  renderDividendEst();
}
function _divStatRows(stocks) {
  var rows = [];
  stocks.forEach(function (s) {
    var r = { code: s.code, m: {}, act: {}, tot: 0 };
    (s.res.months || []).forEach(function (m) {
      r.m[m.month] = (r.m[m.month] || 0) + m.total;
      if (m.status === 'actual') r.act[m.month] = true;
      r.tot += m.total;
    });
    if (r.tot > 0) rows.push(r);          // 全年 0 元（今年尚未配息）不列入
  });
  var asc = /Asc$/.test(_divStatSort);
  rows.sort(function (a, b) {
    if (/^code/.test(_divStatSort)) {
      var c = String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
      return asc ? c : -c;
    }
    return asc ? a.tot - b.tot : b.tot - a.tot;
  });
  return rows;
}
function _divStatTableHtml(stocks, money) {
  var rows = _divStatRows(stocks);
  if (!rows.length) return '';
  var arrow = function (key) {
    return _divStatSort === key + 'Asc' ? '▲' : (_divStatSort === key + 'Desc' ? '▼' : '↕');
  };
  var sorted = function (key) { return _divStatSort.indexOf(key) === 0 ? ' sorted' : ''; };
  var h = '<div class="divest-divider"></div><div class="divest-sec-title">月份總覽（依發放月）</div>' +
    '<div class="dstat-wrap"><table class="dstat">' +
    '<thead><tr><th class="dstat-code sort-th' + sorted('code') + '" onclick="divStatSort(\'code\')" title="點擊排序">代號<span class="sort-ind">' + arrow('code') + '</span></th>';
  for (var mo = 1; mo <= 12; mo++) h += '<th class="num">' + mo + '月</th>';
  h += '<th class="num dstat-tot sort-th' + sorted('tot') + '" onclick="divStatSort(\'tot\')" title="點擊排序">總計<span class="sort-ind">' + arrow('tot') + '</span></th></tr></thead><tbody>';

  var colT = {}, grand = 0;
  rows.forEach(function (r) {
    h += '<tr><td class="dstat-code">' + r.code + '</td>';
    for (var mo = 1; mo <= 12; mo++) {
      var v = r.m[mo];
      if (v) { colT[mo] = (colT[mo] || 0) + v; grand += v; }
      h += '<td class="num' + (v ? (r.act[mo] ? ' dv-act' : ' dv-est') : '') + '">' +
        (v ? money(v) : '') + '</td>';
    }
    h += '<td class="num dstat-tot">' + money(r.tot) + '</td></tr>';
  });
  h += '</tbody><tfoot><tr><td class="dstat-code">合計</td>';
  for (var k = 1; k <= 12; k++) h += '<td class="num">' + (colT[k] ? money(colT[k]) : '') + '</td>';
  h += '<td class="num dstat-tot">' + money(grand) + '</td></tr></tfoot></table></div>';
  return h;
}

function toggleDivStock(code) {
  _divEstOpen[code] = !_divEstOpen[code];
  renderDividendEst();
}

// ── 上櫃除權息預告表（TPEx OpenAPI，官方 JSON；每日 1 次即涵蓋全市場，零額外成本）──
// 供股利估算與填息追蹤共用：任一頁先用到就抓並快取，不再互相相依
var TPEX_CAL_LS = 'refill_cal_v1';
var _tpexFresh = false;                 // 本次是否真的向 TPEx 抓了新資料
function _tpexCached() {
  try { var c = JSON.parse(localStorage.getItem(TPEX_CAL_LS) || 'null'); if (c && c.day === _divTwDate().iso) return c.rows; } catch (e) {}
  return null;
}
async function fetchTpexExright() {
  var hit = _tpexCached();
  if (hit) return hit;
  _tpexFresh = true;
  var rows = [];
  try {
    var url = 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost';
    var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
    var j = await r.json();
    (Array.isArray(j) ? j : []).forEach(function (x) {
      var d = String(x.ExRrightsExDividendDate || '');
      if (d.length !== 7) return;                                    // 民國 yyyMMdd
      var iso = (+d.slice(0, 3) + 1911) + '-' + d.slice(3, 5) + '-' + d.slice(5, 7);
      var amt = parseFloat(x.CashDividend);                          // 可能是「尚未公告」
      rows.push({ code: String(x.SecuritiesCompanyCode), name: x.CompanyName || '',
        exDate: iso, amount: isNaN(amt) ? null : amt, payDate: null, src: 'TPEx' });
    });
  } catch (e) { console.warn('[tpex exright]', e); }
  if (rows.length) { try { localStorage.setItem(TPEX_CAL_LS, JSON.stringify({ day: _divTwDate().iso, rows: rows })); } catch (e) {} }
  return rows;
}

// 併入「已公告但資料源尚未收錄」的除息：TPEx 除權息預告表（填息追蹤頁快取）＋使用者手動補登
// 目的：剛公告、e添富/Yahoo 還沒更新時，估算即可改採實際除息日與金額，而非以往年推估
// 只讀 localStorage 既有快取，不額外發網路請求；同除息日「已有值優先、缺漏才補」
// ── 官方除權息歷史（第二資料源）──
// e添富只到約 2025/01、Yahoo 會漏筆（00981B 漏掉 2026-03-03 每股 0.062，券商實領金額證實確有此次）。
// 上櫃：TPEx「除權除息計算結果表」exDailyQ；上市：TWSE「除權除息計算結果表」TWT49U。兩者皆可指定日期區間。
// 抓近兩年（歷年配息圖要用），每半年一段、上市上櫃並行共 8 次；只留持有代號，當日快取。
// 不用一年一段：TPEx 一年約 1,300 筆，GAS 端常逾時（回 {"error":"逾時…"}），半年一段並各重試一次。
var DIV_OFFHIST_LS = 'divest_offhist_v2';
// { day: 最後一次完整更新日, codes: 持股代號組合, map: { code: [{ exDate, amount, src }] } }
// 過去的除權息結果不會再變 → 保留上次完整資料（不限當天），每日只補抓「上次更新日前 7 天～今天」這段。
// GAS 壅塞時全部 8 段常逾時；增量只需 2 段，且抓不到時仍可用前次資料，不致漏掉已知的除息。
var _divOffHist = null;
function _divOffHistStored() {
  if (!_divOffHist) { try { _divOffHist = JSON.parse(localStorage.getItem(DIV_OFFHIST_LS) || 'null'); } catch (e) {} }
  return _divOffHist;
}
function _divOffHistReady(codes) {
  var c = _divOffHistStored();
  return !!(c && c.day === _divTwDate().iso && c.codes === codes.slice().sort().join(','));
}
var _divOffHistBusy = false;
async function _divLoadOfficialHist(codes, force) {
  var today = _divTwDate().iso, key = codes.slice().sort().join(',');
  if (!force && _divOffHistReady(codes)) return;
  var prev = _divOffHistStored();
  var t = Date.parse(today), DAY = 86400000, horizon = t - 730 * DAY;   // 歷年配息圖要兩年
  // 增量：同一組持股且有前次完整資料 → 從前次更新日前 7 天抓起（重疊一週，避免邊界漏筆）；否則抓滿兩年
  var from = (prev && prev.codes === key && prev.day) ? Math.max(horizon, Date.parse(prev.day) - 7 * DAY) : horizon;
  var spans = [];
  for (var end = t; end > from; end -= 183 * DAY) spans.push([new Date(Math.max(from, end - 182 * DAY)), new Date(end)]);

  var want = {}; codes.forEach(function (c) { want[c] = true; });
  var fresh = {}, okCount = 0;
  var add = function (code, iso, amt, src) {
    code = String(code).trim();
    if (!want[code] || !iso || !(amt > 0)) return;
    (fresh[code] = fresh[code] || []).push({ exDate: iso, amount: amt, src: src });
  };
  var via = async function (u) {           // GAS 逾時會回 {error}（HTTP 200），當作失敗重試一次
    for (var a = 0; a < 2; a++) {
      try {
        var j = await _divFetchT(NEWS_GAS_URL + '?url=' + encodeURIComponent(u), 40000).then(function (r) { return r.json(); });
        if (j && !j.error) return j;
      } catch (e) {}
    }
    throw new Error('GAS 抓取失敗：' + u);
  };
  var roc = function (d) { return (d.getUTCFullYear() - 1911) + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + d.getUTCDate()).slice(-2); };
  var ymd = function (d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); };
  var rocToIso = function (txt) {   // 「115/03/03」或「115年03月03日」
    var m = String(txt || '').match(/(\d{2,3})\D(\d{1,2})\D(\d{1,2})/);
    return m ? (+m[1] + 1911) + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : null;
  };
  await Promise.all(spans.map(async function (sp) {
    try {       // TPEx：欄位 0 除權息日期、1 代號、6 息值
      var j = await via('https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=' + roc(sp[0]) + '&endDate=' + roc(sp[1]) + '&response=json');
      var tb = j && j.tables && j.tables[0];
      if (j && j.stat === 'ok' && tb) { okCount++; (tb.data || []).forEach(function (x) { add(x[1], rocToIso(x[0]), parseFloat(x[6]), 'TPEx'); }); }
    } catch (e) { console.warn('[TPEx 除權息歷史]', e); }
  }).concat(spans.map(async function (sp) {
    try {       // TWSE：欄位 0 資料日期、1 代號、5 權值＋息值、6 權/息（ETF 只取「息」）
      var j = await via('https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=' + ymd(sp[0]) + '&endDate=' + ymd(sp[1]) + '&response=json');
      var tb = j && (j.tables ? j.tables[0] : j);
      if (j && /ok/i.test(j.stat || '') && tb) {
        okCount++;
        (tb.data || []).forEach(function (x) { if (/息/.test(x[6]) && !/權/.test(x[6])) add(x[1], rocToIso(x[0]), parseFloat(x[5]), 'TWSE'); });
      }
    } catch (e) { console.warn('[TWSE 除權息歷史]', e); }
  })));
  if (okCount < spans.length * 2) return;          // 有任一段失敗 → 不更新（沿用前次完整資料），下次再試

  // 組合：前次資料中早於本次抓取起點的保留，其餘以本次結果為準；超過兩年的丟掉
  var fromIso = new Date(from).toISOString().slice(0, 10), horizonIso = new Date(horizon).toISOString().slice(0, 10);
  var map = {};
  codes.forEach(function (c) {
    var keep = ((prev && prev.codes === key && prev.map[c]) || []).filter(function (r) { return r.exDate < fromIso && r.exDate >= horizonIso; });
    var list = keep.concat(fresh[c] || []);
    if (list.length) map[c] = list;
  });
  _divOffHist = { day: today, codes: key, map: map };
  try { localStorage.setItem(DIV_OFFHIST_LS, JSON.stringify(_divOffHist)); } catch (e) {}
}
// 併入：同一檔、除息日相差 3 天內視為同一次（各來源時區／登錄日可能差一天）→ 以官方金額為準、保留原發放日；
// 找不到對應的 → 新增一筆（發放日未知，由 _divDerivePay 推算）。
function _divMergeOfficialHist(recMap, codes) {
  var hist = _divOffHist && _divOffHist.map;
  if (!hist) return;
  var near = function (a, b) { return Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * 86400000; };
  codes.forEach(function (code) {
    var off = hist[code];
    if (!off || !off.length) return;
    var list = (recMap[code] || []).map(function (x) { return Object.assign({}, x); });   // 複製，避免污染 e添富 快取物件
    off.forEach(function (o) {
      var cur = list.filter(function (x) { return x.exDate && near(x.exDate, o.exDate); })[0];
      if (cur) {
        if (cur.amount == null || Math.abs(cur.amount - o.amount) > 1e-6) { cur.amount = o.amount; cur._src = (cur._src ? cur._src + '＋' : '') + o.src; }
      } else {
        list.push({ code: code, name: (_contracts[code] && _contracts[code].name) || '', exDate: o.exDate, payDate: null, amount: o.amount, _src: o.src + '歷史' });
      }
    });
    recMap[code] = list;
  });
}

function _divMergeAnnounced(recMap) {
  var add = {};
  var push = function (code, exDate, payDate, amount, src) {
    if (!recMap[code] || !exDate) return;          // 僅處理本來就有配息資料的持股
    (add[code] = add[code] || []).push({ exDate: exDate, payDate: payDate || null, amount: amount, src: src });
  };
  try {                                            // TPEx 除權息預告（全市場快取，取持股者）
    var cal = JSON.parse(localStorage.getItem('refill_cal_v1') || 'null');
    if (cal && cal.rows) cal.rows.forEach(function (r) { push(String(r.code), r.exDate, r.payDate, r.amount, 'TPEx'); });
  } catch (e) {}
  try {                                            // 手動補登（後併入，可補上 TPEx 缺的金額/發放日）
    var man = JSON.parse(localStorage.getItem('refill_manual_v1') || '{}');
    Object.keys(man).forEach(function (code) {
      var m = man[code]; if (m) push(String(code), m.exDate, m.payDate, m.amount, '手動');
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
        var rec = { code: code, name: '', exDate: n.exDate, payDate: n.payDate, amount: n.amount, _src: n.src };
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
