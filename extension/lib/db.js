/**
 * IndexedDB store.
 *
 * IndexedDB is used instead of chrome.storage because a full catalogue is
 * ~46k records (~6 MB) and chrome.storage.local is capped at 10 MB.
 */

const DB_NAME = "fab-free-claimer";
const DB_VERSION = 1;
const STORES = ["listings", "claimed", "failed", "meta"];

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === "meta" ? "k" : "uid" });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function putMany(store, rows) {
  if (!rows.length) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    const objectStore = transaction.objectStore(store);
    for (const row of rows) objectStore.put(row);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function getAll(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllKeys(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function count(store) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).count();
    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => reject(request.error);
  });
}

export async function clear(store) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getMeta(key, fallback = null) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
    request.onsuccess = () => resolve(request.result ? request.result.v : fallback);
    request.onerror = () => reject(request.error);
  });
}

export async function setMeta(key, value) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("meta", "readwrite");
    transaction.objectStore("meta").put({ k: key, v: value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function stats() {
  const [listings, claimed, failed] = await Promise.all([
    count("listings"),
    count("claimed"),
    count("failed"),
  ]);
  return { listings, claimed, failed };
}

/** Wipe everything (used by "reset" in the popup). */
export async function reset() {
  for (const store of STORES) {
    await clear(store);
  }
}
