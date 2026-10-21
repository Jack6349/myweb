// 股利總管 Web — 填息追蹤（股利估算子頁籤）
// 填息定義：基準價 P0 ＝ 除息日前一交易日收盤；除息後首次「收盤 ≥ P0」即填息，天數以交易日計。
// 價格用 Yahoo 未還原收盤價（還原價會抹平除息缺口，算不出填息）；每檔每日快取，無除息紀錄者不抓價。

var RF_YEARS = 2;                 // 統計範圍（近 2 年除息）
var RF_LS = 'refill_px_v1';       // 日K 快取（每日）
var RF_CAL_LS = 'refill_cal_v2';  // 除權息預告快取（TPEx＋TWSE，每日）
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
  return (r.amount != null ? r.amount + '  ' : '') + (r.exDate || '').replace(/-/g, '/') + (r.payDate ? '  ' + r.payDate.replace(/-/g, '/') : '');
}
// 可接受：「0.153 2026/08/18 2026/09/09」「2026/10/05」「10/05 0.085」等——
// 帶斜線/橫線的是日期（第一個＝除息日、第二個＝發放日；省略年份時取今年，已過則視為明年），不帶的數字是每股金額（可省略＝待公告）。
function _rfParseManual(s) {
  var p = String(s || '').trim().split(/[\s,\t]+/).filter(Boolean);
  var today = _divTwDate().iso, dates = [], amt = null;
  p.forEach(function (x) {
    var m = x.match(/^(?:(\d{4})[\/\-.])?(\d{1,2})[\/\-.](\d{1,2})$/);
    if (m) {
      var y = m[1] ? +m[1] : +today.slice(0, 4);
      var iso = y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
      if (!m[1] && iso < today && !dates.length) iso = (y + 1) + iso.slice(4);
      dates.push(iso);
    } else if (/^\d*\.?\d+$/.test(x) && amt == null) amt = parseFloat(x);
  });
  if (!dates.length) return null;
  if (amt != null && !(amt > 0)) amt = null;
  var pay = dates[1] || null;
  if (pay && pay < dates[0]) pay = null;
  return { amount: amt, exDate: dates[0], payDate: pay };
}
// 清除「已完成」的手動補登，避免舊資料殘留在輸入框造成誤判。
// 判斷用發放日而非除息日：已除息但未發放的紀錄仍是股利估算的來源
// （例：8/18 除息、9/9 發放，9 月才入帳），太早刪會讓估算少一筆。
// 無發放日時保守等除息後 60 天（一般發放日在除息後 3～4 週）。
function _rfManPrune() {
  var man = _rfManLoad(), today = _divTwDate().iso, changed = false;
  Object.keys(man).forEach(function (code) {
    var r = man[code];
    if (!r || !r.exDate) return;
    var done;
    if (r.payDate) done = r.payDate < today;
    else done = new Date(new Date(r.exDate + 'T00:00:00+08:00').getTime() + 60 * 86400000)
      .toISOString().slice(0, 10) < today;
    if (done) { delete man[code]; changed = true; }
  });
  if (changed) _rfManSave(man);
  return changed;
}

function rfManualInput(code, el) {
  var raw = el.value;
  var map = _rfManLoad();
  // 輸入框在股利估算頁的除息日曆裡，所以重畫的是那一頁（_rfNote 也顯示在該表標題）
  if (!raw.trim()) { delete map[code]; _rfManSave(map); _rfNote = code + ' 手動資料已清除'; _rfSyncDivEst(); return; }
  var r = _rfParseManual(raw);
  if (!r) {
    _rfNote = code + ' 格式無法解析，請貼上如：0.153　2026/08/18　2026/09/09';
    if (typeof renderDividendEst === 'function') renderDividendEst();   // 只重畫，不重抓
    return;
  }
  map[code] = r;
  _rfManSave(map);
  _rfNote = code + ' 已補登：配息 ' + (r.amount != null ? r.amount : '待公告') + '、除息 ' + r.exDate + (r.payDate ? '、發放 ' + r.payDate : '');
  // 貼到過期的除息日時明講：日曆只列未來除息，貼舊資料不會有反應，容易誤以為沒生效
  if (r.exDate < _divTwDate().iso) {
    _rfNote += '　※ 此除息日已過，不會顯示在除息日曆' +
      (r.payDate && r.payDate >= _divTwDate().iso ? '（發放日未到，仍計入股利估算）' : '');
  }
  _rfSyncDivEst();                  // 重算股利估算：連帶重建除息日曆（併入手動值）並重畫
}
var _rfResult = null;             // [{code,name,events:[],filled,total,avgDays,medDays,pending}]
var _rfOpen = {};                 // code -> 是否展開
var _rfCal = null;                // 除息日曆：[{code,name,exDate,amount,payDate,src}]
var _rfPay = null;                // 本月發放：[{code,payDate,derived,amount,exDate}]

// ── 上櫃除權息預告表（TPEx OpenAPI，官方 JSON；每日 1 次即涵蓋全市場）──
// TPEx 除權息預告表：實作已移至 dividend-est.js 的 fetchTpexExright()（兩頁共用同一份每日快取）
async function _rfFetchTpex() {
  return (typeof fetchTpexExright === 'function') ? await fetchTpexExright() : [];
}

