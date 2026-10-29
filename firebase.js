// Firebase init (Modular SDK v10, loaded from the CDN because there is no bundler).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCqH4SFVAiS5g4kS6yvBRU4I8RTchxbsL0",
  authDomain: "diner-7924a.firebaseapp.com",
  databaseURL: "https://diner-7924a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "diner-7924a",
  storageBucket: "diner-7924a.firebasestorage.app",
  messagingSenderId: "574786145448",
  appId: "1:574786145448:web:1a1bd3dc3693d8fc37c69d"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// Server-synced clock so both players agree on timers despite device clock drift.
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
export const now = () => Date.now() + offset;
