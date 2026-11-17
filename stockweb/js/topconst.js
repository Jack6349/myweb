// 股利總管 Web — 成分股曝險（持股 ETF 的台股成分股，依實際曝險加權取前 20，盤中即時）
// 曝險(B)：Σ(各 ETF 現值 × 該檔在此 ETF 的權重%)；總權重% = 曝險 ÷ 總持股現值 ×100
// 僅台股（Shioaji 即時報價）；進入時訂閱 tick、離開時退訂（排除已是自身持股者）

var _topConstRows = [];   // 前 20：{code,name,expo,pct,holders:[{etf,weight}]}
var _topSubbed = [];      // 本卡片新訂閱的代號（離開退訂）
// 前 N 大。從 15 改 20：多出來的五檔會多五個 tick 訂閱
// （非自身持股的成分股進頁時才訂閱、離開退訂）。
// 即時行情那邊用自己的 STREAM_OTHER_N，不受這裡影響。
var TOPCONST_N = 20;

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
    if (!_contracts[code]) { try { _contracts[code] = await fetchContract(code); } catch (e) { hush('topconst', e); } }
    if (!_rows[code]) _rows[code] = { close: null, total_volume: null, time: '' };
  }
  try {
    var cons = rows.map(function (r) { return _contracts[r.code]; }).filter(Boolean);
    var snaps = await fetchSnapshots(cons);
    snaps.forEach(function (s) { _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) }; });
  } catch (e) { hush('topconst', e); }

  // 訂閱 tick（僅非自身持股者；自身持股已由 ensureFeed 訂閱過）
  var own = {}; (_positions || []).forEach(function (p) { own[String(p.code)] = true; });
  _topSubbed = [];
  for (var j = 0; j < rows.length; j++) {
    var c = _contracts[rows[j].code];
    if (c && !own[rows[j].code]) { try { await subscribeTick(c); _topSubbed.push(rows[j].code); } catch (e) { hush('topconst', e); } }
  }
  info.textContent = '已連線｜前 ' + rows.length + ' 大台股成分（依曝險）';
  renderTopConstTable();
}

function renderTopConstTable() {
  var wrap = document.getElementById('topconst-wrap');
  if (!wrap) return;
  var html = '<div class="inv-table-wrap tc-wrap"><table class="inv-table tc-table"><thead><tr>' +
    '<th>代號</th><th class="inv-st-cell" title="連續漲跌的天數：▲N 連漲 N 天、▼N 連跌 N 天、⤴ 今天轉漲、⤵ 今天轉跌。&#10;原本接在現價右邊，把那一欄的右對齊打掉了，所以搶出來自己一欄。">趨勢</th><th>名稱</th><th class="num">總權重</th><th class="num">現價</th>' +
    '<th class="num" title="超過門檻的數字底下會多一條線，漲紅跌綠。門檻在參數設定的「顯示標記」">漲跌</th>' + '<th class="num" title="超過門檻的數字底下會多一條線，漲紅跌綠。門檻在參數設定的「顯示標記」">漲跌幅</th><th>持有明細（ETF 權重）</th></tr></thead><tbody>';
  _topConstRows.forEach(function (r) { html += '<tr id="tc-tr-' + r.code + '">' + topConstRowHtml(r) + '</tr>'; });
  html += '</tbody></table></div>' +
    '<div class="detail-note"><dl>' +
    '<dt>總權重</dt><dd><code>Σ(各 ETF 現值 × 該檔權重) ÷ 總持股現值</code>' +
    '＝你透過 ETF 對該台股的實際曝險佔比，滑鼠可看曝險金額。</dd>' +
    '<dt>更新</dt><dd>現價與漲跌盤中即時；總權重於進入時計算。僅列台股成分股。</dd>' +
    '</dl></div>';
  wrap.innerHTML = html;
  if (typeof rbStreakFill === 'function') rbStreakFill(wrap);
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
  var lim = (typeof limitState === 'function') ? limitState(r.code, price) : '';
  return '<td class="inv-code' + (lim ? ' lim-' + lim : '') + '"><span class="code-link" title="看線圖" onclick="openChartPop(\'' + r.code + '\')">' + r.code + '</span></td>' +
    // 趨勢徽章自己一欄，與持股庫存、即時持股同一個做法。
    '<td class="inv-st-cell">'
      + (price != null && typeof rbStreakSlot === 'function' ? rbStreakSlot(r.code) : '') + '</td>' +
    '<td class="inv-name">' + ((c && c.name) || r.name || '') + '</td>' +
    '<td class="num" title="曝險 $' + Math.round(r.expo).toLocaleString('zh-TW') + '"><b>' + r.pct.toFixed(2) + '%</b></td>' +
    '<td class="num ' + ccls + '">' + (price != null ? '<span class="rb-bpx">' + price.toFixed(2) + '</span>' : '—')
      + '</td>' +
    '<td class="num ' + ccls + chgMark(chgPct) + '">' + (chgAmt == null ? '—' : fmtChg(chgAmt)) + '</td>' +
    '<td class="num ' + ccls + chgMark(chgPct) + '">' + (chgPct == null ? '—' : fmtPct(chgPct)) + '</td>' +
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
    }).catch(function (e) { hush('topconst', e); });
  });
  _topSubbed = [];
}

