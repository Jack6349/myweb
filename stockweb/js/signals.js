// 股利總管 Web — 籌碼淨值評估（L2 淨值錨 + L3 籌碼行為）
// L2：TWSE 官方淨值/市價/折溢價%（?etfnav=；大幅折價=可能錯殺、大幅溢價=追價過熱）
// L3：T86 三大法人買賣（穿透成分股加權籌碼分數）＋ MI_MARGN 融資熱度 ＋ TDCC 大戶/散戶週變化
// 註：券商 App 的「診斷分數」為加值產品、不在 Shioaji API；此處為自算公開資料指標。

var SIG_GAS = NEWS_GAS_URL;
var SIG_T86_DAYS = 5;
var _sigRows = [];   // [{code,name,nav,chip,margin,tdcc}] 供 Prompt

// ═════ L2 官方淨值 ═════
var _sigNavMap = null, _sigNavDay = null;
function _sigToday() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
async function sigEnsureNavMap(force) {
  var today = _sigToday();
  if (!force && _sigNavMap && _sigNavDay === today && Object.keys(_sigNavMap).length) return _sigNavMap;
  var map = null;
  try {
    var r = await fetch(SIG_GAS + '?etfnav=1');
    var j = await r.json();
    if (j && j.stat === 'OK' && j.map && Object.keys(j.map).length) map = j.map;
  } catch (e) {}
  if (!map) { // 回退：直抓 all_etf.txt
    map = {};
    for (var a = 0; a < 4 && !Object.keys(map).length; a++) {
      try {
        var r2 = await fetch(SIG_GAS + '?url=' + encodeURIComponent('https://mis.twse.com.tw/stock/data/all_etf.txt'));
        var d2 = await r2.json();
        var insts = d2.a1 || (Array.isArray(d2) ? d2 : []);
        insts.forEach(function (inst) {
          (inst.msgArray || []).forEach(function (x) {
            if (!x.a) return;
            var nav = parseFloat(x.f), prem = parseFloat(x.g), price = parseFloat(x.e);
            if (!isNaN(nav) && nav > 0) map[String(x.a).toUpperCase()] = { nav: nav, premium: isNaN(prem) ? null : prem, price: isNaN(price) ? null : price, date: x.i };
          });
        });
      } catch (e) {}
      if (!Object.keys(map).length) await new Promise(function (rs) { setTimeout(rs, 500); });
    }
  }
  _sigNavMap = map || {}; _sigNavDay = today;
  return _sigNavMap;
}
function sigGetNav(code) { return (_sigNavMap && _sigNavMap[String(code).toUpperCase()]) || null; }

// ═════ L3-a T86 三大法人 ═════
function _sigNum(s) { return parseInt(String(s).replace(/,/g, ''), 10) || 0; }
function _sigTodayYmd() { var tw = new Date(Date.now() + 8 * 3600000); return tw.getUTCFullYear() * 10000 + (tw.getUTCMonth() + 1) * 100 + tw.getUTCDate(); }

