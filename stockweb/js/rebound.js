// 股利總管 Web — 進場訊號板
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
  var sp = parseFloat(localStorage.getItem('rb_soxpct'));
  return {
    look: (isNaN(n) || n < 1 || n > 60) ? 5 : n,
    drop: (isNaN(d) || d <= 0 || d > 50) ? 5 : d,
    years: (isNaN(y) || y < 1 || y > 10) ? 2 : y,
    holds: holds.slice(0, 5),
    // 費半門檻不寫死成百分比，寫成「費半自身日報酬的第 N 百分位」：
    // 百分位是資料算出來的，换成幾 % 會隨市況變，寫死成 3% 就是憑空訂數字。
    soxPct: (isNaN(sp) || sp < 50 || sp > 99.9) ? 90 : sp,
    // 情境判定窗：台股近 N 日累計是負的算「連跌後」，否則算「上漲中」。
    // 2／3／5 日的結論方向一致（連跌後掛平盤的成交率 17%／12%／3%，
    // 上漲中 24%／33%／41%），跌得越久越不會回到昨收。預設 3 日。
    regWin: (function () {
      var w = parseInt(localStorage.getItem('rb_regwin'), 10);
      return (isNaN(w) || w < 1 || w > 20) ? 3 : w;
    })(),
    soxOn: localStorage.getItem('rb_soxon') !== '0'
  };
}
function rbCfgStatus() {
  var c = _rbCfg();
  return c.look + ' 日累計跌 ≥ ' + c.drop + '%｜持有 ' + c.holds.join('/') + ' 日｜歷史 ' + c.years + ' 年'
    + (c.soxOn ? '｜隔夜費半第 ' + c.soxPct + ' 百分位' : '｜不含隔夜費半');
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
// ══════════ Yahoo 的台股日線整天缺值時，用本機券商的分K補回來 ══════════
// 2026-11-12 實測：^TWII 有 43,091.87，但個股與 ETF 全部是 null——
// 00934、0056、00878、八檔主動式，open/high/low/close/volume 無一例外。
// 缺的那一天會被濾掉，「前收」於是退回再前一天：00934 顯示 27.66（11/11 收），
// 實際 11/12 收 27.09，整列的漲跌、推估、實際全部錯一天，而畫面上看不出來。
//
// 交易日曆用大盤（^TWII）：它有值而個股沒有，缺口才看得出來。
// 只補最近幾個交易日，更早的缺口影響不到前收與推估，不值得花配額。
var RB_GAP_DAYS = 6;
async function _rbDayFromBroker(code, d) {
  // 大盤不是股票代號：指數走 IND／TSE／001，與總覽那張加權指數分時同一個來源。
  // 成交量的單位也不同（指數給的不是張），所以指數這條不做張轉股。
  var isIdx = (code === '^TWII');
  var cands;
  if (isIdx) {
    cands = [{ security_type: 'IND', exchange: 'TSE', code: '001' }];
  } else {
    var ex = (typeof _ovEx === 'function') ? _ovEx(code) : 'TSE';
    cands = ((ex === 'OTC') ? ['OTC', 'TSE'] : ['TSE', 'OTC']).map(function (e) {
      return { security_type: 'STK', exchange: e, code: code };
    });
  }
  for (var a = 0; a < cands.length; a++) {
    try {
      var r = await fetch('/api/v1/data/kbars', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contract: cands[a], start: d, end: d })
      });
      if (!r.ok) continue;
      var j = await r.json(), dt = j.datetime || [];
      var o = null, h = -Infinity, l = Infinity, c = null, v = 0, n = 0;
      for (var i = 0; i < dt.length; i++) {
        if (dt[i].slice(0, 10) !== d) continue;
        n++;
        if (o == null && j.Open[i] > 0) o = j.Open[i];
        if (j.High[i] > h) h = j.High[i];
        if (j.Low[i] < l) l = j.Low[i];
        if (j.Close[i] > 0) c = j.Close[i];
        v += j.Volume[i] || 0;
      }
      if (!n || !(c > 0)) continue;
      // 還原價跟著收盤：這一天有沒有除息無從得知，a === c 代表「不還原」。
      // ovEstimate 用 a/c 的倍率偵測除息日，相等就不會被誤判成除息。
      // 成交量券商給「張」、Yahoo 給「股」，不乘回去的話這一天在 20 日均量裡
      // 只剩千分之一，量能那一欄會整排偏掉。
      return { d: d, c: c, a: c, o: o, h: (h === -Infinity ? null : h),
               l: (l === Infinity ? null : l), v: isIdx ? v : v * 1000, src: 'broker' };
    } catch (e) { hush('rebound-gap', e); }
  }
  return null;
}
async function _rbPatchGaps(code, out, cal) {
  if (!out || !cal || !cal.length) return out;
  // 「整天沒有」與「只有收盤、沒有高低」都算缺口：後者算不出成交率，
  // 而券商的分 K 聚出來的是真實日內高低，換掉比留著殘根好。
  var have = {}, stub = {};
  out.forEach(function (b) { if (b.h > 0 && b.l > 0) have[b.d] = 1; else stub[b.d] = 1; });
  var miss = cal.slice(-RB_GAP_DAYS).filter(function (d) { return !have[d]; });
  if (!miss.length) return out;                 // 正常情況一次都不會往下走
  for (var i = 0; i < miss.length; i++) {
    var b = await _rbDayFromBroker(code, miss[i]);
    if (!b) continue;
    if (stub[miss[i]]) {
      for (var z = out.length - 1; z >= 0; z--) if (out[z].d === miss[i]) { out.splice(z, 1); break; }
    }
    out.push(b);
  }
  out.sort(function (a, b2) { return a.d < b2.d ? -1 : 1; });
  return out;
}

