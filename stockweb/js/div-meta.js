// 股利總管 Web — 配息資料（股利估算第四頁籤）＋ ETF 規格／配息頻率登錄表
//
// 配息頻率優先序（_divFreqOverride，經 dividend-est.js 的 _divInferStep 供全站使用）：
//   手動輸入（Firestore stock_div_meta/{uid}）＞ 程式常數 DIV_FREQ_OVERRIDE ＞ MoneyDJ（data/etf-freq.json）＞ 官方規格「收益分配」＞ 由除息紀錄推算
// MoneyDJ：全市場 ETF 的「配息頻率」欄，由本機排程 shioaji-server\etf-freq.py 每月抓一次、存成 data/etf-freq.json 上傳到本機服務。
//   網頁無法直接抓（GAS 代理只收 JSON、瀏覽器跨站限制），所以走本機排程。新上市只配過 1 次的 ETF 也能拿到正確頻率。
// 官方規格來源：上市 ETF＝TWSE ETF 商品資訊；上櫃 ETF＝TPEx ETF 商品資訊（兩者 JSON 結構相同），經 GAS 抓取、快取 30 天。
//
// 手動輸入存放：Firestore stock_div_meta/{uid}（獨立文件）。不寫進 stock_portfolio/{uid}：
// 該文件由網頁版與手機版（/stock）以整份覆寫方式儲存，額外欄位會被洗掉。
// Firestore 規則尚未開放此路徑或未登入時，暫存本機 localStorage，規則開放後首次載入自動搬上雲端。

var DIV_FREQ_OVERRIDE = {
  // 'XXXXX': 3,   // 程式層級的固定登錄（一般不需要，改用配息資料頁手動輸入）
};
var DIV_FREQ_NAME = { 1: '月配', 2: '雙月配', 3: '季配', 6: '半年配', 12: '年配' };   // 雙月配：00907、00930（年 6 次）

// ── 官方規格快取 ──
var DIV_META_LS = 'divest_etfmeta_v1';
var DIV_META_TTL = 30 * 86400000, DIV_META_MISS_TTL = 7 * 86400000;   // 查無資料的也快取 7 天，避免每次進頁都重打
var _divMeta = (function () { try { return JSON.parse(localStorage.getItem(DIV_META_LS) || '{}') || {}; } catch (e) { return {}; } })();
function _divMetaSave() { try { localStorage.setItem(DIV_META_LS, JSON.stringify(_divMeta)); } catch (e) {} }

// ── 手動輸入 ──
var DIV_MAN_LS = 'divest_manual_v1';
var _divMan = {}, _divManLoaded = false, _divManStore = 'local', _divManErr = '';
function _divManLocal() { try { return JSON.parse(localStorage.getItem(DIV_MAN_LS) || '{}') || {}; } catch (e) { return {}; } }
function _divManRef() { return window.FB.doc(window.FB.db, 'stock_div_meta', window.OWNER_UID); }

async function _divManLoad() {
  if (_divManLoaded) return;
  var local = _divManLocal();
  _divMan = local; _divManStore = 'local';
  if (!(window.FB && window.OWNER_UID)) { _divManErr = '未登入 Google'; _divManLoaded = true; return; }
  try {
    var snap = await Promise.race([
      window.FB.getDoc(_divManRef()),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('Firestore 逾時')); }, 8000); })
    ]);
    var remote = (snap.exists() && snap.data().manual) || {};
    // 本機暫存（規則未開放期間輸入的）較新者搬上雲端
    var moved = false;
    Object.keys(local).forEach(function (c) {
      if (!remote[c] || (local[c].at || 0) > (remote[c].at || 0)) { remote[c] = local[c]; moved = true; }
    });
    _divMan = remote; _divManStore = 'firestore'; _divManErr = '';
    if (moved) {
      await window.FB.setDoc(_divManRef(), { manual: remote, updatedAt: new Date().toISOString() });
      try { localStorage.removeItem(DIV_MAN_LS); } catch (e) {}
    }
  } catch (e) {
    _divManErr = (e && (e.code || e.message)) || String(e);
  }
  _divManLoaded = true;
}
// 登入狀態變化（晚於頁面載入才完成登入）→ 下次使用時重讀雲端
window.addEventListener('owner-ready', function () { _divManLoaded = false; });