// ── 除息日曆：上市走 e添富（_divRecMap 已含未來公告）、上櫃走 TPEx；合併後依除息日排序 ──
async function _rfBuildCalendar(codes, todayIso) {
  var cal = {};
  // e添富：_divRecMap 內除息日 ≥ 今天者
  codes.forEach(function (code) {
    ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || []).forEach(function (r) {
      if (!r.exDate || r.exDate < todayIso) return;
      // 來源：主來源（e添富／Yahoo歷史／TPEx／Yahoo預告）＋ _fill（補了缺漏欄位的次要來源）
      var base = r._src || ((typeof _divByCode !== 'undefined' && _divByCode[code]) ? 'e添富' : 'Yahoo歷史');
      cal[code + '|' + r.exDate] = { code: code, name: _swapName(code) || r.name || '',
        exDate: r.exDate, amount: r.amount, payDate: r.payDate || null,
        diff: r._diff || null,           // 官方公告後與財經網站先前值不同
        src: base + (r._fill ? '＋' + r._fill : '') };
    });
  });
  // 預告表（上櫃 TPEx＋上市 TWSE）：僅補持股
  var tp = await _rfFetchTpex();
  var held = {}; codes.forEach(function (c) { held[c] = true; });
  tp.forEach(function (r) {
    if (!held[r.code] || r.exDate < todayIso) return;
    var k = r.code + '|' + r.exDate, cur = cal[k];
    var sn = r.src || 'TPEx';
    if (!cur) { cal[k] = { code: r.code, name: _swapName(r.code) || r.name, exDate: r.exDate, amount: r.amount, payDate: null, src: sn }; }
    else if (cur.amount == null && r.amount != null) { cur.amount = r.amount; cur.src += '＋' + sn; }
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
      if (cur.amount == null && r.amount != null) cur.amount = r.amount;
      if (!cur.payDate && r.payDate) cur.payDate = r.payDate;
      cur.manual = true;   // 只要有手動紀錄就標記，重整後輸入框才會保留、可再編輯或清除
    }
  });
  return Object.keys(cal).map(function (k) { return cal[k]; })
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : (a.exDate > b.exDate ? 1 : String(a.code).localeCompare(String(b.code))); });
}

var _rfNote = '';   // 頁面提示訊息（手動補登結果）

