// 股利總管 Web — 加減碼報告：系統性風險評分（量化取代質化 veto）
// ※ 依使用者自訂規則自動算分的參考工具，非投資建議。門檻為初始值，待 6 個月歷史回測校準。
// 六項各 0/1/2 分（總 0–12）＋「股債同向重挫」旗標（觸發直接 veto，不論總分）。
// 資料源：Yahoo（^VIX/^TNX/DX-Y.NYB/^SOX/^IXIC，經 GAS 代理）＋ Shioaji 台指期夜盤 TXFR1。

// ── 門檻常數（回測校準後改這裡即可） ──
var RS_TH = {
  vix:    [20, 25],    // 絕對值：<20→0, 20~25→1, >25→2
  vixChg: [10, 20],    // 單日漲幅%（只計上升）
  yield:  [1, 2],      // 美10年債殖利率單日變化%（絕對值）
  dxy:    [0.5, 1],    // 美元指數單日變化%（絕對值）
  equity: [2, 4],      // 費半/Nasdaq 單日跌幅%（取較大者）
  night:  [1, 3]       // 台指期夜盤跌幅%
};
// 股債同向重挫旗標：股市跌幅≥且美10年債殖利率同步漲幅≥（兩者皆達極端 → 傳統對沖失效）
var RS_FLAG = { equityDrop: 4, yieldUp: 2 };

function _rsScore(v, th) { return v == null ? null : (v < th[0] ? 0 : (v <= th[1] ? 1 : 2)); }
function _rsColor(s) { return s == null ? 'var(--text3)' : (s === 0 ? 'var(--down)' : (s === 1 ? 'var(--accent2)' : 'var(--up)')); }

var _rsCache = {}; // sym → {ts,data}；成功結果快取 3 分鐘，減少 GAS urlfetch 消耗
async function _rsYahoo(sym) {
  var c = _rsCache[sym];
  if (c && Date.now() - c.ts < 180000) return c.data;
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d';
    var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
    var j = await r.json();
    var res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) return null;
    var closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [])
      .filter(function (x) { return x != null; });
    if (closes.length < 2) return null;
    var last = closes[closes.length - 1], prev = closes[closes.length - 2];
    var data = { value: last, chg: prev ? (last - prev) / prev * 100 : null };
    _rsCache[sym] = { ts: Date.now(), data: data };
    return data;
  } catch (e) { return null; }
}
async function _rsNight() {
  try {
    var r = await fetch('/api/v1/data/snapshots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contracts: [{ security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }] })
    });
    var a = await r.json();
    if (a && a[0] && a[0].close != null) return { value: a[0].close, chg: a[0].change_rate };
  } catch (e) {}
  return null;
}

