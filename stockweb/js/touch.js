// 股利總管 Web — 掛單參考：近三日「掛高 X 元在 N 分鐘內被觸及」的比例
//
// 用途：決定限價單要掛多遠。00981A 掛高 0.03 有七成機會碰到，
// 同樣掛高 0.03 放在 00981B 身上一百次只碰到一次 —— 這個差距用漲跌幅看不出來。
//
// ── 為什麼不是「逐筆變動率」──
// 2026-11-06 實測全部持股的相鄰成交價差：中位數一律 0.01，第 90 百分位
// 00981A 是 0.02、00981B 是 0.01，兩者沒有量級差距。
// 拉開差距的是單位時間的行程：每 10 分鐘 00981A 走 0.20、00981B 走 0.01，差 20 倍。
// 原因是成交密度 —— 同一天 00981A 成交 48,666 筆（每秒 2.7 筆）、00981B 只有 710 筆。
// 所以這裡量的是「一段時間內價格走到哪」，不是「相鄰兩筆差多少」。
//
// ── 演算法 ──
// 把當日每一個成交時刻都當成一次下單：在該時刻以「成交價 + X」掛賣，
// 看往後 N 分鐘內的最高價有沒有到 X。最後 N 分鐘沒有完整視窗，不計入。
// 前向最大值用單調佇列，48,666 筆是線性一遍。
//
// ── 樣本的真實大小 ──
// 分母看起來有幾萬，但相鄰時刻的視窗高度重疊，彼此不獨立。
// 真正獨立的視窗數 ＝ 交易時間 ÷ 視窗長度 ＝ 270 分 ÷ 10 分 ≈ 27／日，三日約 81 個。
// 所以表上的百分比不該讀到個位數，差幾個百分點沒有意義。
//
// ── 快取 ──
// 過去的交易日不會再變 → 算過就永久存著（只存統計值，不存原始逐筆：
// 00981A 一天的逐筆是 2.7 MB，localStorage 放不下，統計值只有幾個數字）。
// 今天的會一直增加，每次開頁重算。

var TOUCH_OFFS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.10];
var TOUCH_WIN_MIN = 10;                 // 視窗長度（分鐘）
var TOUCH_DAYS = 3;                     // 取最近幾個有成交的交易日
var TOUCH_BACK = 12;                    // 最多往回找幾個日曆天（含連假）
// 樣本門檻取自視窗本身，不是自訂整數：要談「N 分鐘內會不會觸及」，
// 至少每分鐘要有一筆成交可以當錨點，否則多數視窗裡根本沒有價格更新。
// 台股日盤 09:00–13:30 共 270 分鐘 → 三日 810 筆。低於這個數只標筆數、不下結論。
var TOUCH_MIN_TICKS = 270 * TOUCH_DAYS;

var TOUCH_SEL_LS = 'touch_sel_v1';      // 要顯示的代號清單
var TOUCH_STAT_LS = 'touch_stat_v1';    // { 'code|YYYY-MM-DD': { n, hit[], ticks } }

var _touchStat = null;                  // 記憶體中的快取
var _touchRows = null;                  // 算好的各檔結果
var _touchBusy = false;
var _touchErr = '';