async function sigFetchT86Day(ymd) {
  var key = 't86_v1_' + ymd;
  try { var c = localStorage.getItem(key); if (c === 'HOLIDAY') return null; if (c) return JSON.parse(c); } catch (e) {}
  var j = null;
  try { var r = await fetch('https://www.twse.com.tw/rwd/zh/fund/T86?date=' + ymd + '&selectType=ALLBUT0999&response=json'); j = await r.json(); } catch (e) { return null; }
  if (!j || j.stat !== 'OK' || !Array.isArray(j.data) || !j.data.length) {
    if (ymd < _sigTodayYmd()) { try { localStorage.setItem(key, 'HOLIDAY'); } catch (e) {} }
    return null;
  }
  var map = {};
  j.data.forEach(function (row) { map[String(row[0]).trim()] = [_sigNum(row[4]), _sigNum(row[10])]; });
  try { localStorage.setItem(key, JSON.stringify(map)); } catch (e) {}
  return map;
}
async function sigRecentT86(n) {
  var out = [], now = new Date(Date.now() + 8 * 3600000);
  for (var back = 0; back < 16 && out.length < n; back++) {
    var d = new Date(now.getTime() - back * 86400000), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    var ymd = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    var map = await sigFetchT86Day(ymd);
    if (map) out.push({ ymd: ymd, map: map });
  }
  return out;
}
function _sigStreak(vals) {
  if (!vals.length || vals[0] === 0) return 0;
  var dir = vals[0] > 0 ? 1 : -1, n = 0;
  for (var i = 0; i < vals.length; i++) { var v = vals[i]; if ((v > 0 ? 1 : v < 0 ? -1 : 0) !== dir) break; n++; }
  return dir * n;
}
function _sigClamp5(v) { return Math.max(-5, Math.min(5, v)); }
function sigComputeChipScore(holdings, t86days) {
  if (!t86days.length) return null;
  var wsum = 0, covered = 0, totalW = 0, rows = [];
  (holdings || []).forEach(function (h) {
    if (typeof h.weight !== 'number') return;
    totalW += h.weight;
    var code = String(h.code).trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) return;
    var series = t86days.map(function (d) { return d.map[code]; });
    if (series.every(function (s) { return !s; })) return;
    var fS = _sigStreak(series.map(function (s) { return s ? s[0] : 0; }));
    var tS = _sigStreak(series.map(function (s) { return s ? s[1] : 0; }));
    var sc = _sigClamp5(fS) + _sigClamp5(tS);
    wsum += h.weight * sc; covered += h.weight;
    rows.push({ code: code, name: h.name || '', weight: h.weight, f: fS, t: tS, impact: Math.abs(h.weight * sc) });
  });
  if (covered <= 0 || totalW <= 0 || covered / totalW < 0.3) return null;
  rows.sort(function (a, b) { return b.impact - a.impact; });
  return { score: wsum / covered, coveredPct: Math.round(covered / totalW * 100), days: t86days.length, contributors: rows.slice(0, 3) };
}

// ═════ L3-b 融資餘額 ═════
async function sigFetchMarginDay(ymd) {
  var key = 'mgn_v1_' + ymd;
  try { var c = localStorage.getItem(key); if (c === 'HOLIDAY') return null; if (c) return JSON.parse(c); } catch (e) {}
  var j = null;
  try { var r = await fetch('https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=' + ymd + '&selectType=ALL&response=json'); j = await r.json(); } catch (e) { return null; }
  var tb = j && j.stat === 'OK' && Array.isArray(j.tables) ? j.tables.find(function (t) { return t.fields && t.fields[0] === '代號' && Array.isArray(t.data) && t.data.length > 100; }) : null;
  if (!tb) { if (ymd < _sigTodayYmd()) { try { localStorage.setItem(key, 'HOLIDAY'); } catch (e) {} } return null; }
  var map = {};
  tb.data.forEach(function (row) { map[String(row[0]).trim()] = _sigNum(row[6]); });
  try { localStorage.setItem(key, JSON.stringify(map)); } catch (e) {}
  return map;
}
async function sigRecentMargin(n) {
  var out = [], now = new Date(Date.now() + 8 * 3600000);
  for (var back = 0; back < 16 && out.length < n; back++) {
    var d = new Date(now.getTime() - back * 86400000), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    var ymd = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    var map = await sigFetchMarginDay(ymd);
    if (map) out.push({ ymd: ymd, map: map });
  }
  return out;
}
// 回傳 {cur, chgPct, overheat}
function sigMargin(code, mgnDays) {
  if (!mgnDays.length) return null;
  var series = mgnDays.map(function (d) { return d.map[code]; });
  var cur = series[0];
  if (cur == null) return null;
  var oldest = null;
  for (var i = series.length - 1; i >= 1; i--) { if (series[i] != null) { oldest = series[i]; break; } }
  var chg = null, overheat = false;
  if (oldest != null && oldest >= 50) {
    chg = (cur - oldest) / oldest * 100;
    var nav = sigGetNav(code);
    overheat = chg >= 10 && nav && nav.premium != null && nav.premium > 0.3;
  }
  return { cur: cur, chgPct: chg, days: series.length, overheat: overheat };
}

