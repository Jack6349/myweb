/* travel-v2 prototype — P2 Visio 式拖放
 * 行為需求：
 *  - 站點由左側規劃區(pool)拖入右側時間軸(board)後，從規劃區消失（不可重複取用）
 *  - drop 落點決定插入位置：兩站點間=插入、首站前=成為首站、末站後=接尾
 *  - 同一天內可調整先後順序
 *  - 可跨天搬移
 * 採原生 HTML5 Drag & Drop。資料以 App.state.currentTrip 的 pool / days 為真實來源，
 * drop 後改資料並重繪（由 app.js 提供 App.renderEditor）。
 */

const DragDrop = (() => {
  // 目前被拖曳站點的來源資訊
  let dragging = null; // { from:'pool'|day(number), id }

  function attachStation(el, from, id) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragging = { from, id };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox 需要 setData 才會啟動拖曳
      e.dataTransfer.setData('text/plain', id);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragging = null;
      clearHover();
    });
  }

  function clearHover() {
    document.querySelectorAll('.drop-hover').forEach(n => n.classList.remove('drop-hover'));
  }

  // gap：某天 day 中，插入位置 index（0=首站前，n=末站後）
  function attachGap(el, day, index) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-hover'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-hover');
      if (!dragging) return;
      App.moveStation(dragging, day, index);
      dragging = null;
    });
  }

  // 左側規劃區落點：把右側時間軸的站點拖回規劃區
  function attachPool(el) {
    el.addEventListener('dragover', (e) => {
      if (!dragging || dragging.from === 'pool') return; // 本來就在規劃區則不處理
      e.preventDefault();
      el.classList.add('drop-hover');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-hover');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-hover');
      if (!dragging || dragging.from === 'pool') return;
      e.preventDefault();
      App.moveStationToPool(dragging);
      dragging = null;
    });
  }

  // 整個 day 容器（空白天時當作 index 0 的落點）
  function attachDayContainer(el, day, getCount) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      // 若 drop 沒落在任何 gap 上，視為接尾
      if (!dragging) return;
      if (e.target === el) {
        e.preventDefault();
        App.moveStation(dragging, day, getCount());
        dragging = null;
      }
    });
  }

  return { attachStation, attachGap, attachDayContainer, attachPool };
})();
