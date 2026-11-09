// 股利總管 Web — 跌深訊號板
//
// 這一頁回答一件事：大盤跌深之後，手上的主動式 ETF 歷史上接下來會不會彈、機率多少。
// 不回答停利（那在停損停利頁，門檻一到就提醒），也不回答成交機率（那在即時持股頁的掛單參考）。
//
// 為什麼要分「系統性」：使用者只在非系統性下跌時進場。戰爭、政事、金融事件造成的跌深，
// 下跌沒有底，歷史反彈統計不適用。程式無法自動判定事件性質，所以改成手動標記，
// 預設不標（＝非系統性），標過的事件從統計裡排掉。
//
// 樣本的誠實話：觸發日彼此重疊（同一段修正會連續觸發好幾天），所以「觸發日數」會灌水。
// 真正獨立的是「事件數」（連續觸發算一段），表上兩個都列，不只列大的那個。
//
// 報酬用還原收盤（adjclose）：這幾檔有配息，期間跨過除息日的話未還原收盤會低估反彈幅度。

var RB_SYS_LS = 'rebound_sys_v1';      // 手動標記為系統性的事件（鍵＝事件起始日）
var RB_VIEW_LS = 'rebound_view_v1';    // 決策／分析視圖

// ── 參數（參數設定頁可調；全部有預設值，壞值一律退回預設）──
function _rbCfg() {
  var n = parseInt(localStorage.getItem('rb_look'), 10);
  var d = parseFloat(localStorage.getItem('rb_drop'));
  var y = parseInt(localStorage.getItem('rb_years'), 10);
  var holds = String(localStorage.getItem('rb_holds') || '5,10,20').split(',')
    .map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return x > 0 && x <= 120; })
    .sort(function (a, b) { return a - b; });
  if (!holds.length) holds = [5, 10, 20];
  return {
    look: (isNaN(n) || n < 1 || n > 60) ? 5 : n,
    drop: (isNaN(d) || d <= 0 || d > 50) ? 5 : d,
    years: (isNaN(y) || y < 1 || y > 10) ? 2 : y,
    holds: holds.slice(0, 5)
  };
}
function rbCfgStatus() {
  var c = _rbCfg();
  return c.look + ' 日累計跌 ≥ ' + c.drop + '%｜持有 ' + c.holds.join('/') + ' 日｜歷史 ' + c.years + ' 年';
}

// ── 手動標記：Firestore stock_prefs/{uid}.reboundSys，未登入或失敗退回 localStorage ──
// 這份是手動累積的判斷，掉了就要重新回想每一段修正的性質，所以跟認購成本補正一樣上雲。
var _rbMarks = null, _rbMLoaded = false, _rbMStore = 'local';
function _rbLocalMarks() { try { return JSON.parse(localStorage.getItem(RB_SYS_LS) || 'null'); } catch (e) { return null; } }
function _rbRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _rbCloud() { return !!(window.FB && window.OWNER_UID); }

async function rbMarksLoad(force) {
  if (_rbMLoaded && !force) return _rbMarks;
  var local = _rbLocalMarks();
  _rbMarks = local || {}; _rbMStore = 'local';
  if (_rbCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_rbRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var remote = (snap.exists() && snap.data().reboundSys) || null;
      if (remote) {
        _rbMarks = remote; _rbMStore = 'firestore';
        if (local) { try { localStorage.removeItem(RB_SYS_LS); } catch (e) {} }
      } else if (local && Object.keys(local).length) {
        await window.FB.setDoc(_rbRef(), { reboundSys: local, reboundUpdatedAt: new Date().toISOString() }, { merge: true });
        _rbMStore = 'firestore';
        try { localStorage.removeItem(RB_SYS_LS); } catch (e) {}
      }
    } catch (e) { hush('rebound', e); }
  }
  _rbMLoaded = true;
  return _rbMarks;
}
async function _rbMarksSave() {
  if (_rbCloud()) {
    try {
      await window.FB.setDoc(_rbRef(), { reboundSys: _rbMarks, reboundUpdatedAt: new Date().toISOString() }, { merge: true });
      _rbMStore = 'firestore';
      return;
    } catch (e) { hush('rebound', e, 1); }
  }
  try { localStorage.setItem(RB_SYS_LS, JSON.stringify(_rbMarks)); _rbMStore = 'local'; }
  catch (e) { hush('rebound', e, 1); }
}
window.addEventListener('owner-ready', function () { _rbMLoaded = false; });