async function _divManSave(code, rec) {
  code = String(code);
  if (rec && Object.keys(rec).some(function (k) { return k !== 'at' && rec[k] != null && rec[k] !== ''; })) _divMan[code] = rec;
  else delete _divMan[code];
  if (window.FB && window.OWNER_UID) {
    try {
      await window.FB.setDoc(_divManRef(), { manual: _divMan, updatedAt: new Date().toISOString() });
      _divManStore = 'firestore'; _divManErr = '';
      try { localStorage.removeItem(DIV_MAN_LS); } catch (e) {}
      return;
    } catch (e) { _divManErr = (e && (e.code || e.message)) || String(e); }
  } else { _divManErr = '未登入 Google'; }
  try { localStorage.setItem(DIV_MAN_LS, JSON.stringify(_divMan)); } catch (e) {}
  _divManStore = 'local';
}

// ── MoneyDJ 配息頻率（同源靜態檔，開頁讀一次）──
var _divMdj = {}, _divMdjDay = null;
(function () {
  fetch('data/etf-freq.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !j.map) return;
    Object.keys(j.map).forEach(function (c) { var s = j.map[c] && j.map[c].s; if (s) _divMdj[c] = s; });
    _divMdjDay = j.updated || null;
    // 比頁面其他資料晚到時：已算好的 ETF 評比指標重算一次（股利估算下次載入即採用）
    if (typeof _esAllMapBase !== 'undefined') _esAllMapBase = null;
    if (typeof renderEtfScreen === 'function') renderEtfScreen();
  }).catch(function () {});
})();

// ── 配息頻率（全站共用入口）──
function _divFreqSource(code) {
  code = String(code || '');
  var m = _divMan[code];
  if (m && m.step) return { step: m.step, src: 'manual' };
  if (DIV_FREQ_OVERRIDE[code]) return { step: DIV_FREQ_OVERRIDE[code], src: 'code' };
  if (_divMdj[code]) return { step: _divMdj[code], src: 'mdj' };
  var o = _divMeta[code], st = o ? _divParseDist(o.dist) : null;
  if (st) return { step: st, src: o.src };
  return null;
}
function _divFreqOverride(code) {
  var f = _divFreqSource(code);
  return f ? f.step : null;
}

// 「收益分配」文字 → 月間隔。官方文字格式不一，例：
//   TWSE「月配息」「季配息」「季配 （收益評價日為每年二月、五月…）」「半年配（…）」「年度配息」
//   TPEx「每月」
//   「每年3月、10月起第45個營業日前(含)進行分配。」（無關鍵字 → 數列出的月份個數：2 個＝半年配）
function _divParseDist(txt) {
  txt = String(txt || '');
  if (!txt || /不配|不分配/.test(txt)) return null;
  // 官方寫法有「季配」也有「季分配」（00878：季分配…每年2、5、8及11月…分配）；只認「季配」時會落到下面的月份計數，
  // 而舊的月份計數只抓得到緊貼「月」字的數字（10月、11月）→ 誤判成半年配。
  if (/雙月(配|分配)|每兩個?月|每二個?月/.test(txt)) return 2;   // 先判雙月，否則會被「月配」吃掉
  if (/半年度?(配|分配)|每半年/.test(txt)) return 6;      // 先判半年，否則會被「年配」吃掉
  if (/季(配|分配)|每季/.test(txt)) return 3;
  if (/月(配|分配)|每月/.test(txt)) return 1;
  if (/年度?(配|分配)/.test(txt)) return 12;
  // 沒有關鍵字：看列出幾個月份（取同一串列表裡最多的那一組，例：「2、5、8及11月」＝4 個月＝季配）
  // 一組列表：數字之間可夾「月」「月底」與頓號／逗號／及（「3月、10月」「2月底、5月底…」「1，4，7，10月」都算同一組）
  var n = 0;
  (txt.match(/\d{1,2}\s*月?底?(?:\s*[，、,及和]\s*\d{1,2}\s*月?底?)*/g) || []).forEach(function (g) {
    if (g.indexOf('月') < 0) return;                      // 沒有「月」字的數字（60日、45個營業日）不算
    var k = (g.match(/\d{1,2}/g) || []).length;
    if (k > n) n = k;
  });
  if (!n) n = _divDistMonths(txt).length;                  // 國字月份（二、五、八、十一月）
  return ({ 1: 12, 2: 6, 4: 3, 6: 2, 12: 1 })[n] || null;   // 列出 6 個月份＝雙月配
}
function _divDistNone(txt) { return /不配|不分配/.test(String(txt || '')); }
// 文字中列出的月份（收益評價月／分配月），回傳排序後的月份數字
function _divDistMonths(txt) {
  var cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
  var seen = {};
  (String(txt || '').match(/(十[一二]?|[一二三四五六七八九]|1[0-2]|[1-9])月/g) || []).forEach(function (m) {
    var k = m.slice(0, -1); seen[/\d/.test(k) ? +k : cn[k]] = true;
  });
  return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
}
// 費率文字取第一個百分比（級距制取最低規模級距的費率；完整文字放 title）
function _divFeePct(txt) {
  var m = String(txt || '').match(/(\d+(?:\.\d+)?)\s*[%％]/);
  return m ? +m[1] : null;
}
function _divFeeTiered(txt) { return (String(txt || '').match(/[%％]/g) || []).length > 1; }

