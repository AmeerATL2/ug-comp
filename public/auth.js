(() => {
  let currentUser = null;
  let customName = '';
  let firebaseReady = false;
  let db = null;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  function firebaseConfigured() {
    return window.UG_FIREBASE_CONFIG && window.UG_FIREBASE_CONFIG.apiKey && !String(window.UG_FIREBASE_CONFIG.apiKey).startsWith('PASTE_');
  }

  async function loadProfile(user) {
    if (!user || !db) { customName = ''; return; }
    try {
      const snap = await db.collection('users').doc(user.uid).get();
      customName = snap.exists ? String(snap.data().name || '').trim() : '';
    } catch (_) {
      customName = '';
    }
  }

  async function init() {
    try {
      if (!firebaseConfigured()) return;
      firebase.initializeApp(window.UG_FIREBASE_CONFIG);
      firebaseReady = true;
      db = firebase.firestore();
      await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      firebase.auth().onAuthStateChanged(async user => {
        currentUser = user || null;
        await loadProfile(currentUser);
        resolveReady(true);
        if (window.UGAuth._listener) window.UGAuth._listener(currentUser, customName);
      });
    } catch (err) {
      console.error(err);
      resolveReady(false);
    }
  }

  window.UGAuth = {
    ready,
    _listener: null,
    get user() { return currentUser; },
    get name() { return customName; },
    get db() { return db; },
    get firebaseReady() { return firebaseReady; },
    onChange(fn) { this._listener = fn; if (currentUser) fn(currentUser, customName); },
    async signInWithGoogle() {
      if (!firebaseReady) throw new Error('Firebase is not configured yet.');
      const provider = new firebase.auth.GoogleAuthProvider();
      await firebase.auth().signInWithPopup(provider);
    },
    async signOut() {
      if (firebaseReady) await firebase.auth().signOut();
    },
    async saveName(name) {
      if (!currentUser || !db) throw new Error('You must be signed in with Google.');
      const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (clean.length < 2) throw new Error('Please enter at least 2 characters.');
      await db.collection('users').doc(currentUser.uid).set({
        name: clean,
        email: currentUser.email || '',
        photoURL: currentUser.photoURL || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      customName = clean;
      return clean;
    },
    async ensureName() {
      await ready;
      return customName;
    },
    async saveBattleHistory(data) {
      if (!currentUser || !db) return;
      const ref = db.collection('users').doc(currentUser.uid).collection('battleHistory').doc();
      await ref.set({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    },
    async getBattleHistory(limit = 50) {
      if (!currentUser || !db) return [];
      const snap = await db.collection('users').doc(currentUser.uid).collection('battleHistory').orderBy('createdAt', 'desc').limit(limit).get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
  };

  init();
})();