// ── 日K（含日期、未還原收盤）：Yahoo 2y，經 GAS ?url= 代理；每日快取 ──
// 台北時間是否已過收盤資料可取得時間（13:30 收盤，Yahoo 日 K 約延遲 30 分鐘，取 14:00）
function _rfAfterClose(ms) { return new Date((ms == null ? Date.now() : ms) + 8 * 3600000).getUTCHours() >= 14; }
async function _rfFetchDaily(code) {
  var day = _divTwDate().iso, cache = { day: day, map: {}, at: {} };
  try { var c = JSON.parse(localStorage.getItem(RF_LS) || 'null'); if (c && c.day === day) cache = c; } catch (e) {}
  cache.at = cache.at || {};
  var hit = cache.map[code];
  // 當日快取若是收盤前抓的、且還沒有今天的 K 棒 → 收盤後重抓（假日重抓一次後時間戳更新，不會重複抓）
  var stale = hit && hit.length && hit[hit.length - 1].d < day && _rfAfterClose() && !_rfAfterClose(cache.at[code] || 0);
  if (hit && !stale) return hit;

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
  if (!bars && stale) return hit;                    // 重抓失敗 → 沿用收盤前的資料
  if (bars) {
    cache.map[code] = bars; cache.day = day; cache.at[code] = Date.now();
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
  if (iEx >= bars.length) {                         // 除息日尚無 K 棒（今日除息、尚未收盤）→ 仍列出，不計入統計
    return { exDate: exDate, amount: amount, base: base, filledDate: null, days: 0, pending: true, waiting: true, gapPct: null, lastPx: null };
  }
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
  var counted = evs.filter(function (e) { return !e.waiting; });   // 待收盤資料的那次不算入填息率／平均天數
  var done = counted.filter(function (e) { return !e.pending; });
  var days = done.map(function (e) { return e.days; }).sort(function (a, b) { return a - b; });
  var avg = days.length ? days.reduce(function (a, b) { return a + b; }, 0) / days.length : null;
  var med = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
  var pend = counted.filter(function (e) { return e.pending; });
  return { code: code, name: _swapName(code) || '', events: evs.slice().reverse(),
    filled: done.length, total: counted.length, avgDays: avg, medDays: med,
    pending: (evs[evs.length - 1] && evs[evs.length - 1].waiting) ? null : (pend[pend.length - 1] || null) };
}

// ── 進入頁面 ──
async function startRefill(force) {
  var wrap = document.getElementById('refill-wrap');
  var info = document.getElementById('refill-info');
  if (!wrap) return;
  if (force) { try { localStorage.removeItem(RF_LS); } catch (e) {} }
  wrap.innerHTML = '<div class="modal-loading">載入持股與配息資料…</div>';

  // 先清掉已完成的補登，再算股利估算，否則估算會先吃到過期資料
  var pruned = _rfManPrune();

  if (!_divEstResult || pruned) { try { await startDividendEst(); } catch (e) {} }
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

  // 除息日曆已移到股利估算頁，連帶在那裡建 _rfCal（startDividendEst）；本頁不再自行組

  var rows = [];
  for (var i = 0; i < withDiv.length; i++) {
    var code = withDiv[i];
    info.textContent = '取得日K ' + (i + 1) + '/' + withDiv.length + '（' + code + '）…';
    var bars = await _rfFetchDaily(code);
    if (!bars) continue;
    var r = _rfComputeCode(code, _divRecMap[code], bars, todayIso);
    if (r) rows.push(r);
  }
  _rfResult = { rows: rows, noDiv: noDiv, day: todayIso, at: Date.now() };
  info.textContent = '近 ' + RF_YEARS + ' 年除息｜' + rows.length + ' 檔';
  renderRefill();
}

// 切回填息追蹤頁籤時是否需重算：跨日，或收盤前算的而現在已收盤（今日除息那幾檔才有 K 棒可判定）
function _rfNeedsRefresh() {
  if (!_rfResult) return true;
  if (_rfResult.day !== _divTwDate().iso) return true;
  return _rfAfterClose() && !_rfAfterClose(_rfResult.at || 0);
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
    sp('貼息中', pendN + ' 檔', pendN ? 'var(--down)' : 'var(--text2)') +
    sp('可重複配息', _rfRepAll(rows), 'var(--text)') +
    '</div>';

  // 除息日曆（未來已公告）已移到股利估算頁的「本月除息個股」與「個股明細」之間

  // 本月發放已移到股利估算頁最上方（_rfPay 仍在那裡建，見 startDividendEst）

  // 未填息個股（本月發放與逐檔填息之間）：所有仍在貼息的除息，一次除息一列
  html += _rfPendingHtml(rows);

  // 逐檔
  html += '<div class="divest-sec-title">逐檔填息（近 ' + RF_YEARS + ' 年，點列展開歷次）</div><div class="rf-list">';
  // 成本均價（對原始成本）／含息損益／含息獲利率：整支沿用持股庫存的 invMetrics，
  // 兩頁同一個數字不會各算各的。逐檔填息每一列都是現有持股，成本一定查得到；
  // 走 Firestore 後備來源（id 為 null）時沒有建倉明細，配息加不出來 → 顯示「—」。
  var posOf = function (code) {
    var arr = (typeof _positions !== 'undefined' && _positions) ? _positions : [];
    for (var i = 0; i < arr.length; i++) if (String(arr[i].code) === String(code)) return arr[i];
    return null;
  };
  rows.forEach(function (r) {
    var open = !!_rfOpen[r.code];
    var pz = posOf(r.code);
    // 可重複配息占比：dmMix 的線性遞減加權（最新一期權重最高，平均會把趨勢抹掉）。
    // d 股利 ＋ i 利息 ＋ cc 賣出選擇權權利金；排除 c 賣股價差、e 平準金、o 其他。
    var mx = (typeof dmMix === 'function') ? dmMix(r.code, 12) : null;
    var repPct = mx ? (mx.d + mx.i + mx.cc) : null;
    var mt = (pz && typeof invMetrics === 'function') ? invMetrics(pz) : null;
    var avgTxt = (mt && mt.avg != null) ? mt.avg.toFixed(2) : '—';   // 原始成本均價
    var wdTxt = '—', wrTxt = '—', wdCls = 'flat', wrCls = 'flat';
    if (mt && mt.withDiv != null) {
      wdCls = colorClass(mt.withDiv);
      wdTxt = (mt.withDiv >= 0 ? '+' : '') + Math.round(mt.withDiv).toLocaleString('zh-TW');
    }
    if (mt && mt.wrate != null) {
      wrCls = colorClass(mt.wrate);
      wrTxt = (mt.wrate > 0 ? '+' : '') + mt.wrate.toFixed(2) + '%';
    }
    var pr = r.total ? r.filled / r.total * 100 : 0;
    // 不分色：原本以 80／50 分紅白綠，那兩個門檻是自訂的、不是從資料推的。
    // 樣本只有個位數檔，改用分位數也撐不起來，索性只給數字，讓讀的人自己比。
    var latest = r.events[0];
    var lastTxt;
    if (!latest) lastTxt = '—';
    else if (latest.waiting) lastTxt = '<span class="flat">待收盤資料</span>';
    else if (latest.pending) lastTxt = '<span class="down">貼息中</span>';
    else lastTxt = '<span class="up">已填息</span>';
    html += '<div class="rf-item">' +
      '<div class="rf-head" onclick="toggleRefill(\'' + r.code + '\')">' +
        '<span class="rf-code">' + r.code + '</span>' +
        '<span class="rf-name">' + r.name + '</span>' +
        _rfLv('rf-cost', '均價', avgTxt) +
        _rfLv('rf-wdiv ' + wdCls, '含息', wdTxt) +
        '<span class="rf-wrate ' + wrCls + '">' + wrTxt + '</span>' +
        _rfLv('rf-amtc', '配息', _rfAmtCell(r.code)) +
        _rfLv('rf-rep', '可重複', repPct == null ? '—' : repPct.toFixed(0) + '%',
          mx ? '近 ' + mx.n + ' 期加權：股利 ' + mx.d.toFixed(1) +
            '、利息 ' + mx.i.toFixed(1) + '、權利金 ' + mx.cc.toFixed(1) +
            '、賣股價差 ' + mx.c.toFixed(1) + '、平準金 ' + mx.e.toFixed(1) : '') +
        '<span class="rf-rate">' + r.filled + '/' + r.total + '（' + pr.toFixed(0) + '%）</span>' +
        _rfLv('rf-avg', '平均', r.avgDays != null ? r.avgDays.toFixed(1) + ' 天' : '—') +
        '<span class="rf-last">最近 ' + (latest ? _rfMd(latest.exDate) + ' 除息 ' + latest.amount.toFixed(3) + '　' + lastTxt : '—') + '</span>' +
        '<span class="rf-gap"></span>' +
        '<span class="divest-chev">' + (open ? '▼' : '▶') + '</span>' +
      '</div>' +
      (open ? _rfDetailHtml(r) : '') +
    '</div>';
  });
  html += '</div>';

  if (_rfResult.noDiv.length) {
    html += '<div class="rf-nodiv">尚未開始除息（未抓取價格）：' + _rfResult.noDiv.join('、') + '</div>';
  }
  html += '<div class="tx-note nb"><dl>' +
    '<dt>填息</dt><dd><code>基準價 ＝ 除息日前一交易日收盤</code>，除息後首次<code>收盤 ≥ 基準價</code>即填息，天數以交易日計。</dd>' +
    '<dt>成本均價</dt><dd><code>原始成本 ÷ 股數</code>，含手續費與銀行認購成本補正，與持股庫存同一個值。' +
    '券商記錄的成本已被扣掉累積配息，這裡加回還原成當初實際付出的錢。</dd>' +
    '<dt>含息損益</dt><dd><code>資本損益（現值 － 原始成本）＋ 累積已配息</code>，獲利率為其除以原始成本。' +
    '配息取自券商建倉明細的 <code>ex_dividends</code>，是<b>自買進以來的累計</b>，沒有日期可拆：' +
    '同一列左邊的填息率只算近 ' + RF_YEARS + ' 年，兩個欄位的時間區間不一樣。' +
    '出借中的權益補償是否計入這個欄位，券商沒有說明，尚未確認。</dd>' +
    '<dt>配息趨勢</dt><dd>近 6 個月<b>每期平均</b>金額相對前 6 個月的變化。用每期平均而非區間總額，' +
    '否則月配與季配比到的是一年配幾次。任一邊不足 1 期時改列逐期原始金額，不推估方向。' +
    '滑鼠移上去看近 12 個月的逐期序列。這一欄只講金額變化，不講錢從哪來，要配合右邊的「可重複」一起看。</dd>' +
    '<dt>可重複配息</dt><dd><code>股利 ＋ 利息 ＋ 賣出選擇權權利金</code>，排除賣股價差與收益平準金。' +
    '前者只要策略照跑就會再發生；賣股價差要行情配合，平準金是把新申購者的本金發還。' +
    '逐檔取近 12 期線性遞減加權（最新一期最重），合計列以配息金額加權。來源：公開資訊觀測站。</dd>' +
    '<dt>填息與賺賠是兩件事</dt><dd>填息比的是市場基準（除息前一日收盤），成本均價是你自己的進場點。' +
    '可以「已填息」但還在賠，也可以「貼息中」但是賺的，兩組紅綠不互相印證。</dd>' +
    '<dt>價格</dt><dd>Yahoo 未還原收盤（還原價會抹平除息缺口）。</dd>' +
    '<dt>範圍</dt><dd>近 ' + RF_YEARS + ' 年已除息紀錄，每日快取，按「重新整理」強制更新。' +
    '歷史統計，不預測未來填息表現，非投資建議。</dd>' +
    '</dl></div>';
  wrap.innerHTML = html;
}

// 整體可重複占比：以近 12 個月的配息金額加權（每股金額 × 目前股數），
// 不是各檔取平均——6 萬的 00999A 不該和 69 萬的 00918 一樣重。
function _rfRepAll(rows) {
  if (typeof dmRecs !== 'function') return '—';
  var tot = 0, rep = 0;
  rows.forEach(function (r) {
    var sh = (typeof _sharesMap !== 'undefined' && _sharesMap[r.code]) || 0;
    if (!sh) return;
    (dmRecs(r.code, 12) || []).forEach(function (x) {
      if (x.amt == null || !x.pct) return;
      var amt = x.amt * sh;
      tot += amt;
      rep += amt * ((x.pct.d || 0) + (x.pct.i || 0) + (x.pct.cc || 0)) / 100;
    });
  });
  return tot ? (rep / tot * 100).toFixed(0) + '%' : '—';
}

// 一格「標籤 ＋ 數值」。整格靠右對齊時，字數不同會讓標籤起點跟著跑，
// 所以拆成兩個子元素：標籤貼左、數值貼右，同一欄的標籤與數字各自對齊。
function _rfLv(cls, lb, val, tip) {
  return '<span class="rf-lv ' + cls + '"' + (tip ? ' title="' + tip + '"' : '') + '>' +
    '<i class="rf-lb">' + lb + '</i><b class="rf-v">' + val + '</b></span>';
}

// 配息金額趨勢：近 6 個月「每期平均」vs 前 6 個月「每期平均」。
// 用每期平均而不是區間總額，因為月配與季配在同一個區間的期數不同，
// 總額會把配息頻率混進來，比到的是一年配幾次而不是每次配多少。
// 任一邊不足 1 期就不給百分比，改列原始序列（沿用 div-mix.js 的作法：
// 幾個數字比一個箭頭清楚，而且不需要任何門檻）。
function _rfAmtTrend(code) {
  var list = (typeof dmRecs === 'function') ? dmRecs(code, 12) : null;
  if (!list || !list.length) return null;
  var d = new Date(Date.now() + 8 * 3600000);
  d.setMonth(d.getMonth() - 6);
  var mid = d.toISOString().slice(0, 10);
  var now = [], prev = [], seq = [];
  list.forEach(function (x) {
    if (x.amt == null) return;
    seq.push(x.amt);
    (x.ex >= mid ? now : prev).push(x.amt);
  });
  seq.reverse();                                   // dmRecs 是新→舊，序列顯示要舊→新
  if (!seq.length) return null;
  var avg = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
  var out = { seq: seq, n: seq.length, min: Math.min.apply(null, seq), max: Math.max.apply(null, seq) };
  if (now.length && prev.length) {
    out.now = avg(now); out.prev = avg(prev);
    out.pct = out.prev ? (out.now - out.prev) / out.prev * 100 : null;
    out.nNow = now.length; out.nPrev = prev.length;
  }
  return out;
}
function _rfAmtCell(code) {
  var t = _rfAmtTrend(code);
  if (!t) return '<span class="flat">—</span>';
  var fmt = function (v) { return v < 1 ? v.toFixed(3) : v.toFixed(2); };
  var tip = '近 12 個月逐期每股配息（舊→新）：' + t.seq.map(fmt).join(' → ') +
    (t.pct == null ? '' : '&#10;近半年每期平均 ' + fmt(t.now) + '（' + t.nNow + ' 期）' +
      '、前半年 ' + fmt(t.prev) + '（' + t.nPrev + ' 期）');
  var wrap = function (cls, txt) {
    return '<span class="rf-amt ' + cls + '" title="' + tip + '">' + txt + '</span>';
  };
  if (t.pct == null) {
    // 期數不夠分半年：不推估方向，只陳述看得到的事實
    if (t.n === 1) return wrap('flat', '僅 1 期');
    if (t.min === t.max) return wrap('flat', '持平');
    return wrap(t.seq[t.seq.length - 1] >= t.seq[0] ? 'up' : 'down',
      fmt(t.seq[0]) + '→' + fmt(t.seq[t.seq.length - 1]));
  }
  if (t.pct === 0) return wrap('flat', '持平');
  return wrap(t.pct > 0 ? 'up' : 'down',
    (t.pct > 0 ? '▲' : '▼') + Math.abs(t.pct).toFixed(0) + '%');
}

function _rfMd(iso) { return iso ? iso.slice(5).replace('-', '/') : '—'; }

// 未填息個股：逐檔填息中 pending 的每一次除息（同一檔可有多列：月配多次未填，各自基準價不同）
// 現價：盤中有即時報價用即時價，否則用 Yahoo 最近收盤（與明細同源）；距填息％＝(基準價－現價)÷基準價
// 今天剛除息、尚無收盤資料（waiting）者不列。排序：距填息％由小到大（最接近填息的在上）。
function _rfPendingHtml(rows) {
  var list = [];
  rows.forEach(function (r) {
    r.events.forEach(function (e) {
      if (!e.pending || e.waiting) return;
      var live = (typeof _rows !== 'undefined') && _rows[r.code] && _rows[r.code].close;
      var px = live != null && live > 0 ? live : e.lastPx;
      var gap = (e.base - px) / e.base * 100;
      if (gap <= 0) return;                                   // 即時價已站回基準價（收盤確認前先不列）
      list.push({ code: r.code, name: r.name, ex: e.exDate, amt: e.amount, base: e.base, px: px, diff: px - e.base, days: e.days, gap: gap });
    });
  });
  list.sort(function (a, b) { return a.gap - b.gap || (a.ex < b.ex ? -1 : 1); });

  var h = '<div class="divest-sec-title">未填息個股' + (list.length ? '<span class="rf-cmnote">' + list.length + ' 筆</span>' : '') + '</div>';
  if (!list.length) return h + '<div class="rf-cal-empty">目前無未填息個股。</div>';
  h += '<div class="inv-table-wrap"><table class="inv-table swap-table rf-pend"><thead><tr>' +
    '<th>代號</th><th>名稱</th><th>除息日</th><th class="num">配息</th><th class="num">基準價</th>' +
    '<th class="num" title="盤中為即時價，否則為最近收盤">現價</th><th class="num" title="現價－基準價">價差</th>' +
    '<th class="num" title="除息後經過的交易日數">貼息</th><th class="num" title="(基準價－現價)÷基準價">距填息</th></tr></thead><tbody>';
  list.forEach(function (x) {
    h += '<tr>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + x.code + '\')">' + x.code + '</span></td>' +
      '<td class="inv-name">' + (x.name || '') + '</td>' +
      '<td>' + _rfMd(x.ex) + '</td>' +
      '<td class="num">' + x.amt.toFixed(3) + '</td>' +
      '<td class="num">' + x.base.toFixed(2) + '</td>' +
      '<td class="num">' + x.px.toFixed(2) + '</td>' +
      '<td class="num down">' + x.diff.toFixed(2) + '</td>' +
      '<td class="num">' + x.days + ' 天</td>' +
      // 距填息不上色：它跟左邊的「價差」是同一件事的兩種寫法（價差 -2.3 元＝距填息 2.3%），
      // 原本一個綠一個紅，同一列把同一個事實標成兩種顏色。而且這張表整張都是未填息的，
      // 顏色分不出任何東西；要比遠近看數字即可（本表已依距填息由小到大排序）。
      '<td class="num">' + x.gap.toFixed(2) + '%</td>' +
    '</tr>';
  });
  return h + '</tbody></table></div>';
}

// 本月發放：發放月＝當月的配息（含已入帳與待發放）
//
// 張數一律取「除息日當時可領的量」，不是目前持股。2026-10-06 實測兩邊差 31,555 元：
//   00918  現在 165 張，9/18 除息當天之後才買的 15 張領不到 → 多算 26,250
//   00989B 現在 235 張，9/15 之後買的 65 張領不到           → 多算  5,720
//   00999A 現在   6 張，10/01 買的 1 張領不到                → 多算    290
//   00988B 現在   5 張，但 9/18 賣掉的 5 張除息當天還持有    → 少算    705
// 可領量股利估算已經算過（computeEtfYear 依建倉明細與已實現損益判定），
// 直接取同一份結果，兩頁才不會各自長出一套數字。
function _rfBuildMonthPay(codes, todayIso) {
  var ym = todayIso.slice(0, 7), out = [];
  var est = (typeof _divEstResult !== 'undefined' && _divEstResult && _divEstResult.stocks) || null;
  if (est) {
    est.forEach(function (s) {
      (s.res.months || []).forEach(function (m) {
        if (!m.payDate || m.payDate.slice(0, 7) !== ym) return;
        out.push({ code: s.code, payDate: m.payDate, derived: false, amount: m.perShare,
                   exDate: m.exDate, shares: m.shares, total: m.total, partial: !!m.partial,
                   lentShares: m.lentShares || 0, lentTotal: m.lentTotal || 0, lentSrc: m.lentSrc, lentDate: m.lentDate });
      });
    });
  } else {
    // 估算結果還沒好（直接進填息追蹤頁）→ 退回原本的推算，張數用目前持股
    codes.forEach(function (code) {
      ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || []).forEach(function (r) {
        var pay = _divPayRoll(r.payDate || _divDerivePay(r.exDate));   // 與股利估算同一推算規則（含週末順延）
        if (!pay || pay.slice(0, 7) !== ym) return;
        out.push({ code: code, payDate: pay, derived: !r.payDate, amount: r.amount, exDate: r.exDate });
      });
    });
  }
  out.sort(function (a, b) {
    return a.payDate < b.payDate ? -1 : (a.payDate > b.payDate ? 1 : String(a.code).localeCompare(String(b.code)));
  });
  return out;
}

