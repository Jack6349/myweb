// 股利總管 Web — 退休現金流設定（每月預計支出、定存年利率）
//
// 支出採「基準 ＋ 月份覆寫」：多數月份金額一樣，少數月份有大額（年繳保費、稅、旅遊）。
// 12 格全填太煩，單一固定值又表達不了那幾個月，所以只覆寫需要的月份。
// 月份用 1～12 而非 YYYY-MM：這些支出每年重複，綁到特定年份隔年就要重填。
//
// 定存年利率：用來評估「這筆錢放這裡跟放定存比」。預設 1.70%，來源是央行
// 「五大銀行平均存款利率」一年期（臺銀／土銀／合庫／一銀／華銀五家皆 1.700，
// 資料日 115/10/19，https://www.cbc.gov.tw/public/data/averagerate.xlsx）。
// 大額存款（一般以 500 萬為界）牌告低於此數且各行自訂，要用大額就自己改。
//
// 儲存：Firestore stock_prefs/{uid} 的 retireCfg 欄位（merge 寫入，同認購成本補正）；
//       未登入或寫入失敗時退回 localStorage，登入後下次載入自動搬上雲端。

var RT_LS = 'retire_cfg_v1';
var RT_DEP_DEFAULT = 1.70;        // 央行五大銀行一年期定儲平均固定利率（115/10/19）
var RT_DEP_SOURCE = '央行五大銀行一年期定儲平均（115/10/19）';

var _rtCfg = null, _rtLoaded = false, _rtStore = 'local', _rtErr = '';

function _rtLocal() { try { return JSON.parse(localStorage.getItem(RT_LS) || 'null'); } catch (e) { return null; } }
function _rtRef() { return window.FB.doc(window.FB.db, 'stock_prefs', window.OWNER_UID); }
function _rtCloud() { return !!(window.FB && window.OWNER_UID); }
function _rtNorm(d) {
  return { base: (d && d.base != null) ? +d.base : null,
           months: (d && d.months) || {},
           depRate: (d && d.depRate != null) ? +d.depRate : null,
           spcN: (d && d.spcN != null) ? +d.spcN : null,
           spcUp: (d && d.spcUp != null) ? +d.spcUp : null,
           spcLo: (d && d.spcLo != null) ? +d.spcLo : null,
           spcAvg: d ? d.spcAvg !== false : true };
}

// 總現值管制圖的參數。中線不另外存，一律取上下限的中點。
var RT_SPC_N = 5, RT_SPC_UP = 18000000, RT_SPC_LO = 17000000;
function rtSpc() {
  var c = _rtCfg || {};
  var up = c.spcUp != null ? c.spcUp : RT_SPC_UP;
  var lo = c.spcLo != null ? c.spcLo : RT_SPC_LO;
  if (up < lo) { var t = up; up = lo; lo = t; }          // 填反了就自己對調，不要畫出上下顛倒的區間
  return { n: c.spcN != null ? Math.max(2, Math.round(c.spcN)) : RT_SPC_N,
           up: up, lo: lo, mid: (up + lo) / 2, avg: c.spcAvg !== false };
}

async function rtLoad(force) {
  if (_rtLoaded && !force) return _rtCfg;
  var local = _rtLocal();
  _rtCfg = local ? _rtNorm(local) : null; _rtStore = 'local';
  if (_rtCloud()) {
    try {
      var snap = await Promise.race([
        window.FB.getDoc(_rtRef()),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
      ]);
      var d = snap.exists() ? snap.data() : {};
      if (d.retireCfg) {
        _rtCfg = _rtNorm(d.retireCfg); _rtStore = 'firestore'; _rtErr = '';
        if (local) { try { localStorage.removeItem(RT_LS); } catch (e) {} }
      } else if (local) {
        await _rtSave();
      }
    } catch (e) { _rtErr = (e && (e.code || e.message)) || String(e); }
  } else { _rtErr = '未登入 Google'; }
  if (_rtCfg == null) _rtCfg = _rtNorm(null);
  _rtLoaded = true;
  return _rtCfg;
}
window.addEventListener('owner-ready', function () { _rtLoaded = false; });

async function _rtSave() {
  if (_rtCloud()) {
    try {
      await window.FB.setDoc(_rtRef(), { retireCfg: _rtCfg, retireUpdatedAt: new Date().toISOString() }, { merge: true });
      _rtStore = 'firestore'; _rtErr = '';
      try { localStorage.removeItem(RT_LS); } catch (e) {}
      return;
    } catch (e) { _rtErr = (e && (e.code || e.message)) || String(e); }
  } else { _rtErr = '未登入 Google'; }
  try { localStorage.setItem(RT_LS, JSON.stringify(_rtCfg)); } catch (e) {}
  _rtStore = 'local';
}

