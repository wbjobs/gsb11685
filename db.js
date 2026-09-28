/*
 * db.js — IndexedDB 持久化：保存帧率样本，用于主线程 vs 离屏的量化对比。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'offscreen-bench';
  const DB_VERSION = 1;
  const STORE = 'fps-samples';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in global)) {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('mode', 'mode', { unique: false });
          store.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      const result = fn(store);
      transaction.oncomplete = () => resolve(result && result._value);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  const BenchDB = {
    /** 保存一条样本：{ mode: 'main'|'worker', fps, frameTime, longtasks } */
    async saveSample(sample) {
      const db = await open();
      return tx(db, 'readwrite', (store) => store.add({ ...sample, ts: Date.now() }));
    },

    /** 按模式聚合：{ main: {avgFps, count}, worker: {...} } */
    async summary() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readonly');
        const req = transaction.objectStore(STORE).getAll();
        req.onsuccess = () => {
          const acc = {};
          for (const row of req.result) {
            const bucket = (acc[row.mode] = acc[row.mode] || { fpsSum: 0, ftSum: 0, count: 0 });
            bucket.fpsSum += row.fps;
            bucket.ftSum += row.frameTime || 0;
            bucket.count++;
          }
          const out = {};
          for (const mode of Object.keys(acc)) {
            const b = acc[mode];
            out[mode] = {
              avgFps: Math.round((b.fpsSum / b.count) * 10) / 10,
              avgFrameTime: Math.round((b.ftSum / b.count) * 100) / 100,
              count: b.count,
            };
          }
          resolve(out);
        };
        req.onerror = () => reject(req.error);
      });
    },

    async clear() {
      const db = await open();
      return tx(db, 'readwrite', (store) => store.clear());
    },
  };

  global.BenchDB = BenchDB;
})(typeof self !== 'undefined' ? self : this);