// ── 發放日曆（本月＋下月）──
// 為什麼用月曆而不是清單：清單看不出「間隔」。實測 2026-10 的進帳是
// 6→10→13→15→17 連續五筆，然後空 11 天到 28 號；那段空檔對調度現金有意義。
// 七欄不砍週末：10 個發放日裡有 2 個落在週六（10-10、10-17），砍掉會漏兩成。
// 格子約 84% 是空的（10 月 6/31 天、11 月 4/30 天），這是月曆換「看得出間隔」要付的。

function _rfPayOfMonth(ym) {
  var est = (typeof _divEstResult !== 'undefined' && _divEstResult && _divEstResult.stocks) || null;
  var out = [];
  if (!est) return out;
  est.forEach(function (s) {
    (s.res.months || []).forEach(function (m) {
      if (!m.payDate || m.payDate.slice(0, 7) !== ym) return;
      out.push({ code: s.code, payDate: m.payDate, amount: m.perShare, total: m.total || 0,
                 status: m.status, shares: m.shares,
                 lentTotal: m.lentTotal || 0, lentShares: m.lentShares || 0 });
    });
  });
  out.sort(function (a, b) {
    return a.payDate < b.payDate ? -1 : (a.payDate > b.payDate ? 1 : String(a.code).localeCompare(String(b.code)));
  });
  return out;
}