// 某月的預計支出：有覆寫用覆寫，否則用基準；都沒有回 null（畫面顯示「—」而不是 0）
function rtExpense(month) {
  if (!_rtCfg) return null;
  var o = _rtCfg.months[String(month)];
  if (o != null && o !== '') return +o;
  return _rtCfg.base != null ? _rtCfg.base : null;
}
// 年支出合計：12 個月逐月相加（覆寫月用覆寫值）。基準未填且該月無覆寫 → 該月不計，並回報缺幾個月
function rtYearTotal() {
  var sum = 0, miss = 0;
  for (var m = 1; m <= 12; m++) {
    var v = rtExpense(m);
    if (v == null) miss++; else sum += v;
  }
  return { total: sum, miss: miss };
}
function rtDepRate() { return (_rtCfg && _rtCfg.depRate != null) ? _rtCfg.depRate : RT_DEP_DEFAULT; }

function rtSet(field, value) {
  if (!_rtCfg) return;
  var v = (value === '' || value == null) ? null : parseFloat(value);
  if (v != null && isNaN(v)) v = null;
  _rtCfg[field] = v;
  _rtSave();
  rtRenderSummary();
  if (typeof pvRender === 'function' && typeof _pvOpen !== 'undefined' && _pvOpen) pvRender();
}
function rtSetBool(field, on) {
  if (!_rtCfg) return;
  _rtCfg[field] = !!on;
  _rtSave();
  if (typeof pvRender === 'function' && typeof _pvOpen !== 'undefined' && _pvOpen) pvRender();
}
function rtSetMonth(m, value) {
  if (!_rtCfg) return;
  var v = (value === '' || value == null) ? null : parseFloat(value);
  if (v == null || isNaN(v)) delete _rtCfg.months[String(m)];
  else _rtCfg.months[String(m)] = v;
  _rtSave();
  rtRenderSummary();
}

// 右側狀態摘要（設定列收合時顯示）
function rtStatus() {
  if (!_rtCfg || _rtCfg.base == null) return '未設定';
  var y = rtYearTotal(), n = Object.keys(_rtCfg.months).length;
  return '月基準 ' + _rtCfg.base.toLocaleString('zh-TW') + (n ? '，' + n + ' 個月覆寫' : '') +
    '，年支出 ' + y.total.toLocaleString('zh-TW');
}
function rtRenderSummary() {
  var el = document.getElementById('rt-summary');
  if (el) el.innerHTML = rtCashHtml();
  var st = document.querySelector('[data-set-status="retire-exp"]');
  if (st) st.textContent = rtStatus();
}

// 支出對照配息：月份總覽已經算出逐月入帳，這裡只做相減與累計餘額
// 現金流對照表：顯示在 股利估算 → 月份總覽 底下（divnav.js 呼叫），不在設定頁
function rtCashHtml() {
  var y = rtYearTotal();
  if (_rtCfg.base == null && !Object.keys(_rtCfg.months).length) {
    return '<div class="set-hint">填入月基準後，這裡會顯示年支出合計；配息對照需要股利估算頁先載入月份總覽。</div>';
  }
  var inc = (typeof divMonthlyTotals === 'function') ? divMonthlyTotals() : null;
  var h = '<div class="set-hint">年支出合計 <b>' + y.total.toLocaleString('zh-TW') + '</b>' +
    (y.miss ? '（' + y.miss + ' 個月未填，未計入）' : '') + '</div>';
  if (!inc) {
    h += '<div class="set-hint">配息對照：請先開啟股利估算頁載入月份總覽。</div>';
    return h;
  }
  var bal = 0, rows = '';
  inc.forEach(function (o) {
    var e = rtExpense(o.m);
    var net = (e == null) ? null : o.amt - e;
    if (net != null) bal += net;
    rows += '<tr><td>' + o.label + '</td>' +
      '<td class="num">' + o.amt.toLocaleString('zh-TW') + '</td>' +
      '<td class="num">' + (e == null ? '—' : e.toLocaleString('zh-TW')) + '</td>' +
      '<td class="num ' + (net == null ? '' : (net >= 0 ? 'up' : 'down')) + '">' +
        (net == null ? '—' : (net >= 0 ? '+' : '') + net.toLocaleString('zh-TW')) + '</td>' +
      '<td class="num ' + (bal >= 0 ? '' : 'down') + '">' + Math.round(bal).toLocaleString('zh-TW') + '</td></tr>';
  });
  h += '<table class="detail-table set-cash"><thead><tr><th>月份</th><th class="num">配息入帳</th>' +
    '<th class="num">預計支出</th><th class="num">當月淨額</th><th class="num">累計餘額</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<div class="set-hint">配息入帳取自股利估算的月份總覽（依發放月，含借券補償）。' +
    '累計餘額從 0 起算，只看這 12 個月的進出，不含你現有的現金。</div>';
  return h;
}