// ── 官方規格抓取 ──
function _divMetaField(j, name) {
  var tb = j && j.tables && j.tables[0];
  var i = tb && tb.fields ? tb.fields.indexOf(name) : -1;
  return (i >= 0 && tb.data && tb.data[0]) ? tb.data[0][i] : null;
}
async function _divMetaFetchOne(code) {
  var via = function (u) { return _divFetchT(NEWS_GAS_URL + '?url=' + encodeURIComponent(u), 40000).then(function (r) { return r.json(); }); };
  var otc = (_contracts[code] && _contracts[code].exchange) === 'OTC';
  if (!otc) {
    var j = await via('https://www.twse.com.tw/rwd/zh/ETF/productContent?id=' + encodeURIComponent(code) + '&response=json');
    if (j && j.stat === 'ok') {
      return { src: 'TWSE', dist: _divMetaField(j, '收益分配'), mgmt: _divMetaField(j, '管理費'),
        cust: _divMetaField(j, '保管費'), listed: _divMetaField(j, '上市日期') };
    }
    if (j && /沒有此資料/.test(j.stat || '')) return { src: null };
    throw new Error('TWSE 回應異常');
  }
  // TPEx 查詢須帶商品類別；依代號尾碼先猜，猜不到再逐類試
  var types = /[BD]$/.test(code) ? ['bond'] : (/A$/.test(code) ? ['active'] : []);
  ['bond', 'active', 'foreign', 'domestic', 'multi'].forEach(function (t) { if (types.indexOf(t) < 0) types.push(t); });
  for (var i = 0; i < types.length; i++) {
    var k = await via('https://www.tpex.org.tw/www/zh-tw/ETF/detail?code=' + encodeURIComponent(code) + '&type=' + types[i] + '&response=json');
    if (k && k.stat === 'ok') {
      return { src: 'TPEx', dist: _divMetaField(k, '收益分配'), mgmt: _divMetaField(k, '管理費'),
        cust: _divMetaField(k, '保管費'), listed: _divMetaField(k, '上櫃日期') };
    }
    if (!(k && /暫無|參數|沒有/.test(k.stat || ''))) throw new Error('TPEx 回應異常');
  }
  return { src: null };
}
// 預載：官方規格（快取有效者不重抓）＋手動輸入。失敗不影響估算，只是退回紀錄推算。
async function divMetaLoad(codes, force) {
  var now = Date.now(), dirty = false;
  var need = (codes || []).filter(function (c) {
    var o = _divMeta[c];
    return force || !o || now - o.ts > (o.src ? DIV_META_TTL : DIV_META_MISS_TTL);
  });
  await Promise.all(need.map(async function (c) {
    try { var m = await _divMetaFetchOne(c); m.ts = Date.now(); _divMeta[c] = m; dirty = true; }
    catch (e) {}                                    // 網路／GAS 異常 → 不快取，下次再試
  }).concat([_divManLoad().catch(function () {})]));
  if (dirty) _divMetaSave();
}