// ═════ L3-c TDCC 大戶/散戶週報 ═════
var TDCC_HIST_KEY = 'tdcc_hist_v1', TDCC_KEEP = 26;
function _tdccHist() { try { return JSON.parse(localStorage.getItem(TDCC_HIST_KEY)) || {}; } catch (e) { return {}; } }
function _tdccSave(h) { try { localStorage.setItem(TDCC_HIST_KEY, JSON.stringify(h)); } catch (e) {} }
async function sigFetchTdcc(codes) {
  var r = await fetch(SIG_GAS + '?tdcc=' + encodeURIComponent(codes.join(',')));
  var j = await r.json();
  if (j.stat !== 'OK' || !j.rows) throw new Error(j.error || 'TDCC 查詢失敗');
  return j;
}

// ═════ L2b 隔夜美股預估開盤（純美股 ETF）＋ ADR 隔夜參考（台股 ETF）═════
// 台股→美股 ADR 對照（主要 NYSE/Nasdaq 掛牌者）
var TW_ADR = { '2330': 'TSM', '2303': 'UMC', '2412': 'CHT', '3711': 'ASX', '2409': 'AUO' };

function sigIsUsHolding(holdings) {
  var codes = (holdings || []).map(function (h) { return String(h.code || ''); });
  if (!codes.length) return false;
  return codes.filter(function (c) { return /\sUS$/i.test(c); }).length / codes.length >= 0.5;
}

async function sigUsPrices(syms) {
  if (!syms.length) return null;
  try { var r = await fetch(SIG_GAS + '?usprices=' + encodeURIComponent(syms.join(','))); var j = await r.json();
    if (j.stat === 'OK') return { prices: j.prices || {}, fx: j.fx || null }; } catch (e) {}
  return null;
}

// 純美股 ETF：隔夜成分股漲跌 × 權重 × 匯率 → 預估今日開盤淨值漲跌%
async function sigEstNavUS(holdings) {
  var syms = Array.from(new Set((holdings || []).map(function (h) { return String(h.code).replace(/\s*US$/i, '').trim(); }).filter(Boolean)));
  var pd = await sigUsPrices(syms);
  if (!pd) return null;
  var fxR = (pd.fx && pd.fx.changePct != null) ? pd.fx.changePct / 100 : 0;
  var wret = 0, covered = 0;
  (holdings || []).forEach(function (h) {
    if (typeof h.weight !== 'number') return;
    var sym = String(h.code).replace(/\s*US$/i, '').trim();
    var p = pd.prices[sym];
    if (p && p.changePct != null) { var usdR = p.changePct / 100; wret += (h.weight / 100) * ((1 + usdR) * (1 + fxR) - 1); covered += h.weight; }
  });
  if (covered < 15) return null;
  return { estChangePct: wret * 100, coveredPct: Math.round(covered), fxPct: fxR * 100 };
}

// 台股 ETF：成分股中有美股 ADR 者，取 ADR 隔夜漲跌加權 → 開盤前偏向
async function sigAdrBias(holdings) {
  var list = [];
  (holdings || []).forEach(function (h) {
    if (typeof h.weight !== 'number') return;
    var code = String(h.code).trim();
    var sym = TW_ADR[code] || TW_ADR[code.replace(/[A-Z]$/, '')];
    if (sym) list.push({ code: code, sym: sym, name: h.name || '', weight: h.weight });
  });
  if (!list.length) return null;
  var res = await Promise.all(list.map(async function (a) {
    var closes = (typeof fetchDailyCloses === 'function') ? await fetchDailyCloses(a.sym) : null;
    if (!closes || closes.length < 2) return null;
    var last = closes[closes.length - 1], prev = closes[closes.length - 2];
    if (!prev) return null;
    return { sym: a.sym, code: a.code, name: a.name, weight: a.weight, chgPct: (last - prev) / prev * 100 };
  }));
  var valid = res.filter(Boolean);
  if (!valid.length) return null;
  var wsum = 0, wtot = 0;
  valid.forEach(function (v) { wsum += v.weight * v.chgPct; wtot += v.weight; });
  return { bias: wsum / wtot, coveredPct: Math.round(wtot), items: valid.sort(function (a, b) { return b.weight - a.weight; }).slice(0, 3) };
}