function _rfYmShift(ym, k) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) + k;
  y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return y + '-' + (m < 10 ? '0' : '') + m;
}

// 一個月的格子。rows 是該月的發放，todayIso 用來分「已發放／待發放」
function _rfCalMonth(ym, rows, todayIso) {
  var y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
  var first = new Date(Date.UTC(y, mo - 1, 1));
  var lead = first.getUTCDay();                               // 1 號是星期幾（0＝日）
  var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();        // 當月天數
  var byDay = {};
  rows.forEach(function (r) { (byDay[+r.payDate.slice(8, 10)] = byDay[+r.payDate.slice(8, 10)] || []).push(r); });
  var total = rows.reduce(function (a, r) { return a + (r.total || 0); }, 0);
  var est = rows.some(function (r) { return r.status !== 'actual'; });

  var W = ['日', '一', '二', '三', '四', '五', '六'];
  var h = '<div class="rf-cal-mon">' +
    '<div class="rf-cal-head"><span class="rf-cal-ym">' + y + ' 年 ' + mo + ' 月</span>' +
    '<span class="rf-cal-tot">' + total.toLocaleString('zh-TW') + '</span>' +
    (est ? '<span class="rf-cal-estflag">含預估</span>' : '') + '</div>' +
    '<div class="rf-cal-grid">' +
    W.map(function (w) { return '<div class="rf-cal-wd">' + w + '</div>'; }).join('');

  var cells = lead + dim, weeks = Math.ceil(cells / 7);
  for (var i = 0; i < weeks * 7; i++) {
    var d = i - lead + 1;
    if (d < 1 || d > dim) { h += '<div class="rf-cal-cell out"></div>'; continue; }
    var list = byDay[d] || [];
    var iso = ym + '-' + (d < 10 ? '0' : '') + d;
    var sum = list.reduce(function (a, r) { return a + (r.total || 0); }, 0);
    var paid = iso <= todayIso;
    var anyEst = list.some(function (r) { return r.status !== 'actual'; });
    var cls = 'rf-cal-cell' + (list.length ? (anyEst ? ' est' : ' act') : '') + (iso === todayIso ? ' today' : '');
    var tip = list.map(function (r) {
      return r.code + ' ' + (r.total || 0).toLocaleString('zh-TW') +
        (r.lentTotal ? '（直接 ' + ((r.total || 0) - r.lentTotal).toLocaleString('zh-TW') +
          ' ＋ 借券補償 ' + r.lentTotal.toLocaleString('zh-TW') + '）' : '') +
        (r.status === 'actual' ? '' : '（預估）');
    }).join('&#10;');
    h += '<div class="' + cls + '"' + (tip ? ' title="' + tip + '"' : '') + '>' +
      '<span class="rf-cal-d">' + d + '</span>' +
      (list.length
        ? '<span class="rf-cal-amt">' + sum.toLocaleString('zh-TW') + '</span>' +
          '<span class="rf-cal-code">' + list[0].code + (list.length > 1 ? ' +' + (list.length - 1) : '') + '</span>'
        : '') +
      '</div>';
  }
  return h + '</div></div>';
}

