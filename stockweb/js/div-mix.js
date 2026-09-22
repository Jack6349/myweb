// 股利總管 Web — ETF 收益分配組成占比（公開資訊觀測站 MOPS）
// 資料檔 data/etf-div-mix.json 由 shioaji-server/etf-divmix.py 每月 1 號 08:20 排程產生並上傳。
// 網頁只讀不抓：MOPS 明細需逐筆 POST 且回 HTML，GAS 代理只收 JSON，瀏覽器端抓不到。
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

var DM_STALE_DAYS = 40;      // 每月 1 號更新；超過 40 天＝至少漏了一次（抓取或上傳失敗）
var DM_MONTHS = 12;          // 統計窗口。用「近 12 個月」而非固定期數，月配與季配的時間長度才一致
var DM_TREND_PP = 5;         // 趨勢箭頭門檻（百分點）：近半年 vs 前半年差距超過才標，避免小幅波動一直跳

var _dmMap = null, _dmDay = null, _dmLoaded = false;

(function () {
  fetch('data/etf-div-mix.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      _dmLoaded = true;
      if (j && j.map) { _dmMap = j.map; _dmDay = j.updated || null; }
      if (typeof dmOnLoad === 'function') dmOnLoad();
    })
    .catch(function () { _dmLoaded = true; });
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
  return { now: now, prev: prev, diff: diff, dir: diff >= DM_TREND_PP ? 1 : (diff <= -DM_TREND_PP ? -1 : 0) };
}
function dmPickE(p) { return p.e || 0; }                                  // 平準金
function dmPickCore(p) { return (p.d || 0) + (p.i || 0); }                // 本業
function dmPickCap(p) { return (p.c || 0) + (p.cc || 0); }                // 資本利得合計

// 趨勢顯示：箭頭看數值方向，文字看「對持有人好不好」（goodIsUp 決定）
function dmTrendHtml(t, goodIsUp) {
  if (!t) return '<span class="dm-dim">—</span>';
  if (!t.dir) return '<span class="dm-dim">→ 持平</span>';
  var up = t.dir > 0, good = up === !!goodIsUp;
  return '<span class="' + (good ? 'down' : 'up') + '">' + (up ? '↑' : '↓') + ' ' +
    (good ? '改善' : '惡化') + '</span>' +
    '<span class="dm-dim"> ' + t.prev.toFixed(0) + '→' + t.now.toFixed(0) + '%</span>';
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
