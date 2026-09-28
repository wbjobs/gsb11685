/*
 * db.js — IndexedDB 封装：持久化每次采样的帧率/长任务数据，
 * 用于跨会话的帧率对照（主线程绘制 vs 离屏绘制）。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'render-bench';
  var STORE = 'samples';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in global)) {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts');
          store.createIndex('mode', 'mode');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var result = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(result && result._value); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('事务中止')); };
      });
    });
  }

  function add(sample) {
    return tx('readwrite', function (store) { store.add(sample); });
  }

  function getAll() {
    return tx('readonly', function (store) {
      var out = [];
      out._value = undefined;
      var req = store.getAll();
      req.onsuccess = function () { out._value = req.result || []; };
      return out;
    });
  }

  function clear() {
    return tx('readwrite', function (store) { store.clear(); });
  }

  global.BenchDB = { add: add, getAll: getAll, clear: clear };
})(typeof self !== 'undefined' ? self : this);
