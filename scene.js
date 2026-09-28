/*
 * scene.js — 共享 2D 场景（粒子 + 实时图表 + 地图网格）。
 * 同时被主线程（<script>）与 Worker（importScripts）加载，
 * 保证「主线程绘制 vs 离屏绘制」跑的是完全相同的渲染负载。
 */
(function (global) {
  'use strict';

  function createScene(width, height, dpr, params) {
    const state = {
      width,
      height,
      dpr: dpr || 1,
      particleCount: params.particleCount || 3000,
      particles: [],
      chartData: [],
      chartMax: 240,
      pointer: { x: -1, y: -1, active: false },
      time: 0,
      markers: [],
    };

    function rand(min, max) {
      return min + Math.random() * (max - min);
    }

    function spawnParticle() {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(20, 160);
      return {
        x: rand(0, state.width),
        y: rand(0, state.height),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: rand(1, 3),
        hue: rand(0, 360),
      };
    }

    function syncParticles() {
      const target = state.particleCount;
      while (state.particles.length < target) state.particles.push(spawnParticle());
      if (state.particles.length > target) state.particles.length = target;
    }

    function spawnMarkers() {
      state.markers = [];
      for (let i = 0; i < 24; i++) {
        state.markers.push({
          x: rand(0, state.width),
          y: rand(0, state.height),
          phase: rand(0, Math.PI * 2),
        });
      }
    }

    syncParticles();
    spawnMarkers();

    return {
      resize(w, h, dpr) {
        state.width = w;
        state.height = h;
        state.dpr = dpr || state.dpr;
      },

      setParams(params) {
        if (typeof params.particleCount === 'number') {
          state.particleCount = params.particleCount;
          syncParticles();
        }
      },

      setPointer(pointer) {
        state.pointer = pointer;
      },

      update(dt) {
        state.time += dt;
        const { width, height, pointer } = state;

        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i];
          // 指针吸引，制造交互负载
          if (pointer.active && pointer.x >= 0) {
            const dx = pointer.x - p.x;
            const dy = pointer.y - p.y;
            const distSq = dx * dx + dy * dy + 100;
            const force = 40000 / distSq;
            p.vx += (dx / Math.sqrt(distSq)) * force * dt;
            p.vy += (dy / Math.sqrt(distSq)) * force * dt;
          }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.x < 0 || p.x > width) p.vx *= -1;
          if (p.y < 0 || p.y > height) p.vy *= -1;
          p.x = Math.max(0, Math.min(width, p.x));
          p.y = Math.max(0, Math.min(height, p.y));
        }

        // 图表数据流
        const t = state.time;
        state.chartData.push(
          50 + 30 * Math.sin(t * 1.7) + 15 * Math.sin(t * 4.3) + rand(-4, 4)
        );
        if (state.chartData.length > state.chartMax) state.chartData.shift();
      },

      draw(ctx) {
        const { width, height } = state;
        ctx.clearRect(0, 0, width, height);

        // ---- 地图网格层 ----
        ctx.strokeStyle = 'rgba(80, 120, 180, 0.25)';
        ctx.lineWidth = 1;
        const grid = 40;
        ctx.beginPath();
        for (let x = 0; x <= width; x += grid) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
        }
        for (let y = 0; y <= height; y += grid) {
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
        }
        ctx.stroke();

        // 地图标记（脉冲圆）
        for (const m of state.markers) {
          const pulse = 4 + 3 * Math.sin(state.time * 2 + m.phase);
          ctx.beginPath();
          ctx.arc(m.x, m.y, pulse, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 120, 80, 0.7)';
          ctx.fill();
        }

        // ---- 粒子层 ----
        for (let i = 0; i < state.particles.length; i++) {
          const p = state.particles[i];
          ctx.fillStyle = 'hsla(' + p.hue + ', 80%, 60%, 0.8)';
          ctx.fillRect(p.x, p.y, p.r, p.r);
        }

        // ---- 实时图表层（底部） ----
        const chartH = Math.min(140, height * 0.25);
        const chartY = height - chartH;
        ctx.fillStyle = 'rgba(10, 16, 28, 0.75)';
        ctx.fillRect(0, chartY, width, chartH);
        ctx.beginPath();
        const step = width / (state.chartMax - 1);
        for (let i = 0; i < state.chartData.length; i++) {
          const v = state.chartData[i];
          const x = i * step;
          const y = chartY + chartH - (v / 100) * chartH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // ---- 指针高亮 ----
        if (state.pointer.active && state.pointer.x >= 0) {
          ctx.beginPath();
          ctx.arc(state.pointer.x, state.pointer.y, 24, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.stroke();
        }
      },
    };
  }

  global.SceneEngine = { createScene };
})(typeof self !== 'undefined' ? self : this);