// ═════ 主流程 ═════
async function startSignals() {
  var errEl = document.getElementById('sig-error');
  var wrap = document.getElementById('sig-wrap');
  var info = document.getElementById('sig-info');
  errEl.style.display = 'none';
  wrap.innerHTML = '<div class="modal-loading">載入官方淨值、法人籌碼、集保週報…</div>';

  // 持股中的 ETF
  var held = [];
  try {
    var positions = (_positions && _positions.length) ? _positions : await fetchBrokerPositions();
    var names = {};
    try { (await loadPortfolioFallback()).forEach(function (s) { if (s.name) names[String(s.code)] = s.name; }); } catch (e) {}
    held = (positions || []).map(function (p) { return { code: String(p.code).toUpperCase(), name: (_contracts[String(p.code)] && _contracts[String(p.code)].name) || names[String(p.code)] || '' }; })
      .filter(function (h) { return /^00/.test(h.code); });
  } catch (e) { errEl.style.display = 'block'; errEl.textContent = '讀不到持股：' + e.message; wrap.innerHTML = ''; return; }
  if (!held.length) { wrap.innerHTML = '<div class="modal-loading">持股中無 ETF</div>'; return; }

  await sigEnsureNavMap();
  var t86days = [], mgnDays = [];
  try { t86days = await sigRecentT86(SIG_T86_DAYS); } catch (e) {}
  try { mgnDays = await sigRecentMargin(SIG_T86_DAYS); } catch (e) {}

  // TDCC 週快照（距上次≥6天才重抓）
  var hist = _tdccHist();
  var latest = ''; Object.keys(hist).forEach(function (c) { Object.keys(hist[c] || {}).forEach(function (d) { if (d > latest) latest = d; }); });
  var now = new Date(Date.now() + 8 * 3600000);
  var todayD = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86400000;
  var latestD = latest ? Date.UTC(+latest.slice(0, 4), +latest.slice(4, 6) - 1, +latest.slice(6, 8)) / 86400000 : 0;
  var codes = held.map(function (h) { return h.code; });
  var stale = !latest || (todayD - latestD) >= 6 || codes.some(function (c) { return !(hist[c] && hist[c][latest]); });
  if (stale) {
    try {
      var snap = await sigFetchTdcc(codes);
      codes.forEach(function (c) {
        var row = snap.rows[c]; if (!row) return;
        if (!hist[c]) hist[c] = {};
        hist[c][snap.date] = row;
        var ds = Object.keys(hist[c]).sort(); while (ds.length > TDCC_KEEP) delete hist[c][ds.shift()];
      });
      _tdccSave(hist);
    } catch (e) {}
  }

  info.textContent = '近 ' + (t86days.length || 0) + ' 交易日法人｜官方淨值 ' + (_sigNavMap && Object.keys(_sigNavMap).length ? '已載入' : 'N/A');

  // 逐檔並行算成分股籌碼
  _sigRows = [];
  var cards = await Promise.all(held.map(async function (h) {
    var nav = sigGetNav(h.code);
    var mgn = sigMargin(h.code, mgnDays);
    var chip = null, overnight = null, adr = null;
    try {
      var data = await fetchEtfConstituents(h.code);
      chip = sigComputeChipScore(data.holdings, t86days);
      if (sigIsUsHolding(data.holdings)) overnight = await sigEstNavUS(data.holdings);
      else adr = await sigAdrBias(data.holdings);
    } catch (e) {}
    var rec = hist[h.code] || {}; var ds = Object.keys(rec).sort().reverse();
    var tdcc = ds.length ? { cur: rec[ds[0]], prev: ds.length > 1 ? rec[ds[1]] : null, date: ds[0], prevDate: ds[1] } : null;
    _sigRows.push({ code: h.code, name: h.name, nav: nav, chip: chip, margin: mgn, tdcc: tdcc, overnight: overnight, adr: adr });
    return sigCardHtml(h, nav, chip, mgn, tdcc, overnight, adr);
  }));
  wrap.innerHTML = cards.join('') +
    '<div class="sig-note">隔夜美股：純美股 ETF 以成分股隔夜漲跌×匯率推估今日開盤方向（前晚美股大跌通常隔日必跌）。' +
    'ADR 隔夜：台股成分股在美股掛牌的 ADR 隔夜漲跌，與台股高連動，可作開盤前參考。' +
    'L2 折溢價：大幅折價(市價<淨值)＝可能被錯殺、加碼機會；大幅溢價＝追價過熱。' +
    'L3 籌碼分數＝Σ成分股權重×(外資連買賣天數＋投信連買賣天數，各±5)，範圍±10，正(紅)偏多。' +
    '融資5日增≥10%且溢價→⚠️過熱。TDCC 千張大戶比升＝籌碼向大戶集中(偏多)、散戶比升＝轉散(警訊)。' +
    '僅涵蓋上市成分股，美股/債券型 ETF 籌碼不適用。</div>';
}