function renderRetire() {
  var el = document.getElementById('params-retire-body');
  if (!el) return;
  el.innerHTML = '<div class="modal-loading">載入設定…</div>';
  rtLoad().then(function () {
    var MON = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    var cells = '';
    for (var m = 1; m <= 12; m++) {
      var v = _rtCfg.months[String(m)];
      cells += '<label class="rt-mon' + (v == null ? '' : ' on') + '"><span>' + MON[m - 1] + '</span>' +
        '<input type="number" step="1000" class="al-in" value="' + (v == null ? '' : v) + '"' +
        ' placeholder="同基準"' +
        ' oninput="rtSetMonth(' + m + ',this.value)"></label>';
    }
    el.innerHTML =
      '<div class="set-field"><label>每月基準支出</label>' +
        '<input type="number" step="1000" class="al-in" value="' + (_rtCfg.base == null ? '' : _rtCfg.base) + '"' +
        ' oninput="rtSet(\'base\',this.value)"><span class="set-unit">元</span></div>' +
      '<div class="set-hint">多數月份的固定開銷。下面只填跟基準不同的月份，空白就沿用基準。</div>' +
      '<div class="rt-mons">' + cells + '</div>' +
      '<div class="set-field"><label>定存年利率</label>' +
        '<input type="number" step="0.01" class="al-in" value="' + (_rtCfg.depRate == null ? '' : _rtCfg.depRate) + '"' +
        ' placeholder="' + RT_DEP_DEFAULT + '" oninput="rtSet(\'depRate\',this.value)"><span class="set-unit">%</span></div>' +
      '<div class="set-hint">空白時用 ' + RT_DEP_DEFAULT + '%，來源：' + RT_DEP_SOURCE + '。' +
        '大額存款（一般以 500 萬為界）牌告低於此數且各行自訂，要用大額請自行填入。</div>' +
      '<div class="set-hint">逐月淨額與累計餘額顯示在 股利估算 → 月份總覽 底下。</div>' +
      '<div class="set-hint">儲存位置：' + (_rtStore === 'firestore' ? 'Firestore（已登入）' : '本機瀏覽器' +
        (_rtErr ? '（' + _rtErr + '）' : '')) + '</div>';
    rtRenderSummary();
  });
}

// 管制圖參數獨立一列：和每月支出放同一列的話，收合後只看得到「每月預計支出」，
// 不知道裡面還有管制圖的設定。
function rtSpcStatus() {
  if (!_rtCfg) return null;
  var c = rtSpc();
  return c.n + ' 日　' + Math.round(c.lo / 10000).toLocaleString('zh-TW') + '～' +
    Math.round(c.up / 10000).toLocaleString('zh-TW') + ' 萬';
}
function renderRetireSpc() {
  var el = document.getElementById('params-spc-body');
  if (!el) return;
  el.innerHTML = '<div class="modal-loading">載入設定…</div>';
  rtLoad().then(function () {
    el.innerHTML =
      '<div class="set-field"><label>連續天數</label>' +
        '<input type="number" step="1" min="2" class="al-in" value="' + (_rtCfg.spcN == null ? '' : _rtCfg.spcN) + '"' +
        ' placeholder="' + RT_SPC_N + '" oninput="rtSet(\'spcN\',this.value)"><span class="set-unit">日</span></div>' +
      '<div class="set-field"><label>目標上限</label>' +
        '<input type="number" step="100000" class="al-in" value="' + (_rtCfg.spcUp == null ? '' : _rtCfg.spcUp) + '"' +
        ' placeholder="' + RT_SPC_UP + '" oninput="rtSet(\'spcUp\',this.value)"><span class="set-unit">元</span></div>' +
      '<div class="set-field"><label>目標下限</label>' +
        '<input type="number" step="100000" class="al-in" value="' + (_rtCfg.spcLo == null ? '' : _rtCfg.spcLo) + '"' +
        ' placeholder="' + RT_SPC_LO + '" oninput="rtSet(\'spcLo\',this.value)"><span class="set-unit">元</span></div>' +
      '<div class="set-field"><label>90 日平均線</label>' +
        '<label class="set-switch"><input type="checkbox"' + (_rtCfg.spcAvg !== false ? ' checked' : '') +
        ' onchange="rtSetBool(\'spcAvg\',this.checked)"><span>顯示</span></label></div>' +
      '<div class="set-hint">中線不用填，一律取上下限的中點。連續天數以「每日較前一日上升或下降」計，' +
        '設 5 就是連續 5 個交易日同方向。改完這裡，走勢抽屜的管制圖會立刻重畫。</div>'
      '';
  });
}
