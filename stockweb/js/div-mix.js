// 股利總管 Web — ETF 收益分配組成占比（公開資訊觀測站 MOPS）
// 資料檔 data/etf-div-mix.json 由 shioaji-server/etf-divmix.py 每日 19:00 排程產生並上傳。
// 網頁只讀不抓：MOPS 明細需逐筆 POST 且回 HTML，GAS 代理只收 JSON，瀏覽器端抓不到。
//
// 另讀 data/etf-div-next.json（etf-divnext.py 每日，來源 Yahoo 台股）補「下一期已公告金額」。
// 為什麼要補：投信公告金額的時間比 MOPS 申報早很多。實測 00984D 的 10/05 除息，
// 券商 9/20 公告、當天有新聞，MOPS 到 9/28 仍是未公告，TWSE 預告表金額欄空白。
// 可靠度已驗：三檔已除息者與 MOPS 逐筆相符，不是沿用前期的推估。
// 分工：占比與歷史一律以 MOPS 為準，本檔只在 MOPS 該筆尚未有金額時填補。
//
// 五項占比（MOPS 原始欄位）：
//   d  股利所得      ┐ 本業：成分股配息與債息，可重複發生
//   i  利息所得      ┘
//   e  收益平準金      把新申購者的本金撥一部分當配息發，會稀釋淨值
//   c  已實現資本利得  基金賣股賺的價差，行情反轉就沒有
//   cc 賣出選擇權權利金 掩護性買權策略收入（主動式 ETF 才有），會持續產生
//   o  其他所得
// c／cc 分開存的理由：00918 的 100% 是賣股價差（一次性），00404A 的 68% 是 covered call
// 權利金（策略性、可重複），兩者品質不同，不能併成一個「資本利得」看。

var DM_STALE_DAYS = 5;       // 每日 19:00 更新；超過 5 天＝排程連續數日未成功
var DM_MONTHS = 12;          // 統計區間。用「近 12 個月」而非固定期數，月配與季配的時間長度才一致
// 原本有 DM_TREND_PP = 5，差距超過 5 個百分點才標箭頭，註解寫「避免小幅波動一直跳」。
// 那個 5 是憑感覺訂的，沒有依據，而且它把連續量硬切成改善／持平／惡化三格，
// 4.9pp 和 5.1pp 會落在不同格子。改成直接顯示差值，由看的人自己判斷大小。

var _dmMap = null, _dmDay = null, _dmLoaded = false, _dmNext = null, _dmNextDay = null;

// 兩份 JSON 都載完才 resolve。股利估算要在併入「已公告除息」之前 await 它，
// 否則第一次進頁時 Yahoo 還沒到，除息日曆會少掉那一筆金額。
var _dmReady = (function () {
  var a = fetch('data/etf-div-mix.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.map) { _dmMap = j.map; _dmDay = j.updated || null; } })
    .catch(function () {});
  // 下一期已公告金額，失敗不影響主資料
  var b = fetch('data/etf-div-next.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.map) { _dmNext = j.map; _dmNextDay = j.updated || null; } })
    .catch(function () {});
  return Promise.all([a, b]).then(function () {
    _dmLoaded = true;
    if (typeof dmOnLoad === 'function') dmOnLoad();
  });
})();

function _dmTodayIso() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
// 從今天往前推 n 個月的 ISO 日期
function _dmBackIso(n) {
  var d = new Date(Date.now() + 8 * 3600000);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

// 近 months 個月內、已公告占比的期數（新→舊）。pending（只發了評價結果公告）不列入計算。
function dmRecs(code, months) {
  var list = _dmMap && _dmMap[String(code)];
  if (!list || !list.length) return [];
  var from = _dmBackIso(months == null ? DM_MONTHS : months);
  return list.filter(function (x) { return x.pct && x.ex >= from; });
}

// 上一次除息日（含 pending，因為計息區間是以除息日界定，跟占比公告了沒無關）。
// 用 dmRecs 反推會出錯：00988B 的 2026-07-16 那期還在待公告，被濾掉後
// 2026-08-18 的上一次會變成 2026-06-15，區間從 33 天膨脹成 64 天。
function dmPrevEx(code, ex) {
  var list = _dmMap && _dmMap[String(code)];
  if (!list || !list.length) return null;
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var e = list[i].ex;
    if (e && e < ex && (best == null || e > best)) best = e;
  }
  return best;
}

// 下一期「已公告但 MOPS 尚未申報」的配息金額（來源 Yahoo，見檔頭）。
// 只在該除息日於 MOPS 完全沒有金額時回傳；MOPS 一旦有值就以 MOPS 為準，本函式回 null。
function dmNext(code) {
  var y = _dmNext && _dmNext[String(code)];
  if (!y || !(y.amt > 0) || !y.ex) return null;
  var list = (_dmMap && _dmMap[String(code)]) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].ex === y.ex && list[i].amt > 0) return null;   // MOPS 已有，不用補
  }
  return { ex: y.ex, pay: y.pay || null, amt: y.amt, period: y.period || null, src: 'Yahoo' };
}