function _sigPct(v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp == null ? 2 : dp) + '%'; }
function _sigCls(v, th) { th = th || 0; return v == null ? 'flat' : (v > th ? 'up' : (v < -th ? 'down' : 'flat')); }
function _sigStreakLabel(n, who) { return n === 0 ? who + '觀望' : who + (n > 0 ? '連買' : '連賣') + Math.abs(n) + '日'; }
function _fmtUnits(v) { return v >= 1e8 ? (v / 1e8).toFixed(2) + '億' : (v / 1e4).toFixed(1) + '萬'; }
function _tdRow(label, cur, prev, kind) {
  var curTxt, dTxt = '—', dcls = 'flat';
  if (kind === 'pp') { curTxt = cur.toFixed(2) + '%'; if (prev != null) { var d = cur - prev; dcls = _sigCls(d, 0.005); dTxt = Math.abs(d) < 0.005 ? '持平' : (d > 0 ? '▲' : '▼') + Math.abs(d).toFixed(2) + 'pp'; } }
  else if (kind === 'units') { curTxt = _fmtUnits(cur); if (prev != null) { var d2 = cur - prev; dcls = _sigCls(d2, 0.5); dTxt = Math.abs(d2) < 0.5 ? '持平' : (d2 > 0 ? '▲' : '▼') + _fmtUnits(Math.abs(d2)); } }
  else { curTxt = cur.toLocaleString('zh-TW'); if (prev != null) { var d3 = cur - prev; dcls = _sigCls(d3, 0.5); dTxt = Math.abs(d3) < 0.5 ? '持平' : (d3 > 0 ? '▲' : '▼') + Math.abs(d3).toLocaleString('zh-TW'); } }
  return '<div class="sig-tdrow"><span>' + label + '</span><span class="sig-tdcur">' + curTxt + '</span><span class="' + dcls + '">' + dTxt + '</span></div>';
}

