// 新上市 ETF（關注股票頁的子頁籤）
// 清單與明細由本機排程 etf-new.py 產生 data/etf-new.json：
//   清單＝證交所 ISIN 公開資訊（含已核准、還沒掛牌者）
//   明細＝MoneyDJ 的「投資策略」整段與基本資料欄位
// 現價走本機 Shioaji 的 snapshots（一次取完，不訂閱、不佔訂閱額度）。
var EN_URL = 'data/etf-new.json';
var _enData = null;         // {at, windowDays, listed:[], pending:[], pendingNote}
var _enPx = {};             // code → {close, chgPct}
var _enOpen = {};           // code → true（展開中）
var _enBusy = false;

async function enLoad(force) {
  if (_enData && !force) return _enData;
  var r = await fetch(EN_URL + '?t=' + Date.now());
  if (!r.ok) throw new Error('etf-new.json HTTP ' + r.status);
  _enData = await r.json();
  return _enData;
}

// 現價：一次把全部新 ETF 丟給 snapshots。
// 還沒掛牌的沒有報價，snapshots 會跳過或回 null，顯示「未上市」而不是 0。
async function enPrices() {
  if (!_enData || !_enData.listed.length) return;
  var cons = _enData.listed.filter(function (x) { return !x.upcoming; })
    .map(function (x) {
      return { security_type: 'STK', exchange: x.market === '上櫃' ? 'OTC' : 'TSE', code: x.code };
    });
  if (!cons.length) return;
  try {
    var r = await fetch('/api/v1/data/snapshots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contracts: cons })
    });
    if (!r.ok) return;
    (await r.json()).forEach(function (s) {
      if (s && s.code) _enPx[String(s.code)] = { close: s.close, chgPct: s.change_rate };
    });
  } catch (e) { console.warn('[新上市 ETF 報價]', e); }
}

async function startEtfNew(force) {
  var wrap = document.getElementById('wt-new-wrap');
  if (!wrap || _enBusy) return;
  _enBusy = true;
  try {
    if (!_enData || force) wrap.innerHTML = '<div class="modal-loading">載入新上市 ETF…</div>';
    await enLoad(force);
    renderEtfNew();
    await enPrices();
    renderEtfNew();
  } catch (e) {
    wrap.innerHTML = '<div class="modal-loading">載入失敗：' + e.message +
      '（本機排程 etf-new.py 還沒跑過時會是這個狀態）</div>';
  } finally { _enBusy = false; }
}

function enToggle(code) {
  _enOpen[code] = !_enOpen[code];
  renderEtfNew();
}

async function enWatch(code, el) {
  if (el.checked) await wtAdd(code); else wtRemove(code);
  renderEtfNew();
}

function _enPxCell(r) {
  if (r.upcoming) return '<span class="swap-dim">未上市</span>';
  var p = _enPx[r.code];
  if (!p || p.close == null) return '—';
  var c = p.chgPct == null ? 'flat' : colorClass(p.chgPct);
  return p.close.toFixed(2) +
    (p.chgPct == null ? '' : ' <span class="' + c + '" style="font-size:11px">' +
      (p.chgPct > 0 ? '+' : '') + p.chgPct.toFixed(2) + '%</span>');
}

// 展開內容：投資特色＝MoneyDJ 的投資策略整段；其餘欄位照原樣列出。
// 基準指數欄不列：MoneyDJ 該欄實測有誤植（009828 顯示的是 00412A 的指數）。
var EN_SHOW = ['發行公司', '成立日期', '上市日期', '投資標的', '投資區域',
               '經理費', '配息頻率', '追蹤指數', '保管銀行', '經理人', 'ETF規模', 'ETF淨值'];