// ── 配息資料頁籤 ──
var _divMetaBusy = false;
function _divMetaCodes() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return Object.keys(m).filter(function (c) { return m[c] > 0 && isEtfCode(c); })
    .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
}
async function startDivMeta(force) {
  var wrap = document.getElementById('divmeta-wrap');
  if (!wrap || _divMetaBusy) return;
  _divMetaBusy = true;
  try {
    if (!(typeof _divRecMap !== 'undefined' && _divRecMap && Object.keys(_divRecMap).length)) {
      wrap.innerHTML = '<div class="modal-loading">讀取配息紀錄…</div>';
      await startDividendEst(false);                // 配息紀錄由股利估算載入（含 TPEx 預告、手動補登）
    }
    wrap.innerHTML = '<div class="modal-loading">讀取官方 ETF 規格…</div>';
    await divMetaLoad(_divMetaCodes(), force);
  } finally { _divMetaBusy = false; }
  renderDivMeta();
}

function _divMetaRow(code) {
  var today = _divTwDate().iso;
  var c = (_contracts && _contracts[code]) || {};
  var o = _divMeta[code] || {}, man = _divMan[code] || {};
  var recs = ((typeof _divRecMap !== 'undefined' && _divRecMap[code]) || [])
    .filter(function (r) { return r.exDate; }).slice()
    .sort(function (a, b) { return a.exDate < b.exDate ? -1 : 1; });
  var f = _divFreqSource(code);
  var step, src;
  if (f) { step = f.step; src = f.src; }
  else if (recs.length) { step = _divInferStep(recs.map(function (r) { return Object.assign({ code: code }, r); })); src = recs.length >= 2 ? 'infer' : 'guess'; }
  else { step = null; src = _divDistNone(o.dist) ? 'none' : 'guess'; }

  var past = recs.filter(function (r) { return r.exDate <= today && r.amount > 0; });
  var last = past[past.length - 1] || null;
  var next = recs.filter(function (r) { return r.exDate > today; })[0] || null;
  var d12 = new Date(Date.parse(today) - 365 * 86400000).toISOString().slice(0, 10);
  var in12 = past.filter(function (r) { return r.exDate > d12; });
  var sum12 = in12.reduce(function (a, r) { return a + r.amount; }, 0);
  var r0 = (typeof _rows !== 'undefined') && _rows[code];
  var px = (r0 && r0.close != null) ? r0.close : (c.reference || null);
  var latestAmt = (next && next.amount > 0) ? next.amount : (last ? last.amount : null);
  var yld1 = (px && latestAmt && step) ? latestAmt * (12 / step) / px * 100 : null;
  var yld12 = (px && in12.length) ? sum12 / px * 100 : null;

  var mgmt = man.mgmt != null ? man.mgmt : _divFeePct(o.mgmt);
  var cust = man.cust != null ? man.cust : _divFeePct(o.cust);
  // 狀態：red＝頻率靠猜（紀錄 ≤1 筆且無官方／手動）、yellow＝由紀錄推算、green＝官方或手動、gray＝不配息
  var lv = src === 'none' ? 'gray' : (src === 'guess' ? 'red' : (src === 'infer' ? 'yellow' : 'green'));
  var chk = (typeof _divBrokerCheck === 'function') ? _divBrokerCheck(code) : null;
  if (chk && chk.bad.length) lv = 'red';                        // 與券商實領不符 → 除息紀錄有缺漏，列最上面
  return { code: code, name: c.name || '', cat: (typeof catOf === 'function') ? catOf(code) : '', o: o, man: man,
    step: step, src: src, lv: lv, chk: chk, recs: recs, last: last, next: next, in12: in12, sum12: sum12,
    yld1: yld1, yld12: yld12, mgmt: mgmt, cust: cust };
}

