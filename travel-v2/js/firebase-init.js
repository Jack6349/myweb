// travel-v2 第二階段 — Firebase 初始化（ES Module）
// 本檔僅初始化 Firebase App / Firestore，並暴露給 window.FB 供測試與
// repo.firebase.js 使用（RepoFirebase.init(db)）。
// 目前未被 app.js 使用，prototype 仍走 LocalRepo（js/repo.js），不受影響。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

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

// 暴露於 window，供 console 測試 / 之後 RepoFirebase.init(db) 使用
window.FB = {
  app, db,
  // Firestore 常用函式一併暴露，避免重複 import
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, updateDoc,
};

console.log('[firebase-init] Firebase 已初始化，projectId =', firebaseConfig.projectId);

// module script 為 deferred 執行，可能晚於一般 <script> 中呼叫的 App.init()。
// 通知任何正在等待 window.FB 的程式（見 firebase-sync.js 的 waitForFB）。
window.dispatchEvent(new Event('fb-ready'));