// 勾選＝「這一段是系統性事件」，取消＝非系統性。改完就地重算，不重抓行情。
async function rbMarkToggle(date, on) {
  await rbMarksLoad();
  if (on) _rbMarks[date] = 1; else delete _rbMarks[date];
  await _rbMarksSave();
  rbRender();
}

// ── 日線（Yahoo，經 GAS 代理；還原收盤優先）──
var _rbBars = {};
async function _rbSeries(sym, years) {
  var key = sym + '|' + years;
  if (_rbBars[key]) return _rbBars[key];
  var syms = /^\d/.test(String(sym)) ? [sym + '.TW', sym + '.TWO'] : [sym];
  var out = [];
  for (var i = 0; i < syms.length && !out.length; i++) {
    try {
      var j = await _esVia('https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(syms[i]) + '?interval=1d&range=' + years + 'y', 40000);
      var res = j && j.chart && j.chart.result && j.chart.result[0];
      var ts = (res && res.timestamp) || [];
      var cl = (res && res.indicators && res.indicators.quote[0].close) || [];
      var acl = ((res && res.indicators && res.indicators.adjclose && res.indicators.adjclose[0]) || {}).adjclose || null;
      for (var k = 0; k < ts.length; k++) {
        if (cl[k] == null) continue;
        out.push({
          d: new Date(ts[k] * 1000 + 8 * 3600000).toISOString().slice(0, 10),
          c: cl[k], a: (acl && acl[k] != null) ? acl[k] : cl[k]
        });
      }
    } catch (e) { hush('rebound', e); }
  }
  out.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
  if (out.length) _rbBars[key] = out;
  return out;
}

// ── 觸發判定：第 i 天的「前 look 個交易日累計報酬」≤ −drop ──
// 大盤用未還原收盤（指數沒有配息還原的問題），個股報酬用還原收盤。
function _rbTriggers(idx, cfg) {
  var days = [], cum = {};
  for (var i = cfg.look; i < idx.length; i++) {
    var r = (idx[i].c / idx[i - cfg.look].c - 1) * 100;
    cum[idx[i].d] = r;
    if (r <= -cfg.drop) days.push(i);
  }
  // 連續觸發（序列上相鄰）歸成一段事件
  var eps = [];
  for (var k = 0; k < days.length; k++) {
    if (k && days[k] === days[k - 1] + 1) {
      var e = eps[eps.length - 1];
      e.end = idx[days[k]].d; e.n++;
      if (cum[e.end] < e.worst) e.worst = cum[e.end];
    } else {
      eps.push({ start: idx[days[k]].d, end: idx[days[k]].d, n: 1, worst: cum[idx[days[k]].d] });
    }
  }
  // 每個觸發日歸屬到它所在事件的起始日（標記以事件為單位，不是逐日標）
  var own = {};
  eps.forEach(function (e) {
    days.forEach(function (i2) {
      var d2 = idx[i2].d;
      if (d2 >= e.start && d2 <= e.end) own[d2] = e.start;
    });
  });
  return { days: days.map(function (i3) { return idx[i3].d; }), eps: eps, own: own, cum: cum };
}

function _rbMed(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 給定觸發日清單與持有天數，算這一檔的前瞻報酬分布。
// 還沒走滿 h 個交易日的觸發日（含正在進行中的那一段）自動排除，不補半套。
// 事件數要逐檔算、不能用全域的那個：各檔成立日不同（最早 2024 年），
// 加上最後一段還沒走滿 h 天，實際用到的事件比觸發事件總數少。
function _rbFwd(bars, dates, h) {
  var pos = {};
  bars.forEach(function (b, i) { pos[b.d] = i; });
  var own = (_rbData && _rbData.trig.own) || {};
  var rs = [], eps = {};
  dates.forEach(function (d) {
    var i = pos[d];
    if (i == null || i + h >= bars.length) return;
    if (!(bars[i].a > 0)) return;
    rs.push((bars[i + h].a / bars[i].a - 1) * 100);
    eps[own[d] || d] = 1;
  });
  if (!rs.length) return null;
  var up = rs.filter(function (r) { return r > 0; }).length;
  var sum = rs.reduce(function (a, b) { return a + b; }, 0);
  return {
    n: rs.length, eps: Object.keys(eps).length, up: up / rs.length * 100, avg: sum / rs.length,
    med: _rbMed(rs), min: Math.min.apply(null, rs), max: Math.max.apply(null, rs)
  };
}

// ── 標的：持股中代號結尾為 A 的（category.js：A＝主動股票型）──
// 不用名稱判斷，因為合約名稱要等行情載入；主動債券型（結尾 D）不列，
// 跌深反彈講的是股票型的回彈，債券型的價格動因是殖利率不是這個。
function _rbCodes() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return Object.keys(m).filter(function (c) { return m[c] > 0 && /A$/.test(c); }).sort();
}
function _rbName(c) {
  return (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || '';
}

// ══════════ 載入 ══════════
var _rbData = null;

async function startRebound(force) {
  var wrap = document.getElementById('rebound-wrap');
  var info = document.getElementById('rebound-info');
  if (!wrap) return;
  if (_rbData && !force) { rbRender(); return; }
  wrap.innerHTML = '<div class="modal-loading">抓取大盤與各檔日線…</div>';

  if (typeof ensureFeed === 'function' && !Object.keys((typeof _sharesMap !== 'undefined' && _sharesMap) || {}).length) {
    try { await ensureFeed(function (m) { if (info) info.textContent = m; }); } catch (e) { hush('rebound', e); }
  }
  await rbMarksLoad(force);

  var cfg = _rbCfg(), codes = _rbCodes();
  if (!codes.length) {
    _rbData = null;
    wrap.innerHTML = '<div class="modal-loading">持股中沒有主動式股票型 ETF（代號結尾 A），這一頁沒有標的可統計</div>';
    return;
  }
  if (force) _rbBars = {};

  var idx = await _rbSeries('^TWII', cfg.years);
  if (idx.length < cfg.look + 30) {
    _rbData = null;
    wrap.innerHTML = '<div class="modal-loading">大盤日線取不到（代理服務無回應），無法判定訊號。'
      + '<button class="btn-query" onclick="startRebound(true)">重試</button></div>';
    return;
  }
  var series = {};
  for (var i = 0; i < codes.length; i++) {
    if (info) info.textContent = '抓取 ' + codes[i] + ' 日線…（' + (i + 1) + '/' + codes.length + '）';
    series[codes[i]] = await _rbSeries(codes[i], cfg.years);
  }
  _rbData = { cfg: cfg, codes: codes, idx: idx, series: series, trig: _rbTriggers(idx, cfg) };
  if (info) info.textContent = '資料日 ' + idx[idx.length - 1].d + '（Yahoo 日線，' + cfg.years + ' 年）';
  rbRender();
}

function rbView(v) {
  try { localStorage.setItem(RB_VIEW_LS, v); } catch (e) {}
  rbRender();
}
function _rbViewSel() {
  try { if (localStorage.getItem(RB_VIEW_LS) === 'ana') return 'ana'; } catch (e) {}
  return 'dec';
}

function _rbPct(v, d) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d == null ? 1 : d) + '%';
}
function _rbCol(v) { return v == null ? 'var(--text3)' : (v > 0 ? 'var(--up)' : (v < 0 ? 'var(--down)' : 'var(--text)')); }

