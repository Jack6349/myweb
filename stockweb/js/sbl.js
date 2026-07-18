// 股利總管 Web — 出借行情（交易資訊子頁籤：持股 × TWSE 借券資料，值得出借提醒）
// 來源：TWSE /rwd/zh/lending/t13sa710（借券成交明細→逐檔聚合加權/最高費率、成交張數）
//      ＋ /rwd/zh/marginTrading/TWT93U（融券借券賣出餘額，上市，單位:股）
// 盤後資料：進頁載入一次＋手動更新；門檻存 localStorage，改門檻只重算不重抓

var _sblLoaded = false;
var _sblCache = null; // { date, fee:{code:{w,max,vol}}, bal:{code:{today,prev}}, positions }

// ── 子頁籤切換（交易帳務 / 出借行情）──
function txShowTab(tab) {
  var acc = tab === 'account';
  document.getElementById('tx-tab-account').style.display = acc ? '' : 'none';
  document.getElementById('tx-tab-sbl').style.display = acc ? 'none' : '';
  document.getElementById('tx-subtab-account').classList.toggle('active', acc);
  document.getElementById('tx-subtab-sbl').classList.toggle('active', !acc);
  if (!acc && !_sblLoaded) startSbl();
}

function _sblThr() {
  var f = parseFloat(localStorage.getItem('sbl_fee_min')), v = parseInt(localStorage.getItem('sbl_vol_min'), 10);
  var i = parseFloat(localStorage.getItem('sbl_idle_days'));
  return { fee: isNaN(f) ? 0.5 : f, vol: isNaN(v) ? 10 : v, idle: (isNaN(i) || i < 0) ? 6 : i };
}
function sblThrChanged() {
  var f = parseFloat(document.getElementById('sbl-fee-min').value), v = parseInt(document.getElementById('sbl-vol-min').value, 10);
  var i = parseFloat(document.getElementById('sbl-idle-days').value);
  if (!isNaN(f)) localStorage.setItem('sbl_fee_min', f);
  if (!isNaN(v)) localStorage.setItem('sbl_vol_min', v);
  if (!isNaN(i) && i >= 0) localStorage.setItem('sbl_idle_days', i);
  if (_sblCache) _sblRender(); // 只重算提醒/試算，不重抓
}

// ── 實際已借出 ──
// 借出數量自動偵測（同 stream.js 出借補償邏輯）：出借中股數不在彙總 quantity、但建倉明細
// 仍有未平倉 → 借出股數 = 明細股數 − 彙總股數。費率券商無 API，仍手動輸入存 localStorage。
function _sblLent() {
  try { return JSON.parse(localStorage.getItem('sbl_lent') || '{}'); } catch (e) { return {}; }
}
function sblLentInp(inp, code) {
  var lent = _sblLent(), v = parseFloat(inp.value);
  if (isNaN(v) || v <= 0) delete lent[code]; else lent[code] = { r: v };
  localStorage.setItem('sbl_lent', JSON.stringify(lent));
  if (_sblCache) _sblRender();
}
// 逐檔查建倉明細，補出 totalShares（含借出）與 lentShares（借出中）
async function _sblEnrichLent(positions) {
  await Promise.all(positions.map(async function (p) {
    p.lentShares = 0; p.totalShares = p.quantity;
    if (p.id == null) return;
    try {
      var det = await fetchPositionDetail(p.id);
      var dq = 0, dcost = 0;
      (det || []).forEach(function (d) { if (d.quantity > 0) { dq += d.quantity; dcost += (d.price || 0); } });
      var detShares = dq * 1000; // 明細以「張」計 → 股
      if (detShares > p.quantity) {
        p.lentShares = detShares - p.quantity;
        p.totalShares = detShares;
      }
    } catch (e) { console.warn('[sbl detail]', p.code, e); }
  }));
}

