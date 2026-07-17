// 股利總管 — 登入閘門（Phase 1）
// 僅限本人（OWNER_EMAIL）登入；其他 Google 帳號登入後一律擋下。
// 取得的 uid 存於 window.OWNER_UID，供 Phase 2 的 repo.firebase.js 寫入 users/{uid}。

(function () {
  var OWNER_EMAIL = 'jack6349@gmail.com';

  var gate, btn, msg, signoutBtn;

  // 等待 firebase-init.js（deferred module）就緒
  function waitForFB(timeoutMs) {
    if (window.FB) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(!!window.FB); }, timeoutMs || 4000);
      window.addEventListener('fb-ready', function () { clearTimeout(timer); resolve(true); }, { once: true });
    });
  }

  function showGate() { if (gate) gate.style.display = 'flex'; }
  function hideGate() { if (gate) gate.style.display = 'none'; }
  function setMsg(t) { if (msg) msg.textContent = t || ''; }

  function renderSignedOut() {
    if (btn) btn.style.display = '';
    if (signoutBtn) signoutBtn.style.display = 'none';
    setMsg('');
    showGate();
  }

  function renderNotOwner(email) {
    if (btn) btn.style.display = 'none';
    if (signoutBtn) signoutBtn.style.display = '';
    setMsg('此為私人股利帳本，僅限本人使用。\n目前登入：' + (email || '') + '\n如為本人請改用本人 Google 帳號登入。');
    showGate();
  }

  function renderOwner(user) {
    window.OWNER_UID = user.uid;
    window.OWNER_USER = user;
    hideGate();
    // 通知其他模組：本人已登入（Phase 2 由 repo.firebase.js 接手）
    window.dispatchEvent(new Event('owner-ready'));
  }

  async function init() {
    gate = document.getElementById('login-gate');
    btn = document.getElementById('login-btn');
    msg = document.getElementById('login-msg');
    signoutBtn = document.getElementById('login-signout');

    if (btn) btn.addEventListener('click', doSignIn);
    if (signoutBtn) signoutBtn.addEventListener('click', doSignOut);

    var ok = await waitForFB();
    if (!ok || !window.FB || !window.FB.auth) {
      setMsg('Firebase 載入失敗，請檢查網路後重新整理。');
      showGate();
      return;
    }

    window.FB.onAuthStateChanged(window.FB.auth, function (user) {
      if (!user) { renderSignedOut(); return; }
      if (user.email && user.email.toLowerCase() === OWNER_EMAIL) { renderOwner(user); }
      else { renderNotOwner(user.email); }
    });
  }

  function doSignIn() {
    if (!window.FB || !window.FB.auth) return;
    setMsg('登入中…');
    window.FB.signInWithPopup(window.FB.auth, new window.FB.GoogleAuthProvider())
      .catch(function (e) {
        if (e && e.code === 'auth/popup-closed-by-user') { setMsg(''); return; }
        setMsg('登入失敗：' + (e && e.code ? e.code : e));
      });
  }

  function doSignOut() {
    if (!window.FB || !window.FB.auth) return;
    window.FB.signOut(window.FB.auth);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