// 排除（或只取）標記為系統性的事件之後，剩下的觸發日
function _rbUsableDates(sysOnly) {
  var t = _rbData.trig, marks = _rbMarks || {};
  return t.days.filter(function (d) {
    var isSys = !!marks[t.own[d]];
    return sysOnly ? isSys : !isSys;
  });
}

// ══════════ 畫面 ══════════
function rbRender() {
  var wrap = document.getElementById('rebound-wrap');
  if (!wrap || !_rbData) return;
  var cfg = _rbData.cfg, idx = _rbData.idx, t = _rbData.trig, marks = _rbMarks || {};
  var last = idx[idx.length - 1], lastCum = t.cum[last.d];
  var lastEp = t.eps.length ? t.eps[t.eps.length - 1] : null;
  // 正在觸發中＝最後一筆資料日本身就是觸發日
  var live = !!(lastEp && lastEp.end === last.d);
  var liveSys = live && !!marks[lastEp.start];

  var view = _rbViewSel();
  var html = '<div class="pv-tabs rb-tabs">' +
    '<button class="pv-tab' + (view === 'dec' ? ' on' : '') + '" onclick="rbView(\'dec\')">決策</button>' +
    '<button class="pv-tab' + (view === 'ana' ? ' on' : '') + '" onclick="rbView(\'ana\')">分析</button>' +
    '</div>';

  // ── 判定卡（兩個視圖都在最上面）──
  var lamp, lcol, ltxt;
  if (!live) { lamp = '🟢'; lcol = 'var(--down)'; ltxt = '沒有跌深訊號'; }
  else if (liveSys) { lamp = '🔴'; lcol = 'var(--up)'; ltxt = '觸發中，但已標為系統性事件'; }
  else { lamp = '🟡'; lcol = 'var(--accent2)'; ltxt = '跌深訊號觸發中'; }

  var sub;
  if (live) {
    sub = '大盤 ' + cfg.look + ' 日累計 <b style="color:var(--down)">' + _rbPct(lastCum, 2) + '</b>'
      + '，已達門檻 −' + cfg.drop + '%。這一段從 ' + lastEp.start + ' 起算，連續第 ' + lastEp.n + ' 個交易日觸發，'
      + '段內最深 ' + _rbPct(lastEp.worst, 2) + '。';
    sub += liveSys
      ? '<br>標為系統性＝下方歷史統計不適用，那些數字是從非系統性修正算出來的。'
      : '<br>未標為系統性 → 下方統計適用。若這一段是戰爭、政事或金融事件造成的，勾起來把它從統計裡排掉。';
  } else {
    sub = '大盤 ' + cfg.look + ' 日累計 ' + _rbPct(lastCum, 2) + '，離 −' + cfg.drop + '% 門檻還有 '
      + Math.abs(cfg.drop + (lastCum == null ? 0 : lastCum)).toFixed(2) + ' 個百分點。'
      + (lastEp ? '上一次觸發是 ' + lastEp.start + ' ～ ' + lastEp.end + '。' : '');
  }

  html += '<div class="rs-verdict rb-verdict" style="border-color:' + lcol + '">' +
    '<div class="rb-lamp">' + lamp + '</div>' +
    '<div class="rs-verdict-txt"><div class="rs-vlabel">現在狀態</div>' +
    '<div style="color:' + lcol + ';font-weight:700;font-size:15px">' + ltxt + '</div>' +
    '<div class="rb-sub">' + sub + '</div>' +
    '</div></div>';

  if (live) {
    html += '<label class="rb-sysbox' + (liveSys ? ' on' : '') + '">' +
      '<input type="checkbox"' + (liveSys ? ' checked' : '') +
      ' onchange="rbMarkToggle(\'' + lastEp.start + '\', this.checked)">' +
      '<span>這一段（' + lastEp.start + ' 起）是系統性事件：戰爭、政事、金融事件</span></label>';
  }

  var dates = _rbUsableDates(false);
  var sysEps = t.eps.filter(function (e) { return !!marks[e.start]; }).length;
  var usableEps = t.eps.length - sysEps;

  html += (view === 'ana') ? _rbAnaHtml(dates, usableEps, sysEps) : _rbDecHtml(dates, usableEps, sysEps);
  wrap.innerHTML = html;
}