function sigCardHtml(h, nav, chip, mgn, tdcc, overnight, adr) {
  // L2b 隔夜美股預估開盤 / ADR 隔夜參考
  var onHtml = '';
  if (overnight) {
    var ocls = _sigCls(overnight.estChangePct, 0);
    onHtml = '<div class="sig-sec"><span class="sig-label">隔夜美股</span>' +
      '<span>預估開盤 <b class="' + ocls + '">' + _sigPct(overnight.estChangePct) + '</b>' +
      '<span class="sig-sub">成分覆蓋 ' + overnight.coveredPct + '%｜含匯率 ' + _sigPct(overnight.fxPct) + '</span></span></div>';
  } else if (adr) {
    var acls = _sigCls(adr.bias, 0);
    var items = adr.items.map(function (it) { return it.sym + ' ' + _sigPct(it.chgPct); }).join('、');
    onHtml = '<div class="sig-sec"><span class="sig-label">ADR 隔夜</span>' +
      '<span>偏向 <b class="' + acls + '">' + _sigPct(adr.bias) + '</b>' +
      '<span class="sig-sub">涵蓋權重 ' + adr.coveredPct + '%：' + items + '</span></span></div>';
  }
  // L2
  var navHtml;
  if (nav && nav.premium != null) {
    var pcls = nav.premium < 0 ? 'down' : (nav.premium > 0 ? 'up' : 'flat');
    var tag = nav.premium <= -1 ? '折價（可能錯殺）' : (nav.premium >= 1 ? '溢價（追價過熱）' : '折溢價正常');
    navHtml = '<div class="sig-sec"><span class="sig-label">L2 淨值錨</span>' +
      '<span>淨值 ' + nav.nav.toFixed(2) + '｜市價 ' + (nav.price != null ? nav.price.toFixed(2) : '—') +
      '｜折溢價 <b class="' + pcls + '">' + _sigPct(nav.premium) + '</b>（' + tag + '）</span></div>';
  } else {
    navHtml = '<div class="sig-sec"><span class="sig-label">L2 淨值錨</span><span class="flat">官方淨值查無（主動式/上櫃可能不在列）</span></div>';
  }
  // L3 chip
  var chipHtml;
  if (chip) {
    var sc = chip.score, ccls = _sigCls(sc, 0.5);
    var ctag = sc > 2 ? '偏多' : (sc < -2 ? '偏空' : '中性');
    var contrib = chip.contributors.map(function (c) {
      return '<div class="sig-contrib"><span>' + c.code + ' ' + c.name + '（' + c.weight.toFixed(1) + '%）</span>' +
        '<span><span class="' + _sigCls(c.f, 0) + '">' + _sigStreakLabel(c.f, '外') + '</span> ' +
        '<span class="' + _sigCls(c.t, 0) + '">' + _sigStreakLabel(c.t, '投') + '</span></span></div>';
    }).join('');
    var lowCov = chip.coveredPct < 60;
    chipHtml = '<div class="sig-sec"><span class="sig-label">L3 法人籌碼</span>' +
      '<span class="sig-score ' + ccls + '">' + (sc > 0 ? '+' : '') + sc.toFixed(1) + ' ' + ctag +
      '<span class="sig-sub' + (lowCov ? ' sig-warn' : '') + '">覆蓋 ' + chip.coveredPct + '%' +
      (lowCov ? ' ⚠️僅代表台股部位' : '') + '｜近' + chip.days + '日</span></span></div>' + contrib;
  } else {
    chipHtml = '<div class="sig-sec"><span class="sig-label">L3 法人籌碼</span><span class="flat">成分股籌碼不適用（美股/債券成分）</span></div>';
  }
  // margin
  var mgnHtml = '';
  if (mgn) {
    var mcls = mgn.chgPct == null ? 'flat' : _sigCls(mgn.chgPct, 0);
    mgnHtml = '<div class="sig-tdrow"><span>融資餘額(散戶)</span><span class="sig-tdcur">' + mgn.cur.toLocaleString('zh-TW') + ' 張</span>' +
      '<span class="' + mcls + '">' + (mgn.chgPct == null ? '—' : mgn.days + '日' + _sigPct(mgn.chgPct, 1)) +
      (mgn.overheat ? ' <span class="sig-warn" title="融資5日增逾10%且溢價，追價買貴風險">⚠️過熱</span>' : '') + '</span></div>';
  }
  // TDCC
  var tdccHtml = '';
  if (tdcc && tdcc.cur) {
    var cu = tdcc.cur, pv = tdcc.prev;
    tdccHtml = '<div class="sig-sec"><span class="sig-label">L3 集保大戶</span>' +
      '<span class="sig-sub">資料日 ' + tdcc.date.slice(4, 6) + '/' + tdcc.date.slice(6, 8) + (pv ? '｜vs ' + tdcc.prevDate.slice(4, 6) + '/' + tdcc.prevDate.slice(6, 8) : '（首週）') + '</span></div>' +
      _tdRow('受益人數', cu.people, pv && pv.people, 'int') +
      _tdRow('千張大戶比', cu.big1000, pv && pv.big1000, 'pp') +
      _tdRow('散戶比(≤10張)', cu.retail, pv && pv.retail, 'pp');
  }

  return '<div class="sig-card"><div class="sig-head"><span class="sig-code">' + h.code + '</span>' +
    '<span class="sig-name">' + (h.name || '') + '</span></div>' +
    onHtml + navHtml + chipHtml + mgnHtml + tdccHtml + '</div>';
}