async function startRiskReport(force) {
  var wrap = document.getElementById('risk-wrap');
  var info = document.getElementById('risk-info');
  wrap.innerHTML = '<div class="modal-loading">抓取總經與台指夜盤資料…</div>';

  var res = await Promise.all([
    _rsYahoo('^VIX'), _rsYahoo('^TNX'), _rsYahoo('DX-Y.NYB'),
    _rsYahoo('^SOX'), _rsYahoo('^IXIC'), _rsNight()
  ]);
  var vix = res[0], tnx = res[1], dxy = res[2], sox = res[3], ndx = res[4], night = res[5];

  // 帶正負號顯示（漲跌都可能，非只跌）
  var sp = function (v, d) { return v == null ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + '%'; };
  // 費半/Nasdaq 取「較弱者」（最負）當代表值；跌幅用於評分
  var soxC = sox ? sox.chg : null, ndxC = ndx ? ndx.chg : null;
  var equityWorst = (soxC != null && ndxC != null) ? Math.min(soxC, ndxC) : (soxC != null ? soxC : ndxC);
  var equityDrop = equityWorst != null ? Math.max(0, -equityWorst) : null;
  var nightChg = night && night.chg != null ? night.chg : null;
  var nightDrop = nightChg != null ? Math.max(0, -nightChg) : null;
  var vixUp = vix && vix.chg != null ? Math.max(0, vix.chg) : null;

  var rows = [
    { k: 'VIX 絕對值', val: vix ? vix.value.toFixed(2) : '—', score: vix ? _rsScore(vix.value, RS_TH.vix) : null },
    { k: 'VIX 單日變化', val: vix ? sp(vix.chg, 1) : '—', score: _rsScore(vixUp, RS_TH.vixChg) },
    { k: '美10年債殖利率變化', val: tnx ? sp(tnx.chg, 2) : '—', score: tnx && tnx.chg != null ? _rsScore(Math.abs(tnx.chg), RS_TH.yield) : null },
    { k: '美元指數變化', val: dxy ? sp(dxy.chg, 2) : '—', score: dxy && dxy.chg != null ? _rsScore(Math.abs(dxy.chg), RS_TH.dxy) : null },
    { k: '費半/Nasdaq 變化（取較弱）', val: equityWorst != null ? sp(equityWorst, 2) : '—', score: _rsScore(equityDrop, RS_TH.equity) },
    { k: '台指期夜盤變化', val: nightChg != null ? sp(nightChg, 2) : '—', score: _rsScore(nightDrop, RS_TH.night) }
  ];

  var total = 0, avail = 0;
  rows.forEach(function (r) { if (r.score != null) { total += r.score; avail++; } });

  // 股債同向重挫旗標
  var flag = (equityDrop != null && tnx && tnx.chg != null && equityDrop >= RS_FLAG.equityDrop && tnx.chg >= RS_FLAG.yieldUp);

  // 動作對照
  var verdict, vColor;
  if (flag) { verdict = '危機訊號：直接 veto，暫停加碼'; vColor = 'var(--up)'; }
  else if (total >= 7) { verdict = '高風險：veto，暫停加碼，等分數回落'; vColor = 'var(--up)'; }
  else if (total >= 4) { verdict = '中度風險：加碼額度減半，或延後一日確認止穩'; vColor = 'var(--accent2)'; }
  else { verdict = '正常波動：照第一/二層規則正常加碼'; vColor = 'var(--down)'; }

  var tw = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
  info.textContent = '更新：' + tw + '（台北）';

  var html = '';
  // 判定卡
  html += '<div class="rs-verdict" style="border-color:' + vColor + '">' +
    '<div class="rs-score-big" style="color:' + vColor + '">' + total + '<span style="font-size:16px;color:var(--text3)"> / 12</span></div>' +
    '<div class="rs-verdict-txt"><div class="rs-vlabel">建議動作</div><div style="color:' + vColor + ';font-weight:700">' + verdict + '</div>' +
    (avail < 6 ? '<div style="font-size:11px;color:var(--text3);margin-top:2px">（' + avail + '/6 項有資料，' + (6 - avail) + ' 項暫缺）</div>' : '') +
    '</div></div>';
  // 旗標
  html += '<div class="rs-flag ' + (flag ? 'on' : '') + '">' +
    (flag ? '⚠️ 股債同向重挫旗標【觸發】：股市重挫且美債殖利率同步飆升，傳統股債對沖失效 → 直接 veto' :
      '股債同向重挫旗標：未觸發（需 費半/Nasdaq 跌幅≥' + RS_FLAG.equityDrop + '% 且 美10年債殖利率漲幅≥' + RS_FLAG.yieldUp + '%）') +
    '</div>';
  // 指標明細
  html += '<div class="rs-sec-title">指標明細</div><table class="rs-table"><thead><tr><th>指標</th><th class="num">數值</th><th class="num">得分</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    html += '<tr><td>' + r.k + '</td><td class="num">' + r.val + '</td>' +
      '<td class="num" style="color:' + _rsColor(r.score) + ';font-weight:700">' + (r.score == null ? '—' : r.score) + '</td></tr>';
  });
  html += '</tbody></table>';
  // 對照與免責
  html += '<div class="rs-note">' +
    '<b>動作對照</b>：0–3 正常加碼｜4–6 減半或延後｜7+ veto｜旗標觸發直接 veto。<br>' +
    '<b>得分色</b>：<span style="color:var(--down)">0 低</span>／<span style="color:var(--accent2)">1 中</span>／<span style="color:var(--up)">2 高</span>。<br>' +
    '資料源：Yahoo（VIX/美10年債/美元指數/費半/Nasdaq）＋ Shioaji 台指期夜盤(TXFR1)。' +
    '門檻為初始值、待 6 個月歷史回測校準。<b>本面板為依你設定規則自動算分的參考，非投資建議。</b>' +
    '</div>';
  wrap.innerHTML = html;
}

// ── 頂欄台指期即時徽章（僅「加減碼報告」頁；夜盤時即時、收盤後為最後/結算值） ──
var _txfTimer = null;
async function renderTxfBadge() {
  var el = document.getElementById('topbar-txf');
  if (!el) return;
  var n = await _rsNight();
  if (!n || n.value == null) { el.innerHTML = ''; return; }
  var cls = n.chg > 0 ? 'up' : (n.chg < 0 ? 'down' : 'flat'); // 台股慣例：漲紅跌綠
  var arrow = n.chg > 0 ? '▲' : (n.chg < 0 ? '▼' : '');
  el.innerHTML = '<span class="txf-lb">台指期</span>' +
    '<span class="txf-v ' + cls + '">' + Math.round(n.value).toLocaleString('zh-TW') +
    ' ' + arrow + Math.abs(n.chg == null ? 0 : n.chg).toFixed(2) + '%</span>';
}
function startTxfBadge() {
  renderTxfBadge();
  if (_txfTimer) clearInterval(_txfTimer);
  _txfTimer = setInterval(renderTxfBadge, 15000); // 夜盤即時；收盤後值不變、成本極低（直連 Shioaji 無 GAS 配額）
}
function stopTxfBadge() {
  if (_txfTimer) { clearInterval(_txfTimer); _txfTimer = null; }
  var el = document.getElementById('topbar-txf');
  if (el) el.innerHTML = '';
}
