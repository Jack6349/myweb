/* travel-v2 prototype — 極簡視圖路由
 * 單頁多視圖：以顯示/隱藏 .view 區塊模擬頁面跳轉，維護返回堆疊。
 */

const Router = (() => {
  const stack = [];           // 返回堆疊（存 viewId）
  let current = null;

  function show(viewId, opts = {}) {
    const target = document.getElementById(viewId);
    if (!target) { console.warn('view not found:', viewId); return; }

    document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
    target.classList.add('view--active');

    if (!opts.replace && current && current !== viewId) {
      stack.push(current);
    }
    current = viewId;

    // 觸發該頁渲染（app.js 註冊）
    if (typeof App !== 'undefined' && App.onShow) App.onShow(viewId, opts.params || {});

    // 回到頂部，符合手機換頁體感
    window.scrollTo(0, 0);
  }

  function back() {
    if (stack.length > 0) {
      const prev = stack.pop();
      show(prev, { replace: true });
    } else {
      show('view-home', { replace: true });
    }
  }

  function reset(viewId) {
    stack.length = 0;
    current = null;
    show(viewId, { replace: true });
  }

  return { show, back, reset, get current() { return current; } };
})();
