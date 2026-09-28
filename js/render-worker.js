/*
 * render-worker.js — 离屏渲染 Worker。
 * 接收 transferControlToOffscreen 转移过来的画布控制权，
 * 在 Worker 线程内完成场景模拟 + 绘制，主线程只负责交互。
 *
 * 指令同步协议：主线程每条指令带递增 seq，Worker 应用后记录 lastSeq，
 * 并通过 stats 消息回传，主线程据此确认"已发送/已应用"一致。
 */
importScripts('scene.js');

var canvas = null;
var ctx = null;
var state = null;
var running = false;
var lastTime = 0;
var lastSeq = 0;
var dpr = 1;

var raf = typeof requestAnimationFrame === 'function'
  ? requestAnimationFrame.bind(self)
  : function (cb) { return setTimeout(function () { cb(performance.now()); }, 16); };

self.onmessage = function (e) {
  var msg = e.data;
  try {
    switch (msg.type) {
      case 'init': handleInit(msg); break;
      case 'resize': handleResize(msg); break;
      case 'config':
        if (state) SceneShared.applyConfig(state, msg.config);
        ack(msg.seq);
        break;
      case 'pointer':
        if (state) {
          state.pointer.x = msg.x * dpr;
          state.pointer.y = msg.y * dpr;
          state.pointer.down = !!msg.down;
        }
        ack(msg.seq);
        break;
      case 'context-restored': // 主线程通知（备用路径）
        reacquireContext();
        break;
      case 'stop':
        running = false;
        break;
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

function ack(seq) {
  if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq;
}

function handleInit(msg) {
  canvas = msg.canvas;
  dpr = msg.dpr || 1;
  ctx = canvas.getContext('2d');
  if (!ctx) {
    postMessage({ type: 'error', message: 'Worker 内无法获取 2D 上下文' });
    return;
  }
  attachContextLossHandlers();
  state = SceneShared.createState(msg.width, msg.height, msg.config);
  running = true;
  lastTime = performance.now();
  postMessage({ type: 'ready' });
  loop();
}

function handleResize(msg) {
  if (!canvas || !state) return;
  dpr = msg.dpr || dpr;
  canvas.width = msg.width;
  canvas.height = msg.height;
  SceneShared.resize(state, msg.width, msg.height);
  ack(msg.seq);
}

/* ---- 上下文丢失 / 恢复 ---- */
function attachContextLossHandlers() {
  if (!ctx || typeof ctx.addEventListener !== 'function') return; // 老内核无此事件
  ctx.addEventListener('contextlost', function (e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault(); // 允许自动恢复
    running = false;
    postMessage({ type: 'contextlost' });
  });
  ctx.addEventListener('contextrestored', function () {
    reacquireContext();
    postMessage({ type: 'contextrestored' });
  });
}

function reacquireContext() {
  if (!canvas) return;
  var fresh = canvas.getContext('2d');
  if (fresh) {
    ctx = fresh;
    attachContextLossHandlers();
    if (state) SceneShared.render(ctx, state);
    if (!running) { running = true; lastTime = performance.now(); loop(); }
  }
}

/* ---- 渲染循环 + 帧率统计 ---- */
var frames = 0;
var statStart = 0;
var frameCost = 0;

function loop() {
  if (!running) return;
  raf(loop);
  var now = performance.now();
  var dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  var t0 = performance.now();
  SceneShared.update(state, dt);
  SceneShared.render(ctx, state);
  frameCost += performance.now() - t0;

  frames++;
  if (statStart === 0) statStart = now;
  var elapsed = now - statStart;
  if (elapsed >= 500) {
    postMessage({
      type: 'stats',
      fps: Math.round(frames * 1000 / elapsed),
      frameMs: +(frameCost / frames).toFixed(2),
      lastSeq: lastSeq
    });
    frames = 0;
    frameCost = 0;
    statStart = now;
  }
}
