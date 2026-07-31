import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
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