function touchSel() {
  try {
    var a = JSON.parse(localStorage.getItem(TOUCH_SEL_LS));
    return Array.isArray(a) ? a.map(String) : [];
  } catch (e) { return []; }
}
function touchSelSet(arr) {
  try { localStorage.setItem(TOUCH_SEL_LS, JSON.stringify(arr)); } catch (e) { hush('touch', e); }
}
function _touchStatLoad() {
  if (_touchStat) return _touchStat;
  try { _touchStat = JSON.parse(localStorage.getItem(TOUCH_STAT_LS)) || {}; }
  catch (e) { _touchStat = {}; }
  return _touchStat;
}
function _touchStatSave() {
  try { localStorage.setItem(TOUCH_STAT_LS, JSON.stringify(_touchStat || {})); }
  catch (e) { hush('touch', e); }
}
function _touchYmd(d) {
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

// 單日統計。回傳 { n, hit[], ticks }：n＝有完整視窗的時刻數，hit[k]＝其中觸及第 k 個偏移的次數。
function _touchDay(j) {
  var p = j.close || [], dts = j.datetime || [];
  var n = p.length;
  if (n < 2) return { n: 0, hit: TOUCH_OFFS.map(function () { return 0; }), ticks: n };
  var ts = new Array(n);
  for (var i = 0; i < n; i++) ts[i] = Date.parse(dts[i]);
  var win = TOUCH_WIN_MIN * 60000, end = ts[n - 1] - win;
  var hit = TOUCH_OFFS.map(function () { return 0; });
  // 單調遞減佇列：隊首永遠是目前視窗內的最高價
  var dq = new Int32Array(n), head = 0, tail = 0, j2 = 0, cnt = 0;
  for (var a = 0; a < n; a++) {
    if (ts[a] > end) break;
    while (j2 < n && ts[j2] <= ts[a] + win) {
      while (tail > head && p[dq[tail - 1]] <= p[j2]) tail--;
      dq[tail++] = j2; j2++;
    }
    while (tail > head && dq[head] < a) head++;
    if (tail <= head) continue;
    var hi = p[dq[head]];
    cnt++;
    for (var k = 0; k < TOUCH_OFFS.length; k++) {
      if (hi >= p[a] + TOUCH_OFFS[k] - 1e-9) hit[k]++;
    }
  }
  return { n: cnt, hit: hit, ticks: n };
}

async function _touchFetch(code, date) {
  var r = await fetch(API + '/api/v1/data/ticks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract: { security_type: 'STK', exchange: 'TSE', code: code }, date: date })
  });
  if (!r.ok) throw new Error('ticks HTTP ' + r.status);
  return r.json();
}

// 單一代號：往回找出最近 TOUCH_DAYS 個有成交的日子，合併統計。
// 過去的日子讀快取；今天一律重算（盤中還在增加）。
async function _touchCode(code) {
  var st = _touchStatLoad();
  var today = _touchYmd(new Date());
  var days = [], tot = { n: 0, hit: TOUCH_OFFS.map(function () { return 0; }), ticks: 0 };
  for (var back = 0; back < TOUCH_BACK && days.length < TOUCH_DAYS; back++) {
    var date = _touchYmd(new Date(Date.now() - back * 86400000));
    var key = code + '|' + date;
    var one = (date !== today) ? st[key] : null;
    if (!one) {
      var j;
      try { j = await _touchFetch(code, date); }
      catch (e) { hush('touch', e); continue; }
      one = _touchDay(j);
      if (date !== today) { st[key] = one; }      // 收盤後的日子不會再變，永久留著
    }
    if (!one.ticks) continue;                      // 假日或停止交易
    days.push(date);
    tot.n += one.n; tot.ticks += one.ticks;
    for (var k = 0; k < TOUCH_OFFS.length; k++) tot.hit[k] += one.hit[k];
  }
  _touchStatSave();
  if (!days.length) return null;
  return {
    code: code, days: days.slice().reverse(), n: tot.n, ticks: tot.ticks,
    rate: tot.hit.map(function (h) { return tot.n ? h / tot.n * 100 : null; }),
    thin: tot.ticks < TOUCH_MIN_TICKS
  };
}

async function touchLoad(force) {
  var sel = touchSel();
  if (!sel.length) { _touchRows = []; return; }
  if (_touchBusy) return;
  _touchBusy = true; _touchErr = '';
  if (force) { _touchStat = {}; _touchStatSave(); }
  var out = [];
  for (var i = 0; i < sel.length; i++) {
    try {
      var r = await _touchCode(sel[i]);
      if (r) out.push(r);
    } catch (e) { hush('touch', e); _touchErr = e.message; }
    _touchRows = out.slice();
    touchRender();                                  // 一檔算完就畫一檔，不用等整批
  }
  _touchRows = out;
  _touchBusy = false;
  touchRender();
}