function rfPayCalHtml() {
  var todayIso = _divTwDate().iso, ym1 = todayIso.slice(0, 7), ym2 = _rfYmShift(ym1, 1);
  var r1 = _rfPayOfMonth(ym1), r2 = _rfPayOfMonth(ym2);
  if (!r1.length && !r2.length) return '';
  var sum = function (a) { return a.reduce(function (x, r) { return x + (r.total || 0); }, 0); };
  var t1 = sum(r1), t2 = sum(r2);
  // 標題用子標題而非 .divest-sec-title：後者會被左選單的分組器切成獨立區塊，
  // 但這張日曆是「本月發放」的一部分，要留在同一個區塊裡。
  return '<div class="rf-cal-title">發放日曆' +
      '<span class="divest-sec-sum">本月 ' + t1.toLocaleString('zh-TW') +
      '　下月 ' + t2.toLocaleString('zh-TW') + '</span></div>' +
    '<div class="rf-cal-wrap">' + _rfCalMonth(ym1, r1, todayIso) + _rfCalMonth(ym2, r2, todayIso) + '</div>' +
    '<div class="detail-note">依<b>發放日</b>排，金額為當日可領合計（含借券補償）。' +
      '滑鼠移到格子上看逐檔明細與補償拆分。實色＝已公告發放日，外框＝發放日為推估（除息月＋1）。' +
      '公告發放日落在非上班日時已<b>順延到下一個上班日</b>：實測 00981B 公告 10/17（週六）' +
      '實際 10/19 入帳、00988B 公告 10/10（週六）實際 10/12。' +
      '依行政院人事行政總處的辦公日曆表判斷，含國定假日、彈性放假與補班的星期六' +
      '（例 2026-10-09、10-26 都放假，只看星期幾會漏掉）。' +
      '日曆未涵蓋的年份退回只跳過週六日。' +
      '多檔同日時格子顯示第一檔加「+N」，整年只有四天是多檔同日。</div>';
}

