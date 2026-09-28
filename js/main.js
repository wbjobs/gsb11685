/*
 * main.js — 主线程编排：
 *  - 模式切换：主线程绘制 <-> OffscreenCanvas + Worker 离屏绘制
 *  - 能力检测与降级（无 OffscreenCanvas / Worker 创建失败 / 控制权转移失败）
 *  - 上下文丢失恢复（主线程与 Worker 两侧）
 *  - 绘制指令同步（seq/ack 协议）
 *  - PerformanceObserver(longtask) 量化主线程响应性
 *  - IndexedDB 持久化采样，输出帧率对照
 */
(function () {
  'use strict';

  /* ---------- 能力检测 ---------- */
  var caps = {
    offscreen: typeof OffscreenCanvas !== 'undefined' &&
      !!HTMLCanvasElement.prototype.transferControlToOffscreen,
    worker: typeof Worker !== 'undefined',
    longtask: typeof PerformanceObserver !== 'undefined' &&
      Array.isArray(PerformanceObserver.supportedEntryTypes) &&
      PerformanceObserver.supportedEntryTypes.indexOf('longtask') !== -1
  };

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage');
  var els = {
    modeMain: $('modeMain'), modeWorker: $('modeWorker'),
    banner: $('banner'),
    statMode: $('statMode'), statRenderFps: $('statRenderFps'),
    statMainFps: $('statMainFps'), statFrameMs: $('statFrameMs'),
    statLongtask: $('statLongtask'), statSync: $('statSync'),
    particles: $('particles'), particlesVal: $('particlesVal'),
    blockMain: $('blockMain'), simulateWorkerFail: $('simulateWorkerFail'),
    simulateCtxLoss: $('simulateCtxLoss'),
    history: $('history'), clearHistory: $('clearHistory'), log: $('log')
  };

  /* ---------- 全局状态 ---------- */
  var mode = 'main';            // 'main' | 'worker'
  var worker = null;
  var canvas = null;
  var mainCtx = null;
  var mainState = null;
  var seq = 0;                  // 已发送指令序号
  var ackedSeq = 0;             // Worker 已确认序号
  var workerStats = { fps: 0, frameMs: 0 };
  var longtaskCount = 0;
  var longtaskTime = 0;
  var pointerDown = false;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  /* ---------- 日志 / 提示 ---------- */
  function log(msg) {
    var line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    els.log.prepend(line);
    while (els.log.children.length > 60) els.log.removeChild(els.log.lastChild);
  }

  function showBanner(msg, kind) {
    els.banner.textContent = msg;
    els.banner.className = 'banner show ' + (kind || 'warn');
  }
  function hideBanner() { els.banner.className = 'banner'; }

  /* ---------- 画布管理（每次切换都新建，保证可安全 transferControlToOffscreen） ---------- */
  function freshCanvas() {
    if (canvas) canvas.remove();
    canvas = document.createElement('canvas');
    canvas.id = 'view';
    stage.innerHTML = '';
    stage.appendChild(canvas);
    var rect = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    return canvas;
  }

  function currentConfig() {
    return { particleCount: parseInt(els.particles.value, 10) };
  }

  /* ---------- 指令同步：发送并记录 seq ---------- */
  function sendCommand(msg) {
    msg.seq = ++seq;
    if (mode === 'worker' && worker) {
      worker.postMessage(msg);
    } else if (mainState) {
      applyLocal(msg);
      ackedSeq = seq; // 主线程模式本地即同步
    }
    updateSyncStat();
  }

  function applyLocal(msg) {
    if (msg.type === 'config') SceneShared.applyConfig(mainState, msg.config);
    else if (msg.type === 'pointer') {
      mainState.pointer.x = msg.x * dpr;
      mainState.pointer.y = msg.y * dpr;
      mainState.pointer.down = !!msg.down;
    } else if (msg.type === 'resize') SceneShared.resize(mainState, msg.width, msg.height);
  }

  function updateSyncStat() {
    var pending = seq - ackedSeq;
    els.statSync.textContent = '已发送 ' + seq + ' / 已确认 ' + ackedSeq +
      (pending > 0 ? '（待同步 ' + pending + '）' : '（一致）');
    els.statSync.classList.toggle('stale', pending > 20);
  }

  /* ---------- 主线程渲染模式 ---------- */
  var mainRunning = false;

  function startMainMode(reason) {
    stopAll();
    mode = 'main';
    els.modeMain.checked = true;
    freshCanvas();
    mainCtx = canvas.getContext('2d');
    if (!mainCtx) {
      showBanner('无法获取 2D 上下文，渲染不可用', 'error');
      return;
    }
    attachMainContextLossHandlers();
    mainState = SceneShared.createState(canvas.width, canvas.height, currentConfig());
    mainRunning = true;
    els.statMode.textContent = '主线程绘制';
    if (reason) log(reason);
    log('已切换到主线程绘制模式');
  }

  function attachMainContextLossHandlers() {
    if (!mainCtx || typeof mainCtx.addEventListener !== 'function') return;
    mainCtx.addEventListener('contextlost', onMainContextLost);
    mainCtx.addEventListener('contextrestored', onMainContextRestored);
  }

  function onMainContextLost(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    mainRunning = false;
    showBanner('主线程渲染上下文丢失，正在恢复…', 'error');
    log('主线程 2D 上下文丢失');
  }

  function onMainContextRestored() {
    recoverMainContext();
    log('主线程 2D 上下文已恢复');
    hideBanner();
  }

  function recoverMainContext() {
    var fresh = canvas.getContext('2d');
    if (!fresh) {
      showBanner('上下文恢复失败，500ms 后重试', 'error');
      setTimeout(recoverMainContext, 500);
      return;
    }
    mainCtx = fresh;
    attachMainContextLossHandlers();
    mainRunning = true;
  }

  /* ---------- Worker 离屏渲染模式 ---------- */
  function startWorkerMode() {
    if (!caps.worker) {
      showBanner('当前浏览器不支持 Web Worker，已降级到主线程绘制');
      startMainMode('降级原因：不支持 Worker');
      return;
    }
    if (!caps.offscreen) {
      showBanner('当前浏览器不支持 OffscreenCanvas，已降级到主线程绘制');
      startMainMode('降级原因：不支持 OffscreenCanvas');
      return;
    }

    stopAll();
    mode = 'worker';
    els.modeWorker.checked = true;
    var view = freshCanvas();

    // 模拟 Worker 创建失败（用于测试降级路径）
    var scriptUrl = els.simulateWorkerFail.checked
      ? 'js/render-worker.__missing__.js'
      : 'js/render-worker.js';

    try {
      worker = new Worker(scriptUrl);
    } catch (err) {
      showBanner('Worker 创建失败：' + err.message + '，已降级到主线程绘制', 'error');
      worker = null;
      startMainMode('降级原因：Worker 构造异常');
      return;
    }

    var readyTimer = setTimeout(function () {
      failWorker('Worker 启动超时（3s 无响应）');
    }, 3000);

    worker.onerror = function (e) {
      failWorker('Worker 错误：' + (e.message || '脚本加载/运行失败'));
    };

    worker.onmessage = function (e) {
      var msg = e.data;
      switch (msg.type) {
        case 'ready':
          clearTimeout(readyTimer);
          els.statMode.textContent = '离屏绘制（Worker）';
          hideBanner();
          log('Worker 就绪，离屏绘制已启动');
          // 同步当前配置，保证指令流连续
          sendCommand({ type: 'config', config: currentConfig() });
          break;
        case 'stats':
          workerStats.fps = msg.fps;
          workerStats.frameMs = msg.frameMs;
          if (typeof msg.lastSeq === 'number') {
            ackedSeq = Math.max(ackedSeq, msg.lastSeq);
            updateSyncStat();
          }
          break;
        case 'contextlost':
          showBanner('离屏渲染上下文丢失，等待自动恢复…', 'error');
          log('Worker 内上下文丢失');
          break;
        case 'contextrestored':
          hideBanner();
          log('Worker 内上下文已恢复');
          break;
        case 'error':
          failWorker('Worker 报告错误：' + msg.message);
          break;
      }
    };

    // 控制权转移：只能在未被转移过的画布上调用一次
    var offscreen;
    try {
      offscreen = view.transferControlToOffscreen();
    } catch (err) {
      clearTimeout(readyTimer);
      worker.terminate();
      worker = null;
      showBanner('画布控制权转移失败：' + err.message + '，已降级到主线程绘制', 'error');
      startMainMode('降级原因：transferControlToOffscreen 失败');
      return;
    }

    worker.postMessage({
      type: 'init',
      canvas: offscreen,
      width: view.width,
      height: view.height,
      dpr: dpr,
      config: currentConfig()
    }, [offscreen]);
    log('画布控制权已转移给 Worker');
  }

  function failWorker(reason) {
    showBanner(reason + '，已降级到主线程绘制', 'error');
    if (worker) { worker.terminate(); worker = null; }
    startMainMode('降级原因：' + reason);
  }

  function stopAll() {
    mainRunning = false;
    if (worker) { worker.terminate(); worker = null; }
    workerStats = { fps: 0, frameMs: 0 };
  }

  /* ---------- 主线程统一 rAF：UI 帧率 +（main 模式下的）渲染 ---------- */
  var uiFrames = 0, uiStatStart = performance.now();
  var mainFrames = 0, mainFrameCost = 0;
  var lastTick = performance.now();

  function tick(now) {
    requestAnimationFrame(tick);
    var dt = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;

    if (mode === 'main' && mainRunning && mainState && mainCtx) {
      var t0 = performance.now();
      SceneShared.update(mainState, dt);
      SceneShared.render(mainCtx, mainState);
      mainFrameCost += performance.now() - t0;
      mainFrames++;
    }

    uiFrames++;
    if (now - uiStatStart >= 1000) {
      var uiFps = Math.round(uiFrames * 1000 / (now - uiStatStart));
      var renderFps = mode === 'main'
        ? Math.round(mainFrames * 1000 / (now - uiStatStart))
        : workerStats.fps;
      var frameMs = mode === 'main'
        ? (mainFrames ? mainFrameCost / mainFrames : 0)
        : workerStats.frameMs;

      els.statMainFps.textContent = uiFps + ' fps';
      els.statRenderFps.textContent = renderFps + ' fps';
      els.statFrameMs.textContent = frameMs.toFixed(2) + ' ms';
      els.statLongtask.textContent = longtaskCount + ' 次 / ' + longtaskTime.toFixed(0) + ' ms';

      BenchDB.add({
        ts: Date.now(), mode: mode, renderFps: renderFps, mainFps: uiFps,
        frameMs: +frameMs.toFixed(2), longtasks: longtaskCount,
        tbt: +longtaskTime.toFixed(0)
      }).catch(function () {});

      uiFrames = 0; mainFrames = 0; mainFrameCost = 0;
      longtaskCount = 0; longtaskTime = 0;
      uiStatStart = now;
    }
  }
  requestAnimationFrame(tick);

  /* ---------- PerformanceObserver：长任务量化主线程响应性 ---------- */
  if (caps.longtask) {
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          longtaskCount++;
          longtaskTime += entry.duration;
        });
      }).observe({ entryTypes: ['longtask'] });
    } catch (err) {
      log('PerformanceObserver(longtask) 注册失败：' + err.message);
    }
  } else {
    log('当前浏览器不支持 longtask 观察，响应性仅以主线程 fps 体现');
  }

  /* ---------- 交互事件（主线程只负责交互） ---------- */
  function pointerPos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  stage.addEventListener('pointermove', function (e) {
    var p = pointerPos(e);
    sendCommand({ type: 'pointer', x: p.x, y: p.y, down: pointerDown });
  });
  stage.addEventListener('pointerdown', function (e) {
    pointerDown = true;
    var p = pointerPos(e);
    sendCommand({ type: 'pointer', x: p.x, y: p.y, down: true });
  });
  window.addEventListener('pointerup', function () {
    pointerDown = false;
    sendCommand({ type: 'pointer', x: -9999, y: -9999, down: false });
  });

  els.particles.addEventListener('input', function () {
    els.particlesVal.textContent = els.particles.value;
    sendCommand({ type: 'config', config: currentConfig() });
  });

  els.modeMain.addEventListener('change', function () { if (this.checked) startMainMode(); });
  els.modeWorker.addEventListener('change', function () { if (this.checked) startWorkerMode(); });

  els.blockMain.addEventListener('click', function () {
    var until = performance.now() + 300;
    while (performance.now() < until) { Math.sqrt(Math.random()); } // 制造长任务
    log('已人为阻塞主线程 300ms（观察两种模式的差异）');
  });

  els.simulateCtxLoss.addEventListener('click', function () {
    log('模拟上下文丢失…');
    if (mode === 'main') {
      onMainContextLost(null);
      setTimeout(onMainContextRestored, 600); // 模拟浏览器自动恢复
    } else if (worker) {
      worker.postMessage({ type: 'context-restored' }); // 触发 Worker 侧重取上下文
      showBanner('已触发离屏上下文恢复流程', 'warn');
      setTimeout(hideBanner, 800);
    }
  });

  /* ---------- 尺寸同步 ---------- */
  var resizeTimer = null;
  new ResizeObserver(function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!canvas) return;
      var rect = stage.getBoundingClientRect();
      var w = Math.max(1, Math.round(rect.width * dpr));
      var h = Math.max(1, Math.round(rect.height * dpr));
      if (mode === 'main') {
        canvas.width = w; canvas.height = h;
        sendCommand({ type: 'resize', width: w, height: h });
      } else {
        sendCommand({ type: 'resize', width: w, height: h, dpr: dpr });
      }
    }, 150);
  }).observe(stage);

  /* ---------- 历史对照（IndexedDB） ---------- */
  els.history.addEventListener('click', function () {
    BenchDB.getAll().then(function (rows) {
      var agg = {};
      rows.forEach(function (r) {
        var a = agg[r.mode] || (agg[r.mode] = { n: 0, fps: 0, mainFps: 0, tbt: 0 });
        a.n++; a.fps += r.renderFps; a.mainFps += r.mainFps; a.tbt += r.tbt;
      });
      Object.keys(agg).forEach(function (m) {
        var a = agg[m];
        log('历史[' + (m === 'worker' ? '离屏' : '主线程') + '] 样本 ' + a.n +
          '：平均渲染 ' + (a.fps / a.n).toFixed(1) + ' fps，主线程 ' +
          (a.mainFps / a.n).toFixed(1) + ' fps，平均 TBT ' + (a.tbt / a.n).toFixed(0) + ' ms/s');
      });
      if (!rows.length) log('暂无历史采样数据');
    }).catch(function (err) { log('读取历史失败：' + err.message); });
  });

  els.clearHistory.addEventListener('click', function () {
    BenchDB.clear().then(function () { log('历史采样已清除'); })
      .catch(function (err) { log('清除失败：' + err.message); });
  });

  /* ---------- 启动 ---------- */
  log('能力检测：OffscreenCanvas=' + caps.offscreen + '，Worker=' + caps.worker +
    '，longtask=' + caps.longtask);
  if (caps.offscreen && caps.worker) {
    startWorkerMode();
  } else {
    showBanner('当前浏览器不支持 OffscreenCanvas/Worker，已降级到主线程绘制');
    startMainMode('降级原因：能力缺失');
  }
})();