// 各檔實際可用歷史：主動式 ETF 多半 2025 下半年到 2026 年才上市，
// 「歷史 2 年」是抓取區間、不是各檔真的有 2 年資料，這一行把差距講出來。
function _rbHistLine() {
  var rows = _rbData.codes.map(function (c) {
    var b = _rbData.series[c] || [];
    return b.length ? { c: c, d: b[0].d, n: b.length } : null;
  }).filter(Boolean).sort(function (a, b) { return a.n - b.n; });
  if (!rows.length) return '無資料';
  var lo = rows[0], hi = rows[rows.length - 1];
  return '最短 ' + lo.c + ' 自 ' + lo.d + '（' + lo.n + ' 個交易日）、最長 ' + hi.c + ' 自 ' + hi.d
    + '（' + hi.n + ' 個交易日）';
}

// ── 決策視圖：結論先行。只有最長持有期的勝率、中位數、最差，依中位數排序。──
function _rbDecHtml(dates, usableEps, sysEps) {
  var cfg = _rbData.cfg, h = cfg.holds[cfg.holds.length - 1];
  var rows = _rbData.codes.map(function (c) {
    return { c: c, s: _rbFwd(_rbData.series[c] || [], dates, h) };
  }).filter(function (r) { return r.s; });
  if (!rows.length) {
    return '<div class="detail-note nb-keep">歷史樣本不足：' + cfg.years + ' 年內沒有走滿 ' + h
      + ' 個交易日的非系統性觸發事件，無法給出機率。放寬門檻或拉長歷史長度（參數設定 → 跌深反彈訊號）才有樣本。</div>';
  }
  rows.sort(function (a, b) { return b.s.med - a.s.med; });

  var html = '<div class="sec-title">跌深之後持有 ' + h + ' 個交易日</div>' +
    '<table class="inv-table rb-table"><thead><tr>' +
    '<th>代號 / 名稱</th><th class="num">上漲機率</th><th class="num">報酬中位數</th>' +
    '<th class="num">最差一次</th><th class="num">樣本（事件／觸發日）</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    html += '<tr><td><span class="tx-ocode">' + r.c + '</span><span class="tx-oname">' + _rbName(r.c) + '</span></td>' +
      '<td class="num" style="font-weight:700">' + r.s.up.toFixed(0) + '%</td>' +
      '<td class="num" style="color:' + _rbCol(r.s.med) + ';font-weight:700">' + _rbPct(r.s.med) + '</td>' +
      '<td class="num" style="color:' + _rbCol(r.s.min) + '">' + _rbPct(r.s.min) + '</td>' +
      '<td class="num rs-dim">' + r.s.eps + ' 段 ／ ' + r.s.n + ' 日</td></tr>';
  });
  html += '</tbody></table>';

  var thin = rows.slice().sort(function (a, b) { return a.s.eps - b.s.eps; })[0];
  html += '<div class="rb-caveat">勝率與中位數的分母是「觸發日」，但同一段修正會連續好幾天都達門檻，'
    + '每一天各算一次，所以真正獨立的是「段」。最薄的是 ' + thin.c + ' 的 ' + thin.s.eps + ' 段 —— '
    + '它的勝率 ' + thin.s.up.toFixed(0) + '% 實際意思接近「' + thin.s.eps + ' 段裡大約 '
    + Math.round(thin.s.eps * thin.s.up / 100) + ' 段是賺的」，不是幾十次的統計。'
    + '本區間共 ' + _rbData.trig.eps.length + ' 段觸發'
    + (sysEps ? '，其中 ' + sysEps + ' 段已標為系統性、不在統計內' : '')
    + '，目前這一段還沒走滿天數、也不列入。<br>'
    + '各檔段數差這麼多是因為上市日差很多：' + _rbHistLine() + '。'
    + '歷史最短的那幾檔只涵蓋一段多頭，它們的勝率不是「長期統計」，是「這幾個月的樣子」。</div>';

  html += '<div class="detail-note"><dl>' + _rbSixHtml() + '</dl></div>';
  return html;
}

