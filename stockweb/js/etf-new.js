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
  return (p && p.close != null) ? p.close.toFixed(2) : '—';
}
function _enChgCell(r) {
  if (r.upcoming) return '<span class="swap-dim">—</span>';
  var p = _enPx[r.code];
  if (!p || p.chgPct == null) return '—';
  var c = colorClass(p.chgPct);
  return '<span class="' + c + '">' + (p.chgPct > 0 ? '▲' : (p.chgPct < 0 ? '▼' : '')) +
    Math.abs(p.chgPct).toFixed(2) + '%</span>';
}

// ── 排序 ──
// 未上市的沒有價格也沒有漲跌，不管升冪降冪一律排最後，否則它們會佔住榜首或榜尾。
var _enSort = 'listDesc';
function enSortCol(key) {
  _enSort = (_enSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  renderEtfNew();
}
function _enSortVal(r, key) {
  if (key === 'code') return r.code;
  if (key === 'type') return (r.type || '') + r.market;
  if (key === 'list') return r.listDate;
  var p = _enPx[r.code] || {};
  if (key === 'px') return p.close;
  if (key === 'chg') return p.chgPct;
  return null;
}
function _enSorted(list) {
  var m = /^(\w+?)(Desc|Asc)$/.exec(_enSort);
  if (!m) return list;
  var key = m[1], asc = m[2] === 'Asc';
  var txt = (key === 'code' || key === 'type' || key === 'list');
  return list.slice().sort(function (a, b) {
    var x = _enSortVal(a, key), y = _enSortVal(b, key);
    var nx = (x == null || x === ''), ny = (y == null || y === '');
    if (nx !== ny) return nx ? 1 : -1;      // 沒值的恆在後
    if (nx) return 0;
    var d = txt ? String(x).localeCompare(String(y), undefined, { numeric: true }) : x - y;
    return asc ? d : -d;
  });
}
function _enTh(key, label, cls) {
  var on = _enSort === key + 'Asc' || _enSort === key + 'Desc';
  var ind = on ? (_enSort === key + 'Asc' ? '▲' : '▼') : '↕';
  return '<th class="sort-th' + (cls ? ' ' + cls : '') + (on ? ' on' : '') +
    '" onclick="enSortCol(\'' + key + '\')" title="點擊排序">' + label +
    '<span class="sort-ind">' + ind + '</span></th>';
}

// 展開內容：投資特色＝MoneyDJ 的投資策略整段；其餘欄位照原樣列出。
// 基準指數欄不列：MoneyDJ 該欄實測有誤植（009828 顯示的是 00412A 的指數）。
var EN_SHOW = ['發行公司', '成立日期', '上市日期', '投資標的', '投資區域',
               '經理費', '配息頻率', '追蹤指數', '保管銀行', '經理人', 'ETF規模', 'ETF淨值'];

function _enDetailHtml(r) {
  var d = r.detail || {};
  var h = '<tr class="en-detail"><td colspan="7"><div class="en-box">';
  h += '<div class="en-sec">投資特色</div>';
  h += d['投資策略']
    ? '<div class="en-text">' + d['投資策略'] + '</div>'
    : '<div class="en-text swap-dim">MoneyDJ 沒有這一檔的投資策略說明。</div>';
  h += '<div class="en-sec">收益分配</div>';
  var dv = r.div;
  h += '<div class="en-kv en-kv-div">';
  var kvp = function (k, v, title) {
    return '<div class="en-pair"><span class="en-k">' + k + '</span>' +
      '<span class="en-v"' + (title ? ' title="' + title.replace(/"/g, '&quot;') + '"' : '') +
      '>' + v + '</span></div>';
  };
  h += kvp('配息頻率', d['配息頻率'] && d['配息頻率'] !== 'N/A' ? d['配息頻率'] : '<span class="swap-dim">尚未公告</span>');
  if (dv) {
    // 金額與日期走較早的來源（Yahoo），官方公告常落後一到兩週，金額欄還會是空的
    h += kvp('配息金額', (dv.amount ? dv.amount + (dv.period ? ' <span class="swap-dim">' + dv.period + '</span>' : '')
                                    : '<span class="swap-dim">待公告</span>'),
             '每 1 受益權單位。來源：' + (dv.dateSrc || '—'));
    h += kvp('除息交易日', (dv.exDate || '—') +
      (dv.exDiff ? ' <span class="swap-warn" title="與證交所公告的除息日不同，以較早公告者為準並持續核對">≠</span>' : ''),
      '來源：' + (dv.dateSrc || '—'));
    h += kvp('收益分配發放日', dv.payDate || '—', '來源：' + (dv.dateSrc || '—'));
    if (dv.equalization == null) {
      h += kvp('收益平準金', '<span class="swap-dim">' + (r.termsNote || '條款尚未公告') + '</span>');
      h += kvp('評價日', '<span class="swap-dim">' + (r.termsNote || '條款尚未公告') + '</span>');
    } else {
      // 收益平準金：看收益分配標準條款裡有沒有把它列入可分配收益，是條款寫的，不是推論
      h += kvp('收益平準金', dv.equalization
        ? '列入可分配收益'
        : '<span class="swap-dim">條款未提及</span>', '取自證交所公告的「收益分配標準」全文');
      // 評價日：條款明寫「收益分配評價日（…）」才顯示那一句；沒寫就只給基準日，不改名硬湊
      h += dv.valuationDay
        ? kvp('評價日', dv.valuationDay, '取自收益分配標準條款')
        : kvp('收益分配基準日', dv.baseDate || '—', '條款未載明收益分配評價日，這裡給的是證交所公告的收益分配基準日');
    }
  } else {
    h += kvp('配息金額', '<span class="swap-dim">' + (r.divNote || '無資料') + '</span>');
    h += kvp('收益平準金', '<span class="swap-dim">' + (r.divNote || '無資料') + '</span>');
    h += kvp('評價日', '<span class="swap-dim">' + (r.divNote || '無資料') + '</span>');
  }
  h += '</div>';
  if (dv && dv.std) {
    h += '<details class="en-std"><summary>收益分配標準全文</summary><div class="en-text">' +
      dv.std.replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</div></details>';
  }
  var kv = EN_SHOW.filter(function (k) { return d[k]; });
  if (kv.length) {
    h += '<div class="en-sec">基本資料</div><div class="en-kv">';
    kv.forEach(function (k) {
      // 值過長時以省略號收尾，title 保留全文（例「ETF規模 13951.77百萬台幣 (2026/10/13)」）
      h += '<div class="en-pair"><span class="en-k">' + k + '</span>' +
           '<span class="en-v" title="' + d[k].replace(/"/g, '&quot;') + '">' + d[k] + '</span></div>';
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
  h += '<div class="inv-table-wrap en-wrap"><table class="inv-table en-table"><thead><tr>' +
    '<th class="num">關注</th>' + _enTh('code', '代號') + '<th>名稱</th>' +
    _enTh('px', '現價', 'num') + _enTh('chg', '今日漲跌', 'num') +
    _enTh('type', '類型') + _enTh('list', '上市日') + '</tr></thead><tbody>';
  _enSorted(d.listed).forEach(function (r) {
    var on = list.indexOf(r.code) >= 0;
    h += '<tr class="en-row" onclick="enToggle(\'' + r.code + '\')">' +
      '<td class="num" onclick="event.stopPropagation()">' +
        '<input type="checkbox" class="en-chk"' + (on ? ' checked' : '') +
        ' onchange="enWatch(\'' + r.code + '\',this)" title="加入／移除關注股票"></td>' +
      '<td class="inv-code"><span class="code-link" title="看線圖"' +
        ' onclick="event.stopPropagation();openChartPop(\'' + r.code + '\')">' + r.code + '</span></td>' +
      '<td class="inv-name">' + r.name +
        '<span class="en-caret">' + (_enOpen[r.code] ? '▼' : '▶') + '</span></td>' +
      '<td class="num">' + _enPxCell(r) + '</td>' +
      '<td class="num">' + _enChgCell(r) + '</td>' +
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
    '<dt>收益分配</dt><dd>日期與金額取 Yahoo 台股配息頁，不以官方公告為主來源：公告會落後一到兩週，' +
      '今天的實例是 00408A 與 00991B 的除息日兩邊一致，但證交所的金額欄仍是空的，Yahoo 已有 0.21 與 0.067。' +
      '收益平準金與評價日仍取證交所公告的「收益分配標準」全文，那是公開說明書層級的條款，不隨公告時效變動。' +
      '條款沒載明評價日時改列收益分配基準日，不改名硬湊。兩邊除息日不同會標「≠」。</dd>' +
    '<dt>關注</dt><dd>勾選即加入「關注股票」清單（上限 ' + (typeof WT_MAX !== 'undefined' ? WT_MAX : 30) +
      ' 檔），與該頁是同一份清單。</dd>' +
    '</dl></div>';
  wrap.innerHTML = h;
}
