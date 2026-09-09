/* travel-expense — Firebase 初始化（ES Module）
 *
 * 沿用與 travel-v2 相同的 Firebase 專案（life-manager-61307），
 * 但 collection 一律加 TravelExpense_ 前綴，與 travel-v2 的資料完全隔開。
 *
 * 說明：firebaseConfig 內的 apiKey 會出現在前端，這是 Firebase 的正常設計
 * （它是專案識別碼，不是密鑰）。實際的存取控制靠 Firestore 安全規則，
 * 規則內容見 _docs/travel-expense/firestore-rules.md。
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyD-igMSQif7ekedzilp1GXbiGVdGCHZbt0',
  authDomain: 'life-manager-61307.firebaseapp.com',
  projectId: 'life-manager-61307',
  storageBucket: 'life-manager-61307.firebasestorage.app',
  messagingSenderId: '1047938106297',
  appId: '1:1047938106297:web:19b8e0d24a87319cf8ec68',
};

const app = initializeApp(firebaseConfig);

// 離線持久化：斷網時仍可讀寫，恢復連線後自動同步；
// multipleTabManager 讓多個分頁同時開啟也能共用快取。
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const auth = getAuth(app);

window.FB = {
  app, db, auth,
  collection, doc, setDoc, deleteDoc, onSnapshot,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
};

// module script 為 deferred，可能晚於一般 <script> 執行；通知等待中的程式碼。
window.dispatchEvent(new Event('fb-ready'));