async function _rbSeries(sym, years) {
  var key = sym + '|' + years;
  if (_rbBars[key]) return _rbBars[key];
  var syms = /^\d/.test(String(sym)) ? [sym + '.TW', sym + '.TWO'] : [sym];
  var out = [], _rbMeta = null, tzo = 8 * 3600000;
  for (var i = 0; i < syms.length && !out.length; i++) {
    try {
      var j = await _esVia('https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(syms[i]) + '?interval=1d&range=' + years + 'y', 40000);
      var res = j && j.chart && j.chart.result && j.chart.result[0];
      _rbMeta = (res && res.meta) || null;
      // 日期一律用「交易所當地日」：台股 +8、費半 −5。
      // 寫死 +8 的話美股會被推到隔天，與隔夜對應就錯一天。
      if (_rbMeta && typeof _rbMeta.gmtoffset === 'number') tzo = _rbMeta.gmtoffset * 1000;
      var ts = (res && res.timestamp) || [];
      var qt = (res && res.indicators && res.indicators.quote[0]) || {};
      var cl = qt.close || [], op = qt.open || [], hg = qt.high || [], lw = qt.low || [], vo = qt.volume || [];
      var acl = ((res && res.indicators && res.indicators.adjclose && res.indicators.adjclose[0]) || {}).adjclose || null;
      for (var k = 0; k < ts.length; k++) {
        // close 是 null 但 high/low 在的那一天先留著，下面用 meta 的收盤補。
        //
        // 收盤後 Yahoo 的當日 close 會空一段時間（11/12、11/13 連兩天，全台股標的皆然），
        // 但同一根的 open/high/low 是有值的。原本只要 close 是 null 就整根丟掉，
        // 連帶把 high/low 一起丟了，再由下面的 meta 補一根「只有收盤、沒有高低」的殘根。
        // 殘根對股票那邊無所謂（只用到收盤），債券那邊卻會被整個濾掉：
        // 成交率要日內最高最低才算得出來，濾掉之後「前收」就退回前一天。
        // 2026-11-14 00:40 實測 00981B：11/13 的 o/h/l 都在、只有 close 是 null，
        // meta 的收盤 9.09 也在，畫面卻顯示 11/12 的 9.11。
        if (cl[k] == null && !(hg[k] > 0 && lw[k] > 0)) continue;
        out.push({
          d: new Date(ts[k] * 1000 + tzo).toISOString().slice(0, 10),
          c: cl[k], a: (acl && acl[k] != null) ? acl[k] : cl[k],
          o: op[k] == null ? null : op[k], h: hg[k] == null ? null : hg[k], l: lw[k] == null ? null : lw[k],
          v: vo[k] == null ? null : vo[k]
        });
      }
    } catch (e) { hush('rebound', e); }
  }
  out.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
  // Yahoo 的日線陣列有時最後一根 close 是 null（^TWII 常發生），收盤價只在 meta 裡。
  // 不補的話觸發判定會漏掉最新一個交易日，變成拿前天的位置在做今天的判斷。
  if (_rbMeta && _rbMeta.regularMarketPrice > 0 && _rbMeta.regularMarketTime) {
    var md = new Date(_rbMeta.regularMarketTime * 1000 + tzo).toISOString().slice(0, 10);
    var lastB = out.length ? out[out.length - 1] : null;
    if (lastB && lastB.d === md && !(lastB.c > 0)) {
      // 高低已經在手上，只缺收盤 —— 補進同一根，不要另外長一根沒有高低的出來
      lastB.c = _rbMeta.regularMarketPrice;
      lastB.a = _rbMeta.regularMarketPrice;
    } else if (!lastB || md > lastB.d) {
      out.push({ d: md, c: _rbMeta.regularMarketPrice, a: _rbMeta.regularMarketPrice, o: null, h: null, l: null });
    }
  }
  // 補不到收盤的留著會讓下游算出 NaN（_rbTriggers 直接相除，沒有防呆）
  out = out.filter(function (b) { return b.c > 0; });
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

// ══════ 隔夜費半條件機率 ══════
// 問的不是「跌深之後抱 N 日」（那是下面主表），是「昨夜費半大漲，台股今天漲多少」。
// 兩個時間尺度不同（單日 vs 數週），所以做成獨立區塊、不併進主表的同一列，
// 否則會讓人以為兩個數字可以相加。
//
// 為什麼用費半而不用台指期夜盤：這一頁所有資料都走 Yahoo，離線（券商未連）也能看；
// 夜盤期貨 Yahoo 沒有，要接本機伺服器，接了這一頁就綁死在伺服器開著。
// 代價是「夜盤漲幅 → 現貨開盤」這一層滑移無法量化，寫在六欄的「不能告訴你」裡。

function _rbQuant(sorted, p) {
  if (!sorted.length) return null;
  var i = p / 100 * (sorted.length - 1), lo = Math.floor(i), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function _rbRank(sorted, v) {
  if (!sorted.length) return null;
  var n = 0;
  for (var i = 0; i < sorted.length; i++) if (sorted[i] <= v) n++;
  return n / sorted.length * 100;
}
// 二分搜：給定台股交易日 d，回「日期小於 d 的最後一個美股交易日」。
// 台股 13:30 收盤時美股當天還沒開，所以同一個日期的美股盤算「隔夜」、落在隔天的台股。
function _rbPrevFn(dates) {
  return function (d) {
    var lo = 0, hi = dates.length - 1, ans = null;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (dates[m] < d) { ans = dates[m]; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  };
}
// 前收那一欄自己的漲跌（對再前一個交易日），用來決定字色。
//
// 用還原收盤算，不用未還原：除息當天未還原價會憑空掉一截，
// 拿它上色會把配息標成下跌，而紅綠在這一頁的意思是「價格動了多少」。
// 個股沒有還原資料時退回未還原，指數本來就沒有配息，兩者相同。
function _rbLastChg(bars) {
  if (!bars || bars.length < 2) return null;
  var b = bars[bars.length - 1], p = bars[bars.length - 2];
  var c1 = (b.a > 0) ? b.a : b.c, c0 = (p.a > 0) ? p.a : p.c;
  if (!(c0 > 0) || !(c1 > 0)) return null;
  return (c1 / c0 - 1) * 100;
}
// 前收目前走在什麼狀態：連續同向幾天，或剛剛轉向。
//
// 這是描述不是預測。實測過連漲連跌對隔日沒有預測力
// （Wald-Wolfowitz 連串檢定 Z = −0.65／−0.65／−0.44，連續長度跟丟銅板沒有差別），
// 所以標籤只陳述現在的序列長什麼樣，不帶任何「所以會怎樣」的暗示，字色也不加重。
// 用還原收盤判方向，除息當天不算下跌。
function _rbStreak(bars) {
  if (!bars || bars.length < 2) return null;
  var px = function (x) { return (x.a > 0) ? x.a : x.c; };
  var dir = function (i) {
    var a = px(bars[i]), b = px(bars[i - 1]);
    if (!(a > 0) || !(b > 0)) return 0;
    var d = a - b;
    return d > 0 ? 1 : (d < 0 ? -1 : 0);
  };
  var last = bars.length - 1, d0 = dir(last);
  if (d0 === 0) return { n: 0, dir: 0, txt: '平盤' };
  var n2 = 1;
  for (var i = last - 1; i >= 1; i--) { if (dir(i) !== d0) break; n2++; }
  if (n2 >= 2) return { n: n2, dir: d0, txt: '連' + (d0 > 0 ? '漲' : '跌') + ' ' + n2 };
  var prev = (bars.length >= 3) ? dir(last - 1) : 0;
  if (prev === -d0) return { n: 1, dir: d0, txt: (d0 > 0 ? '跌轉漲' : '漲轉跌') };
  return { n: 1, dir: d0, txt: (d0 > 0 ? '漲' : '跌') };
}
// 圖示的選擇：連續用「方向＋天數」，轉向用弧線。
//
// 兩種狀態本質不同，不該共用一套符號：連續是數量（▲5 比 ▲×5 乾淨），
// 轉向是事件（⤴ 一眼就是折返，不需要數字）。
// 硬用同一套會變成 ▼▲ 或 ○● 那種要想一下才讀得懂的東西。
function _rbStreakSub(bars) {
  var k = _rbStreak(bars);
  if (!k) return '';
  var icon, cls, tip;
  if (k.dir === 0) {
    icon = '—'; cls = 'rb-bs-fl'; tip = '前收跟再前一天收在同一個價';
  } else if (k.n >= 2) {
    icon = (k.dir > 0 ? '▲' : '▼') + k.n;
    cls = k.dir > 0 ? 'rb-bs-up' : 'rb-bs-dn';
    tip = '連續第 ' + k.n + ' 天' + (k.dir > 0 ? '上漲' : '下跌');
  } else if (k.txt.length === 3) {          // 跌轉漲／漲轉跌
    icon = k.dir > 0 ? '⤴' : '⤵';
    cls = k.dir > 0 ? 'rb-bs-up' : 'rb-bs-dn';
    tip = k.txt + '：' + k.txt.charAt(0) + '了一段之後，這一天轉' + k.txt.charAt(2);
  } else {                                   // 再前一天持平，等於只有 1 天
    icon = (k.dir > 0 ? '▲' : '▼') + '1';
    cls = k.dir > 0 ? 'rb-bs-up' : 'rb-bs-dn';
    tip = '前收' + k.txt + '，再前一天持平';
  }
  return '<span class="rb-bsub ' + cls + '" title="' + tip + '（還原後，除息不算下跌）">'
    + icon + '</span>';
}
// 前收儲存格：數字照舊，字色是它自己的漲跌，底下一行是目前的狀態
function _rbBaseTd(pc, bars) {
  if (!(pc > 0)) return '<td class="num rs-dim">—</td>';
  var ch = _rbLastChg(bars);
  return '<td class="num" style="color:' + _rbCol(ch) + '"'
    + (ch == null ? '' : ' title="前收對再前一個交易日 ' + _rbPct(ch, 2) + '（還原後，除息不算下跌）"')
    // 金額包成整行，徽章落到下一行。
    // 接在金額後面會讓每一列的數字右邊美不齊，整欄就掃不了了。
    + '><span class="rb-bpx">' + pc.toFixed(2) + '</span>' + _rbStreakSub(bars) + '</td>';
}

// 費半日報酬分布與門檻。指數沒有配息，用未還原收盤。
//
// 門檻是對稱的兩個：第 pct 百分位（大漲）與第 100−pct 百分位（大跌）。
// 原本只有大漲那一個，費半大跌的日子整張卡直接收成一行「未達門檻」。
// 2026-11-14 實測：費半 −3.80%（第 8 百分位），大跌門檻 −3.37%，明明是達標的，
// 畫面什麼都不給。而費半大跌正是買進最需要資訊的時候。
//
// 兩邊的樣本相當（大漲 51 個台股交易日、大跌 46 個），不是資料只夠做一邊。
function _rbSoxCalc(bars, pct) {
  if (!bars || bars.length < 60) return null;
  var rets = {}, dates = [];
  for (var i = 1; i < bars.length; i++) {
    if (!(bars[i - 1].c > 0)) continue;
    rets[bars[i].d] = (bars[i].c / bars[i - 1].c - 1) * 100;
    dates.push(bars[i].d);
  }
  if (dates.length < 60) return null;
  var sorted = dates.map(function (d) { return rets[d]; }).sort(function (a, b) { return a - b; });
  var thr = _rbQuant(sorted, pct), thrDn = _rbQuant(sorted, 100 - pct);
  var lastD = dates[dates.length - 1];
  var hit = dates.filter(function (d) { return rets[d] >= thr; });
  var hitDn = dates.filter(function (d) { return rets[d] <= thrDn; });
  return {
    rets: rets, dates: dates, sorted: sorted, thr: thr, thrDn: thrDn, n: sorted.length,
    hit: hit.length, hitDn: hitDn.length, prev: _rbPrevFn(dates),
    last: { d: lastD, r: rets[lastD], rank: _rbRank(sorted, rets[lastD]) }
  };
}
// 今天站在哪一邊：'up' 大漲、'dn' 大跌、null 兩邊都沒達標
function _rbSoxSide(sox) {
  if (!sox || !sox.last || sox.last.r == null) return null;
  if (sox.last.r >= sox.thr) return 'up';
  if (sox.last.r <= sox.thrDn) return 'dn';
  return null;
}
// 挑樣本的判準。三個統計函式都吃這個，不各自寫一份比大小。
function _rbSoxHit(sox, side) {
  if (side === 'dn') return function (v) { return v <= sox.thrDn; };
  return function (v) { return v >= sox.thr; };
}
// 達標日的「日內形狀」：全日漲幅拆成開盤前（跳空）與開盤後（盤中）兩段。
// 為什麼要拆：掛限價買進能不能成交，看的是日內最低價有沒有碰到掛價，
// 跟收盤對收盤是兩個問題。漲幅如果全在跳空，掛在跳空之下等於等回檔。
//
// 開高低是未還原價，所以跟「昨收」比的時候跨除息日會把配息算成跳空缺口。
// 除息日的判定不自己維護清單，用資料算：還原係數（adjclose ÷ close）在前後兩根之間
// 變了，那一根就是除息日，整根排掉。
// 掋這個價，成交率多少。這是挂限價單真正要的數字——
// 中位數、最低、最高都是收盤對收盤的分布描述，沒有一個能變成委託單上的價格。
//
// 實測的發現（七檔方向一致）：連跌後反而更難成交。
//   00981A 近 3 日判定：掛平盤的成交率，連跌後 9%（n=22）、上漲中 44%（n=18）。
// 機制就是「開盤跳空」那一欄在講的：連跌＋費半大漲是最強的跳空組合，
// 開高就不回頭，等拉回等不到。
//
// 除息日排掉：開高低是未還原價，跟前收相比會把配息算成跳空（與 _rbSoxGap 同一個判法）。
var RB_FILL_OFFS = (function () {
  var a = [];
  for (var k = -100; k <= 200; k += 25) a.push(k / 100);   // −1% 到 +2%，0.25 一檔
  return a;
})();

// 成交率表與日內形狀表的排序。
// 掋價格子排的是成交率（依價格排等於依前收排，重複），
// 而且用的是「今天那一邊」的數字，與畫面標重的那一邊一致。
var RB_FSORT_LS = 'rb_fsort_v1', RB_GSORT_LS = 'rb_gsort_v1', RB_DSORT_LS = 'rb_dsort_v1';
var _rbFSort = rbSortGet(RB_FSORT_LS, 'upDesc');
var _rbGSort = rbSortGet(RB_GSORT_LS, 'gapDesc');
function rbFSort(k) {
  _rbFSort = rbSortNext(_rbFSort, k);
  try { localStorage.setItem(RB_FSORT_LS, _rbFSort); } catch (e) {}
  rbRender();
}
function rbGSort(k) {
  _rbGSort = rbSortNext(_rbGSort, k);
  try { localStorage.setItem(RB_GSORT_LS, _rbGSort); } catch (e) {}
  rbRender();
}
var _rbDSort = rbSortGet(RB_DSORT_LS, 'ccAsc');
function rbDSort(k) {
  _rbDSort = rbSortNext(_rbDSort, k);
  try { localStorage.setItem(RB_DSORT_LS, _rbDSort); } catch (e) {}
  rbRender();
}
// 分析視圖可以手動切到另一邊看歷史；決策視圖一律跟著今天的方向，不給切。
var _rbSoxView = null;
function rbSoxSide(k) { _rbSoxView = k; rbRender(); }

function _rbFill(bars, sox, reg, hit) {
  if (!bars || !sox || !reg) return null;
  hit = hit || _rbSoxHit(sox, 'up');
  var mk = function () { return { n: 0, hit: RB_FILL_OFFS.map(function () { return 0; }) }; };
  var dn = mk(), up = mk();
  for (var i = 1; i < bars.length; i++) {
    var b = bars[i], pv = bars[i - 1];
    if (!(pv.c > 0) || !(b.l > 0)) continue;
    var u = sox.prev(b.d);
    if (u == null || u < pv.d || !hit(sox.rets[u])) continue;
    var f0 = pv.a / pv.c, f1 = b.a / b.c;
    if (Math.abs(f1 - f0) > 1e-6 * Math.max(f0, f1)) continue;      // 除息日
    var v = reg[b.d];
    if (v == null) continue;
    var g = (v < 0) ? dn : up;
    g.n++;
    // 掛價先對齊升降單位再比，而且在「分」的整數格線上比。
    // 兩個理由：一是委託單只掛得出格線上的價格，畫面顯示的也是對齊後的那個數字，
    // 統計卻用沒對齊的原始百分比價位，等於量的門檻比你實際掛得出去的嚴一點。
    // 二是浮點數的容忍值問題（詳見 bondsig.js 的 _bsCents）。
    // 這張表的掛價是百分比、落點不在格線上，所以影響比債券那張小：
    // 2026-11-14 實測三檔差 0 到 3 個百分點，多數是 0 到 1，但方向一律是低估。
    var lc = Math.round(b.l * 100);
    RB_FILL_OFFS.forEach(function (k, j) {
      var raw = pv.c * (1 + k / 100), t = raw < 50 ? 0.01 : 0.05;
      if (lc <= Math.round(Math.round(raw / t) * t * 100)) g.hit[j]++;
    });
  }
  if (!dn.n && !up.n) return null;
  var pc = function (g) {
    return g.n ? g.hit.map(function (h) { return h / g.n * 100; }) : null;
  };
  return { dn: { n: dn.n, p: pc(dn) }, up: { n: up.n, p: pc(up) }, last: bars[bars.length - 1].c };
}

// 台股近 N 日累計（到前一日為止），當成「今天屬於哪種情境」的依據
function _rbRegime(idx, win) {
  var m = {};
  for (var i = win + 1; i < idx.length; i++) {
    if (idx[i - 1].c > 0 && idx[i - 1 - win].c > 0) {
      m[idx[i].d] = (idx[i - 1].c / idx[i - 1 - win].c - 1) * 100;
    }
  }
  return m;
}
function _rbRegimeNow(idx, win) {
  var n = idx.length;
  if (n < win + 1 || !(idx[n - 1].c > 0) || !(idx[n - 1 - win].c > 0)) return null;
  return (idx[n - 1].c / idx[n - 1 - win].c - 1) * 100;
}

function _rbSoxGap(bars, sox, hit) {
  if (!bars || !sox) return null;
  hit = hit || _rbSoxHit(sox, 'up');
  var gap = [], oc = [], hi = [], lo = [], cc = [], fade = 0, n = 0, exdiv = 0;
  for (var i = 1; i < bars.length; i++) {
    var b = bars[i], p = bars[i - 1];
    if (b.o == null || b.h == null || b.l == null) continue;   // meta 補的那根沒有日內價
    if (!(p.c > 0) || !(b.o > 0)) continue;
    var u = sox.prev(b.d);
    if (u == null || u < p.d) continue;
    if (!hit(sox.rets[u])) continue;
    var f0 = p.a / p.c, f1 = b.a / b.c;
    if (Math.abs(f1 - f0) > 1e-6 * Math.max(f0, f1)) { exdiv++; continue; }
    n++;
    gap.push((b.o / p.c - 1) * 100);
    oc.push((b.c / b.o - 1) * 100);
    hi.push((b.h / p.c - 1) * 100);
    lo.push((b.l / p.c - 1) * 100);
    cc.push((b.c / p.c - 1) * 100);
    if (b.c < b.o) fade++;
  }
  if (!n) return null;
  return {
    n: n, exdiv: exdiv, gap: _rbMed(gap), oc: _rbMed(oc),
    hi: _rbMed(hi), lo: _rbMed(lo), cc: _rbMed(cc), fade: fade / n * 100
  };
}

// ── 費半大跌那一邊：跌到哪裡、買了之後多久翻正 ──
//
// 為什麼不照抄大漲那一邊的成交率表：那張表問的是「掛限價買得到嗎」。
// 費半大跌隔天台股開低，掛在前收之下幾乎一定成交，整排會逼近 100%，
// 看起來像發現、其實是定義使然。跌邊要問的是另外三件事：
//   跌到哪裡（日內最低與收盤）、跌幅有多少在開盤就給完（跳空）、買了之後多久翻正。
//
// 翻正的定義是「買在達標日收盤」：那是這個情境下真正做得到的進場點。
// 用「對前收」當基準會算成另一個問題（這一天跌完了沒），不是買方要的。
var RB_DIP_HOLDS = [1, 3, 5];
function _rbSoxDip(bars, sox, hit, useAdj) {
  if (!bars || !sox) return null;
  hit = hit || _rbSoxHit(sox, 'dn');
  var gap = [], lo = [], cc = [], idxs = [], exdiv = 0;
  for (var i = 1; i < bars.length; i++) {
    var b = bars[i], p = bars[i - 1];
    if (!(p.c > 0) || !(b.c > 0)) continue;
    var u = sox.prev(b.d);
    if (u == null || u < p.d || !hit(sox.rets[u])) continue;
    var f0 = p.a / p.c, f1 = b.a / b.c;
    if (Math.abs(f1 - f0) > 1e-6 * Math.max(f0, f1)) { exdiv++; continue; }   // 除息日
    idxs.push(i);
    cc.push((b.c / p.c - 1) * 100);
    if (b.o > 0) gap.push((b.o / p.c - 1) * 100);
    if (b.l > 0) lo.push((b.l / p.c - 1) * 100);
  }
  if (!idxs.length) return null;
  // 翻正：買在達標日收盤，持有 N 個交易日之後的報酬。
  // 最後幾個達標日還沒走滿 N 天，分母因此比上面那幾欄小，每一欄各自標自己的天數。
  var fwd = RB_DIP_HOLDS.map(function (h) {
    var rs = [];
    idxs.forEach(function (i) {
      var j = i + h;
      if (j >= bars.length) return;
      var p0 = useAdj ? bars[i].a : bars[i].c, p1 = useAdj ? bars[j].a : bars[j].c;
      if (!(p0 > 0) || !(p1 > 0)) return;
      rs.push((p1 / p0 - 1) * 100);
    });
    if (!rs.length) return { h: h, n: 0, up: null, med: null };
    return { h: h, n: rs.length, med: _rbMed(rs),
             up: rs.filter(function (r) { return r > 0; }).length / rs.length * 100 };
  });
  return { n: idxs.length, exdiv: exdiv, gap: _rbMed(gap), lo: _rbMed(lo), cc: _rbMed(cc),
           fwd: fwd, last: bars[bars.length - 1].c };
}

// 一檔在「前一夜費半 ≥ 門檻」的那些台股交易日，當日漲跌的分布。
// 個股用還原收盤（除息日不該被當成下跌），大盤用未還原。
function _rbSoxFwd(bars, sox, useAdj, hit) {
  if (!bars || !sox) return null;
  hit = hit || _rbSoxHit(sox, 'up');
  var rs = [], ds = [];
  for (var i = 1; i < bars.length; i++) {
    var u = sox.prev(bars[i].d);
    // 這一根美股盤必須落在前一個台股收盤之後，否則是前天已經反應過的那一根
    if (u == null || u < bars[i - 1].d) continue;
    if (!hit(sox.rets[u])) continue;
    var p0 = useAdj ? bars[i - 1].a : bars[i - 1].c, p1 = useAdj ? bars[i].a : bars[i].c;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    rs.push((p1 / p0 - 1) * 100); ds.push(bars[i].d);
  }
  if (!rs.length) return null;
  var up = rs.filter(function (r) { return r > 0; }).length;
  return {
    n: rs.length, up: up / rs.length * 100, med: _rbMed(rs), dates: ds,
    avg: rs.reduce(function (a, b) { return a + b; }, 0) / rs.length,
    min: Math.min.apply(null, rs), max: Math.max.apply(null, rs)
  };
}

// ── 標的：持股中代號結尾為 A 的（category.js：A＝主動股票型）──
// 不用名稱判斷，因為合約名稱要等行情載入；主動債券型（結尾 D）不列，
// 跌深反彈講的是股票型的回彈，債券型的價格動因是殖利率不是這個。
// 持股中的主動式 ETF＋已關注清單。
// 關注清單不限 A 結尾：要看的是「這個價掋下去會不會成交」，
// 這件事跟標的是不是主動式無關，只要有足夠的日線就算得出來。
function _rbCodes() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  var out = Object.keys(m).filter(function (c) { return m[c] > 0 && /A$/.test(c); });
  var seen = {};
  out.forEach(function (c) { seen[c] = 1; });
  var w = (typeof _wtLoad === 'function') ? (_wtLoad() || []) : [];
  w.forEach(function (c) { c = String(c); if (!seen[c]) { seen[c] = 1; out.push(c); } });
  return out.sort();
}
// 持股中嗎（關注但未持有的要標「—」）
function _rbHeld(c) {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return m[String(c)] > 0;
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
  if (_rbData && !force) {
    rbRender();
    if (typeof ovLiveStart === 'function') ovLiveStart();   // 回到這一頁要重新開始跟現價
    return;
  }
  wrap.innerHTML = '<div class="modal-loading">抓取大盤與各檔日線…</div>';

  if (typeof ensureFeed === 'function' && !Object.keys((typeof _sharesMap !== 'undefined' && _sharesMap) || {}).length) {
    try { await ensureFeed(function (m) { if (info) info.textContent = m; }); } catch (e) { hush('rebound', e); }
  }
  await rbMarksLoad(force);

  var cfg = _rbCfg(), codes = _rbCodes();
  var bonds = (typeof bsCodes === 'function') ? bsCodes() : [];
  if (!codes.length && !bonds.length) {
    _rbData = null;
    wrap.innerHTML = '<div class="modal-loading">持股中沒有主動式股票型 ETF（結尾 A）也沒有債券型（結尾 B、D），這一頁沒有標的可統計</div>';
    return;
  }
  // 只有債券的話，股票那兩個頁籤本來就沒東西可算，但不該因此整頁擋掉——
  // 債券頁籤是獨立的，只需要 HYG 與債券自己的日線。
  if (!codes.length) {
    if (force) _rbBars = {};
    if (typeof bsPrepare === 'function') { try { await bsPrepare(force); } catch (e) { hush('rebound', e); } }
    _rbData = { cfg: cfg, codes: [], idx: [], series: {}, sox: null, bondOnly: true,
                trig: { days: [], eps: [], own: {}, cum: {} } };
    try { localStorage.setItem(RB_VIEW_LS, 'bond'); } catch (e) {}
    if (info) info.textContent = '只有債券型標的，股票那兩個頁籤無資料';
    rbRender();
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
  // 交易日曆取自大盤，用來偵測個股日線整天缺值（見 _rbPatchGaps）
  var cal = idx.map(function (b) { return b.d; });
  // 大盤自己也要補。收盤後 Yahoo 的當日收盤要從別的欄位補，那一根沒有日內高低，
  // 表尾大盤那一列的「開盤跳空」「日內最低」就會少掉最新一天。
  try { await _rbPatchGaps('^TWII', idx, cal); } catch (e) { hush('rebound', e); }
  for (var i = 0; i < codes.length; i++) {
    if (info) info.textContent = '抓取 ' + codes[i] + ' 日線…（' + (i + 1) + '/' + codes.length + '）';
    series[codes[i]] = await _rbSeries(codes[i], cfg.years);
    try { await _rbPatchGaps(codes[i], series[codes[i]], cal); } catch (e) { hush('rebound', e); }
  }
  var sox = null;
  if (cfg.soxOn) {
    if (info) info.textContent = '抓取費半指數日線…';
    for (var sa = 0; sa < 2 && !sox; sa++) {
      try { sox = _rbSoxCalc(await _rbSeries('^SOX', cfg.years), cfg.soxPct); }
      catch (e) { hush('rebound', e); }
    }
  }
  _rbData = { cfg: cfg, codes: codes, idx: idx, series: series, sox: sox, trig: _rbTriggers(idx, cfg) };
  if (typeof ovPrepare === 'function') { try { await ovPrepare(force); } catch (e) { hush('rebound', e); } }
  if (typeof bsPrepare === 'function') { try { await bsPrepare(force); } catch (e) { hush('rebound', e); } }
  if (info) info.textContent = '資料日 ' + idx[idx.length - 1].d + '（Yahoo 日線，' + cfg.years + ' 年）';
  rbRender();
  if (typeof ovLiveStart === 'function') ovLiveStart();
}

function rbView(v) {
  try { localStorage.setItem(RB_VIEW_LS, v); } catch (e) {}
  rbRender();
}
function _rbViewSel() {
  try { var v = localStorage.getItem(RB_VIEW_LS); if (v === 'ana' || v === 'bond') return v; } catch (e) {}
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
  // 債券頁籤不用大盤日線，要在讀 idx 之前分流；
  // 只有債券時 idx 是空的，跳不過去會損在這一行。
  var vsel = _rbViewSel();
  if (vsel === 'bond' || _rbData.bondOnly) {
    var bonly = !!_rbData.bondOnly;
    wrap.innerHTML = '<div class="pv-tabs rb-tabs">' +
      (bonly ? '' :
        '<button class="pv-tab" onclick="rbView(\'dec\')">決策</button>' +
        '<button class="pv-tab" onclick="rbView(\'ana\')">分析</button>') +
      '<button class="pv-tab on" onclick="rbView(\'bond\')">債券</button></div>' +
      ((typeof bsHtml === 'function') ? bsHtml() : '');
    return;
  }
  var last = idx[idx.length - 1], lastCum = t.cum[last.d];
  var lastEp = t.eps.length ? t.eps[t.eps.length - 1] : null;
  // 正在觸發中＝最後一筆資料日本身就是觸發日
  var live = !!(lastEp && lastEp.end === last.d);
  var liveSys = live && !!marks[lastEp.start];

  var view = _rbViewSel();
  var html = '<div class="pv-tabs rb-tabs">' +
    '<button class="pv-tab' + (view === 'dec' ? ' on' : '') + '" onclick="rbView(\'dec\')">決策</button>' +
    '<button class="pv-tab' + (view === 'ana' ? ' on' : '') + '" onclick="rbView(\'ana\')">分析</button>' +
    '<button class="pv-tab' + (view === 'bond' ? ' on' : '') + '" onclick="rbView(\'bond\')">債券</button>' +
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

  html += (typeof ovHtml === 'function') ? ovHtml(view) : '';
  html += _rbSoxHtml(view);
  html += (view === 'ana') ? _rbAnaHtml(dates, usableEps, sysEps) : _rbDecHtml(dates, usableEps, sysEps);
  wrap.innerHTML = html;
}

// ── 費半大跌那一邊的表 ──
// 欄位跟大漲那一邊刻意不同，理由寫在 _rbSoxDip 的檔頭。
// 價格一律換算出來：百分比抄不進委託單。
function _rbSoxDnHtml(sox, hit, head, sideBtn, on, pending) {
  var idx = _rbData.idx;
  var rows = _rbData.codes.map(function (c) {
    return { c: c, d: _rbSoxDip(_rbData.series[c] || [], sox, hit, true) };
  }).filter(function (r) { return r.d; });
  var twD = _rbSoxDip(idx, sox, hit, false);

  var html = '<div class="rb-sox">' + sideBtn;
  html += '<div class="sec-title">隔夜費半大跌之後</div>';
  html += '<div class="rb-sox-hd' + (on ? ' on' : '') + '">'
    + (on ? '已達大跌門檻。' : '今天不在這一邊（下表是歷史分布）。') + head;
  if (on && pending) {
    var u2 = sox.prev(idx[idx.length - 1].d);
    html += '這一夜還沒進市場。'
      + ((u2 != null && hit(sox.rets[u2])) ? '<b>連續第二根以上</b>（已經跌過一輪）。'
                                           : '<b>訊號的第一根</b>。');
  } else if (on) {
    html += '台股已反應過，下表是歷史分布。';
  }
  html += '</div>';

  if (!rows.length) {
    return html + '<div class="rb-caveat nb-keep">這組門檻下沒有任何一檔有樣本：'
      + '要麼門檻太嚴（第 ' + _rbData.cfg.soxPct + ' 百分位的對稱邊），要麼這幾檔上市後還沒碰過。</div></div>';
  }

  html += '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>'
    + rbSortTh(_rbDSort, 'rbDSort', 'code', '代號 / 名稱').replace('class="num ', 'class="')
    + rbSortTh(_rbDSort, 'rbDSort', 'px', '前收')
    + rbSortTh(_rbDSort, 'rbDSort', 'n', '樣本')
    + rbSortTh(_rbDSort, 'rbDSort', 'gap', '開盤跳空', '達標日開盤對前收的中位數。跌幅有多少在開盤就給完')
    + rbSortTh(_rbDSort, 'rbDSort', 'lo', '日內最低', '達標日最低價對前收的中位數。掛單掛在這裡附近才接得到')
    + rbSortTh(_rbDSort, 'rbDSort', 'cc', '當日收盤', '達標日收盤對前收的中位數');
  RB_DIP_HOLDS.forEach(function (h, j) {
    html += rbSortTh(_rbDSort, 'rbDSort', 'w' + j, (h === 1 ? '隔日' : '第 ' + h + ' 日') + '翻正',
      '買在達標日收盤，' + h + ' 個交易日之後收盤是正報酬的比例；小字是報酬中位數與天數');
  });
  html += '</tr></thead><tbody>';

  // 價格放主體、百分比降為小字。掛單要抄的是價格，百分比只是用來判斷哪一欄。
  // 與成交率表、債券表、隔夜推估同一個主從關係。
  var pxCell = function (pc, v, bold) {
    if (v == null) return '<td class="num rs-dim">—</td>';
    var body = '<span class="rb-gsub" style="color:' + _rbCol(v) + '">' + _rbPct(v, 2) + '</span>';
    if (!(pc > 0)) return '<td class="num">' + body + '</td>';
    var q = pc * (1 + v / 100), t = q < 50 ? 0.01 : 0.05;
    return '<td class="num"><span class="rb-fpx"' + (bold ? ' style="font-size:15px"' : '') + '>'
      + (Math.round(q / t) * t).toFixed(2) + '</span>' + body + '</td>';
  };
  var wcell = function (f) {
    if (!f || !f.n) return '<td class="num rs-dim">—</td>';
    // 翻正機率不上紅綠。綠色在這一頁是「跌」，而翻正講的是漲，
    // 機率越高標越綠會讓人第一眼讀成相反的意思。
    // 機率本身用粗細表達強弱，紅綠留給旁邊的報酬中位數（那個真的是漲跌）。
    return '<td class="num"><span style="font-weight:700;color:'
      + (f.up >= 50 ? 'var(--text)' : 'var(--text3)') + '">' + f.up.toFixed(0) + '%</span>'
      + '<span class="rb-gsub" style="color:' + _rbCol(f.med) + '">' + _rbPct(f.med, 2) + '</span>'
      + '<span class="rb-gsub">' + f.n + ' 天</span></td>';
  };
  var line = function (code, name, d, isIdx) {
    var pc = d.last;
    var h = '<tr' + (isIdx ? ' class="rb-sysrow"' : '') + '>'
      + '<td><span class="tx-ocode">' + code + '</span><span class="tx-oname">' + name + '</span></td>'
      + _rbBaseTd(pc, isIdx ? idx : (_rbData.series[code] || []))
      + '<td class="num rs-dim">' + d.n + ' 天</td>'
      + pxCell(pc, d.gap)
      + pxCell(pc, d.lo, true)        // 掛限價買進接得到的位置，這一欄放最大
      + pxCell(pc, d.cc);
    d.fwd.forEach(function (f) { h += wcell(f); });
    return h + '</tr>';
  };
  var dval = function (r, k) {
    if (k === 'code') return r.c;
    if (k === 'px') return r.d.last;
    if (k === 'n') return r.d.n;
    var m = /^w(\d+)$/.exec(k);
    if (m) { var f = r.d.fwd[+m[1]]; return f ? f.up : null; }
    return r.d[k] == null ? null : r.d[k];
  };
  rbSortRows(rows, _rbDSort, dval)
    .forEach(function (r) { html += line(r.c, _rbName(r.c), r.d, false); });
  if (twD) html += line('大盤', '加權指數', twD, true);
  html += '</tbody></table></div>';

  var ex = rows.reduce(function (a, r) { return a + r.d.exdiv; }, 0);
  html += '<div class="rb-caveat">「翻正」是買在<b>達標日收盤</b>之後 N 個交易日的報酬，'
    + '不是「對前收回來了沒」。最後幾個達標日還沒走滿天數，所以越右邊的欄位分母越小，各欄自己標。'
    + '除息日整根排除（還原係數有沒有變動），本次共排掉 ' + ex + ' 日。'
    + '開高低是未還原價，「前收」那幾欄跨除息日會把配息算成跳空，判法與大漲那一邊相同。</div>';
  html += '</div>';
  return html;
}

// ── 隔夜費半條件卡 ──
// 決策視圖：未達門檻收成一行，達門檻才展表。分析視圖：一律展表。
// 本卡不受「系統性」標記影響：那些標記是標在跌深事件上的，跟隔夜費半是兩組条件。
function _rbSoxHtml(view) {
  var cfg = _rbData.cfg;
  if (!cfg.soxOn) return '';
  var sox = _rbData.sox;
  if (!sox) {
    return '<div class="rb-caveat nb-keep">費半（^SOX）日線取不到（代理服務無回應或樣本不足），'
      + '隔夜條件卡略過；下方主表不受影響。</div>';
  }
  var L = sox.last;
  var side = _rbSoxSide(sox);
  var ana0 = (view === 'ana');
  var shown = (ana0 && _rbSoxView) ? _rbSoxView : (side || 'up');
  var on = (side === shown);
  var hit = _rbSoxHit(sox, shown);
  var idx = _rbData.idx, lastTw = idx[idx.length - 1];
  // 費半最後一根落在台股最後一根的後面 → 台股還沒反應（同一日期的美股盤在台股收盤之後）
  var pending = L.d >= lastTw.d;

  // 美股這一盤收了沒。沒收的話這個數字還會動，而門檻判定會跟著翻面：
  // 2026-11-14 實測同一根 00:34 是 −4.89%、03:06 是 −3.80%，一個多小時回了 1.1 個百分點，
  // 而大跌門檻 −3.37% 離 −3.80% 只剩 0.43。不標的話會把半場的分數當成終場。
  var liveS = (typeof _ovSoxLive !== 'undefined') ? _ovSoxLive : null;
  var sess = (liveS && liveS.open === true) ? '<b style="color:var(--caution)">盤中，還會變</b>'
    : ((liveS && liveS.open === false) ? '已收盤' : '');
  var head = '費半 <b style="color:' + _rbCol(L.r) + '">' + _rbPct(L.r, 2)
    + '</b>（' + L.d + (sess ? '，' + sess : '') + '，自身第 '
    + (L.rank == null ? '—' : L.rank.toFixed(0)) + ' 百分位）。'
    + '門檻 大漲 <b>' + _rbPct(sox.thr, 2) + '</b>／大跌 <b>' + _rbPct(sox.thrDn, 2) + '</b>。';

  if (!side && !ana0) {
    return '<div class="rb-sox rb-sox-off nb-keep">隔夜費半兩邊都沒達標。' + head + '</div>';
  }
  var sideBtn = !ana0 ? '' : '<div class="rb-sideb">'
    + '<button class="pv-tab' + (shown === 'up' ? ' on' : '') + '" onclick="rbSoxSide(\'up\')">大漲那一邊</button>'
    + '<button class="pv-tab' + (shown === 'dn' ? ' on' : '') + '" onclick="rbSoxSide(\'dn\')">大跌那一邊</button></div>';

  if (shown === 'dn') return _rbSoxDnHtml(sox, hit, head, sideBtn, on, pending);

  var rows = _rbData.codes.map(function (c) {
    return { c: c, s: _rbSoxFwd(_rbData.series[c] || [], sox, true, hit),
             g: _rbSoxGap(_rbData.series[c] || [], sox, hit) };
  }).filter(function (r) { return r.s; });
  rows.sort(function (a, b) { return b.s.med - a.s.med; });
  var twS = _rbSoxFwd(idx, sox, false, hit), twG = _rbSoxGap(idx, sox, hit);

  var html = '<div class="rb-sox">' + sideBtn;
  html += '<div class="sec-title">隔夜費半大漲之後，台股當天</div>';
  html += '<div class="rb-sox-hd' + (on ? ' on' : '') + '">'
    + (on ? '已達大漲門檻。' : '今天不在這一邊（下表是歷史分布）。') + head;
  if (on && pending) {
    // 台股上一個交易日對到的費半是否也達標 → 今天就是連續第二根
    var u2 = sox.prev(lastTw.d), prevHit = (u2 != null && sox.rets[u2] >= sox.thr);
    html += '這一夜還沒進市場。'
      + (prevHit ? '<b>連續第二根以上</b>（起點已被墊高）。'
                 : '<b>訊號的第一根</b>。');
  } else if (on) {
    html += '台股已反應過，下表是歷史分布。';
  }
  html += '</div>';

  if (!rows.length) {
    html += '<div class="rb-caveat nb-keep">這組門檻下沒有任何一檔有樣本：'
      + '要麼門檻太嚴（第 ' + cfg.soxPct + ' 百分位），要麼這幾檔上市後還沒碰過。'
      + '參數設定 → 跌深反彈訊號 調低百分位。</div></div>';
    return html;
  }

  var ana = (view === 'ana');
  var reg = _rbRegime(idx, cfg.regWin);
  var regNow = _rbRegimeNow(idx, cfg.regWin);
  var nowDn = (regNow != null && regNow < 0);
  var fills = {};
  _rbData.codes.forEach(function (c) { fills[c] = _rbFill(_rbData.series[c] || [], sox, reg, hit); });
  var twF = _rbFill(idx, sox, reg, hit);

  html += '<div class="rb-sox-hd">現在是<b>' + (nowDn ? '連跌後' : '上漲中')
    + '</b>（大盤近 ' + cfg.regWin + ' 日 <b style="color:' + _rbCol(regNow) + '">'
    + _rbPct(regNow, 2) + '</b>）。小字是<b>連跌後／上漲中</b>的成交率。</div>';

  html += '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>'
    + rbSortTh(_rbFSort, 'rbFSort', 'code', '代號 / 名稱').replace('class="num ', 'class="')
    + rbSortTh(_rbFSort, 'rbFSort', 'px', '前收')
    + rbSortTh(_rbFSort, 'rbFSort', 'up', '上漲機率')
    + rbSortTh(_rbFSort, 'rbFSort', 'gap', '開盤跳空', '達標日的開盤跳空中位數；漲幅幾乎全在這裡給完');
  RB_FILL_OFFS.forEach(function (k, j) {
    html += rbSortTh(_rbFSort, 'rbFSort', 'f' + j,
      (k === 0 ? '平盤' : (k > 0 ? '＋' : '−') + Math.abs(k) + '%'),
      '排序依' + (nowDn ? '連跌後' : '上漲中') + '的成交率（依價格排等於依前收排，重複）');
  });
  html += rbSortTh(_rbFSort, 'rbFSort', 'n', '樣本 跌／漲', '左為連跌後的天數、右為上漲中；排序依今天那一邊')
    + '</tr></thead><tbody>';

  var rate = function (v, on) {
    if (v == null) return '<span class="dm-dim">—</span>';
    return '<span class="' + (on ? (v >= 60 ? 'bs-hi' : (v >= 30 ? 'bs-mid' : 'bs-lo')) : 'bs-off') + '">'
      + v.toFixed(0) + '%</span>';
  };
  var fline = function (code, name, st, g, f, isIdx) {
    var h = '<tr' + (isIdx ? ' class="rb-sysrow"' : '') + '>'
      + '<td><span class="tx-ocode">' + code + '</span><span class="tx-oname">' + name + '</span></td>';
    if (!f) {
      return h + '<td class="num rs-dim" colspan="' + (RB_FILL_OFFS.length + 4)
        + '">沒有可算的樣本</td></tr>';
    }
    var pc = f.last, tk = (typeof ovTick === 'function') ? null : null;
    h += _rbBaseTd(pc, isIdx ? _rbData.idx : (_rbData.series[code] || []))
      + '<td class="num" style="font-weight:700">' + (st ? st.up.toFixed(0) + '%' : '—') + '</td>'
      + '<td class="num" style="color:' + _rbCol(g ? g.gap : null) + '">' + (g ? _rbPct(g.gap, 2) : '—') + '</td>';
    RB_FILL_OFFS.forEach(function (k, j) {
      var px = pc * (1 + k / 100);
      var t = px < 50 ? 0.01 : 0.05;
      var ap = Math.round(px / t) * t;
      // 價格是要抄進委託單的那個數字，放主體；成交率降為輔助小字
      h += '<td class="num"><span class="rb-fpx">' + ap.toFixed(2) + '</span>'
        + '<span class="rb-frate">'
        + rate(f.dn.p ? f.dn.p[j] : null, nowDn) + '<span class="bs-slash">／</span>'
        + rate(f.up.p ? f.up.p[j] : null, !nowDn) + '</span></td>';
    });
    h += '<td class="num rs-dim">' + f.dn.n + ' ／ ' + f.up.n + ' 天</td></tr>';
    return h;
  };
  var fval = function (r, k) {
    var f = fills[r.c];
    if (k === 'code') return r.c;
    if (k === 'px') return f ? f.last : null;
    if (k === 'up') return r.s ? r.s.up : null;
    if (k === 'gap') return r.g ? r.g.gap : null;
    if (k === 'n') return f ? (nowDn ? f.dn.n : f.up.n) : null;
    var m = /^f(\d+)$/.exec(k);
    if (m && f) {
      var g = nowDn ? f.dn : f.up;
      return g.p ? g.p[+m[1]] : null;
    }
    return null;
  };
  rbSortRows(rows, _rbFSort, fval)
    .forEach(function (r) { html += fline(r.c, _rbName(r.c), r.s, r.g, fills[r.c], false); });
  if (twS) html += fline('大盤', '加權指數', twS, twG, twF, true);
  html += '</tbody></table></div>';

  var thin = rows.filter(function (r) { return r.s.n < 20; });

  if (ana) {
    var gr = rows.filter(function (r) { return r.g; });
    if (gr.length) {
      var ex = gr.reduce(function (a, r) { return a + r.g.exdiv; }, 0);
      html += '<div class="sec-title">達標日的日內形狀（皆為中位數）</div>'
        + '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>'
        + rbSortTh(_rbGSort, 'rbGSort', 'code', '代號 / 名稱').replace('class="num ', 'class="')
        + rbSortTh(_rbGSort, 'rbGSort', 'px', '前收')
        + rbSortTh(_rbGSort, 'rbGSort', 'n', '樣本')
        + rbSortTh(_rbGSort, 'rbGSort', 'gap', '開盤跳空')
        + rbSortTh(_rbGSort, 'rbGSort', 'oc', '開盤→收盤')
        + rbSortTh(_rbGSort, 'rbGSort', 'hi', '日內最高')
        + rbSortTh(_rbGSort, 'rbGSort', 'lo', '日內最低')
        + rbSortTh(_rbGSort, 'rbGSort', 'cc', '全日收盤')
        + rbSortTh(_rbGSort, 'rbGSort', 'fade', '開盤後下跌的日子')
        + '</tr></thead><tbody>';
      // 百分比不能抄進委託單：每一欄都把中位數換成價格（前收×(1+%)，對齊升降單位）。
      // 開盤→收盤是同一天兩個價相除，沒有「對前收」的基準，維持百分比。
      // 同樣是價格主體、百分比小字。「開盤→收盤」沒有對前收的基準，維持純百分比。
      var gcell = function (pc, v) {
        if (v == null) return '<td class="num rs-dim">—</td>';
        var sub = '<span class="rb-gsub" style="color:' + _rbCol(v) + '">' + _rbPct(v, 2) + '</span>';
        if (!(pc > 0)) return '<td class="num">' + sub + '</td>';
        var q = pc * (1 + v / 100), t = q < 50 ? 0.01 : 0.05;
        return '<td class="num"><span class="rb-fpx">' + (Math.round(q / t) * t).toFixed(2) + '</span>' + sub + '</td>';
      };
      var gline = function (code, name, g, isIdx, pc) {
        return '<tr' + (isIdx ? ' class="rb-sysrow"' : '') + '>'
          + '<td><span class="tx-ocode">' + code + '</span><span class="tx-oname">' + name + '</span></td>'
          + _rbBaseTd(pc, isIdx ? idx : (_rbData.series[code] || []))
          + '<td class="num rs-dim">' + g.n + ' 天</td>'
          + gcell(pc, g.gap)
          + '<td class="num" style="color:' + _rbCol(g.oc) + ';font-weight:700">' + _rbPct(g.oc, 2) + '</td>'
          + gcell(pc, g.hi)
          + gcell(pc, g.lo)
          + gcell(pc, g.cc)
          + '<td class="num rs-dim">' + g.fade.toFixed(0) + '%</td></tr>';
      };
      var lastC = function (c) {
        var b = _rbData.series[c] || [];
        return b.length ? b[b.length - 1].c : null;
      };
      var gval = function (r, k) {
        if (k === 'code') return r.c;
        if (k === 'px') return lastC(r.c);
        if (k === 'n') return r.g.n;
        return r.g[k] == null ? null : r.g[k];
      };
      rbSortRows(gr, _rbGSort, gval)
        .forEach(function (r) { html += gline(r.c, _rbName(r.c), r.g, false, lastC(r.c)); });
      if (twG) html += gline('大盤', '加權指數', twG, true, idx[idx.length - 1].c);
      html += '</tbody></table></div>'
        + '<div class="rb-caveat">開高低都是未還原價，所以跟「昨收」相比時跨除息日會把配息算成跳空缺口。'
        + '除息日用還原係數（還原收盤 ÷ 收盤）是否變動判定並整根排除，'
        + '不自己維護除息日清單；本次共排掉 ' + ex + ' 日。'
        + '「開盤→收盤」是同一天的兩個價相除，沒有這個問題。</div>';
    }
    if (twS) {
      html += '<div class="rb-caveat rs-dim nb-keep">符合條件的台股交易日（' + twS.n + ' 天）：'
        + twS.dates.join('、') + '</div>';
    }
  }
  html += '</div>';
  return html;
}

// 費半大跌那一邊的六欄
function _rbSoxDipSixHtml() {
  if (!_rbData || !_rbData.cfg.soxOn || !_rbData.sox) return '';
  var sox = _rbData.sox, cfg = _rbData.cfg;
  return '<dt>費半大跌後的翻正機率 · 定義</dt><dd>挑出「前一夜費半 ≤ 大跌門檻」的台股交易日'
    + '（門檻是費半自身日報酬的第 ' + (100 - cfg.soxPct) + ' 百分位，近 ' + cfg.years + ' 年算出來是 '
    + _rbPct(sox.thrDn, 2) + '，共 ' + sox.hitDn + ' 個費半交易日）。'
    + '假設在那一天的台股收盤買進，看 1、3、5 個交易日之後的收盤是不是正報酬，'
    + '列出正報酬的比例與報酬中位數。個股用還原收盤，除息日整根排除。</dd>'
    + '<dt>費半大跌後的翻正機率 · 比較基準</dt><dd>跟「隨便哪一天買進」比才有意義，而這張表<b>沒有給那個對照</b>。'
    + '表尾的大盤那一列是唯一的橫向對照：個股的翻正機率高於大盤，差額才是這幾檔自己的東西。'
    + '所以這張表不能用來證明「費半大跌隔天買進比較好」，只能用來比較這幾檔之間誰反彈得快。</dd>'
    + '<dt>費半大跌後的翻正機率 · 白話意義</dt><dd>費半昨晚重挫，如果你今天收盤接下來，'
    + '歷史上過幾天會回到成本之上的比例大概是多少、通常賺賠多少。</dd>'
    + '<dt>費半大跌後的翻正機率 · 機制</dt><dd>這幾檔重押台股半導體供應鏈，費半是同一條供應鏈的海外定價。'
    + '傳導路徑：<code>費半收盤 → 台積電 ADR 與夜盤期貨先反應 → 隔日台股開盤缺口</code>。'
    + '跌的那一邊多了一件漲的那一邊沒有的事：開盤跳空會把跌幅先給完一部分，'
    + '所以「日內最低」通常比「開盤跳空」更深，掛在跳空價接不到的單，掛在日內最低附近才接得到。'
    + '至於為什麼過幾天會翻正，機制不在費半，在於這類急殺多半是情緒定價、'
    + '基本面沒有同步變化，所以價格會往回走。這也是它最容易失效的地方：'
    + '當跌勢真的來自基本面（例如終端需求轉弱），價格不會往回走，而這張表分不出這兩種。</dd>'
    + '<dt>費半大跌後的翻正機率 · 行動含義</dt><dd>它給的是掛價與等待天數的參考，不是進出訊號。'
    + '「日內最低」那一欄換算出來的價格是掛限價買進真正接得到的位置；'
    + '翻正機率那幾欄告訴你接到之後大概要等幾天才看得到正報酬。'
    + '機率低於五成的那幾檔，意思是這個情境在它身上沒有優勢，單憑這張表不足以支撐買進。</dd>'
    + '<dt>費半大跌後的翻正機率 · 不能告訴你什麼</dt><dd>四件事。'
    + '一、分不出情緒急殺與基本面轉弱，而這兩者的後續完全相反（見機制）。'
    + '二、樣本 ' + sox.hitDn + ' 個費半交易日看起來不少，但同一段修正會連續好幾天都達門檻，'
    + '真正獨立的事件遠少於天數，1、3、5 日三欄之間又高度重疊，區間比數字看起來寬得多。'
    + '三、沒有「隨便哪一天買進」的對照，所以證明不了這個情境本身有優勢。'
    + '四、費半那一根若還在盤中（卡頭會標），門檻判定可能在收盤前翻面，'
    + '現在看到的這一邊未必是最後成立的那一邊。</dd>';
}

// 日內形狀（開盤跳空）的六欄
// 成交率表的六欄。決策視圖只留這一段，而且是收合的。
function _rbFillSixHtml() {
  if (!_rbData || !_rbData.cfg.soxOn || !_rbData.sox) return '';
  var w = _rbData.cfg.regWin;
  return '<dt>成交率表怎麼用</dt><dd>找到你想掛的價（格子底下那個數字，已對齊升降單位），'
    + '上面的百分比就是「達標日裡有多少比例的日子，日內最低價碰得到它」。'
    + '兩個數字是<b>連跌後／上漲中</b>，以大盤近 ' + w + ' 日累計是正是負區分（可在參數設定改）。</dd>'
    + '<dt>連跌後反而更難成交</dt><dd>七檔方向一致。實測掛平盤的成交率：'
    + '判定窗 2 日時連跌後 17%、上漲中 24%；3 日 12% vs 33%；5 日 3% vs 41%。'
    + '跌得越久越不會回到昨收——因為連跌加費半大漲是最強的跳空組合，'
    + '漲幅在開盤就給完了（見「開盤跳空」那一欄）。</dd>'
    + '<dt>這張表不能告訴你什麼</dt><dd>成交率高不代表買得劃算：'
    + '跌得多當然容易成交，那正是價格在走弱。'
    + '樣本最少的只有十幾天（最右邊那一欄），一天就能改寫幾個百分點。'
    + '它也不保證你那個數量排得進去。</dd>';
}

function _rbGapSixHtml() {
  if (!_rbData.cfg.soxOn || !_rbData.sox) return '';
  var gs = _rbData.codes.map(function (c) { return _rbSoxGap(_rbData.series[c] || [], _rbData.sox); })
    .filter(Boolean);
  if (!gs.length) return '';
  var fmin = Math.min.apply(null, gs.map(function (g) { return g.fade; }));
  var fmax = Math.max.apply(null, gs.map(function (g) { return g.fade; }));
  return '<dt>開盤跳空 · 定義</dt><dd><code>開盤跳空 ＝ 當日開盤 ÷ 前一日收盤 − 1</code>；'
    + '<code>開盤→收盤 ＝ 當日收盤 ÷ 當日開盤 − 1</code>；'
    + '<code>全日收盤 ＝ 當日收盤 ÷ 前一日收盤 − 1</code>。'
    + '都只取達標日（前一夜費半 ≥ 門檻）的中位數。'
    + '開高低是未還原價，跨除息日會把配息算成跳空，'
    + '所以除息日整根排掉 —— 判定方式是還原係數（還原收盤 ÷ 收盤）'
    + '在前後兩根之間有沒有變，不自己維護除息日清單。</dd>'
    + '<dt>開盤跳空 · 比較基準</dt><dd>兩個。一是「跳空」跟「開盤後」互比，'
    + '回答漲幅是哪一段給的；二是「日內最低」跟你的掛價比，回答限價買進能不能成交。'
    + '主表那一欄中位數是收盤對收盤，跟成交與否無關。</dd>'
    + '<dt>開盤跳空 · 白話意義</dt><dd>這一天的漲幅是開盤就跳上去的，'
    + '還是開盤後慢慢走上去的。</dd>'
    + '<dt>開盤跳空 · 機制</dt><dd>隤夜費半的資訊在台股開盤前就已經全部公開，'
    + '集合競價一次反應完；開盤之後沒有新的隤夜資訊進來，'
    + '所以盤中的中位數接近 0。這不是「盤中不會動」，'
    + '是「盤中的漲跟跌差不多抵掉」 —— 開盤後下跌的日子有 '
    + fmin.toFixed(0) + '%～' + fmax.toFixed(0) + '%。</dd>'
    + '<dt>開盤跳空 · 行動含意</dt><dd>掛限價買進時，掛價要跟「日內最低」比，'
    + '不是跟「收盤」比。掛在跳空幅度之下，成交的前提是它從開盤跌回來，'
    + '而中位的日子不會。反過來，掛到能吃到開盤的位置，'
    + '成本就已經含了跳空那一段，當天幾乎不會再走 —— 要赚的是後面幾天，'
    + '那是主表（跌深後持有 N 日）在回答的。</dd>'
    + '<dt>開盤跳空 · 不能告訴你什麼</dt><dd>四件事。'
    + '一、只給中位數的形狀，不給路徑。開盤後下跌的日子有 '
    + fmin.toFixed(0) + '%～' + fmax.toFixed(0) + '%，「開盤後 ≈ 0」是中位數，不是每天都 0。'
    + '二、不算「某個掛價的成交率」。那要逐檔逐價位掃一遍，本頁沒做，'
    + '要評估具體掛價得另外算。'
    + '三、開盤跳空用的是集合競價的成交價，它不保證你那個數量排得進去；'
    + '這幾檔成交量不大，張數大的時候實際成交價會比表上差。'
    + '四、連續第二根訊號時跳空會不會變小，樣本不足判斷不出來（見前一項說明）。</dd>';
}

// 隔夜費半條件卡的六欄
function _rbSoxSixHtml() {
  if (!_rbData.cfg.soxOn || !_rbData.sox) return '';
  var cfg = _rbData.cfg, sox = _rbData.sox;
  return '<dt>隔夜費半 · 定義</dt><dd>每一個台股交易日往前找「日期小於它的最後一個費半交易日」'
    + '（台股 13:30 收盤時美股當天還沒開，所以同一日期的美股盤算隔夜）。'
    + '該費半日漲幅 ≥ 門檻的挑出來，統計各檔在對應台股交易日的當日漲跌'
    + '（<code>還原收盤 ÷ 前一日還原收盤 − 1</code>）。'
    + '門檻不寫死成百分比，寫成費半自身日報酬的第 ' + cfg.soxPct
    + ' 百分位（近 ' + cfg.years + ' 年 ' + sox.n + ' 個交易日算出來是 ' + _rbPct(sox.thr, 2)
    + '），因為「幾 % 算大漲」本身會隨市況變。</dd>'
    + '<dt>隔夜費半 · 比較基準</dt><dd>表尾那一列是大盤。'
    + '個別 ETF 的中位數要跟大盤比，才分得出「它自己彈得多」與「只是跟著大盤漲」。'
    + '第二個基準是各檔互相比，回答同樣一個隔夜消息下哪一檔幅度大。'
    + '沒有跟「任意一天」的平均漲幅比，所以這張表不證明「費半大漲雔天進場比較好」。</dd>'
    + '<dt>隔夜費半 · 白話意義</dt><dd>費半昨晚大漲，歷史上這一檔雔天通常漲多少、漲的機率有多高。'
    + '用來估量級：今天是「漲一點點」還是「漲一大段」。</dd>'
    + '<dt>隔夜費半 · 機制</dt><dd>這幾檔重押台股半導體供應鏈，費半是同一條供應鏈的海外定價。'
    + '傳導路徑：<code>費半收盤 → 台積電 ADR 與夜盤期貨先反應 → 雔日台股開盤缺口</code>。'
    + '主動式 ETF 的持股集中度比大盤高，同一個隔夜消息到它們身上會放大；'
    + '放大是雙向的，所以「最低」那一欄有幾檔是負的 —— 費半大漲雔天台股開高走低是發生過的。</dd>'
    + '<dt>隔夜費半 · 行動含義</dt><dd>它說的是幅度，不是進出。'
    + '配下方主表的部位欄一起看：若今天往上跳，已經越過停利門檻的那幾檔會越跨越多；'
    + '若你在分段接，這一欄告訴你「今天掛原價大概掛不到」。'
    + '要掛多少、要買幾張，這一頁不算。</dd>'
    + '<dt>隔夜費半 · 不能告訴你什麼</dt><dd>四件事。'
    + '一、分不出第二根會不會比第一根弱。表上把兩種日子混在同一組樣本裡；'
    + '拆開算過，連續第二根的日子各檔只有 1～2 天、大盤 4 天，'
    + '全部收紅但中位數方向各檔不一致（大盤比第一根高、ETF 多數比第一根低）。'
    + 'n 這麼少判斷不出來，目前當成未知，不給結論。'
    + '卡頭會直接講明今天是第一根還是第二根，不用你自己對日期。'
    + '二、隔夜漲幅不等於開盤漲幅，開高走低也算在這組樣本裡；'
    + '台指期夜盤才是更貼近開盤的指標，但 Yahoo 沒有夜盤歷史，'
    + '這一層滑移本頁無法量化。'
    + '三、只說當天，不說後面幾天會不會吐回去 —— 那是下方主表在回答的。'
    + '四、持股含外國成分的主動式 ETF 不受 10% 漲停限制（資料裡出現過單日超過 10% 的樣本），'
    + '「最高」那一欄沒有制度上的天花板，相對地下檔也沒有保護。</dd>';
}

// ══════════ 部位（沿用既有基準，不另外算一份）══════════
// 成本、損益、含息獲利率一律呼叫 inventory.js 的 invMetrics：
// 那裡已經處理過「券商淨成本已扣配息要還原」與認購成本補正，
// 在這裡重算一份必然會跟庫存頁對不起來。含稅費也跟著頂欄的切換走。
function _rbPos(code) {
  var ps = (typeof _positions !== 'undefined' && _positions) || [];
  for (var i = 0; i < ps.length; i++) {
    if (String(ps[i].code) !== code) continue;
    if (typeof invMetrics !== 'function') return null;
    try { return invMetrics(ps[i]); } catch (e) { hush('rebound', e); return null; }
  }
  return null;
}
function _rbAlert(code) {
  return ((typeof loadAlerts === 'function' ? loadAlerts() : {}) || {})[code] || null;
}

// 年化波動率：日報酬標準差 × √252。用還原收盤，否則除息日會被當成一次大跌、把波動灌高。
function _rbVol(bars) {
  if (!bars || bars.length < 30) return null;
  var r = [];
  for (var i = 1; i < bars.length; i++) if (bars[i - 1].a > 0) r.push(bars[i].a / bars[i - 1].a - 1);
  if (r.length < 30) return null;
  var m = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
  var v = r.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

function _rbMoney(v) {
  if (v == null) return '—';
  return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('zh-TW');
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

// ── 決策視圖：手上的部位現況，接上這一檔跌深之後的歷史分布，同一列看完。──
// 分開兩張表的話，判斷「這一檔現在能不能接／該不該停利」要自己對代號，
// 那等於把合併的工作丟回去。
var RB_SORT_LS = 'rebound_sort_v1';
var _rbSort = (function () {
  try { var v = localStorage.getItem(RB_SORT_LS); if (v) return v; } catch (e) {}
  return 'medDesc';
})();
function rbSort(key) {
  _rbSort = (_rbSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  try { localStorage.setItem(RB_SORT_LS, _rbSort); } catch (e) {}
  rbRender();
}
function _rbTh(key, label, cls) {
  var on = (_rbSort === key + 'Asc' || _rbSort === key + 'Desc');
  var ind = _rbSort === key + 'Asc' ? '▲' : (_rbSort === key + 'Desc' ? '▼' : '↕');
  return '<th class="' + (cls || 'num') + ' sort-th' + (on ? ' sorted' : '') + '" onclick="rbSort(\'' + key + '\')">'
    + label + '<span class="sort-ind">' + ind + '</span></th>';
}

function _rbDecHtml(dates, usableEps, sysEps) {
  var cfg = _rbData.cfg, h = cfg.holds[cfg.holds.length - 1];
  var rows = _rbData.codes.map(function (c) {
    var s = _rbFwd(_rbData.series[c] || [], dates, h);
    var p = _rbPos(c), a = _rbAlert(c);
    var price = p ? (p.cost && p.shares ? null : null) : null;
    // 現價：invMetrics 沒回現價，從同一份報價取（與庫存頁同一個來源）
    var r0 = (typeof _rows !== 'undefined' && _rows[c]) || null;
    price = (r0 && r0.close != null) ? r0.close : null;
    var gap = (price != null && p && p.avg) ? (price - p.avg) / p.avg * 100 : null;
    return {
      c: c, s: s, p: p, a: a, price: price, gap: gap,
      vol: _rbVol(_rbData.series[c] || []),
      avg: p ? p.avg : null, cost: p ? p.cost : null, val: p ? p.val : null,
      prate: p ? p.prate : null, div: p ? p.div : null, wrate: p ? p.wrate : null,
      chg: p ? p.chg : null,
      up: s ? s.up : null, med: s ? s.med : null, min: s ? s.min : null
    };
  });
  var withStat = rows.filter(function (r) { return r.s; });
  if (!withStat.length) {
    return '<div class="detail-note nb-keep">歷史樣本不足：沒有走滿 ' + h
      + ' 個交易日的非系統性觸發事件，無法給出機率。'
      + '放寬門檻或拉長歷史長度（參數設定 → 跌深反彈訊號）才有樣本。</div>';
  }

  var key = _rbSort.replace(/(Asc|Desc)$/, ''), dir = /Asc$/.test(_rbSort) ? 1 : -1;
  rows.sort(function (a, b) {
    if (key === 'code') return a.c < b.c ? -dir : (a.c > b.c ? dir : 0);
    var x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // 沒有資料的一律沉底，不隨升降冪跑到最前面
    if (y == null) return -1;
    return (x - y) * dir;
  });

  var hasPos = rows.some(function (r) { return r.p; });
  var html = '<div class="sec-title">部位現況 ＋ 跌深之後持有 ' + h + ' 個交易日</div>';
  if (!hasPos) {
    html += '<div class="rb-caveat nb-keep">部位欄位是空的：行情與庫存尚未載入（未登入或券商連線未建立）。'
      + '按「↻ 重新整理」重試；統計欄位不受影響。</div>';
  }
  html += '<div class="rs-cat-wrap"><table class="inv-table rb-table rb-dec"><thead><tr>'
    + '<th rowspan="2">代號 / 名稱</th>'
    + '<th colspan="7" class="rb-grp">現在手上的部位</th>'
    + '<th colspan="4" class="rb-grp">跌深後持有 ' + h + ' 日（歷史）</th></tr><tr>'
    + _rbTh('price', '現價')
    + _rbTh('avg', '原始均價')
    + _rbTh('gap', '現價 vs 均價')
    + _rbTh('cost', '原始成本')
    + _rbTh('val', '現值')
    + _rbTh('div', '已配息')
    + _rbTh('wrate', '含息獲利率')
    + _rbTh('up', '上漲機率')
    + _rbTh('med', '報酬中位數')
    + _rbTh('min', '最差一次')
    + '<th class="num">樣本</th>'
    + '</tr></thead><tbody>';

  rows.forEach(function (r) {
    // 現價格底下掛買進價門檻：決定「分段接」掛多少的時候要看的就是這兩個
    // 差距為負＝門檻已經越過，寫「已達」而不是寫一個負數：
    // 「差 −2.8pp」要讀的人自己翻譯成「已經超過了」，那是把判讀丟回去。
    var gapTxt = function (label, unit, diff, dec) {
      if (diff <= 0) return '<div class="rb-sub3 rb-hit">' + label + '　已達（超過 '
        + Math.abs(diff).toFixed(dec) + unit + '）</div>';
      return '<div class="rb-sub3">' + label + '（差 ' + diff.toFixed(dec) + unit + '）</div>';
    };
    var buyLine = '';
    if (r.a && r.a.buyPrice != null && r.price != null) {
      // 買進價是「跌到這個價才買」→ 現價越低越接近，差距＝現價 − 門檻
      buyLine = gapTxt('買進 ' + r.a.buyPrice, '', r.price - r.a.buyPrice, 2);
    } else if (r.price != null) {
      buyLine = '<div class="rb-sub3 rs-dim">未設買進價</div>';
    }
    // 含息獲利率底下掛停利門檻：決定「要不要停利」看的是這兩個
    var tpLine = '';
    if (r.a && r.a.tpRate != null && r.wrate != null) {
      tpLine = gapTxt('停利 ' + r.a.tpRate + '%', 'pp', r.a.tpRate - r.wrate, 1);
    } else if (r.a && r.a.tpPrice != null && r.price != null) {
      tpLine = gapTxt('停利 ' + r.a.tpPrice, '', r.a.tpPrice - r.price, 2);
    } else if (r.wrate != null) {
      tpLine = '<div class="rb-sub3 rs-dim">未設停利</div>';
    }
    var s = r.s;
    html += '<tr><td><span class="tx-ocode">' + r.c + '</span><span class="tx-oname">' + _rbName(r.c) + '</span>'
      + (r.vol != null ? '<div class="rb-sub3 rs-dim">年化波動 ' + r.vol.toFixed(1) + '%</div>' : '') + '</td>'
      + '<td class="num">' + (r.price == null ? '—' : r.price.toFixed(2))
        + (r.chg != null ? '<div class="rb-sub3" style="color:' + _rbCol(r.chg) + '">' + _rbPct(r.chg, 2) + '</div>' : '')
        + buyLine + '</td>'
      + '<td class="num">' + (r.avg == null ? '—' : r.avg.toFixed(2)) + '</td>'
      + '<td class="num" style="color:' + _rbCol(r.gap) + ';font-weight:700">' + _rbPct(r.gap) + '</td>'
      + '<td class="num rs-dim">' + _rbMoney(r.cost) + '</td>'
      + '<td class="num">' + _rbMoney(r.val) + '</td>'
      + '<td class="num rs-dim">' + _rbMoney(r.div) + '</td>'
      + '<td class="num" style="color:' + _rbCol(r.wrate) + ';font-weight:700">' + _rbPct(r.wrate)
        + (r.prate != null ? '<div class="rb-sub3 rs-dim">資本 ' + _rbPct(r.prate) + '</div>' : '')
        + tpLine + '</td>'
      + (s
        ? '<td class="num" style="font-weight:700">' + s.up.toFixed(0) + '%</td>'
          + '<td class="num" style="color:' + _rbCol(s.med) + ';font-weight:700">' + _rbPct(s.med) + '</td>'
          + '<td class="num" style="color:' + _rbCol(s.min) + '">' + _rbPct(s.min) + '</td>'
          + '<td class="num rs-dim">' + s.eps + ' 段 ／ ' + s.n + ' 日</td>'
        : '<td class="num rs-dim" colspan="4">歷史不足 ' + h + ' 日，無統計</td>')
      + '</tr>';
  });
  html += '</tbody></table></div>';
  rows = withStat;

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

  // 決策視圖不放方法論：這一頁的目的是參考不是預測，推估邏輯是寫給自己看的。
  // 完整的六欄留在分析視圖。
  html += '<div class="detail-note"><dl>'
    + (_rbSoxSide(_rbData.sox) === 'dn' ? _rbSoxDipSixHtml() : _rbFillSixHtml()) + '</dl></div>';
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
  html += '<div class="rb-caveat nb-keep">勾起來的事件從上方統計排除。目前 ' + usableEps + ' 段納入、' + sysEps + ' 段排除。'
    + '標記存在 ' + (_rbMStore === 'firestore' ? 'Firestore（已登入）' : '本機瀏覽器（未登入）') + '。</div>';

  html += '<div class="detail-note"><dl>' + _rbSoxSixHtml() + _rbSoxDipSixHtml()
    + _rbGapSixHtml() + _rbSixHtml() + _rbMethodHtml() + '</dl></div>';
  return html;
}

// 部位欄位的六欄
function _rbPosSixHtml() {
  return '<dt>部位欄位 · 定義</dt><dd>全部沿用持股庫存頁的 <code>invMetrics</code>，不在這一頁另算一份。'
    + '<code>原始成本 ＝ 券商淨成本 ＋ 這些批次累積已領的配息</code>（券商的成本已被配息扣過，要先還原，'
    + '否則配息愈多成本看起來愈低、損益率虛胖）；<code>原始均價 ＝ 原始成本 ÷ 持有股數</code>；'
    + '<code>現價 vs 均價 ＝ (現價 − 原始均價) ÷ 原始均價</code>；'
    + '<code>資本損益率 ＝ (現值 − 原始成本) ÷ 原始成本</code>（純價差）；'
    + '<code>含息獲利率 ＝ (價差 ＋ 已落袋配息) ÷ 原始成本</code>。'
    + '現值是否扣賣出手續費與交易稅，跟著頂欄的「含稅費」切換走。'
    + '年化波動率＝日報酬標準差 × √252，用還原收盤算，不然除息日會被當成一次大跌。</dd>'
    + '<dt>部位欄位 · 比較基準</dt><dd>三個基準各管一件事。'
    + '「現價 vs 均價」比的是自己的成本，回答分段接還有多少空間、接下去會把均價拉到哪一邊；'
    + '「含息獲利率」比的是停損停利頁設的停利率門檻（小字那一行就是差距），回答該不該停利；'
    + '「年化波動率」是各檔互相比，回答同樣一筆錢放哪一檔帳面會晃得比較兇。</dd>'
    + '<dt>部位欄位 · 白話意義</dt><dd>這幾欄回答「我現在站在哪裡」。'
    + '右邊的統計欄回答「從這裡往前走，歷史上會怎樣」。兩邊要同一列看：'
    + '歷史反彈中位數再高，如果這一檔已經超過你的停利門檻，那是要賣的情境不是要接的情境。</dd>'
    + '<dt>部位欄位 · 機制</dt><dd>為什麼成本要還原配息：券商的庫存成本是「付出的錢 − 領到的配息」，'
    + '它報的損益因此天生含息。不還原的話，配息領愈多的那幾檔成本愈低、資本損益率愈好看，'
    + '跟真正的價差表現無關，各檔之間也就不能比。還原之後才分得出兩件事 —— '
    + '價差賺多少（資本損益率）、加上配息總共賺多少（含息獲利率）。</dd>'
    + '<dt>部位欄位 · 行動含義</dt><dd>「現價 vs 均價」為負代表接下去會降低均價，'
    + '負得愈多降得愈快；為正代表接下去會墊高均價。'
    + '「含息獲利率」與停利門檻的差距縮到 0 就是停損停利頁會亮燈的時候。'
    + '這兩欄只說明位置，不說明金額 —— 要接多少、要賣幾張，這一頁不算。</dd>'
    + '<dt>部位欄位 · 不能告訴你什麼</dt><dd>兩件事。'
    + '一、不含已出清的批次，所以「已配息」只算還在手上的這些批次領過的，'
    + '不是這檔歷年配息總額，拿來算長期報酬會低估。'
    + '二、現價是最近一筆報價，收盤後到隔天開盤之間是停住的；'
    + '盤前看到的「現價 vs 均價」是昨天的位置，不是現在的。</dd>';
}

// 統計欄位的六欄
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
    + '要掛多遠才會成交看即時持股頁的掛單參考。'
    + '跟左邊的部位欄位合起來才完整：統計說這一檔跌深之後歷史上彈得好，'
    + '部位說你現在的均價在哪、離停利門檻多遠 —— 前者是機會，後者是這個機會對你的意義。</dd>'
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
  return '<dt>這一頁不做什麼</dt><dd>不判定成交機率（那在即時持股頁的掛單參考：掛高／掛低 X 元在 10 分鐘內'
    + '被觸及的比例）、不設定停利停損門檻（那在停損停利頁，這裡只顯示設好的門檻與差距）、'
    + '不算要接多少或賣幾張、不給傾向。列完位置與分布就停。</dd>'
    + '<dt>資料來源</dt><dd>部位欄位來自券商庫存與即時報價（與持股庫存頁同一份，經 invMetrics）。'
    + '統計欄位來自 Yahoo Finance 日線（^TWII、^SOX 與各檔，經 GAS 代理），取 ' + cfg.years + ' 年。'
    + '大盤用未還原收盤（指數無配息），個股用還原收盤。'
    + '盤中最後一根是當日快照、不是定盤，收盤前的觸發判定會變動。</dd>'
    + '<dt>重疊樣本</dt><dd>同一段修正會連續好幾天都達門檻，每一天都算一次樣本，'
    + '所以「樣本 N 日」大於獨立事件數。勝率的分母是觸發日、不是事件。</dd>'
    + '<dt>參數</dt><dd>回看天數、跌幅門檻、持有天數、歷史長度都在 參數設定 → 跌深反彈訊號 可改，'
    + '改完回這一頁按重新整理。門檻沒有「正確值」：' + cfg.look + ' 日 ' + cfg.drop
    + '% 是起始值，改嚴樣本變少、改鬆樣本變雜。</dd>';
}

// ══════════ 參數設定頁的區塊（設定留在本模組，settings.js 只負責擺放）══════════
// 百分位换算成幾 %：只在訊號板已算過時附上，不為了顯示一個數字去重抓行情
function _rbSoxThrTxt() {
  var sox = _rbData && _rbData.sox;
  if (!sox) return '';
  return '（目前≈ ' + _rbPct(sox.thr, 2) + '）';
}
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
    '<span class="set-lb">隔夜費半條件卡</span><span class="set-inline">' +
      '<label class="rb-chk"><input id="rb-soxon" type="checkbox"' + (c.soxOn ? ' checked' : '') +
      ' onchange="rbCfgChanged()"><span>在訊號板上顯示</span></label></span>' +
    '<span class="set-lb">費半門檻百分位</span>' + inp('rb-soxpct', c.soxPct, '1', '百分位' + _rbSoxThrTxt(), 50, 99.9) +
    '<span class="set-lb">情境判定窗</span>' + inp('rb-regwin', c.regWin, '1', '交易日（台股累計負的算連跌後）', 1, 20) +
    '</div>' +
    '<div class="set-hint">目前：' + rbCfgStatus() + '。'
      + '改完到 進場訊號板 按「↻ 重新整理」重算（會重抓日線）。<br>'
      + '回看天數與跌幅門檻決定「什麼叫跌深」：改嚴（天數短、跌幅大）樣本變少但事件更極端，'
      + '改鬆樣本變多但混進一般回檔。歷史長度拉長樣本變多，但愈早的市場結構跟現在差愈多 —— '
      + '主動式 ETF 多半 2025 下半年之後才上市，拉超過上市日也補不出資料。'
      + '持有天數是你打算抱多久，表上每一個天數各算一欄。<br>'
      + '改回看天數或跌幅門檻會動到事件的切分位置：系統性標記是記在「事件起始日」上的，'
      + '切分一變，舊的標記就可能對不上新的事件、變成沒有作用。'
      + '改完請到訊號板的分析視圖確認事件清單上的勾還在正確的那一段。<br>'
      + '費半門檻填的是百分位、不是百分比：填 90 代表「費半自身最大的 10% 漲幅」。'
      + '寫死成幾 % 的話，波動大的年份會天天觸發、波動小的年份永遠不觸發。'
      + '百分位調高樣本變少但事件更極端，調低樣本變多但混進一般上漲日。'
      + '這一卡用費半而不用台指期夜盤：Yahoo 沒有夜盤歷史，'
      + '接本機伺服器的話這一頁就不能離線看。</div>';
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
  var sp = parseFloat(g('rb-soxpct'));
  if (!isNaN(sp) && sp >= 50 && sp <= 99.9) localStorage.setItem('rb_soxpct', sp);
  var rw = parseInt(g('rb-regwin'), 10);
  if (!isNaN(rw) && rw >= 1 && rw <= 20) localStorage.setItem('rb_regwin', rw);
  var so = document.getElementById('rb-soxon');
  if (so) localStorage.setItem('rb_soxon', so.checked ? '1' : '0');
  // 參數變了，已算好的結果就過期了；下次進頁重抓，不在這裡順手重抓（使用者可能還在打字）
  _rbData = null;
  var hint = document.querySelector('#params-rebound-body .set-hint');
  if (hint) hint.innerHTML = hint.innerHTML.replace(/目前：[^。]*。/, '目前：' + rbCfgStatus() + '。');
  if (typeof setRender === 'function') {
    var st = document.querySelector('[data-set-status="rebound"]');
    if (st) st.textContent = rbCfgStatus();
  }
}