function renderDivMeta() {
  var wrap = document.getElementById('divmeta-wrap');
  if (!wrap) return;
  var codes = _divMetaCodes();
  if (!codes.length) { wrap.innerHTML = '<div class="modal-loading">目前持股中沒有 ETF</div>'; return; }
  var order = { red: 0, yellow: 1, green: 2, gray: 3 };
  var rows = codes.map(_divMetaRow).sort(function (a, b) {
    return (order[a.lv] - order[b.lv]) || a.code.localeCompare(b.code, undefined, { numeric: true });
  });
  var md = function (iso) { return iso ? iso.slice(5).replace('-', '/') : '—'; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); };
  var dim = function (s) { return '<span class="dm-dim">' + s + '</span>'; };
  var srcName = { manual: '手動', code: '程式登錄', mdj: 'MoneyDJ', TWSE: 'TWSE', TPEx: 'TPEx', infer: '紀錄推算', guess: '推定', none: '官方' };
  var lvTip = { red: '頻率靠推定（紀錄 ≤1 筆、無官方或手動資料），或除息紀錄與券商實領金額不符，請確認', yellow: '頻率由除息紀錄推算', green: '頻率來自 MoneyDJ、官方或手動輸入', gray: '官方標示不配息' };
  var rfMan = (typeof _rfManLoad === 'function') ? _rfManLoad() : {};

  var store = _divManStore === 'firestore'
    ? '<span class="st-pill st-ok">手動輸入存於雲端（Firestore）</span>'
    : '<span class="st-pill st-part" title="' + esc(_divManErr) + '">手動輸入暫存本機（' + esc(_divManErr || 'Firestore 未連線') + '）</span>';
  var info = document.getElementById('divmeta-info');
  if (info) info.innerHTML = store;

  var h = '<div class="inv-table-wrap"><table class="inv-table dm-table"><thead><tr>' +
    '<th>狀態</th><th>代號</th><th>名稱</th><th>分類</th>' +
    '<th title="選「自動」＝依官方規格或除息紀錄；手動選擇會覆蓋全站（股利估算、換股試算、關注股票、歷年配息圖）">配息頻率</th>' +
    '<th title="近 13 個月實際除息（含已公告）的月份；尚無紀錄時以官方收益評價月推估">除息月份</th>' +
    '<th class="num" title="年率 %；級距制顯示最低規模級距，完整文字見提示">管理費</th><th class="num">保管費</th>' +
    '<th class="num" title="管理費＋保管費">總費用</th><th>上市櫃日</th>' +
    '<th>最近除息</th><th>下次除息</th>' +
    '<th class="num" title="近 12 個月已除息之每股金額合計">近12月每股</th>' +
    '<th class="num" title="最新一次每股 × 年配息次數 ÷ 現價">年化殖利率</th>' +
    '<th class="num" title="近 12 個月每股合計 ÷ 現價；上市未滿一年會偏低">近12月殖利率</th>' +
    '<th class="num">紀錄</th>' +
    '<th title="已賣出批次：券商記錄的持有期間實領股利 vs 依除息紀錄重算，不符代表紀錄缺漏">券商核對</th></tr></thead><tbody>';

  rows.forEach(function (r) {
    var o = r.o, man = r.man;
    // 頻率下拉：自動（顯示目前採用值與來源）＋四種手動
    var autoLbl = '自動';
    if (!man.step) autoLbl += r.step ? '（' + DIV_FREQ_NAME[r.step] + '）' : (r.src === 'none' ? '（不配息）' : '（未知）');
    var sel = '<select class="dm-sel" onchange="divMetaSet(\'' + r.code + '\',\'step\',this.value)">' +
      '<option value="">' + autoLbl + '</option>' +
      [1, 2, 3, 6, 12].map(function (s) { return '<option value="' + s + '"' + (man.step === s ? ' selected' : '') + '>' + DIV_FREQ_NAME[s] + '</option>'; }).join('') +
      '</select>';
    var srcTag = '<span class="dm-src dm-src-' + (r.src === 'TWSE' || r.src === 'TPEx' || r.src === 'mdj' ? 'off' : r.src) + '" title="' +
      esc(o.dist ? '官方原文：' + o.dist : '') + '">' + srcName[r.src] + '</span>';

    // 除息月份：取實際除息紀錄（近 13 個月＋已公告未除息），不用官方原文的月份——
    // 官方寫的多是「收益評價日」（00918：二、五、八、十一月），比除息早約一個月，直接顯示會被誤認為除息月。
    // 紀錄不足（新上市）時才退回官方月份，並標「評價」以示區別。
    var d13 = new Date(Date.parse(_divTwDate().iso) - 395 * 86400000).toISOString().slice(0, 10);
    var exM = {};
    r.recs.forEach(function (x) { if (x.exDate >= d13) exM[+x.exDate.slice(5, 7)] = true; });
    var exList = Object.keys(exM).map(Number).sort(function (a, b) { return a - b; });
    var offM = _divDistMonths(o.dist), offTip = o.dist ? '官方收益分配：' + o.dist : '';
    var monthsTxt;
    if (r.step === 1 && exList.length >= 3) monthsTxt = '每月';
    else if (exList.length && r.step && 12 % r.step === 0 && exList.length < 12 / r.step) {
      // 紀錄還不滿一輪（新上市，例 00404A 只除息過 9 月）：依配息頻率從最近一次往後推，推估的月份淡色顯示
      var last = +r.recs.filter(function (x) { return x.exDate >= d13; }).slice(-1)[0].exDate.slice(5, 7);
      var all = {};
      for (var k = 0; k < 12 / r.step; k++) all[((last - 1 + k * r.step) % 12) + 1] = true;
      monthsTxt = Object.keys(all).map(Number).sort(function (a, b) { return a - b; })
        .map(function (mm) { return exM[mm] ? String(mm) : dim(String(mm)); }).join('/') + '月';
    }
    else if (exList.length) monthsTxt = exList.join('/') + '月';
    else if (/每月|月配/.test(o.dist || '')) monthsTxt = dim('每月');
    else if (offM.length) monthsTxt = dim('評價 ' + offM.join('/') + '月');
    else monthsTxt = dim('—');
    monthsTxt = '<span title="' + esc(offTip) + '">' + monthsTxt + '</span>';

    var feeCell = function (key, val, raw) {
      var manual = man[key] != null;
      var ph = _divFeePct(raw);
      // 數字、%、級距標記包成一組靠右：% 緊貼數字；「級」固定佔位（沒有也留空），各列 % 才上下對齊
      return '<td class="num" title="' + esc(raw || '') + '"><span class="dm-feewrap">' +
        '<input class="dm-fee' + (manual ? ' dm-manual' : '') + '" type="number" step="0.001" min="0" max="5" ' +
        'value="' + (manual ? man[key] : '') + '" placeholder="' + (ph != null ? ph : '—') + '" ' +
        'onchange="divMetaSet(\'' + r.code + '\',\'' + key + '\',this.value)">' +
        '<span class="dm-pct">%</span>' +
        '<span class="dm-tier"' + (!manual && _divFeeTiered(raw) ? ' title="級距制">級' : '>') + '</span></span></td>';
    };
    var tot = (r.mgmt != null && r.cust != null) ? (r.mgmt + r.cust).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%' : dim('—');

    var nextTxt = r.next
      ? md(r.next.exDate) + '　' + (r.next.amount > 0 ? r.next.amount.toFixed(4) : dim('待公告')) +
        (r.next.payDate ? dim('　發 ' + md(r.next.payDate)) : '') + (rfMan[r.code] ? ' <span class="dm-src dm-src-manual" title="已手動補登">補登</span>' : '')
      : dim('—');
    // 手動補登下次除息：投信已公告、但官方預告表（約前兩週）與 e添富 都還沒收錄時用；官方收錄後以官方值為準
    var mv = rfMan[r.code] && rfMan[r.code].exDate >= _divTwDate().iso ? _rfManStr(rfMan[r.code]) : '';
    nextTxt += '<input class="sbl-inp dm-next-inp' + (mv ? ' dm-manual' : '') + '" type="text" value="' + esc(mv) + '"' +
      ' placeholder="補登 10/05 [金額] [發放日]" title="投信已公告但尚未收錄時手動輸入：除息日必填，金額、發放日可省略（省略發放日時依該檔過去的除息→發放天數推算）。清空即移除"' +
      ' onchange="divMetaNextEx(\'' + r.code + '\',this.value)">';
    var y12 = r.yld12 == null ? dim('—')
      : r.yld12.toFixed(2) + '%' + (r.step && r.in12.length < 12 / r.step ? dim('（' + r.in12.length + ' 次）') : '');

    h += '<tr>' +
      '<td><span class="dm-lv dm-lv-' + r.lv + '" title="' + lvTip[r.lv] + '"></span></td>' +
      '<td class="inv-code">' + r.code + '</td><td class="inv-name">' + esc(r.name) + '</td>' +
      '<td>' + dim(esc(r.cat)) + '</td>' +
      '<td class="dm-freq">' + sel + srcTag + '</td>' +
      '<td>' + monthsTxt + '</td>' +
      feeCell('mgmt', r.mgmt, o.mgmt) + feeCell('cust', r.cust, o.cust) +
      '<td class="num">' + tot + '</td>' +
      '<td>' + (o.listed ? esc(String(o.listed).replace(/\./g, '/')) : dim('—')) + '</td>' +
      '<td>' + (r.last ? md(r.last.exDate) + '　' + r.last.amount.toFixed(4) : dim('—')) + '</td>' +
      '<td>' + nextTxt + '</td>' +
      '<td class="num">' + (r.in12.length ? r.sum12.toFixed(4) : dim('—')) + '</td>' +
      '<td class="num">' + (r.yld1 == null ? dim('—') : r.yld1.toFixed(2) + '%') + '</td>' +
      '<td class="num">' + y12 + '</td>' +
      '<td class="num' + (r.recs.length <= 1 ? ' dm-warn' : '') + '">' + r.recs.length + '</td>' +
      '<td>' + _divChkCell(r.chk) + '</td>' +
      '</tr>';
  });
  h += '</tbody></table></div>' +
    '<div class="divest-note">' +
    '<span class="dm-lv dm-lv-red"></span> 頻率靠推定，需確認　<span class="dm-lv dm-lv-yellow"></span> 由除息紀錄推算　' +
    '<span class="dm-lv dm-lv-green"></span> 官方或手動　<span class="dm-lv dm-lv-gray"></span> 不配息。' +
    '官方規格：上市＝TWSE、上櫃＝TPEx「ETF 商品資訊」，每 30 天更新一次。' +
    '配息頻率、管理費、保管費可手動輸入，會覆蓋官方值；清空即回到自動。「下次除息」欄可手動補登投信已公告、官方尚未收錄的除息日（金額與發放日可省略）。</div>';
  wrap.innerHTML = h;
}

