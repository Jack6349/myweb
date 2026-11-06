// 股利總管 Web — 被吞掉的錯誤：集中記錄，出口是頂欄那顆燈
//
// 為什麼需要這個：
//   全站有兩百多處 catch 把錯誤整個吞掉，畫面與 console 都沒有任何痕跡。
//   2026-11-06 查到的五檔 bug 就是這樣藏了兩週：推送一到就丟 ReferenceError，
//   被空 catch 接走，畫面永遠停在「等待五檔推送…」，看起來像還沒來而不是壞了。
//
// 為什麼出口是燈不是 console：
//   這是每天在用的工具，不會開著開發者工具。訊息要出現在看得到的地方才有用。
//
// 燈號語意（安燈）：
//   不亮 — 這次開頁沒有任何東西被吞掉
//   黃   — 有東西失敗，但畫面還能用（某個數字少一塊，表格照常顯示）
//   紅   — 有東西失敗到畫面是錯的或會停住
//
// 刻意不記的：localStorage／sessionStorage 的存取失敗。隱私視窗、配額滿、
//   被封鎖時必然丟錯，而程式本來就設計成「沒有儲存也照常跑」，那是支援的狀態
//   不是錯誤。記了只會讓燈一直黃，真有事反而被淹掉。

var HUSH_MAX = 200;          // 最多保留幾種錯誤（同一種只佔一列，重複只加次數）
var _hushLog = [];           // { key, seq, ts, tag, msg, lv, n }
var _hushSeq = 0;            // 面板排序用。同一秒內好幾筆時 ts 分不出先後，要靠序號
var _hushOpen = false;

// tag → 畫面上的功能名。使用者認得的是導覽列那些字，不是檔名。
var HUSH_NAME = {
  stream: '即時行情', live: '即時持股', inventory: '持股庫存', 'cost-override': '持股庫存',
  'dividend-est': '股利估算', 'div-meta': '配息資料', 'div-mix': '配息資料',
  divnav: '配息資料', refill: '配息資料', txinfo: '交易資訊', trades: '交易資訊',
  trend: '趨勢評估', signals: '籌碼淨值', 'nav-premium': '籌碼淨值', 'nav-usage': '籌碼淨值',
  alerts: '停損停利', news: '新聞情勢', digest: '新聞情勢',
  'risk-score': '加減碼報告', 'swap-scan': '加減碼報告', swap: '加減碼報告',
  topconst: '成分股曝險', constituents: '成分股曝險', watch: '關注股票',
  params: '參數設定', settings: '參數設定', chart: '線圖', pvhist: '總現值走勢',
  'etf-screen': 'ETF 篩選', 'style-drift': '風格漂移', 'lent-log': '出借紀錄',
  'fill-toast': '委託提示', sbl: '借券', order: '下單', retire: '退休現金流'
};

// 記一筆。lv 預設 1（黃）；畫面會停住或顯示錯誤內容的傳 2（紅）。
// 呼叫端一律是已經空掉的 catch，所以這裡不能再丟錯，也不能改變控制流。
function hush(tag, e, lv) {
  try {
    lv = (lv === 2) ? 2 : 1;
    var msg;
    if (e && e.message) msg = (e.name ? e.name + ': ' : '') + e.message;
    else if (e && e.type) msg = '事件錯誤 ' + e.type;     // SSE／fetch 的 ErrorEvent 沒有 message
    else msg = String(e);
    if (msg.length > 160) msg = msg.slice(0, 160) + '…';
    var key = tag + '|' + msg, hit = null;
    for (var i = 0; i < _hushLog.length; i++) { if (_hushLog[i].key === key) { hit = _hushLog[i]; break; } }
    if (hit) { hit.n++; hit.ts = Date.now(); hit.seq = ++_hushSeq; if (lv > hit.lv) hit.lv = lv; }
    else {
      _hushLog.push({ key: key, seq: ++_hushSeq, ts: Date.now(), tag: tag, msg: msg, lv: lv, n: 1 });
      if (_hushLog.length > HUSH_MAX) _hushLog.shift();
    }
    hushPaint();
    if (_hushOpen) hushPanel();
  } catch (_) {
    // 記錄自己丟錯就真的只能吞：在這裡再呼叫 hush 會無窮遞迴。
    // 全站唯一一個該留空的 catch。
  }
}

function _hushWorst() {
  var w = 0;
  _hushLog.forEach(function (r) { if (r.lv > w) w = r.lv; });
  return _hushLog.length ? w : 0;
}
function _hushCount() {
  var n = 0;
  _hushLog.forEach(function (r) { n += r.n; });
  return n;
}
function _hushName(tag) { return HUSH_NAME[tag] || tag; }
function _hushTime(ts) { return new Date(ts + 8 * 3600000).toISOString().slice(11, 19); }

// 頂欄那顆燈。沒事就整個不顯示：常駐一顆綠燈只會變成背景，有事也看不出來。
function hushPaint() {
  var el = document.getElementById('hush-lamp');
  if (!el) return;
  var lv = _hushWorst();
  if (!lv) { el.hidden = true; el.className = 'hush-lamp'; el.innerHTML = ''; return; }
  el.hidden = false;
  el.className = 'hush-lamp lv' + lv + (_hushOpen ? ' on' : '');
  el.innerHTML = '<span class="hush-dot"></span>' + _hushCount();
  el.title = (lv === 2 ? '有功能失敗，畫面可能不正確' : '有資料沒抓到，畫面少一塊')
    + '　共 ' + _hushCount() + ' 次，點一下看清單';
}

function hushToggle() {
  _hushOpen = !_hushOpen;
  hushPaint();
  hushPanel();
}

function hushClear() {
  _hushLog = [];
  _hushSeq = 0;
  _hushOpen = false;
  hushPaint();
  hushPanel();
}

function hushPanel() {
  var p = document.getElementById('hush-panel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'hush-panel';
    p.className = 'hush-panel';
    document.body.appendChild(p);
  }
  if (!_hushOpen || !_hushLog.length) { p.hidden = true; return; }
  p.hidden = false;
  // 新的在上面：剛發生的才是你現在想知道的
  var rows = _hushLog.slice().sort(function (a, b) { return b.seq - a.seq; });
  var h = '<div class="hush-head">沒有顯示出來的失敗' +
    '<span class="hush-sub">這一頁從開啟到現在被吞掉的錯誤。重新整理後歸零。</span>' +
    '<button class="hush-x" onclick="hushClear()">清除</button></div>' +
    '<table class="hush-table"><thead><tr><th>時間</th><th>功能</th><th>狀況</th><th class="num">次數</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    h += '<tr class="hush-lv' + r.lv + '">' +
      '<td class="hush-t">' + _hushTime(r.ts) + '</td>' +
      '<td>' + _hushName(r.tag) + '</td>' +
      '<td class="hush-msg">' + String(r.msg).replace(/</g, '&lt;') + '</td>' +
      '<td class="num">' + r.n + '</td></tr>';
  });
  p.innerHTML = h + '</tbody></table>' +
    '<div class="hush-foot">黃＝資料少一塊，畫面其餘照常；紅＝該功能停住或顯示的內容不正確。</div>';
}

// 點面板以外的地方就收起來
document.addEventListener('click', function (ev) {
  if (!_hushOpen) return;
  var t = ev.target;
  if (t.closest && (t.closest('#hush-panel') || t.closest('#hush-lamp'))) return;
  _hushOpen = false;
  hushPaint();
  hushPanel();
});