function _rfMonthPayHtml() {
  var rows = _rfPay || [];
  var ymLabel = (_rfResult ? _rfResult.day : _divTwDate().iso).slice(0, 7).replace('-', '/');
  var title = function (sumHtml) {
    return '<div class="divest-sec-title">本月發放（' + ymLabel + '）' + (sumHtml || '') + '</div>';
  };
  if (!rows.length) return title() + '<div class="rf-cal-empty">本月無配息發放。</div>';

  // 合計擺在標頭後面，但要跑完整張表才算得出來 → 先把表存著，最後再組標頭
  var todayIso = _divTwDate().iso, total = 0;
  var h = '<div class="inv-table-wrap"><table class="inv-table swap-table rf-pay"><thead><tr>' +
    '<th>發放日</th><th>代號</th><th>名稱</th><th class="num">配息金額</th><th class="num">現價</th>' +
    '<th class="num" title="配息金額 ÷ 現價">月殖利率</th>' +
    '<th class="num" title="每股成本均價（券商庫存）">持有成本</th>' +
    '<th class="num" title="配息金額 ÷ 持有成本">成本月殖利率</th>' +
    '<th class="num">持有(張)</th><th class="num">可領金額</th></tr></thead><tbody>';
  rows.forEach(function (e) {
    var px = _swapPrice(e.code), cost = _swapCostPx(e.code);
    // 可領張數優先用估算算好的（除息日當時的持有量），沒有才退回目前持股
    var sh = (e.shares != null) ? e.shares : _swapHeld(e.code);
    var amt = e.amount;
    var yPx = (amt != null && px > 0) ? amt / px * 100 : null;
    var yCost = (amt != null && cost > 0) ? amt / cost * 100 : null;
    var get = (e.total != null) ? e.total : ((amt != null && sh) ? amt * sh : null);
    if (get != null) total += get;
    // 除息日借出中的部分由借券人另付權益補償、分開到帳（見 lent-log.js）→ 主列只放直接入帳，補償另起一列。合計不變。
    var lentSh = e.lentShares > 0 ? e.lentShares : 0;
    if (lentSh) { sh -= lentSh; get -= e.lentTotal; }
    var paid = e.payDate <= todayIso;
    h += '<tr>' +
      '<td class="rf-cal-date' + (paid ? ' rf-paid' : '') + '" title="' + (paid ? '已發放' : '待發放') +
        (e.derived ? '（發放日由除息月＋1 推導）' : '') + '">' + e.payDate + (e.derived ? ' *' : '') + '</td>' +
      '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + e.code + '\')">' + e.code + '</span></td>' +
      '<td class="inv-name">' + (_swapName(e.code) || '') + '</td>' +
      '<td class="num' + (amt == null ? ' swap-warn' : '') + '">' + (amt != null ? amt.toFixed(4) : '待公告') + '</td>' +
      '<td class="num">' + (px != null ? px.toFixed(2) : '—') + '</td>' +
      '<td class="num swap-yield">' + (yPx != null ? yPx.toFixed(2) + '%' : '—') + '</td>' +
      costCellHtml(cost, px) +
      '<td class="num swap-yield">' + (yCost != null ? yCost.toFixed(2) + '%' : '—') + '</td>' +
      '<td class="num"' + (e.partial ? ' title="除息日當天（含）之後買進的批次領不到；已賣出但除息時仍持有的照算"' : '') +
        '>' + _swapLots(sh) + (e.partial ? ' <span class="dexm-lent">(可領)</span>' : '') + '</td>' +
      '<td class="num">' + (get != null ? fmtMoney(get) : '—') + '</td>' +
    '</tr>';
    if (lentSh) {
      h += '<tr class="rf-pay-lent"><td class="rf-cal-date' + (paid ? ' rf-paid' : '') + '"></td>' +
        '<td colspan="7" title="' + ((typeof lentSrcText === 'function' && lentSrcText(e)) || '') + '">└ 借券補償</td>' +
        '<td class="num">' + _swapLots(lentSh) + '</td>' +
        '<td class="num">' + fmtMoney(e.lentTotal) + '</td></tr>';
    }
  });
  h += '</tbody></table></div>' +
    '<div class="rf-cal-note"><dl>' +
    '<dt>月殖利率</dt><dd><code>配息金額 ÷ 現價</code></dd>' +
    '<dt>成本月殖利率</dt><dd><code>配息金額 ÷ 持有成本</code>；月配標的即單月報酬率，年化約 ×12。</dd>' +
    '<dt>持有(張)</dt><dd>除息日當時可領的張數，不是目前持股：除息日當天（含）之後買進的領不到，' +
    '已賣出但除息時仍持有的照算。與月份總覽同一份計算，兩邊的本月合計相等。</dd>' +
    '<dt>借券補償</dt><dd>除息日借出中的張數，配息由借券人另付權益補償，與直接入帳分開到帳，故另列一行。' +
    '借出張數來源見參數設定「除息日借出張數」。</dd>' +
    '<dt>發放日標記</dt><dd>「*」＝尚未公告，以「除息月＋1」推導。日期較淡＝已發放。</dd>' +
    '</dl></div>';
  return title('<span class="divest-sec-sum">本月可領合計 <b>' + fmtMoney(total) + '</b>' +
    '<span class="swap-dim">（未扣二代健保與稅；「待公告」金額未計入）</span></span>') + h;
}

