// 股利總管 Web — 每日自動刷新（營業日 08:30）＋ 手動刷新按鈕
//
// 為什麼需要：頁面開著過夜時，各模組的每日快取（配息紀錄、除權息歷史、日 K、成份股清單…）
// 都以「台北日期」為 key，跨日後才會失效；但畫面上的表格不會自己重算，會一直顯示昨天的結果。
// 直接整頁重載最單純：所有每日快取都會以新日期重新判定，也不必逐一重跑各頁的載入流程。
//
// 觸發時機：台北時間週一～週五 08:30（開盤前一小時），且頁面是在該時點之前載入的。
// 每分鐘檢查一次，不用 setTimeout 排程，睡眠喚醒或休眠後補跑也不會漏掉。
// 國定假日不另外判斷（沒有交易日曆資料）；假日重載一次只是重抓當日快取，沒有副作用。

var DR_HOUR = 8, DR_MIN = 30;
var _drStart = Date.now();

function _drTaipei(ms) { return new Date((ms == null ? Date.now() : ms) + 8 * 3600000); }
// 該時刻對應的「最近一次 08:30 觸發點」（台北時區，以 UTC 毫秒表示）；週末回傳 null
function _drTriggerAt(ms) {
  var d = _drTaipei(ms);
  var wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  var t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DR_HOUR, DR_MIN) - 8 * 3600000;
  return t;
}
function _drShouldReload() {
  var t = _drTriggerAt();
  return t != null && Date.now() >= t && _drStart < t;   // 觸發點已到，且本頁在那之前就開著
}
function _drTick() {
  if (!_drShouldReload()) return;
  console.log('[每日刷新] 營業日 08:30，重新載入頁面');
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
      btn.title = '重新載入整頁（營業日 08:30 會自動執行一次）';
      btn.onclick = refreshApp;
      box.insertBefore(btn, document.getElementById('btn-back'));
    }
    setInterval(_drTick, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