// ══════════ 類股組成（資產統計的集中度頁用）══════════
//
// 交易所產業別代碼 → 名稱。券商合約的 category 欄位就是這組代碼，
// 上市與上櫃共用同一套編碼（櫃買的公司基本資料 SecuritiesIndustryCode 與它一致）。
//
// 來源與抓法（2026-11-16）：
//   01–31、35–38 共 34 碼，逐碼打證交所每日收盤行情取回傳標題
//   https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=NN&response=json
//   標題長這樣：「115年11月13日 每日收盤行情(半導體業)」
//   32、33、34 沒有上市公司，證交所那支查不到。32 由櫃買的公司基本資料佐證：
//   該碼 26 家含誠品生活、桂田文創、智崴、鈊象、智冠，是文化創意業無疑。
//   33、34 目前的持股裡沒有，沒有去查，查不到的碼一律原樣顯示代碼。
//
// 不做自動更新：2022 年一次加了綠能環保、數位雲端、運動休閒、居家生活四類，
// 這種事幾年一次，而且查不到就顯示代碼，退化方式是安全的。
var TWSE_IND = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維',
  '05': '電機機械', '06': '電器電纜', '07': '化學生技醫療', '08': '玻璃陶瓷',
  '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業',
  '13': '電子工業', '14': '建材營造', '15': '航運業', '16': '觀光餐旅',
  '17': '金融保險', '18': '貿易百貨', '19': '綜合', '20': '其他',
  '21': '化學工業', '22': '生技醫療業', '23': '油電燃氣業', '24': '半導體業',
  '25': '電腦及週邊設備業', '26': '光電業', '27': '通信網路業', '28': '電子零組件業',
  '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業', '32': '文化創意業',
  '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活'
};
function tcIndName(c) { return TWSE_IND[c] || ('類別 ' + (c || '—')); }

var TC_SEC_MIN = 1;          // 低於這個百分比併成「其他類股」。26 類裡有 18 類不到 1%，不併就讀不了

// 類股組成。回傳 { slices, twPct, rest, n, noCat }
//   slices  已排序的切片（大→小），末兩片是「其他類股」與「海外成分股、債券與現金」
//   twPct   台股曝險合計（ETF 透視 ＋ 直接持有）
//
// 與下面那條累計曲線的涵蓋範圍差一檔：computeTopConst 只走 ETF 的成分股清單，
// 直接持有的個股沒有成分表會被整個跳過，它進了分母卻沒進任何一塊。
// 那樣的話直接持有的台股會落進「海外成分股、債券與現金」，名稱就是錯的，所以這裡補進來。
async function tcSectorMix() {
  var rows = computeTopConst(999) || [];
  // 分母要與 computeTopConst 同一個：各檔現價 × 股數
  var totalVal = 0;
  (_positions || []).forEach(function (p) {
    var r = _rows[String(p.code)];
    var px = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    if (px != null) totalVal += px * p.quantity;
  });
  // 直接持有的台股（四碼純數字＝個股，與 getCategory 同一個判準）；
  // 同一檔若又是某 ETF 的成分，曝險相加，不重複列。
  var byCode = {};
  rows.forEach(function (r) { byCode[r.code] = { code: r.code, name: r.name, pct: r.pct }; });
  (_positions || []).forEach(function (p) {
    var c = String(p.code);
    if (!/^\d{4}$/.test(c)) return;
    var r = _rows[c];
    var px = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    if (px == null || !totalVal) return;
    var pct = px * p.quantity / totalVal * 100;
    if (byCode[c]) byCode[c].pct += pct;
    else byCode[c] = { code: c, name: ((_contracts[c] || {}).name) || '', pct: pct, direct: true };
  });
  var list = Object.keys(byCode).map(function (k) { return byCode[k]; });

  // 補合約（只補沒有的），拿 category。本機伺服器，176 檔平行實測 288ms。
  var need = list.filter(function (r) { return !(_contracts[r.code] && _contracts[r.code].category); });
  if (need.length) {
    await Promise.all(need.map(function (r) {
      return fetchContract(r.code).then(function (c) { if (c && c.code) _contracts[c.code] = c; })
        .catch(function (e) { hush('topconst', e); });
    }));
  }

  var agg = {}, twPct = 0, noCat = [];
  list.forEach(function (r) {
    var c = (_contracts[r.code] || {}).category || '';
    if (!c) noCat.push(r.code);
    var a = agg[c] || (agg[c] = { cat: c, name: tcIndName(c), pct: 0, n: 0, codes: [] });
    a.pct += r.pct; a.n++; a.codes.push(r.code);
    twPct += r.pct;
  });
  var all = Object.keys(agg).map(function (k) { return agg[k]; })
    .sort(function (a, b) { return b.pct - a.pct; });
  var big = all.filter(function (a) { return a.pct >= TC_SEC_MIN; });
  var small = all.filter(function (a) { return a.pct < TC_SEC_MIN; });
  var slices = big.slice();
  if (small.length) {
    slices.push({
      cat: '', name: '其他類股', tail: true,
      pct: small.reduce(function (s, a) { return s + a.pct; }, 0),
      n: small.reduce(function (s, a) { return s + a.n; }, 0),
      codes: [], note: small.map(function (a) { return a.name + ' ' + a.pct.toFixed(2) + '%'; }).join('、')
    });
  }
  var rest = Math.max(0, 100 - twPct);
  if (rest > 0.01) {
    slices.push({ cat: '', name: '海外成分股、債券與現金', tail: true, rest: true, pct: rest, n: 0, codes: [] });
  }
  return { slices: slices, twPct: twPct, rest: rest, n: list.length, noCat: noCat, sectors: all.length };
}