// 除息日曆：未來已公告的除息日；缺金額或發放日的列附手動補登輸入框（貼上整行自動解析）
function _rfCalHtml() {
  var cal = _rfCal || [];
  var h = '<div class="divest-sec-title">除息日曆（未來已公告）' +
    (_rfNote ? '<span class="rf-cmnote">' + _rfNote + '</span>' : '') + '</div>';
  if (!cal.length) {
    return h + '<div class="rf-cal-empty">目前無已公告的未來除息日（上市查 e添富、上櫃查 TPEx 預告表、金額另查 Yahoo）。</div>';
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
      '<td class="num' + (amt == null ? ' swap-warn' : '') + '">' + (amt != null ? amt.toFixed(4) : '待公告') +
        (e.diff ? '<span class="rf-cal-diff" title="' + e.diff.src + '先前為 ' + e.diff.amount.toFixed(4) +
          '，已改用官方公告值">≠</span>' : '') + '</td>' +
      '<td' + (e.payDate ? '' : ' class="swap-warn"') + '>' + (e.payDate || '待公告') + '</td>' +
      '<td class="num">' + _swapLots(sh) + '</td>' +
      '<td class="num">' + (get != null ? fmtMoney(get) : '—') + '</td>' +
      '<td class="rf-src">' + e.src + (e.manual ? '＋手動' : '') + '</td>' +
      '<td>' + (lack || e.manual
        ? '<input class="sbl-inp rf-man-inp" type="text" placeholder="貼上：0.153　2026/08/18　2026/09/09"' +
          ' title="從券商App或看盤網站複製整行貼上，自動解析股利/除息日/發放日；官方公告後會自動改用官方值。清空可移除" value="' +
          // 只顯示「除息日與本列相同」的補登：否則上個月的舊資料會殘留在框內，
          // 看起來像已填好卻不生效（合併時 exDate 對不上就不會採用）
          ((man[e.code] && man[e.code].exDate === e.exDate) ? _rfManStr(man[e.code]) : '') +
          '" onchange="rfManualInput(\'' + e.code + '\',this)">'
        : '') + '</td>' +
    '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="rf-cal-note"><dl>' +
    '<dt>預估可領</dt><dd><code>預估配息 × 持有股數</code>，未扣二代健保與稅。</dd>' +
    '<dt>除息日與發放日</dt><dd>上市＝e添富、上櫃＝TPEx 除權息預告表，每日更新一次。</dd>' +
    '<dt>金額</dt><dd>官方常只先申報日期、金額掛「待公告」，此時取 Yahoo 台股（每日），來源標「＋Yahoo預告」；' +
    '官方一公布即改用官方值。</dd>' +
    '<dt>核對</dt><dd>財經網站的金額通常比官方早。官方公告後一律改用官方值，' +
    '兩邊不同時在金額後標 <code>≠</code>，滑鼠移上去看原本是多少。</dd>' +
    '<dt>手動補登</dt><dd>三邊都還沒有才顯示「待公告」，可在該列貼上整行' +
    '（例 <code>0.153　2026/08/18　2026/09/09</code>）自動解析。官方公告後即被取代，清空輸入框可移除。</dd>' +
    '</dl></div>';
  return h;
}

// 該次除息的組成：公開資訊觀測站申報值，只列占比 > 0 的項目
var RF_SRC_LB = { d: '股利', i: '利息', cc: '權利金', c: '賣股價差', e: '平準金', o: '其他' };
var RF_SRC_REP = { d: 1, i: 1, cc: 1 };
function _rfSrcText(code, exDate) {
  if (typeof dmRecs !== 'function') return '—';
  var hit = null;
  (dmRecs(code, 24) || []).forEach(function (x) { if (x.ex === exDate) hit = x; });
  if (!hit || !hit.pct) return '<span class="flat">—</span>';
  var out = [];
  ['d', 'i', 'cc', 'c', 'e', 'o'].forEach(function (k) {
    var v = hit.pct[k] || 0;
    if (v <= 0) return;
    out.push('<span class="' + (RF_SRC_REP[k] ? 'rf-rep-on' : 'rf-rep-off') + '">' +
      RF_SRC_LB[k] + ' ' + v.toFixed(1) + '</span>');
  });
  return out.length ? out.join(' ') : '<span class="flat">—</span>';
}

function _rfDetailHtml(r) {
  var h = '<div class="rf-detail"><table class="inv-table swap-table"><thead><tr>' +
    '<th>除息日</th><th class="num">配息</th><th>來源</th><th class="num">基準價</th>' +
    '<th>填息日</th><th class="num">天數</th><th>狀態</th></tr></thead><tbody>';
  r.events.forEach(function (e) {
    h += '<tr>' +
      '<td>' + e.exDate + '</td>' +
      '<td class="num">' + e.amount.toFixed(3) + '</td>' +
      '<td class="rf-src">' + _rfSrcText(r.code, e.exDate) + '</td>' +
      '<td class="num">' + e.base.toFixed(2) + '</td>' +
      '<td>' + (e.filledDate || '—') + '</td>' +
      '<td class="num">' + (e.waiting ? '—' : e.days) + '</td>' +
      '<td class="' + (e.waiting ? 'flat' : (e.pending ? 'down' : 'up')) + '">' +
        (e.waiting ? '待收盤資料'
          : (e.pending ? '貼息中 ' + e.days + ' 天　距填息 ' + e.gapPct.toFixed(2) + '%　現價 ' + e.lastPx.toFixed(2) + '＜基準 ' + e.base.toFixed(2)
            : '已填息（' + e.days + ' 天）')) +
      '</td></tr>';
  });
  h += '</tbody></table></div>';
  return h;
}