function touchHtml() {
  var sel = touchSel();
  if (!sel.length) return '';
  var h = '<div class="sec-title">掛單參考<span class="touch-sub">近 ' + TOUCH_DAYS +
    ' 個交易日（含今日）　在某個成交時刻以「成交價 ＋ X」掛賣，往後 ' + TOUCH_WIN_MIN +
    ' 分鐘內最高價碰到 X 的比例</span></div>';
  if (!_touchRows) {
    return h + '<div class="modal-loading">載入逐筆成交中…（首次較久，過去的交易日算過就不再算）</div>';
  }
  if (!_touchRows.length) {
    return h + '<div class="detail-note">' + (_touchErr || '選取的標的沒有逐筆成交資料。') + '</div>';
  }
  h += '<div class="inv-table-wrap"><table class="inv-table touch-table"><thead><tr>' +
    '<th>代號</th>' +
    TOUCH_OFFS.map(function (o) { return '<th class="num">+' + o.toFixed(2) + '</th>'; }).join('') +
    '<th class="num" title="三日合計成交筆數。低於 ' + TOUCH_MIN_TICKS +
    '（交易分鐘數 ' + (270 * TOUCH_DAYS) + '）時多數視窗裡沒有價格更新，百分比參考價值低">筆數</th>' +
    '<th class="num" title="有完整視窗的時刻數。相鄰時刻的視窗高度重疊，彼此不獨立：真正獨立的視窗約 ' +
    Math.round(270 / TOUCH_WIN_MIN) * TOUCH_DAYS + ' 個">樣本</th>' +
    '</tr></thead><tbody>';
  _touchRows.forEach(function (r) {
    h += '<tr' + (r.thin ? ' class="touch-thin"' : '') + '><td class="dstat-code">' + r.code +
      (r.thin ? ' <span class="dexm-lent">筆數低</span>' : '') + '</td>';
    r.rate.forEach(function (v) {
      // 百分位的色階只分三段：高（還碰得到）、中、低（幾乎碰不到）。
      // 分界取自這張表本身的用途 —— 低於五成就是多數時候掛不到，低於一成等於掛不到。
      var cls = v == null ? '' : (v >= 50 ? 'up' : (v >= 10 ? '' : 'down'));
      h += '<td class="num ' + cls + '">' + (v == null ? '—' : Math.round(v) + '%') + '</td>';
    });
    h += '<td class="num touch-dim">' + r.ticks.toLocaleString('zh-TW') + '</td>' +
      '<td class="num touch-dim">' + r.n.toLocaleString('zh-TW') + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function touchRender() {
  var el = document.getElementById('touch-box');
  if (el) el.innerHTML = touchHtml();
}

// 即時持股頁開啟時掛上去（表格下方）。只有選過標的才抓資料。
function touchMount() {
  var host = document.getElementById('live-view');
  if (!host) return;
  var el = document.getElementById('touch-box');
  if (!el) {
    el = document.createElement('div');
    el.id = 'touch-box';
    el.className = 'touch-box';
    host.appendChild(el);
  }
  if (!touchSel().length) { el.innerHTML = ''; return; }
  _touchRows = null;
  touchRender();
  touchLoad();
}

// ── 參數設定：選哪幾檔要看 ──
function renderTouchSel() {
  var el = document.getElementById('params-touch-body');
  if (!el) return;
  var codes = [];
  (typeof _positions !== 'undefined' && _positions || []).forEach(function (p) {
    var c = String(p.code);
    if (codes.indexOf(c) < 0) codes.push(c);
  });
  codes.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  if (!codes.length) { el.innerHTML = '<div class="modal-loading">持股載入中…</div>'; return; }
  var sel = touchSel();
  el.innerHTML = '<div class="detail-note">勾選的標的會在即時持股頁下方列出掛單參考。' +
    '每檔第一次要抓三天的逐筆成交（成交熱絡的一天約 2～3 MB），只勾實際會掛單的那幾檔。</div>' +
    '<div class="touch-pick">' + codes.map(function (c) {
      var on = sel.indexOf(c) >= 0;
      var nm = (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || '';
      return '<label class="touch-chk' + (on ? ' on' : '') + '">' +
        '<input type="checkbox"' + (on ? ' checked' : '') + ' onchange="touchToggle(\'' + c + '\',this.checked)">' +
        '<b>' + c + '</b>' + (nm ? '<span>' + nm + '</span>' : '') + '</label>';
    }).join('') + '</div>' +
    '<div class="touch-act"><button class="dw-btn" onclick="touchClearCache(this)">清除已算過的統計</button>' +
    '<span class="touch-dim">' + Object.keys(_touchStatLoad()).length + ' 個交易日已算過</span></div>';
}
function touchToggle(code, on) {
  var sel = touchSel(), i = sel.indexOf(code);
  if (on && i < 0) sel.push(code);
  if (!on && i >= 0) sel.splice(i, 1);
  touchSelSet(sel);
  renderTouchSel();
  if (document.getElementById('touch-box')) touchMount();
}
function touchClearCache(btn) {
  _touchStat = {};
  _touchStatSave();
  if (btn) btn.textContent = '已清除';
  renderTouchSel();
}
function touchStatus() {
  var n = touchSel().length;
  return n ? n + ' 檔' : '未選取';
}
