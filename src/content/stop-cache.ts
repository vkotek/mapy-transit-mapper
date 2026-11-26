import { CachedStop } from '../shared/types';

const DB_NAME = 'mapy_transit_mapper_db';
const DB_VERSION = 1;
const STORE_NAME = 'stops';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class StopCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async getMany(ids: string[]): Promise<Map<string, CachedStop>> {
    const out = new Map<string, CachedStop>();
    if (ids.length === 0) return out;
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const now = Date.now();

      await Promise.all(
        ids.map(
          (id) =>
            new Promise<void>((resolve) => {
              const req = store.get(id);
              req.onsuccess = () => {
                const rec = req.result as CachedStop | undefined;
                if (rec && now - rec.updatedAt < TTL_MS) {
                  out.set(id, rec);
                }
                resolve();
              };
              req.onerror = () => resolve();
            })
        )
      );
    } catch {
      // Fallback gracefully if IndexedDB is unavailable
    }
    return out;
  }

  async putMany(stops: CachedStop[]): Promise<void> {
    if (stops.length === 0) return;
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const stop of stops) {
        store.put(stop);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Ignore storage errors
    }
  }

  async count(): Promise<number> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      return await new Promise<number>((resolve) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // Ignore
    }
  }
}

export const stopCache = new StopCache();
