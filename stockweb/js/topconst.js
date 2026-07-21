// 股利總管 Web — 成分股曝險（持股 ETF 的台股成分股，依實際曝險加權取前 10，盤中即時）
// 曝險(B)：Σ(各 ETF 現值 × 該檔在此 ETF 的權重%)；總權重% = 曝險 ÷ 總持股現值 ×100
// 僅台股（Shioaji 即時報價）；進入時訂閱 tick、離開時退訂（排除已是自身持股者）

var _topConstRows = [];   // 前 10：{code,name,expo,pct,holders:[{etf,weight}]}
var _topSubbed = [];      // 本卡片新訂閱的代號（離開退訂）
var TOPCONST_N = 10;

// 計算前 n 大台股成分（依曝險 B）；供「成分股曝險」卡片與「即時行情」共用
// 曝險 = Σ(各 ETF 現值 × 該檔權重%)；pct = 曝險 ÷ 總持股現值 ×100
function computeTopConst(n) {
  var totalVal = 0;
  (_positions || []).forEach(function (p) {
    var r = _rows[String(p.code)];
    var px = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    if (px != null) totalVal += px * p.quantity;
  });
  var agg = {};
  (_positions || []).forEach(function (p) {
    var etf = String(p.code);
    var m = (typeof _constMap !== 'undefined') && _constMap[etf];
    if (!m || !m.rows) return;
    var r = _rows[etf];
    var px = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    var etfVal = px != null ? px * p.quantity : 0;
    if (!etfVal) return;
    m.rows.forEach(function (row) {
      if (row.kind !== 'TW') return;
      var tw = row.twCode;
      var a = agg[tw] || (agg[tw] = { code: tw, name: row.name || '', expo: 0, holders: {} });
      a.expo += etfVal * row.weight / 100;
      a.holders[etf] = row.weight;
      if (!a.name && row.name) a.name = row.name;
    });
  });
  var rows = Object.keys(agg).map(function (k) {
    var a = agg[k];
    return {
      code: a.code, name: a.name, expo: a.expo, pct: totalVal ? a.expo / totalVal * 100 : 0,
      holders: Object.keys(a.holders).map(function (e) { return { etf: e, weight: a.holders[e] }; })
        .sort(function (x, y) { return y.weight - x.weight; })
    };
  });
  rows.sort(function (a, b) { return b.expo - a.expo; });
  return rows.slice(0, n || TOPCONST_N);
}

async function startTopConst() {
  var wrap = document.getElementById('topconst-wrap');
  var info = document.getElementById('topconst-info');
  wrap.innerHTML = '<div class="modal-loading">計算成分股曝險中…</div>';
  if (!(await checkServer())) { wrap.innerHTML = '<div class="stream-error" style="display:block">' + serverDownHtml() + '</div>'; return; }
  try {
    await ensureFeed(function (m) { info.textContent = m; });                 // 載入持股/合約/現價
    if (typeof initConstituents === 'function') await initConstituents();     // 載入成分股清單 _constMap
  } catch (e) { wrap.innerHTML = '<div class="modal-loading">載入失敗：' + e.message + '</div>'; return; }

  var rows = computeTopConst(TOPCONST_N);
  _topConstRows = rows;

  if (!rows.length) { wrap.innerHTML = '<div class="modal-loading">無台股成分股資料（請先於「持股庫存」載入成分股，或持股 ETF 無台股成分）</div>'; return; }

  // 補合約（含昨收）＋初始快照
  info.textContent = '取得報價…';
  for (var i = 0; i < rows.length; i++) {
    var code = rows[i].code;
    if (!_contracts[code]) { try { _contracts[code] = await fetchContract(code); } catch (e) {} }
    if (!_rows[code]) _rows[code] = { close: null, total_volume: null, time: '' };
  }
  try {
    var cons = rows.map(function (r) { return _contracts[r.code]; }).filter(Boolean);
    var snaps = await fetchSnapshots(cons);
    snaps.forEach(function (s) { _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) }; });
  } catch (e) {}

  // 訂閱 tick（僅非自身持股者；自身持股已由 ensureFeed 訂閱過）
  var own = {}; (_positions || []).forEach(function (p) { own[String(p.code)] = true; });
  _topSubbed = [];
  for (var j = 0; j < rows.length; j++) {
    var c = _contracts[rows[j].code];
    if (c && !own[rows[j].code]) { try { await subscribeTick(c); _topSubbed.push(rows[j].code); } catch (e) {} }
  }
  info.textContent = '已連線｜前 ' + rows.length + ' 大台股成分（依曝險）';
  renderTopConstTable();
}

