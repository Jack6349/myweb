// 股利總管 Web — 每日自動刷新（營業日 08:30）＋ 手動刷新按鈕
//
// 為什麼需要：頁面開著過夜時，各模組的每日快取（配息紀錄、除權息歷史、日 K、成份股清單…）
// 都以「台北日期」為 key，跨日後才會失效；但畫面上的表格不會自己重算，會一直顯示昨天的結果。
// 直接整頁重載最單純：所有每日快取都會以新日期重新判定，也不必逐一重跑各頁的載入流程。
//
// 觸發時機：台北時間週一～週五 08:30（開盤前一小時），且頁面是在該時點之前載入的。
// 每分鐘檢查一次，不用 setTimeout 排程，睡眠喚醒或休眠後補跑也不會漏掉。
// 國定假日不另外判斷（沒有交易日曆資料）；假日重載一次只是重抓當日快取，沒有副作用。

// ── 觸發點（台北時間）──
//
// 08:30 週一到週五：開盤前一小時，把昨天的每日快取清掉。
//
// 05:30 週二到週六：台指期夜盤 05:00 收盤，美股也收了，這時候重抓才拿得到
//   「驅動今天這一盤」的那兩個收盤，夜推那兩頁才不會整個早上都在用昨天的輸入。
//   星期幾要從台北的角度數：美股週一收盤是台北週二 05:00、週五收盤是台北週六 05:00，
//   所以台北的週日與週一凌晨沒有剛收完的美股盤，不跑。
//   夏令時間美股 04:00 就收了，比 05:30 更早，不影響。
//
// 國定假日不另外判斷（沒有交易日曆資料）；假日多重載一次只是重抓當日快取，沒有副作用。
var DR_POINTS = [
  { h: 8, m: 30, days: [1, 2, 3, 4, 5], why: '開盤前一小時' },
  { h: 5, m: 30, days: [2, 3, 4, 5, 6], why: '夜盤與美股都收盤了' }
];
var _drStart = Date.now();

function _drTaipei(ms) { return new Date((ms == null ? Date.now() : ms) + 8 * 3600000); }
// 現在已經過、而且本頁開著的時候還沒到的那個觸發點。有好幾個就取最晚的那個。
function _drDue(ms) {
  var now = (ms == null) ? Date.now() : ms;
  var d = _drTaipei(now), wd = d.getUTCDay(), best = null;
  for (var i = 0; i < DR_POINTS.length; i++) {
    var P = DR_POINTS[i];
    if (P.days.indexOf(wd) < 0) continue;
    var t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), P.h, P.m) - 8 * 3600000;
    if (now >= t && _drStart < t && (!best || t > best.t)) best = { t: t, p: P };
  }
  return best;
}
function _drTick() {
  var due = _drDue();
  if (!due) return;
  console.log('[每日刷新] ' + (due.p.h < 10 ? '0' : '') + due.p.h + ':' + due.p.m
    + '（' + due.p.why + '），重新載入頁面');
  location.reload();
}

function refreshApp() { location.reload(); }

(function () {
  function init() {
    var box = document.querySelector('.topbar-right');
    if (box) {
      var btn = document.createElement('button');
      btn.className = 'btn-back btn-refresh';
      btn.textContent = '↻ 刷新';
      btn.title = '重新載入整頁。自動執行的時間是營業日 08:30（開盤前）與週二到週六 05:30'
        + '（夜盤與美股都收盤了，夜推那兩頁的輸入要換成最新的收盤）';
      btn.onclick = refreshApp;
      box.insertBefore(btn, document.getElementById('btn-back'));
    }
    setInterval(_drTick, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