// Yahoo 的下一期除息原始值，不看 MOPS 有沒有（dmNext 會擋，那是給健康度用的）。
// 除息日曆與股利估算用：官方（e添富／TPEx）給除息日與發放日，Yahoo 常常先有金額——
// 2026-10-05 那批九檔，MOPS 都還是 pending（只有日期、沒有金額），Yahoo 已經有 0.042～0.085。
// 合併端只補缺漏欄位，所以官方一公告就自動改用官方值。
function dmNextRaw(code) {
  var y = _dmNext && _dmNext[String(code)];
  if (!y || !y.ex) return null;
  return { ex: y.ex, pay: y.pay || null, amt: (y.amt > 0 ? y.amt : null) };
}

// 尚未公告占比的最近一次除息（表二標「下期待公告」用）
function dmPending(code) {
  var list = _dmMap && _dmMap[String(code)];
  if (!list || !list.length) return null;
  var from = _dmBackIso(2);
  for (var i = 0; i < list.length; i++) {
    if (list[i].pending && list[i].ex >= from) return list[i];
  }
  return null;
}

// 線性遞減加權的組成占比：最新一期權重 n、最舊一期權重 1。
// 用加權而非單純平均，是因為平均會把趨勢抹掉——00984D 平準金 11.8→40→35.3→57.6，
// 平均 36% 看起來只是偏高，實際最新一期已經到 57.6%。
function dmMix(code, months) {
  var rs = dmRecs(code, months);
  if (!rs.length) return null;
  var n = rs.length, tot = n * (n + 1) / 2, out = { d: 0, i: 0, e: 0, c: 0, cc: 0, o: 0 };
  rs.forEach(function (r, idx) {
    var w = (n - idx) / tot;                  // rs 是新→舊，idx 0 權重最高
    ['d', 'i', 'e', 'c', 'cc', 'o'].forEach(function (k) { out[k] += (r.pct[k] || 0) * w; });
  });
  out.n = n;
  out.core = out.d + out.i;                   // 本業（股利＋利息）
  out.cap = out.c + out.cc;                   // 資本利得合計（賣股價差＋權利金）
  return out;
}

// 本業占比（0–1）：真實配息率＝年化配息率 × 這個值
function dmCoreRatio(code, months) {
  var m = dmMix(code, months);
  return m ? Math.max(0, Math.min(1, m.core / 100)) : null;
}

// 趨勢：近半年平均 vs 前半年平均（pick 決定看哪一項）。
// 回傳 {now, prev, diff, dir}；dir: 1 上升、-1 下降、0 持平；資料不足回 null。
function dmTrend(code, pick) {
  var list = _dmMap && _dmMap[String(code)];
  if (!list || !list.length) return null;
  var a6 = _dmBackIso(6), a12 = _dmBackIso(12);
  var recent = [], older = [];
  list.forEach(function (x) {
    if (!x.pct) return;
    if (x.ex >= a6) recent.push(pick(x.pct));
    else if (x.ex >= a12) older.push(pick(x.pct));
  });
  if (!recent.length || !older.length) return null;
  var avg = function (a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; };
  var now = avg(recent), prev = avg(older), diff = now - prev;
  return { now: now, prev: prev, diff: diff, nNow: recent.length, nPrev: older.length };
}