function renderTopConstTable() {
  var wrap = document.getElementById('topconst-wrap');
  if (!wrap) return;
  var html = '<div class="inv-table-wrap"><table class="inv-table tc-table"><thead><tr>' +
    '<th>代號</th><th>名稱</th><th class="num">總權重</th><th class="num">現價</th>' +
    '<th class="num">漲跌</th><th class="num">漲跌幅</th><th>持有明細（ETF 權重）</th></tr></thead><tbody>';
  _topConstRows.forEach(function (r) { html += '<tr id="tc-tr-' + r.code + '">' + topConstRowHtml(r) + '</tr>'; });
  html += '</tbody></table></div>' +
    '<div class="detail-note">總權重＝各 ETF 現值×該檔權重 加總 ÷ 總持股現值（你透過 ETF 對該台股的實際曝險佔比，滑鼠可看曝險金額）。僅列台股成分股，現價/漲跌盤中即時；總權重於進入時計算。</div>';
  wrap.innerHTML = html;
}

function topConstRowHtml(r) {
  var c = _contracts[r.code], row = _rows[r.code];
  var price = (row && row.close != null) ? row.close : null;
  var ref = c && c.reference;
  var chgAmt = (price != null && ref) ? price - ref : null;
  var chgPct = (price != null && ref) ? (price - ref) / ref * 100 : null;
  var ccls = chgPct == null ? 'flat' : colorClass(chgPct);
  var holders = r.holders.map(function (h) {
    return '<span class="tc-holder"><span class="code-link tc-c" onclick="openChartPop(\'' + h.etf + '\')">' + h.etf + '</span>' +
      '<span class="tc-w">' + h.weight.toFixed(2) + '%</span></span>';
  }).join('<span class="tc-sep">｜</span>');
  return '<td class="inv-code"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + r.code + '\')">' + r.code + '</span></td>' +
    '<td class="inv-name">' + ((c && c.name) || r.name || '') + '</td>' +
    '<td class="num" title="曝險 $' + Math.round(r.expo).toLocaleString('zh-TW') + '"><b>' + r.pct.toFixed(2) + '%</b></td>' +
    '<td class="num ' + ccls + '">' + (price != null ? price.toFixed(2) : '—') + '</td>' +
    '<td class="num ' + ccls + '">' + (chgAmt == null ? '—' : fmtChg(chgAmt)) + '</td>' +
    '<td class="num ' + ccls + '">' + (chgPct == null ? '—' : fmtPct(chgPct)) + '</td>' +
    '<td class="tc-holders">' + holders + '</td>';
}

// SSE tick 觸發：單列即時更新
function renderTopConstRow(code) {
  var tr = document.getElementById('tc-tr-' + String(code));
  if (!tr) return;
  var r = _topConstRows.filter(function (x) { return x.code === String(code); })[0];
  if (r) tr.innerHTML = topConstRowHtml(r);
}

// 離開卡片：退訂本卡片新訂閱的代號（歸還 200 檔訂閱額度）
function stopTopConst() {
  (_topSubbed || []).forEach(function (code) {
    var c = _contracts[code]; if (!c) return;
    fetch(API + '/api/v1/stream/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', exchange: c.exchange, code: code, quote_type: 'Tick' })
    }).catch(function () {});
  });
  _topSubbed = [];
}
