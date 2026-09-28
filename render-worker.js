/*
 * render-worker.js — 离屏渲染 Worker。
 * 接收主线程通过 transferControlToOffscreen 转移过来的画布控制权，
 * 在 Worker 内独立运行渲染循环；主线程只负责转发交互/参数（指令同步）。
 */
importScripts('scene.js');

let canvas = null;
let ctx = null;
let scene = null;
let running = false;
let rafHandle = null;
let lastTime = 0;

// FPS 统计
let frameCount = 0;
let statWindowStart = 0;
let frameTimeSum = 0;

// 某些环境 Worker 内没有 requestAnimationFrame，用 setTimeout 兜底
const raf =
  typeof self.requestAnimationFrame === 'function'
    ? self.requestAnimationFrame.bind(self)
    : (cb) => setTimeout(() => cb(performance.now()), 16);

function frame(now) {
  if (!running) return;

  // 上下文丢失防御：ctx 被置空（真实丢失或模拟丢失）时停止并上报
  if (!ctx) {
    running = false;
    self.postMessage({ type: 'context-lost' });
    return;
  }

  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  try {
    scene.update(dt);
    scene.draw(ctx);
  } catch (err) {
    running = false;
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
    return;
  }

  // 帧率统计：每秒上报一次
  frameCount++;
  frameTimeSum += now - (frame._prev || now);
  frame._prev = now;
  if (now - statWindowStart >= 1000) {
    const fps = (frameCount * 1000) / (now - statWindowStart);
    const avgFrameTime = frameTimeSum / frameCount;
    self.postMessage({
      type: 'fps',
      fps: Math.round(fps * 10) / 10,
      frameTime: Math.round(avgFrameTime * 100) / 100,
    });
    frameCount = 0;
    frameTimeSum = 0;
    statWindowStart = now;
  }

  rafHandle = raf(frame);
}

self.onmessage = function (e) {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      canvas = msg.canvas;
      try {
        ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      } catch (err) {
        self.postMessage({ type: 'init-fail', message: 'getContext 失败: ' + err.message });
        return;
      }
      if (!ctx) {
        self.postMessage({ type: 'init-fail', message: 'OffscreenCanvas 2D 上下文不可用' });
        return;
      }
      scene = SceneEngine.createScene(msg.width, msg.height, msg.dpr, msg.params || {});
      running = true;
      lastTime = performance.now();
      statWindowStart = lastTime;
      frameCount = 0;
      frameTimeSum = 0;
      frame._prev = lastTime;
      rafHandle = raf(frame);
      self.postMessage({ type: 'ready' });
      break;
    }

    case 'resize':
      if (canvas && scene && ctx) {
        canvas.width = msg.width * msg.dpr;
        canvas.height = msg.height * msg.dpr;
        ctx.setTransform(msg.dpr, 0, 0, msg.dpr, 0, 0);
        scene.resize(msg.width, msg.height, msg.dpr);
      }
      break;

    // 绘制指令同步：参数与交互都由主线程转发
    case 'params':
      if (scene) scene.setParams(msg.params);
      break;

    case 'pointer':
      if (scene) scene.setPointer(msg.pointer);
      break;

    // 模拟上下文丢失：丢弃当前上下文并上报，验证主线程恢复链路
    case 'simulate-context-loss':
      ctx = null;
      break;

    case 'stop':
      running = false;
      break;
  }
};