// ── 分析視圖：全部持有天數、平均與最佳、事件逐筆（在這裡補標歷史事件）──
function _rbAnaHtml(dates, usableEps, sysEps) {
  var cfg = _rbData.cfg, t = _rbData.trig, marks = _rbMarks || {};
  var html = '<div class="sec-title">各持有天數的前瞻報酬</div>' +
    '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr><th rowspan="2">代號 / 名稱</th>';
  cfg.holds.forEach(function (h) { html += '<th colspan="5" class="rb-grp">持有 ' + h + ' 日</th>'; });
  html += '</tr><tr>';
  cfg.holds.forEach(function () {
    html += '<th class="num rb-sub2">段／日</th><th class="num rb-sub2">勝率</th><th class="num rb-sub2">中位數</th>'
      + '<th class="num rb-sub2">平均</th><th class="num rb-sub2">最差／最佳</th>';
  });
  html += '</tr></thead><tbody>';
  _rbData.codes.forEach(function (c) {
    html += '<tr><td><span class="tx-ocode">' + c + '</span><span class="tx-oname">' + _rbName(c) + '</span></td>';
    cfg.holds.forEach(function (h) {
      var s = _rbFwd(_rbData.series[c] || [], dates, h);
      if (!s) { html += '<td class="num rs-dim" colspan="5">樣本不足</td>'; return; }
      html += '<td class="num rs-dim">' + s.eps + '／' + s.n + '</td>' +
        '<td class="num">' + s.up.toFixed(0) + '%</td>' +
        '<td class="num" style="color:' + _rbCol(s.med) + ';font-weight:700">' + _rbPct(s.med) + '</td>' +
        '<td class="num" style="color:' + _rbCol(s.avg) + '">' + _rbPct(s.avg) + '</td>' +
        '<td class="num rs-dim">' + _rbPct(s.min) + ' ／ ' + _rbPct(s.max) + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';

  // 事件清單：歷史事件在這裡補標系統性
  var hL = cfg.holds[cfg.holds.length - 1];
  html += '<div class="sec-title">觸發事件（' + t.eps.length + ' 段）</div>' +
    '<table class="inv-table rb-table rb-eps"><thead><tr><th>起 ～ 迄</th><th class="num">觸發天數</th>' +
    '<th class="num">段內最深</th><th class="num">大盤 ' + hL + ' 日後</th>' +
    '<th style="text-align:center">系統性</th></tr></thead><tbody>';
  var pos = {};
  _rbData.idx.forEach(function (b, i) { pos[b.d] = i; });
  t.eps.slice().reverse().forEach(function (e) {
    var i = pos[e.start];
    var fwd = (i != null && i + hL < _rbData.idx.length)
      ? (_rbData.idx[i + hL].c / _rbData.idx[i].c - 1) * 100 : null;
    var on = !!marks[e.start];
    html += '<tr' + (on ? ' class="rb-sysrow"' : '') + '><td>' + e.start + ' ～ ' + e.end + '</td>' +
      '<td class="num">' + e.n + '</td>' +
      '<td class="num" style="color:var(--down)">' + _rbPct(e.worst, 2) + '</td>' +
      '<td class="num" style="color:' + _rbCol(fwd) + '">' + (fwd == null ? '尚未走滿' : _rbPct(fwd, 2)) + '</td>' +
      '<td style="text-align:center"><input type="checkbox"' + (on ? ' checked' : '') +
      ' onchange="rbMarkToggle(\'' + e.start + '\', this.checked)"></td></tr>';
  });
  html += '</tbody></table>';
  html += '<div class="rb-caveat">勾起來的事件從上方統計排除。目前 ' + usableEps + ' 段納入、' + sysEps + ' 段排除。'
    + '標記存在 ' + (_rbMStore === 'firestore' ? 'Firestore（已登入）' : '本機瀏覽器（未登入）') + '。</div>';

  html += '<div class="detail-note"><dl>' + _rbSixHtml() + _rbMethodHtml() + '</dl></div>';
  return html;
}

// 六欄交付標準
function _rbSixHtml() {
  var cfg = _rbData.cfg, hL = cfg.holds[cfg.holds.length - 1];
  return '<dt>定義</dt><dd>觸發日＝大盤（^TWII）當日收盤相對 ' + cfg.look + ' 個交易日前收盤累計 ≤ −' + cfg.drop + '%。'
    + '每個觸發日當成一次「收盤買進」，往後數 ' + cfg.holds.join('、') + ' 個交易日，'
    + '用該檔還原收盤算報酬（第 N 日還原收盤 ÷ 觸發日還原收盤 − 1）。'
    + '勝率＝報酬為正的比例；中位數＝把所有次數排序取中間那一次。'
    + '用還原收盤是因為期間跨過除息日時，未還原收盤會把配息當成下跌。</dd>'
    + '<dt>比較基準</dt><dd>兩個基準要一起看。一是跟 0 比，勝率回答「會不會彈」；'
    + '二是各檔互相比，中位數回答「哪一檔彈得多」。沒有跟「不跌深時隨便買」的基準報酬比，'
    + '所以這張表不證明跌深買比平常買好，只回答跌深買之後的分布長什麼樣。</dd>'
    + '<dt>白話意義</dt><dd>大盤連著跌到門檻之後，如果那天收盤買進並抱 ' + hL + ' 個交易日，'
    + '歷史上有多少比例是賺的、典型賺多少、最慘的一次賠多少。</dd>'
    + '<dt>機制</dt><dd>主動式 ETF 的持股集中在同一條供應鏈，大盤跌深時它們跌得比大盤多，'
    + '反彈時同樣放大，所以中位數會明顯高於大盤同期。放大是雙向的：'
    + '同一個機制讓「最差一次」也比大盤深，兩欄要一起看。'
    + '各檔形狀不同：有的短天期強、長天期把漲幅吐回去，有的愈久愈好，'
    + '這是持股周轉速度與產業集中度的差別，不是統計雜訊。</dd>'
    + '<dt>行動含義</dt><dd>勝率與中位數說明「這個時點的分布」，不說明「要買多少」。'
    + '要掛多遠才會成交看即時持股頁的掛單參考；賣出看停損停利頁的門檻。'
    + '這一頁只負責回答「現在是不是那個時點、各檔歷史上彈得如何」。</dd>'
    + '<dt>這個指標不能告訴你什麼</dt><dd>三件事。'
    + '一、不能分辨系統性與非系統性 —— 程式看不出跌深的原因，要靠你手動標，標錯統計就錯。'
    + '二、不能告訴你這一次會不會是最差那一次：勝率 80% 的另一面是五次裡有一次踩到，'
    + '所以「最差一次」那一欄跟勝率同等重要。'
    + '三、樣本期間以多頭為主，真正的空頭年跌深之後還會更深，這張表沒有那種樣本。'
    + '而且主動式 ETF 大多 2025 下半年之後才上市（' + _rbHistLine() + '），'
    + '歷史短的那幾檔只經歷過一段多頭，數字看起來漂亮是因為樣本只有那一段。</dd>';
}
function _rbMethodHtml() {
  var cfg = _rbData.cfg;
  return '<dt>這一頁不做什麼</dt><dd>不算成本與損益（在持股庫存與停損停利頁）、不判定成交機率'
    + '（在即時持股頁的掛單參考）、不給傾向。列完分布就停。</dd>'
    + '<dt>資料來源</dt><dd>Yahoo Finance 日線（^TWII 與各檔，經 GAS 代理），取 ' + cfg.years + ' 年。'
    + '大盤用未還原收盤（指數無配息），個股用還原收盤。'
    + '盤中最後一根是當日快照、不是定盤，收盤前的觸發判定會變動。</dd>'
    + '<dt>重疊樣本</dt><dd>同一段修正會連續好幾天都達門檻，每一天都算一次樣本，'
    + '所以「樣本 N 日」大於獨立事件數。勝率的分母是觸發日、不是事件。</dd>'
    + '<dt>參數</dt><dd>回看天數、跌幅門檻、持有天數、歷史長度都在 參數設定 → 跌深反彈訊號 可改，'
    + '改完回這一頁按重新整理。門檻沒有「正確值」：' + cfg.look + ' 日 ' + cfg.drop
    + '% 是起始值，改嚴樣本變少、改鬆樣本變雜。</dd>';
}

// ══════════ 參數設定頁的區塊（設定留在本模組，settings.js 只負責擺放）══════════
function renderReboundParams() {
  var el = document.getElementById('params-rebound-body');
  if (!el) return;
  var c = _rbCfg();
  var inp = function (id, v, step, unit, min, max) {
    return '<span class="set-inline"><input id="' + id + '" type="number" step="' + step +
      '" min="' + min + '" max="' + max + '" class="al-in" value="' + v +
      '" oninput="rbCfgChanged()"><span class="set-unit">' + unit + '</span></span>';
  };
  el.innerHTML = '<div class="rb-pgrid">' +
    '<span class="set-lb">回看天數</span>' + inp('rb-look', c.look, '1', '交易日', 1, 60) +
    '<span class="set-lb">累計跌幅門檻</span>' + inp('rb-drop', c.drop, '0.5', '% 以上', 0.5, 50) +
    '<span class="set-lb">歷史長度</span>' + inp('rb-years', c.years, '1', '年', 1, 10) +
    '<span class="set-lb">持有天數</span><span class="set-inline">' +
      '<input id="rb-holds" type="text" class="al-in rb-holds-in" value="' + c.holds.join(',') +
      '" oninput="rbCfgChanged()"><span class="set-unit">交易日，逗號分隔</span></span>' +
    '</div>' +
    '<div class="set-hint">目前：' + rbCfgStatus() + '。'
      + '改完到 跌深訊號板 按「↻ 重新整理」重算（會重抓日線）。<br>'
      + '回看天數與跌幅門檻決定「什麼叫跌深」：改嚴（天數短、跌幅大）樣本變少但事件更極端，'
      + '改鬆樣本變多但混進一般回檔。歷史長度拉長樣本變多，但愈早的市場結構跟現在差愈多 —— '
      + '主動式 ETF 多半 2025 下半年之後才上市，拉超過上市日也補不出資料。'
      + '持有天數是你打算抱多久，表上每一個天數各算一欄。<br>'
      + '改回看天數或跌幅門檻會動到事件的切分位置：系統性標記是記在「事件起始日」上的，'
      + '切分一變，舊的標記就可能對不上新的事件、變成沒有作用。'
      + '改完請到訊號板的分析視圖確認事件清單上的勾還在正確的那一段。</div>';
}
function rbCfgChanged() {
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : null; };
  var n = parseInt(g('rb-look'), 10), d = parseFloat(g('rb-drop')), y = parseInt(g('rb-years'), 10);
  if (!isNaN(n) && n >= 1 && n <= 60) localStorage.setItem('rb_look', n);
  if (!isNaN(d) && d > 0 && d <= 50) localStorage.setItem('rb_drop', d);
  if (!isNaN(y) && y >= 1 && y <= 10) localStorage.setItem('rb_years', y);
  var hs = String(g('rb-holds') || '').split(',').map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return x > 0 && x <= 120; });
  if (hs.length) localStorage.setItem('rb_holds', hs.join(','));
  // 參數變了，已算好的結果就過期了；下次進頁重抓，不在這裡順手重抓（使用者可能還在打字）
  _rbData = null;
  var hint = document.querySelector('#params-rebound-body .set-hint');
  if (hint) hint.innerHTML = hint.innerHTML.replace(/目前：[^。]*。/, '目前：' + rbCfgStatus() + '。');
  if (typeof setRender === 'function') {
    var st = document.querySelector('[data-set-status="rebound"]');
    if (st) st.textContent = rbCfgStatus();
  }
}
