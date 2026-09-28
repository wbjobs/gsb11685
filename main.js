/*
 * main.js — 主线程控制器。
 * 职责：模式切换（主线程绘制 / OffscreenCanvas Worker 离屏绘制）、
 * 能力检测与降级、Worker 失败提示、上下文丢失恢复、绘制指令同步、
 * PerformanceObserver 响应性采集、IndexedDB 帧率样本落盘。
 */
(function () {
  'use strict';

  // ---------- DOM ----------
  const stage = document.getElementById('stage');
  const els = {
    modeMain: document.getElementById('mode-main'),
    modeWorker: document.getElementById('mode-worker'),
    particles: document.getElementById('particles'),
    particlesLabel: document.getElementById('particles-label'),
    blockBtn: document.getElementById('block-btn'),
    ctxLossBtn: document.getElementById('ctxloss-btn'),
    clearDataBtn: document.getElementById('clear-data-btn'),
    fps: document.getElementById('stat-fps'),
    frameTime: document.getElementById('stat-frametime'),
    longtasks: document.getElementById('stat-longtasks'),
    latency: document.getElementById('stat-latency'),
    modeLabel: document.getElementById('stat-mode'),
    summary: document.getElementById('summary'),
    log: document.getElementById('log'),
    banner: document.getElementById('banner'),
  };

  // ---------- 全局状态 ----------
  const state = {
    mode: 'main', // 'main' | 'worker'
    canvas: null,
    worker: null,
    workerReady: false,
    mainCtx: null,
    scene: null,
    running: false,
    params: { particleCount: 3000 },
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    pointer: { x: -1, y: -1, active: false },
    // 统计
    frameCount: 0,
    frameTimeSum: 0,
    statWindowStart: 0,
    lastFrameTime: 0,
    currentFps: 0,
    currentFrameTime: 0,
    longtaskCount: 0,
    lastInputLatency: 0,
    pendingInputTs: 0,
    lastSampleSave: 0,
    generation: 0,
  };

  const offscreenSupported =
    typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype;

  // ---------- 日志 / 提示 ----------
  function log(message, level) {
    const line = document.createElement('div');
    line.className = 'log-line ' + (level || 'info');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    els.log.prepend(line);
    while (els.log.children.length > 60) els.log.lastChild.remove();
  }

  function showBanner(message, kind) {
    els.banner.textContent = message;
    els.banner.className = 'banner show ' + (kind || 'warn');
  }

  function hideBanner() {
    els.banner.className = 'banner';
  }

  // ---------- PerformanceObserver：长任务（主线程响应性指标） ----------
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longtaskCount++;
          els.longtasks.textContent = String(state.longtaskCount);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (err) {
      log('PerformanceObserver(longtask) 不可用: ' + err.message, 'warn');
    }
  }

  // ---------- 画布管理 ----------
  function createCanvas() {
    if (state.canvas) state.canvas.remove();
    const canvas = document.createElement('canvas');
    canvas.id = 'stage-canvas';
    const rect = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    stage.appendChild(canvas);
    state.canvas = canvas;
    return canvas;
  }

  function canvasCssSize() {
    const rect = stage.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  // ---------- 主线程渲染 ----------
  function startMainLoop() {
    state.generation++;
    stopWorker();
    const canvas = createCanvas();
    state.mainCtx = canvas.getContext('2d', { alpha: false });
    if (!state.mainCtx) {
      showBanner('主线程 2D 上下文创建失败', 'error');
      return;
    }
    state.mainCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    const size = canvasCssSize();
    state.scene = SceneEngine.createScene(size.width, size.height, state.dpr, state.params);
    state.running = true;
    state.mode = 'main';
    state.statWindowStart = performance.now();
    state.lastFrameTime = state.statWindowStart;
    state.frameCount = 0;
    state.frameTimeSum = 0;
    recordFrame._prev = state.statWindowStart;
    requestAnimationFrame(mainFrame);
    updateModeUI();
    log('已切换到【主线程绘制】');
  }

  function mainFrame(now) {
    if (!state.running || state.mode !== 'main') return;
    const dt = Math.min((now - state.lastFrameTime) / 1000, 0.1);
    state.lastFrameTime = now;

    state.scene.setPointer(state.pointer);
    state.scene.update(dt);
    state.scene.draw(state.mainCtx);

    recordFrame(now);
    requestAnimationFrame(mainFrame);
  }

  // ---------- Worker 离屏渲染 ----------
  function startWorkerLoop() {
    state.generation++;
    const generation = state.generation;
    state.running = false; // 停掉可能存在的主线程循环

    if (!offscreenSupported) {
      showBanner('当前浏览器不支持 OffscreenCanvas，已降级为主线程绘制', 'warn');
      log('OffscreenCanvas 不可用，降级主线程绘制', 'warn');
      startMainLoop();
      return;
    }

    const canvas = createCanvas();
    let offscreen;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch (err) {
      // 控制权转移失败（如重复转移）→ 降级
      showBanner('画布控制权转移失败：' + err.message + '，已降级为主线程绘制', 'error');
      log('transferControlToOffscreen 失败: ' + err.message, 'error');
      startMainLoop();
      return;
    }

    let worker;
    try {
      worker = new Worker('render-worker.js');
    } catch (err) {
      showBanner('Worker 创建失败：' + err.message + '，已降级为主线程绘制', 'error');
      log('Worker 创建失败: ' + err.message, 'error');
      startMainLoop();
      return;
    }

    state.worker = worker;
    state.workerReady = false;
    state.mode = 'worker';
    state.frameCount = 0;
    state.frameTimeSum = 0;
    state.statWindowStart = performance.now();
    updateModeUI();

    // init 超时保护：Worker 加载失败（如 file:// 协议、脚本错误）时给出提示并降级
    const initTimeout = setTimeout(() => {
      if (!state.workerReady && generation === state.generation) {
        showBanner('Worker 初始化超时（请通过 http(s) 访问页面，而非 file://），已降级为主线程绘制', 'error');
        log('Worker 初始化超时，降级主线程绘制', 'error');
        startMainLoop();
      }
    }, 3000);

    worker.onerror = (event) => {
      if (generation !== state.generation) return;
      clearTimeout(initTimeout);
      showBanner('Worker 运行错误：' + (event.message || '未知错误') + '，已降级为主线程绘制', 'error');
      log('Worker onerror: ' + (event.message || event.type), 'error');
      startMainLoop();
    };

    worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          clearTimeout(initTimeout);
          state.workerReady = true;
          hideBanner();
          log('Worker 就绪，已切换到【离屏绘制（OffscreenCanvas + Worker）】');
          break;
        case 'fps':
          state.currentFps = msg.fps;
          state.currentFrameTime = msg.frameTime;
          els.fps.textContent = msg.fps.toFixed(1);
          els.frameTime.textContent = msg.frameTime.toFixed(2) + ' ms';
          maybeSaveSample();
          break;
        case 'context-lost':
          log('Worker 报告上下文丢失，开始恢复…', 'warn');
          recoverFromContextLoss();
          break;
        case 'init-fail':
        case 'error':
          showBanner('Worker 渲染失败：' + msg.message + '，已降级为主线程绘制', 'error');
          log('Worker 渲染失败: ' + msg.message, 'error');
          startMainLoop();
          break;
      }
    };

    const size = canvasCssSize();
    worker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        width: size.width,
        height: size.height,
        dpr: state.dpr,
        params: state.params,
      },
      [offscreen] // 转移画布控制权（Transferable）
    );
    log('画布控制权已转移给 Worker（transferControlToOffscreen）');
  }

  function stopWorker() {
    if (state.worker) {
      state.worker.postMessage({ type: 'stop' });
      state.worker.terminate();
      state.worker = null;
      state.workerReady = false;
    }
  }

  // ---------- 上下文丢失恢复 ----------
  function recoverFromContextLoss() {
    showBanner('检测到上下文丢失，正在自动恢复…', 'warn');
    const wasWorker = state.mode === 'worker';
    state.running = false; // 立即停止主线程渲染循环，避免对已丢失的上下文绘制
    // 重建画布节点 + 重建渲染管线（Worker 模式重新转移控制权）
    setTimeout(() => {
      if (wasWorker) {
        stopWorker();
        startWorkerLoop();
      } else {
        startMainLoop();
      }
      log('上下文已恢复（模式：' + (wasWorker ? '离屏' : '主线程') + '）');
      hideBanner();
    }, 300);
  }

  // ---------- 帧统计（主线程模式本地统计；Worker 模式由 Worker 上报） ----------
  function recordFrame(now) {
    state.frameCount++;
    state.frameTimeSum += now - (recordFrame._prev || now);
    recordFrame._prev = now;
    if (now - state.statWindowStart >= 1000) {
      state.currentFps = Math.round((state.frameCount * 1000) / (now - state.statWindowStart) * 10) / 10;
      state.currentFrameTime = Math.round((state.frameTimeSum / state.frameCount) * 100) / 100;
      els.fps.textContent = state.currentFps.toFixed(1);
      els.frameTime.textContent = state.currentFrameTime.toFixed(2) + ' ms';
      state.frameCount = 0;
      state.frameTimeSum = 0;
      state.statWindowStart = now;
      maybeSaveSample();
    }
  }

  // 输入延迟：pointerdown 到下一帧绘制完成的耗时（响应性指标）
  function measureInputLatency() {
    if (!state.pendingInputTs) return;
    requestAnimationFrame(() => {
      state.lastInputLatency = performance.now() - state.pendingInputTs;
      els.latency.textContent = state.lastInputLatency.toFixed(1) + ' ms';
      state.pendingInputTs = 0;
    });
  }

  // ---------- IndexedDB 样本 ----------
  async function maybeSaveSample() {
    const now = Date.now();
    if (now - state.lastSampleSave < 2000 || !state.currentFps) return;
    state.lastSampleSave = now;
    try {
      await BenchDB.saveSample({
        mode: state.mode,
        fps: state.currentFps,
        frameTime: state.currentFrameTime,
        longtasks: state.longtaskCount,
      });
      refreshSummary();
    } catch (err) {
      log('IndexedDB 写入失败: ' + err.message, 'warn');
    }
  }

  async function refreshSummary() {
    try {
      const summary = await BenchDB.summary();
      const main = summary.main;
      const worker = summary.worker;
      els.summary.innerHTML =
        '<div>主线程绘制：' + (main ? main.avgFps + ' FPS / ' + main.avgFrameTime + ' ms（' + main.count + ' 样本）' : '暂无数据') + '</div>' +
        '<div>离屏绘制：' + (worker ? worker.avgFps + ' FPS / ' + worker.avgFrameTime + ' ms（' + worker.count + ' 样本）' : '暂无数据') + '</div>' +
        (main && worker
          ? '<div class="highlight">离屏提升：' + Math.round(((worker.avgFps - main.avgFps) / main.avgFps) * 100) + '% FPS</div>'
          : '');
    } catch (err) {
      els.summary.textContent = '统计数据读取失败：' + err.message;
    }
  }

  // ---------- UI ----------
  function updateModeUI() {
    els.modeMain.classList.toggle('active', state.mode === 'main');
    els.modeWorker.classList.toggle('active', state.mode === 'worker');
    els.modeLabel.textContent = state.mode === 'worker' ? '离屏（Worker）' : '主线程';
  }

  function bindEvents() {
    els.modeMain.addEventListener('click', () => startMainLoop());
    els.modeWorker.addEventListener('click', () => startWorkerLoop());

    els.particles.addEventListener('input', () => {
      state.params.particleCount = Number(els.particles.value);
      els.particlesLabel.textContent = els.particles.value;
      // 绘制指令同步：主线程模式直接改，Worker 模式转发指令
      if (state.mode === 'worker' && state.worker) {
        state.worker.postMessage({ type: 'params', params: state.params });
      } else if (state.scene) {
        state.scene.setParams(state.params);
      }
    });

    els.blockBtn.addEventListener('click', () => {
      // 人为阻塞主线程 2s：离屏模式下画面应依旧流畅，主线程模式会卡死
      log('主线程阻塞 2000ms（观察两种模式的差异）', 'warn');
      const end = performance.now() + 2000;
      while (performance.now() < end) {
        Math.sqrt(Math.random());
      }
    });

    els.ctxLossBtn.addEventListener('click', () => {
      log('模拟上下文丢失…', 'warn');
      if (state.mode === 'worker' && state.worker) {
        state.worker.postMessage({ type: 'simulate-context-loss' });
      } else {
        state.mainCtx = null; // 主线程模式：直接丢弃上下文引用
        recoverFromContextLoss();
      }
    });

    els.clearDataBtn.addEventListener('click', async () => {
      await BenchDB.clear();
      refreshSummary();
      log('历史样本已清空');
    });

    // 指针交互 → 转发给渲染端（指令同步）
    stage.addEventListener('pointermove', (e) => {
      const rect = stage.getBoundingClientRect();
      state.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top, active: true };
      if (state.mode === 'worker' && state.worker) {
        state.worker.postMessage({ type: 'pointer', pointer: state.pointer });
      }
    });
    stage.addEventListener('pointerdown', (e) => {
      state.pendingInputTs = performance.now();
      measureInputLatency();
      const rect = stage.getBoundingClientRect();
      state.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top, active: true };
      if (state.mode === 'worker' && state.worker) {
        state.worker.postMessage({ type: 'pointer', pointer: state.pointer });
      }
    });
    stage.addEventListener('pointerleave', () => {
      state.pointer = { x: -1, y: -1, active: false };
      if (state.mode === 'worker' && state.worker) {
        state.worker.postMessage({ type: 'pointer', pointer: state.pointer });
      }
    });

    // 尺寸变化同步
    new ResizeObserver(() => {
      const size = canvasCssSize();
      if (state.canvas) {
        state.canvas.style.width = size.width + 'px';
        state.canvas.style.height = size.height + 'px';
      }
      if (state.mode === 'worker' && state.worker) {
        state.worker.postMessage({ type: 'resize', width: size.width, height: size.height, dpr: state.dpr });
      } else if (state.canvas && state.mainCtx) {
        state.canvas.width = Math.round(size.width * state.dpr);
        state.canvas.height = Math.round(size.height * state.dpr);
        state.mainCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        if (state.scene) state.scene.resize(size.width, size.height, state.dpr);
      }
    }).observe(stage);
  }

  // ---------- 启动 ----------
  function init() {
    bindEvents();
    refreshSummary();
    if (!offscreenSupported) {
      showBanner('当前浏览器不支持 OffscreenCanvas，仅可使用主线程绘制', 'warn');
      els.modeWorker.disabled = true;
    }
    if (typeof Worker === 'undefined') {
      showBanner('当前环境不支持 Web Worker，仅可使用主线程绘制', 'warn');
      els.modeWorker.disabled = true;
    }
    // 默认优先尝试离屏绘制，失败会自动降级
    startWorkerLoop();
  }

  init();
})();