// ═════ 供 AI Prompt 併入 ═════
async function ensureSignals() {
  if (_sigRows.length) return;
  // 靜默：只算 L2 折溢價 + L3 法人分數（TDCC/融資略，避免過慢）
  try {
    var positions = (_positions && _positions.length) ? _positions : await fetchBrokerPositions();
    var held = (positions || []).map(function (p) { return String(p.code).toUpperCase(); }).filter(function (c) { return /^00/.test(c); });
    await sigEnsureNavMap();
    var t86days = await sigRecentT86(SIG_T86_DAYS);
    _sigRows = await Promise.all(held.map(async function (code) {
      var nav = sigGetNav(code), chip = null, overnight = null, adr = null;
      try {
        var data = await fetchEtfConstituents(code);
        chip = sigComputeChipScore(data.holdings, t86days);
        if (sigIsUsHolding(data.holdings)) overnight = await sigEstNavUS(data.holdings);
        else adr = await sigAdrBias(data.holdings);
      } catch (e) {}
      return { code: code, name: (_contracts[code] && _contracts[code].name) || '', nav: nav, chip: chip, overnight: overnight, adr: adr };
    }));
  } catch (e) {}
}
function signalsSummaryForPrompt() {
  if (!_sigRows.length) return '';
  return _sigRows.map(function (r) {
    var parts = [];
    if (r.overnight) parts.push('隔夜美股預估開盤' + _sigPct(r.overnight.estChangePct) + '(覆蓋' + r.overnight.coveredPct + '%)');
    else if (r.adr) parts.push('ADR隔夜偏向' + _sigPct(r.adr.bias) + '(涵蓋權重' + r.adr.coveredPct + '%)');
    if (r.nav && r.nav.premium != null) parts.push('折溢價' + _sigPct(r.nav.premium) + (r.nav.premium <= -1 ? '(折價/可能錯殺)' : r.nav.premium >= 1 ? '(溢價/過熱)' : ''));
    else parts.push('淨值N/A');
    if (r.chip) {
      var conf = r.chip.coveredPct >= 60 ? '' : (r.chip.coveredPct >= 30 ? '，低覆蓋僅供參考' : '');
      parts.push('法人籌碼' + (r.chip.score > 0 ? '+' : '') + r.chip.score.toFixed(1) +
        (r.chip.score > 2 ? '(偏多)' : r.chip.score < -2 ? '(偏空)' : '') +
        '〔覆蓋' + r.chip.coveredPct + '%' + conf + '〕');
    } else parts.push('籌碼不適用(外資/債券成分)');
    return '- ' + r.code + ' ' + (r.name || '') + '：' + parts.join('，');
  }).join('\n');
}