function _sblNum(s) { var n = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
// 張數顯示：整張加千分位；含零股顯示至 3 位小數並去尾 0
function _sblLots(lots) {
  var v = Math.round(lots * 1000) / 1000;
  return Number.isInteger(v) ? v.toLocaleString('zh-TW') : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
function _sblYmd(d) { return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }

// 借券成交明細（日期區間，一次撈完）：回傳 rows 或 null
// 費率是「當日流量」，多數個股整天無人借（實測 7/17 全市場僅 370/1218 檔有成交）→
// 改抓近 30 日曆天（≈20 交易日）給出參考行情與最近成交日，判斷該不該掛出借才有依據
async function _sblFetchFeeRange(startYmd, endYmd) {
  var url = 'https://www.twse.com.tw/rwd/zh/lending/t13sa710?startDate=' + startYmd + '&endDate=' + endYmd +
    '&tradeType=&stockNo=&response=json';
  var r = await fetch(url); if (!r.ok) return null;
  var j = await r.json();
  if (j.stat !== 'OK' || !j.data || !j.data.length) return null;
  return j.data;
}
// 民國日期 "115年07月17日" → {ymd:'20260717', md:'07/17'}
function _sblRocDate(s) {
  var m = String(s || '').match(/(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  var y = parseInt(m[1], 10) + 1911, mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
  return { ymd: '' + y + mo + d, md: mo + '/' + d };
}

async function startSbl(force) {
  if (force) _sblCache = null;
  _sblLoaded = true;
  var body = document.getElementById('sbl-body');
  body.innerHTML = '<div class="modal-loading">查詢借券資料中…</div>';
  // 門檻輸入框帶入現值
  var thr = _sblThr();
  document.getElementById('sbl-fee-min').value = thr.fee;
  document.getElementById('sbl-vol-min').value = thr.vol;
  document.getElementById('sbl-idle-days').value = thr.idle;
  try {
    // 近 30 日曆天（≈20 交易日）借券成交，一次區間查詢撈完
    var day = new Date(), from = new Date(day.getTime() - 30 * 86400000);
    var endYmd = _sblYmd(day), startYmd = _sblYmd(from), feeRows = null;
    try { feeRows = await _sblFetchFeeRange(startYmd, endYmd); } catch (e) { feeRows = null; }
    if (!feeRows) { body.innerHTML = '<div class="modal-loading">近 30 日查無借券成交資料（TWSE 可能維護中）</div>'; return; }

    // 逐檔聚合：只計「競價」——議借是法人間私下議定（常見 ETF 造市/對沖），費率可低到 0.05%
    // 且量體巨大（實測 20 日全市場議借 1,069 萬張 vs 競價 22.6 萬張），混入會嚴重扭曲加權值，
    // 對散戶出借方無參考價值（例：00988A 全部加權 0.39% → 競價加權 1.74%）。議借另記供對照。
    var fee = {}, feeDays = {};
    feeRows.forEach(function (r) {
      var code = String(r[1] || '').trim().split(/\s+/)[0]; if (!code) return;
      var vol = _sblNum(r[3]), rate = _sblNum(r[4]), dt = _sblRocDate(r[0]), type = String(r[2] || '').trim();
      var f = fee[code] || (fee[code] = { vol: 0, wsum: 0, max: 0, last: null, lastMd: '', negVol: 0, negWsum: 0 });
      if (type === '議借') { f.negVol += vol; f.negWsum += vol * rate; return; }
      if (dt) feeDays[dt.ymd] = true;
      f.vol += vol; f.wsum += vol * rate; if (rate > f.max) f.max = rate;
      if (dt && (!f.last || dt.ymd > f.last)) { f.last = dt.ymd; f.lastMd = dt.md; }
    });
    var _md = function (ymd) { return ymd.slice(4, 6) + '/' + ymd.slice(6, 8); };
    var dayList = Object.keys(feeDays).sort();
    var rangeLabel = dayList.length
      ? '近 ' + dayList.length + ' 交易日（' + _md(dayList[0]) + '~' + _md(dayList[dayList.length - 1]) + '）'
      : '近 30 日';

    // 借券賣出餘額（上市；單位:股）：idx 8=前日餘額、12=當日餘額
    // 費率明細盤中即時揭露、餘額盤後才有 → 當日撈不到就往前找（最多 7 天），日期不同時另行標註
    var bal = {}, balYmd = '';
    var bDay = new Date(day.getTime());
    for (var j = 0; j < 7; j++) {
      var bymd = _sblYmd(bDay);
      try {
        var rb = await fetch('https://www.twse.com.tw/rwd/zh/marginTrading/TWT93U?date=' + bymd + '&response=json');
        var jb = await rb.json();
        if (jb.stat === 'OK' && jb.data && jb.data.length) {
          jb.data.forEach(function (r) {
            bal[String(r[0]).trim()] = { prev: _sblNum(r[8]) / 1000, today: _sblNum(r[12]) / 1000, name: String(r[1] || '').trim() };
          });
          balYmd = bymd; break;
        }
      } catch (e) { console.warn('[sbl TWT93U]', e); break; }
      bDay.setDate(bDay.getDate() - 1);
    }
    var dateEl = document.getElementById('sbl-date');
    dateEl.textContent = '費率 ' + rangeLabel + '・餘額 ' + (balYmd ? _md(balYmd) + '（盤後）' : '暫無資料');

    // 券商庫存（server 未連線時仍顯示市場資料提示）
    var positions = [];
    try { positions = await fetchBrokerPositions() || []; }
    catch (e) { body.innerHTML = '<div class="modal-loading">無法取得券商庫存（' + e.message + '），請確認本機 server 連線後再更新</div>'; return; }
    if (!positions.length) { body.innerHTML = '<div class="modal-loading">目前無庫存持股</div>'; return; }

    // 借出偵測（明細−彙總）；全數出借的檔彙總歸零，補回後仍為 0 的才是真出清
    await _sblEnrichLent(positions);
    positions = positions.filter(function (p) { return p.totalShares > 0; });

    // 名稱補查：TWT93U 沒有的檔（如上櫃/新上市 ETF）就地查合約補進共用快取（同 txinfo 作法）；
    // 全數出借時彙總 last_price 可能缺，順便補合約取平盤價備用
    for (var k = 0; k < positions.length; k++) {
      var p2 = positions[k], code = p2.code;
      if ((!bal[code] || !p2.last_price) && !(typeof _contracts !== 'undefined' && _contracts[code])) {
        try { _contracts[code] = await fetchContract(code); } catch (e2) { console.warn('[sbl contract]', code, e2); }
      }
    }

    _sblCache = { range: rangeLabel, balYmd: balYmd, fee: fee, bal: bal, positions: positions };
    _sblRender();
  } catch (e) {
    body.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>';
  }
}

function _sblRender() {
  var c = _sblCache, thr = _sblThr(), lentMap = _sblLent();
  var rows = c.positions.map(function (p) {
    var code = p.code, f = c.fee[code] || null, b = c.bal[code] || null;
    var ct = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
    var name = (b && b.name) || (ct ? ct.name : '');
    var price = p.last_price || (ct && ct.reference) || 0; // 全數出借時彙總缺現價 → 退平盤價
    var w = f && f.vol ? f.wsum / f.vol : null;
    var hit = w != null && f.vol >= thr.vol && w >= thr.fee;
    var rate = (lentMap[code] && lentMap[code].r) || 0;
    // 估年收基準：已出借者用「出借股數」（才能與左邊實際年收同基準相比）；未出借者用總庫存（全額出借的潛力）
    var estShares = p.lentShares > 0 ? p.lentShares : p.totalShares;
    var est = (w != null && price) ? estShares * price * w / 100 : null;
    // 實際年收＝借出股數×現價×費率%（以現價概算；實際依每日收盤價計息）
    var lentInc = (p.lentShares > 0 && rate > 0 && price) ? p.lentShares * price * rate / 100 : null;
    // 召回試算：換到市場費率的年增額與回本天數
    //   回本天數 ＝ 空窗天數 × (現有費率 ÷ 費率差)   ← 與市值/張數無關，純比例
    var gain = null, bDays = null;
    if (lentInc != null && est != null) {
      gain = est - lentInc;
      var gap = w - rate;
      if (gap > 0) bDays = thr.idle * rate / gap;
    }
    return { code: code, name: name, lots: p.totalShares / 1000, lentLots: p.lentShares / 1000, rate: rate,
      f: f, w: w, b: b, est: est, estOnLent: p.lentShares > 0, hit: hit, lentInc: lentInc, gain: gain, bDays: bDays,
      lastMd: f ? f.lastMd : '' };
  });
  rows.sort(function (a, b) {
    if (a.hit !== b.hit) return a.hit ? -1 : 1;
    if ((a.lentLots > 0) !== (b.lentLots > 0)) return a.lentLots > 0 ? -1 : 1; // 已借出排前
    return (b.w || -1) - (a.w || -1);
  });

  // 提醒橫幅
  var hits = rows.filter(function (r) { return r.hit; });
  var bn = document.getElementById('sbl-banner');
  if (hits.length) {
    bn.style.display = '';
    bn.innerHTML = '🔔 值得出借 ' + hits.length + ' 檔：' + hits.map(function (r) {
      return r.code + (r.name ? ' ' + r.name : '') + '（加權 ' + r.w.toFixed(2) + '%' + (r.lastMd ? '，最近 ' + r.lastMd : '') + '）';
    }).join('、') + '　— 期間費率達門檻且成交熱絡，可考慮手動掛出借';
  } else {
    bn.style.display = 'none'; bn.innerHTML = '';
  }

  var html = '<div class="inv-table-wrap"><table class="inv-table sbl-table"><thead><tr>' +
    '<th>代號 / 名稱</th><th class="num">庫存(張)</th>' +
    '<th class="num sbl-my">借出數量</th><th class="num sbl-my">借出費率％</th><th class="num sbl-my">年收(元)</th>' +
    '<th class="num">借券賣出餘額(張)</th>' +
    '<th class="num">競價費率% 加權/最高</th><th class="num">最近成交</th><th class="num">期間成交(張)</th>' +
    '<th class="num">估年收(元)</th><th class="num sbl-calc">年增(元)</th><th class="num sbl-calc">回本(天)</th>' +
    '<th style="text-align:center">提醒</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    var balHtml = '—';
    if (r.b) {
      var d = r.b.today - r.b.prev;
      var arrow = d > 0 ? ' <span class="up">▲' + Math.round(d).toLocaleString('zh-TW') + '</span>'
        : (d < 0 ? ' <span class="down">▼' + Math.round(-d).toLocaleString('zh-TW') + '</span>' : '');
      balHtml = Math.round(r.b.today).toLocaleString('zh-TW') + arrow;
    }
    // 議借對照（滑鼠提示）：說明該檔另有法人議借成交，但未計入競價費率
    var negLots = r.f ? r.f.negVol : 0;
    var negTip = negLots ? ' title="另有法人議借 ' + Math.round(negLots).toLocaleString('zh-TW') + ' 張（加權 ' +
      (r.f.negWsum / negLots).toFixed(2) + '%），非散戶行情，未計入"' : '';
    html += '<tr' + (r.hit ? ' class="sbl-hit"' : '') + '>' +
      '<td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + (r.name || '') + '</span></td>' +
      '<td class="num">' + _sblLots(r.lots) + '</td>' +
      '<td class="num sbl-my">' + (r.lentLots > 0 ? '<b>' + _sblLots(r.lentLots) + '</b>' : '<span class="sbl-dim">—</span>') + '</td>' +
      '<td class="num sbl-my">' + (r.lentLots > 0
        ? '<input class="sbl-inp sbl-lent-inp" type="number" min="0" step="0.01" value="' + (r.rate || '') + '"' +
          ' placeholder="輸入" onchange="sblLentInp(this,\'' + r.code + '\')">'
        : '<span class="sbl-dim">—</span>') + '</td>' +
      '<td class="num sbl-my">' + (r.lentInc != null ? Math.round(r.lentInc).toLocaleString('zh-TW')
        : (r.lentLots > 0 ? '<span class="sbl-dim">填費率</span>' : '<span class="sbl-dim">—</span>')) + '</td>' +
      '<td class="num">' + balHtml + '</td>' +
      '<td class="num"' + negTip + '>' + (r.w != null ? '<b>' + r.w.toFixed(2) + '</b> / ' + r.f.max.toFixed(2)
        : '<span class="sbl-dim">期間無競價' + (negLots ? '＊' : '') + '</span>') + '</td>' +
      '<td class="num">' + (r.lastMd ? r.lastMd : '<span class="sbl-dim">—</span>') + '</td>' +
      '<td class="num">' + (r.f ? r.f.vol.toLocaleString('zh-TW') : '0') + '</td>' +
      '<td class="num"' + (r.est != null ? ' title="基準：' + (r.estOnLent ? '出借股數（與左側年收同基準）' : '總庫存（全額出借的潛力）') + '"' : '') + '>' +
        (r.est != null ? Math.round(r.est).toLocaleString('zh-TW') : '—') + '</td>' +
      '<td class="num sbl-calc">' + (r.gain == null ? '<span class="sbl-dim">—</span>'
        : (r.gain > 0 ? '<b class="up">+' + Math.round(r.gain).toLocaleString('zh-TW') + '</b>'
          : '<span class="down">' + Math.round(r.gain).toLocaleString('zh-TW') + '</span>')) + '</td>' +
      '<td class="num sbl-calc">' + (r.gain == null ? '<span class="sbl-dim">—</span>'
        : (r.bDays == null ? '<span class="down">優於市場</span>' : '<b>' + r.bDays.toFixed(1) + '</b>')) + '</td>' +
      '<td style="text-align:center">' + (r.hit ? '<span class="sbl-pill">值得出借</span>' : '<span class="sbl-dim">—</span>') + '</td></tr>';
  });
  html += '</tbody>';
  // 已借出合計（有偵測到借出才顯示）
  var lentQ = 0, lentInc = 0, lentN = 0, gainSum = 0;
  rows.forEach(function (r) {
    if (r.lentLots > 0) { lentN++; lentQ += r.lentLots; lentInc += r.lentInc || 0; gainSum += r.gain || 0; }
  });
  if (lentN) {
    html += '<tfoot><tr class="sbl-total"><td>已借出合計（' + lentN + ' 檔）</td><td></td>' +
      '<td class="num sbl-my">' + _sblLots(lentQ) + '</td><td></td>' +
      '<td class="num sbl-my">' + Math.round(lentInc).toLocaleString('zh-TW') + '</td>' +
      '<td colspan="5"></td>' +
      '<td class="num sbl-calc">' + (gainSum ? (gainSum > 0 ? '+' : '') + Math.round(gainSum).toLocaleString('zh-TW') : '') + '</td>' +
      '<td colspan="2"></td></tr></tfoot>';
  }
  html += '</table></div>';
  document.getElementById('sbl-body').innerHTML = html;
}
