// 股利總管 Web — 說明區塊統一收合
//
// 各頁的說明原本直接攤在表格下方，長的一段佔掉大半個畫面。這裡把它們一律收成
// 一列「說明」，點了才展開。做法是全域監看 DOM，抓到說明元素就用 <details> 包起來，
// 不必去改 40 幾個產生 HTML 的地方，之後新增的說明也會自動套用。
//
// 只收「解釋性」的說明。狀態訊息（例如「兩年內尚無已公布金額的除息紀錄」「3 檔」）
// 必須一直看得到，不在名單內；解釋性的說明若用了那幾個共用 class，另外加 nb 標記。

var NOTE_SEL = [
  '.detail-note', '.rs-note', '.divest-note', '.sig-note',
  '.swap-qual-note', '.rf-cal-note', '.cs-note',
  '.nb'
].join(',');

function _noteWrap(el) {
  if (!el || el.getAttribute('data-nbox') || el.closest('.nbox')) return;
  // nb-keep＝借用說明 class 排版、但內容其實是資料（來源、覆蓋率、累積已配息），收起來就看不到了
  if (el.classList.contains('nb-keep')) return;
  // 空的或極短的（載入中、單句狀態）不收，收起來反而多一次點擊
  var txt = (el.textContent || '').trim();
  if (!txt) return;
  // 還沒掛進文件的節點（整塊 innerHTML 組好前就被 observer 看到）沒有 parentNode，
  // 包了會丟 insertBefore of null；下一輪掃描它已經在文件裡，會再被包一次。
  if (!el.parentNode) return;
  el.setAttribute('data-nbox', '1');
  var d = document.createElement('details');
  d.className = 'nbox';
  var s = document.createElement('summary');
  s.textContent = '說明';
  el.parentNode.insertBefore(d, el);
  d.appendChild(s);
  d.appendChild(el);
}

function noteScan(root) {
  var r = root || document;
  if (r.querySelectorAll) Array.prototype.forEach.call(r.querySelectorAll(NOTE_SEL), _noteWrap);
  if (r.nodeType === 1 && r.matches && r.matches(NOTE_SEL)) _noteWrap(r);
}

(function () {
  var start = function () {
    noteScan(document);
    // 各頁都是重繪整塊 innerHTML，所以監看整份文件的子樹異動；
    // _noteWrap 自己有 data-nbox 與 .nbox 兩道防護，包過的不會再包一次。
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) noteScan(added[j]);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
