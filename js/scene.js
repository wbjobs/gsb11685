/*
 * scene.js — 共享的 2D 场景定义（粒子 + 图表 + 热力地图）。
 * 同时被主线程（main 模式）和 Worker（offscreen 模式）加载，
 * 保证两种渲染路径绘制的是完全相同的场景，便于公平对比。
 */
(function (global) {
  'use strict';

  var DEFAULT_CONFIG = {
    particleCount: 2500,
    barCount: 48,
    gridCols: 48,
    gridRows: 28
  };

  function rand(min, max) { return min + Math.random() * (max - min); }

  function createState(width, height, config) {
    var state = {
      width: width,
      height: height,
      time: 0,
      config: Object.assign({}, DEFAULT_CONFIG, config || {}),
      pointer: { x: -9999, y: -9999, down: false },
      particles: [],
      bars: [],
      grid: null
    };
    initParticles(state);
    initBars(state);
    initGrid(state);
    return state;
  }

  function initParticles(state) {
    state.particles.length = 0;
    for (var i = 0; i < state.config.particleCount; i++) {
      state.particles.push({
        x: rand(0, state.width),
        y: rand(0, state.height),
        vx: rand(-60, 60),
        vy: rand(-60, 60),
        hue: rand(0, 360),
        size: rand(1.5, 3.5)
      });
    }
  }

  function initBars(state) {
    state.bars.length = 0;
    for (var i = 0; i < state.config.barCount; i++) {
      state.bars.push({ phase: rand(0, Math.PI * 2), speed: rand(0.5, 2) });
    }
  }

  function initGrid(state) {
    var cols = state.config.gridCols;
    var rows = state.config.gridRows;
    var cells = new Float32Array(cols * rows);
    for (var i = 0; i < cells.length; i++) cells[i] = Math.random();
    state.grid = { cols: cols, rows: rows, cells: cells };
  }

  function applyConfig(state, config) {
    var rebuildParticles = config.particleCount !== undefined &&
      config.particleCount !== state.config.particleCount;
    var rebuildGrid = (config.gridCols !== undefined && config.gridCols !== state.config.gridCols) ||
      (config.gridRows !== undefined && config.gridRows !== state.config.gridRows);
    var rebuildBars = config.barCount !== undefined && config.barCount !== state.config.barCount;
    Object.assign(state.config, config);
    if (rebuildParticles) initParticles(state);
    if (rebuildGrid) initGrid(state);
    if (rebuildBars) initBars(state);
  }

  function resize(state, width, height) {
    state.width = width;
    state.height = height;
    for (var i = 0; i < state.particles.length; i++) {
      var p = state.particles[i];
      if (p.x > width) p.x = width;
      if (p.y > height) p.y = height;
    }
  }

  function update(state, dt) {
    state.time += dt;
    var w = state.width, h = state.height;
    var ptr = state.pointer;

    // 粒子：运动 + 边界反弹 + 指针吸引/排斥
    for (var i = 0; i < state.particles.length; i++) {
      var p = state.particles[i];
      var dx = ptr.x - p.x, dy = ptr.y - p.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < 22500 && d2 > 1) { // 150px 半径
        var d = Math.sqrt(d2);
        var force = (ptr.down ? -260 : 120) / d; // 按下=排斥，否则吸引
        p.vx += dx / d * force * dt * 60;
        p.vy += dy / d * force * dt * 60;
      }
      p.vx *= 0.995; p.vy *= 0.995;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 0) { p.x = 0; p.vx = -p.vx; } else if (p.x > w) { p.x = w; p.vx = -p.vx; }
      if (p.y < 0) { p.y = 0; p.vy = -p.vy; } else if (p.y > h) { p.y = h; p.vy = -p.vy; }
      p.hue = (p.hue + dt * 20) % 360;
    }

    // 热力地图：扩散 + 随机热源（每 4 帧更新一次，降低开销）
    var g = state.grid;
    if (g && (state._gridTick = (state._gridTick || 0) + 1) % 4 === 0) {
      var cells = g.cells, cols = g.cols, rows = g.rows;
      var next = new Float32Array(cells.length);
      for (var y = 0; y < rows; y++) {
        for (var x = 0; x < cols; x++) {
          var idx = y * cols + x;
          var sum = cells[idx], n = 1;
          if (x > 0) { sum += cells[idx - 1]; n++; }
          if (x < cols - 1) { sum += cells[idx + 1]; n++; }
          if (y > 0) { sum += cells[idx - cols]; n++; }
          if (y < rows - 1) { sum += cells[idx + cols]; n++; }
          next[idx] = sum / n * 0.995;
        }
      }
      for (var s = 0; s < 6; s++) {
        next[Math.floor(Math.random() * next.length)] = Math.random();
      }
      g.cells = next;
    }
  }

  function render(ctx, state) {
    var w = state.width, h = state.height;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    renderGrid(ctx, state);
    renderBars(ctx, state);
    renderParticles(ctx, state);
  }

  function renderGrid(ctx, state) {
    var g = state.grid;
    if (!g) return;
    var cw = state.width / g.cols;
    var ch = state.height / g.rows;
    for (var y = 0; y < g.rows; y++) {
      for (var x = 0; x < g.cols; x++) {
        var v = g.cells[y * g.cols + x];
        ctx.fillStyle = 'hsl(' + (220 - v * 180) + ',70%,' + (8 + v * 42) + '%)';
        ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5);
      }
    }
  }

  function renderBars(ctx, state) {
    var n = state.bars.length;
    var bw = state.width / n;
    var maxH = state.height * 0.22;
    for (var i = 0; i < n; i++) {
      var b = state.bars[i];
      var v = 0.5 + 0.5 * Math.sin(state.time * b.speed + b.phase);
      var bh = v * maxH;
      ctx.fillStyle = 'hsla(' + (160 + v * 80) + ',80%,55%,0.85)';
      ctx.fillRect(i * bw + 1, state.height - bh, bw - 2, bh);
    }
  }

  function renderParticles(ctx, state) {
    for (var i = 0; i < state.particles.length; i++) {
      var p = state.particles[i];
      ctx.fillStyle = 'hsl(' + p.hue + ',90%,60%)';
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  global.SceneShared = {
    createState: createState,
    applyConfig: applyConfig,
    resize: resize,
    update: update,
    render: render
  };
})(typeof self !== 'undefined' ? self : this);