function _divChkCell(chk) {
  if (!chk) return '<span class="dm-dim" title="近 12 個月沒有賣出紀錄，無可比對">—</span>';
  if (!chk.bad.length) return '<span class="dm-ok" title="已賣出 ' + chk.n + ' 批的實領股利與除息紀錄一致">✓ ' + chk.n + ' 批</span>';
  var ps = chk.bad.map(function (b) { return b.perShare; });
  var same = ps.every(function (v) { return Math.abs(v - ps[0]) < 0.0015; });
  var tip = chk.bad.map(function (b) {
    return b.buy + ' 買 → ' + b.sell + ' 賣　' + (b.shares / 1000) + ' 張　券商實領 ' + b.broker + '／紀錄推算 ' + b.ours;
  }).join('\n');
  return '<span class="dm-warn" title="' + tip + '">⚠ ' + chk.bad.length + '/' + chk.n + ' 批不符' +
    (same ? '，每股差 ' + (ps[0] > 0 ? '+' : '') + ps[0].toFixed(3) : '') + '</span>';
}

async function divMetaNextEx(code, raw) {
  var map = _rfManLoad();
  if (!String(raw || '').trim()) delete map[code];
  else {
    var r = _rfParseManual(raw);
    if (!r) { alert('無法解析，請輸入如：10/05　或　2026/10/05 0.085 2026/10/27'); return; }
    map[code] = r;
  }
  _rfManSave(map);
  try { await startDividendEst(false); } catch (e) {}   // 重算估算（沿用當日快取），本頁「下次除息」同步更新
  renderDivMeta();
}
async function divMetaSet(code, key, raw) {
  var rec = Object.assign({}, _divMan[code] || {});
  var oldStep = rec.step || null;
  if (key === 'step') rec.step = raw ? +raw : null;
  else { var v = raw === '' ? null : +raw; rec[key] = (v == null || isNaN(v)) ? null : v; }
  Object.keys(rec).forEach(function (k) { if (rec[k] == null) delete rec[k]; });
  rec.at = Date.now();
  await _divManSave(code, rec);
  renderDivMeta();
  // 頻率變動會影響估算與殖利率 → 背景重算股利估算（配息紀錄走快取，不重打外部來源）
  if (key === 'step' && (rec.step || null) !== oldStep && typeof startDividendEst === 'function') {
    startDividendEst(false).then(renderDivMeta).catch(function () {});
  }
}