function _enDetailHtml(r) {
  var d = r.detail || {};
  var h = '<tr class="en-detail"><td colspan="6"><div class="en-box">';
  h += '<div class="en-sec">投資特色</div>';
  h += d['投資策略']
    ? '<div class="en-text">' + d['投資策略'] + '</div>'
    : '<div class="en-text swap-dim">MoneyDJ 沒有這一檔的投資策略說明。</div>';
  h += '<div class="en-sec">收益分配</div>';
  h += '<div class="en-text">配息頻率 <b>' + (d['配息頻率'] && d['配息頻率'] !== 'N/A' ? d['配息頻率'] : '尚未公告') + '</b>' +
    '<span class="swap-dim">　完整的收益分配條款（評價日、分配基準、收益平準金）目前沒有可靠來源，' +
    '要看請查該檔公開說明書。</span></div>';
  var kv = EN_SHOW.filter(function (k) { return d[k]; });
  if (kv.length) {
    h += '<div class="en-sec">基本資料</div><div class="en-kv">';
    kv.forEach(function (k) {
      h += '<div class="en-pair"><span class="en-k">' + k + '</span><span class="en-v">' + d[k] + '</span></div>';
    });
    h += '</div>';
  }
  h += '</div></td></tr>';
  return h;
}

function renderEtfNew() {
  var wrap = document.getElementById('wt-new-wrap');
  if (!wrap || !_enData) return;
  var list = (typeof _wtLoad === 'function') ? _wtLoad() : [];
  var d = _enData;
  var h = '<div class="tr-toolbar">' +
    '<button class="btn-query" onclick="startEtfNew(true)">↻ 重新整理</button>' +
    '<span style="font-size:13px;color:var(--text2)">近 ' + d.windowDays + ' 天新掛牌 ' +
    d.listed.length + ' 檔｜資料 ' + (d.at || '').slice(0, 16).replace('T', ' ') +
    '｜清單 ' + (d.src && d.src.list) + '、明細 ' + (d.src && d.src.detail) + '</span></div>';

  h += '<div class="divest-sec-title">已上市上櫃</div>';
  h += '<div class="inv-table-wrap"><table class="inv-table en-table"><thead><tr>' +
    '<th class="num">關注</th><th>代號</th><th>名稱</th><th class="num">現價</th>' +
    '<th>類型</th><th>上市日</th></tr></thead><tbody>';
  d.listed.forEach(function (r) {
    var on = list.indexOf(r.code) >= 0;
    h += '<tr class="en-row" onclick="enToggle(\'' + r.code + '\')">' +
      '<td class="num" onclick="event.stopPropagation()">' +
        '<input type="checkbox" class="en-chk"' + (on ? ' checked' : '') +
        ' onchange="enWatch(\'' + r.code + '\',this)" title="加入／移除關注股票"></td>' +
      '<td class="inv-code"><span class="code-link">' + r.code + '</span></td>' +
      '<td class="inv-name">' + r.name +
        '<span class="en-caret">' + (_enOpen[r.code] ? '▼' : '▶') + '</span></td>' +
      '<td class="num">' + _enPxCell(r) + '</td>' +
      '<td>' + (r.type || '—') + '<span class="swap-dim"> ' + r.market + '</span></td>' +
      '<td>' + r.listDate + (r.upcoming ? ' <span class="dexm-lent">(待掛牌)</span>' : '') + '</td></tr>';
    if (_enOpen[r.code]) h += _enDetailHtml(r);
  });
  h += '</tbody></table></div>';

  h += '<div class="divest-sec-title">募集中</div>';
  h += '<div class="rf-cal-empty">' + (d.pending && d.pending.length ? '' :
    (d.pendingNote || '募集中清單尚無可靠來源') +
    '，這一區先留空。找到來源後會補上，欄位與上表相同。') + '</div>';

  h += '<div class="rf-cal-note"><dl>' +
    '<dt>清單</dt><dd>證交所 ISIN 公開資訊的 ETF 分類，上市日在近 ' + d.windowDays +
      ' 天內。已核准、還沒掛牌的也會列出，標「待掛牌」。</dd>' +
    '<dt>投資特色</dt><dd>MoneyDJ 的「投資策略」整段原文，未經改寫。</dd>' +
    '<dt>收益分配</dt><dd>只有配息頻率一項。完整條款在公開說明書，目前沒有可以程式取得的聚合來源。</dd>' +
    '<dt>關注</dt><dd>勾選即加入「關注股票」清單（上限 ' + (typeof WT_MAX !== 'undefined' ? WT_MAX : 30) +
      ' 檔），與該頁是同一份清單。</dd>' +
    '</dl></div>';
  wrap.innerHTML = h;
}
