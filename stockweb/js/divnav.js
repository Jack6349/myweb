// 股利總管 Web — 股利估算頁的左側選單
//
// 為什麼：這一頁原本是三個上方子頁籤，而「股利估算」那一頁自己就有五個區塊、
// 總高 1969px，要找某個區塊得一路捲。改成左側選單，一次只顯示一個區塊。
//
// 做法刻意不動 renderDividendEst／renderRefill 的內部：它們輸出的是
// 「.sec-title ＋ 內容 ＋ .divest-divider」平鋪的結構，渲染完之後再把
// 每個標題到下一個標題之間包成一組，選單只負責顯示選中的那一組。
// 兩個 wrap 各掛一個 MutationObserver，非同步重繪完會自動重新分組並套回目前選擇。
//
// 選單收合只做手動鈕，不做自動：實測唯一放不下的是逐檔填息（最小 1357px，
// 加選單需要 1555px 的 main-area）；配息資料已經提到主選單，不在這一頁。

var DV_MENU = [
  { id: 'pay', label: '本月發放', pane: 'est', sec: '本月發放' },
  { id: 'exm', label: '本月除息個股', pane: 'est', sec: '本月除息個股' },
  { id: 'cal', label: '除息日曆', pane: 'est', sec: '除息日曆' },
  { id: 'stk', label: '個股明細', pane: 'est', sec: '個股明細' },
  { id: 'mon', label: '月份總覽', pane: 'est', sec: '月份總覽', cash: true },
  { id: 'swap', label: '換股試算', pane: 'swap', sec: null, sep: true },
  { id: 'pend', label: '未填息個股', pane: 'refill', sec: '未填息個股', sep: true },
  { id: 'rf', label: '逐檔填息', pane: 'refill', sec: '逐檔填息' }
];

var DV_SEL_LS = 'divest_nav_v1', DV_COL_LS = 'divest_navcol_v1';
var _dvSel = (function () {
  try {
    var v = localStorage.getItem(DV_SEL_LS);
    if (DV_MENU.some(function (m) { return m.id === v; })) return v;
  } catch (e) {}
  return 'pay';
})();
var _dvCollapsed = (function () { try { return localStorage.getItem(DV_COL_LS) === '1'; } catch (e) { return false; } })();
var _dvObs = {};

function _dvItem(id) {
  for (var i = 0; i < DV_MENU.length; i++) if (DV_MENU[i].id === id) return DV_MENU[i];
  return DV_MENU[0];
}

// 把平鋪的「標題＋內容」包成一組組 .dv-sec，已經包過就不重複做
function _dvSectionize(wrap) {
  if (!wrap || wrap.getAttribute('data-dv') === '1') return;
  var kids = [].slice.call(wrap.children);
  if (!kids.some(function (k) { return k.classList && k.classList.contains('sec-title'); })) return;
  var frag = document.createDocumentFragment(), cur = null;
  kids.forEach(function (k) {
    if (k.classList && k.classList.contains('sec-title')) {
      cur = document.createElement('div');
      cur.className = 'dv-sec';
      cur.setAttribute('data-sec', k.textContent.trim());
      frag.appendChild(cur);
    }
    // 分隔線是區塊之間的裝飾，拆開後每組只顯示一個，留著會變成孤立的線
    if (k.classList && k.classList.contains('divest-divider')) { k.remove(); return; }
    (cur || frag).appendChild(k);
  });
  wrap.appendChild(frag);
  wrap.setAttribute('data-dv', '1');
}

function _dvApply() {
  var it = _dvItem(_dvSel);
  ['est', 'swap', 'refill'].forEach(function (p) {
    var pane = document.getElementById('divest-tab-' + p);
    if (pane) pane.style.display = (p === it.pane) ? '' : 'none';
  });
  ['divest-wrap', 'refill-wrap'].forEach(function (id) {
    var w = document.getElementById(id);
    if (!w) return;
    _dvSectionize(w);
    [].slice.call(w.querySelectorAll('.dv-sec')).forEach(function (sec) {
      var t = sec.getAttribute('data-sec') || '';
      sec.style.display = (it.sec && t.indexOf(it.sec) === 0) ? '' : 'none';
    });
  });
  // 月份總覽底下接現金流對照（支出設定在 參數設定 → 退休現金流）
  var cash = document.getElementById('dv-cash');
  if (cash) {
    cash.style.display = it.cash ? '' : 'none';
    if (it.cash && typeof rtCashHtml === 'function') {
      if (typeof rtLoad === 'function') {
        rtLoad().then(function () { cash.innerHTML = rtCashHtml(); });
      } else { cash.innerHTML = rtCashHtml(); }
    }
  }
  var nav = document.getElementById('dv-items');
  if (nav) {
    [].slice.call(nav.querySelectorAll('.dv-navitem')).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-id') === _dvSel);
    });
  }
  var shell = document.getElementById('dv-shell');
  if (shell) shell.classList.toggle('collapsed', _dvCollapsed);
  var cb = document.getElementById('dv-collapse');
  if (cb) { cb.textContent = _dvCollapsed ? '»' : '«'; cb.title = _dvCollapsed ? '展開選單' : '收合選單'; }
}

function dvGo(id) {
  _dvSel = id;
  try { localStorage.setItem(DV_SEL_LS, id); } catch (e) {}
  var it = _dvItem(id);
  if (typeof divShowTab === 'function') divShowTab(it.pane);   // 沿用既有的延遲載入
  _dvApply();
}
function dvCollapse() {
  _dvCollapsed = !_dvCollapsed;
  try { localStorage.setItem(DV_COL_LS, _dvCollapsed ? '1' : '0'); } catch (e) {}
  _dvApply();
}

function dvBuild() {
  var nav = document.getElementById('dv-items');
  if (!nav) return;
  nav.innerHTML = DV_MENU.map(function (m) {
    return (m.sep ? '<div class="dv-navsep"></div>' : '') +
      '<button class="dv-navitem" data-id="' + m.id + '" onclick="dvGo(\'' + m.id + '\')">' + m.label + '</button>';
  }).join('');
  // 非同步重繪（換頁籤、重新整理）之後要重新分組並套回目前選擇
  ['divest-wrap', 'refill-wrap'].forEach(function (id) {
    var w = document.getElementById(id);
    if (!w || _dvObs[id]) return;
    _dvObs[id] = new MutationObserver(function () {
      if (w.getAttribute('data-dv') === '1' && !w.querySelector('.dv-sec')) w.removeAttribute('data-dv');
      if (!w.querySelector('.dv-sec')) { w.removeAttribute('data-dv'); _dvApply(); }
    });
    _dvObs[id].observe(w, { childList: true });
  });
  dvGo(_dvSel);
}
