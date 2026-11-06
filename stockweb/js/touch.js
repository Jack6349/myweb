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
var TOUCH_STAT_LS = 'touch_stat_v2';    // { 'code|YYYY-MM-DD': { n, up[], dn[], ticks } }（v1 只有賣出側）

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

// 單日統計。兩側一起算：
//   up[k]＝「掛高第 k 個偏移賣出」在視窗內被最高價碰到的次數
//   dn[k]＝「掛低第 k 個偏移買進」在視窗內被最低價碰到的次數
// n＝有完整視窗的時刻數（結尾不足一個視窗的不計）。
// 兩側分開算而不是用同一個區間：價格可能一路往上，向上碰得到、向下碰不到，
// 用「區間高低差」會把這兩件事混成一個數字。
function _touchDay(j) {
  var p = j.close || [], dts = j.datetime || [];
  var n = p.length;
  var zero = function () { return TOUCH_OFFS.map(function () { return 0; }); };
  if (n < 2) return { n: 0, up: zero(), dn: zero(), ticks: n };
  var ts = new Array(n);
  for (var i = 0; i < n; i++) ts[i] = Date.parse(dts[i]);
  var win = TOUCH_WIN_MIN * 60000, end = ts[n - 1] - win;
  var up = zero(), dn = zero();
  // 兩條單調佇列：qH 遞減（隊首＝視窗內最高價）、qL 遞增（隊首＝最低價）
  var qH = new Int32Array(n), hH = 0, tH = 0;
  var qL = new Int32Array(n), hL = 0, tL = 0;
  var j2 = 0, cnt = 0;
  for (var a = 0; a < n; a++) {
    if (ts[a] > end) break;
    while (j2 < n && ts[j2] <= ts[a] + win) {
      while (tH > hH && p[qH[tH - 1]] <= p[j2]) tH--;
      qH[tH++] = j2;
      while (tL > hL && p[qL[tL - 1]] >= p[j2]) tL--;
      qL[tL++] = j2;
      j2++;
    }
    while (tH > hH && qH[hH] < a) hH++;
    while (tL > hL && qL[hL] < a) hL++;
    if (tH <= hH || tL <= hL) continue;
    var hi = p[qH[hH]], lo = p[qL[hL]];
    cnt++;
    for (var k = 0; k < TOUCH_OFFS.length; k++) {
      if (hi >= p[a] + TOUCH_OFFS[k] - 1e-9) up[k]++;
      if (lo <= p[a] - TOUCH_OFFS[k] + 1e-9) dn[k]++;
    }
  }
  return { n: cnt, up: up, dn: dn, ticks: n };
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
  var zero = function () { return TOUCH_OFFS.map(function () { return 0; }); };
  var days = [], tot = { n: 0, up: zero(), dn: zero(), ticks: 0 };
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
    for (var k = 0; k < TOUCH_OFFS.length; k++) { tot.up[k] += one.up[k]; tot.dn[k] += one.dn[k]; }
  }
  _touchStatSave();
  if (!days.length) return null;
  return {
    code: code, days: days.slice().reverse(), n: tot.n, ticks: tot.ticks,
    up: tot.up.map(function (h) { return tot.n ? h / tot.n * 100 : null; }),
    dn: tot.dn.map(function (h) { return tot.n ? h / tot.n * 100 : null; }),
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
    ' 分鐘內最高價碰到 X 的比例；買進則是掛低 X、看最低價碰不碰得到。'
    // 這裡的紅綠不是漲跌，是「碰得到／碰不到」，與全站慣例不同所以寫明
    + '紅＝五成以上碰得到、綠＝一成以下（與全站的紅漲綠跌無關）</span></div>';
  if (!_touchRows) {
    return h + '<div class="modal-loading">載入逐筆成交中…（首次較久，過去的交易日算過就不再算）</div>';
  }
  if (!_touchRows.length) {
    return h + '<div class="detail-note">' + (_touchErr || '選取的標的沒有逐筆成交資料。') + '</div>';
  }
  h += '<div class="inv-table-wrap"><table class="inv-table touch-table"><thead><tr>' +
    '<th>代號</th><th>方向</th>' +
    // 欄名只寫幅度，正負由「方向」那一欄決定：賣是掛高、買是掛低，同一個幅度
    TOUCH_OFFS.map(function (o) { return '<th class="num">' + o.toFixed(2) + '</th>'; }).join('') +
    '<th class="num" title="三日合計成交筆數。低於 ' + TOUCH_MIN_TICKS +
    '（交易分鐘數 ' + (270 * TOUCH_DAYS) + '）時多數視窗裡沒有價格更新，百分比參考價值低">筆數</th>' +
    '<th class="num" title="有完整視窗的時刻數。相鄰時刻的視窗高度重疊，彼此不獨立：真正獨立的視窗約 ' +
    Math.round(270 / TOUCH_WIN_MIN) * TOUCH_DAYS + ' 個">樣本</th>' +
    '</tr></thead><tbody>';
  _touchRows.forEach(function (r, i) {
    // 一檔兩列：賣高、買低。代號與筆數跨兩列，表格不會因為多一側就變寬一倍。
    // 隔檔上底色（整檔兩列一起上，不是隔列）：這張表的分隔單位是「一檔」，
    // 隔列上色會把同一檔的賣高／買低拆成深淺兩塊，反而更難看出哪兩列是同一檔。
    var base = (r.thin ? 'touch-thin ' : '') + (i % 2 ? 'touch-alt ' : '');
    var cells = function (arr) {
      // 色階只分三段：高（碰得到）、中、低（幾乎碰不到）。
      // 分界取自這張表的用途 —— 低於五成是多數時候掛不到，低於一成等於掛不到。
      return arr.map(function (v) {
        var cls = v == null ? '' : (v >= 50 ? 'up' : (v >= 10 ? '' : 'down'));
        return '<td class="num ' + cls + '">' + (v == null ? '—' : Math.round(v) + '%') + '</td>';
      }).join('');
    };
    h += '<tr class="' + base + 'touch-r1">' +
      '<td class="dstat-code" rowspan="2">' + r.code +
      (r.thin ? ' <span class="dexm-lent">筆數低</span>' : '') + '</td>' +
      '<td class="touch-side" title="以「成交價 ＋ 幅度」掛賣，看往後 ' + TOUCH_WIN_MIN +
      ' 分鐘內的最高價有沒有碰到">賣高</td>' + cells(r.up) +
      '<td class="num touch-dim" rowspan="2">' + r.ticks.toLocaleString('zh-TW') + '</td>' +
      '<td class="num touch-dim" rowspan="2">' + r.n.toLocaleString('zh-TW') + '</td></tr>' +
      '<tr class="' + base + '">' +
      '<td class="touch-side" title="以「成交價 － 幅度」掛買，看往後 ' + TOUCH_WIN_MIN +
      ' 分鐘內的最低價有沒有碰到">買低</td>' + cells(r.dn) + '</tr>';
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
async function renderTouchSel() {
  var el = document.getElementById('params-touch-body');
  if (!el) return;
  // 持股優先用行情引擎已載入的 _positions；直接從首頁進參數設定時它還是空的，
  // 這時直接向券商查一次（與成份股匯入同一套做法），不要卡在「載入中」。
  var pos = (typeof _positions !== 'undefined' && _positions && _positions.length) ? _positions : [];
  if (!pos.length) {
    el.innerHTML = '<div class="modal-loading">查詢持股中…</div>';
    try { pos = (typeof fetchBrokerPositions === 'function') ? (await fetchBrokerPositions() || []) : []; }
    catch (e) { hush('touch', e); pos = []; }
  }
  var codes = [];
  pos.forEach(function (p) {
    var c = String(p.code);
    if (codes.indexOf(c) < 0) codes.push(c);
  });
  codes.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  if (!codes.length) { el.innerHTML = '<div class="modal-loading">查不到持股</div>'; return; }
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
