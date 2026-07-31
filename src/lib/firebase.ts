import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import defaultConfig from '../../firebase-applet-config.json';

const configToUse = defaultConfig || {
  projectId: "gen-lang-client-0099939117",
  appId: "1:203482224009:web:46ebdf676c4a9dd5c8bd58",
  apiKey: "AIzaSyChUKXfKPDowBDOehl8EQKu7DDDPyjZ9qs",
  authDomain: "gen-lang-client-0099939117.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-f9f9707f-b51c-4e60-829d-14bd0bb20a21",
  storageBucket: "gen-lang-client-0099939117.firebasestorage.app",
  messagingSenderId: "203482224009"
};

const app = initializeApp(configToUse);
export const db = getFirestore(app, configToUse.firestoreDatabaseId);
export const auth = getAuth();

// Test connection
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log('[Firebase] Connection testing... OK');
  } catch (error) {
    if (error instanceof Error && error.message.includes('permission-denied')) {
        // Rules might not be fully propagated or test doc doesn't exist, this is usually OK
        console.log('[Firebase] Connection test: Permission defined (expected if rules are strict)');
    } else if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("[Firebase] Please check your Firebase configuration or internet connection.");
    } else {
        console.warn('[Firebase] Connection test result:', error);
    }
  }
}

testConnection();
