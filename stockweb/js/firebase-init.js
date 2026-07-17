// 股利總管 — Firebase 初始化（ES Module）
// 與 travel-v2 共用同一個 Firebase 專案（life-manager-61307）。
// 僅初始化 App / Firestore / Auth，並暴露給 window.FB 供 auth.js、repo.firebase.js 使用。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD-igMSQif7ekedzilp1GXbiGVdGCHZbt0",
  authDomain: "life-manager-61307.firebaseapp.com",
  projectId: "life-manager-61307",
  storageBucket: "life-manager-61307.firebasestorage.app",
  messagingSenderId: "1047938106297",
  appId: "1:1047938106297:web:19b8e0d24a87319cf8ec68",
  measurementId: "G-M8EST4FTVQ"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 暴露於 window，供一般 <script>（auth.js / repo.firebase.js）使用
window.FB = {
  app, db, auth,
  // Firestore（單一文件存取即可，故只帶 doc/getDoc/setDoc）
  doc, getDoc, setDoc,
  // Auth
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
};

console.log('[firebase-init] Firebase 已初始化，projectId =', firebaseConfig.projectId);

// module script 為 deferred 執行，可能晚於一般 <script>。
// 通知等待 window.FB 的程式（auth.js 的 waitForFB）。
window.dispatchEvent(new Event('fb-ready'));