// 逐期原始序列（舊→新）。半年對半年算不出來時（新上市的檔前半年沒有期數）
// 用它取代空白：五個數字比一個箭頭清楚，而且沒有任何門檻。
function dmSeq(code, pick, months) {
  return dmRecs(code, months).map(function (r) {
    return { ex: r.ex, v: pick(r.pct) };
  }).reverse();
}

// 最新一期的占比（未經加權平滑）。加權平均對只有 3~5 期的新檔會抹掉性質變化：
// 00984D 各期平準金 11.8→40→35.3→50.6→57.6，加權後 45.9%，最新一期已是 57.6%。
function dmLatest(code) {
  var rs = dmRecs(code, DM_MONTHS);
  if (!rs.length) return null;
  var p = rs[0].pct;
  return {
    ex: rs[0].ex, amt: rs[0].amt,
    d: p.d || 0, i: p.i || 0, e: p.e || 0, c: p.c || 0, cc: p.cc || 0, o: p.o || 0,
    core: (p.d || 0) + (p.i || 0), cap: (p.c || 0) + (p.cc || 0)
  };
}
function dmPickE(p) { return p.e || 0; }                                  // 平準金
function dmPickCore(p) { return (p.d || 0) + (p.i || 0); }                // 本業
function dmPickCap(p) { return (p.c || 0) + (p.cc || 0); }                // 資本利得合計

// 趨勢顯示：箭頭看數值方向，文字看「對持有人好不好」（goodIsUp 決定）
// 有半年對半年可比就顯示差值（不做門檻判定），否則顯示逐期原始序列。
// code/pick 是序列 fallback 需要的；舊呼叫只傳 (t, goodIsUp) 時退回顯示「—」。
function dmTrendHtml(t, goodIsUp, code, pick) {
  if (t) {
    var d = t.diff, good = (d > 0) === !!goodIsUp;
    var cls = Math.abs(d) < 0.05 ? 'dm-dim' : (good ? 'down' : 'up');
    return '<span class="' + cls + '" title="近半年 ' + t.nNow + ' 期平均 ' + t.now.toFixed(1) +
      '%　前半年 ' + t.nPrev + ' 期平均 ' + t.prev.toFixed(1) + '%">' +
      (d > 0 ? '+' : '') + d.toFixed(1) + ' pp</span>' +
      '<span class="dm-dim"> ' + t.prev.toFixed(0) + '→' + t.now.toFixed(0) + '%</span>';
  }
  if (code && pick) {
    var s = dmSeq(code, pick, DM_MONTHS);
    if (s.length) {
      return '<span class="dm-seq" title="逐期原始值（舊→新）：&#10;' +
        s.map(function (x) { return x.ex + '　' + x.v.toFixed(1) + '%'; }).join('&#10;') +
        '&#10;&#10;期數不足半年對半年，不做平均，直接列出原始序列">' +
        s.map(function (x) { return x.v.toFixed(0); }).join('→') + '%</span>';
    }
  }
  return '<span class="dm-dim">—</span>';
}

// 資料日期提示：正常＝綠、超過 40 天或讀不到＝黃字提醒手動執行（比照 div-meta.js 的 _divMdjPill）
function dmPill() {
  if (!_dmLoaded) return '';
  var fix = '請在電腦上執行 shioaji-server\etf-divmix.cmd（增量更新約 2–3 分鐘，完成後重新整理本頁）；執行紀錄見 etf-divmix.log';
  if (!_dmDay) return '<span class="st-pill st-part" title="' + fix + '">讀不到配息組成資料（data/etf-div-mix.json），請執行 etf-divmix.cmd</span>';
  var age = Math.floor((Date.parse(_dmTodayIso()) - Date.parse(_dmDay)) / 86400000);
  var d = _dmDay.slice(5).replace('-', '/');
  if (age > DM_STALE_DAYS) return '<span class="st-pill st-part" title="' + fix + '">配息組成資料 ' + d + '（已 ' + age + ' 天未更新），請執行 etf-divmix.cmd</span>';
  return '<span class="st-pill st-ok" title="每月 1 號 08:20 自動更新（Windows 排程）；資料來源：公開資訊觀測站">配息組成資料 ' + d + '</span>';
}
