// IndexedDB stores cropped photos as Blobs; each signed-in profile has its own session key.
let pending;
function db() {
  return pending ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('pokedex-bulk-scans', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sessions');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { pending = null; reject(r.error); };
  });
}
export async function sessionStore(userKey, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('sessions', value === undefined ? 'readonly' : 'readwrite');
    const object = tx.objectStore('sessions');
    const r = value === undefined ? object.get(userKey) : value === null ? object.delete(userKey) : object.put(value, userKey);
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Session storage was interrupted'));
  });
}
