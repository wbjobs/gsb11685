# Canvas 离屏绘制 vs 主线程绘制对比

复杂 2D 场景（粒子 + 实时图表 + 地图网格）在 **主线程** 与 **OffscreenCanvas + Web Worker** 两种模式下渲染，量化对比帧率与主线程响应性。

## 运行

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 必须通过 http(s) 访问。file:// 协议下 Worker 无法加载——这本身可用于验证「Worker 创建失败 → 提示 + 降级」链路。

## 技术栈

Canvas 2D · OffscreenCanvas · Web Worker · PerformanceObserver(longtask) · IndexedDB

## 文件

| 文件 | 职责 |
| --- | --- |
| `scene.js` | 共享场景（粒子/图表/地图），主线程与 Worker 复用同一份渲染负载 |
| `render-worker.js` | Worker 内离屏渲染循环，每秒上报 FPS |
| `main.js` | 模式切换、能力检测、降级、上下文恢复、指令同步、性能采集 |
| `db.js` | IndexedDB 帧率样本持久化与聚合 |
| `index.html` / `styles.css` | 页面与样式 |

## 验收标准对照

| 验收项 | 实现 |
| --- | --- |
| 离屏绘制正确 | `transferControlToOffscreen` 转移控制权，Worker 内独立 rAF 渲染同一场景 |
| 帧率对照可量化 | 两种模式 FPS/帧耗时实时显示，样本写入 IndexedDB 并给出历史均值与提升百分比 |
| 控制权转移正确 | `postMessage(..., [offscreen])` Transferable 转移；重复转移异常被捕获并降级 |
| 上下文丢失可恢复 | 「模拟上下文丢失」按钮触发，Worker 上报 → 主线程重建画布与渲染管线自动恢复 |
| 不支持时降级 | 无 OffscreenCanvas / 无 Worker 时 banner 提示并自动切主线程绘制 |
| Worker 创建失败有提示 | `new Worker` try/catch + `onerror` + 3s init 超时，均提示并降级 |
| 绘制指令同步正确 | 粒子数量、指针交互、尺寸变化均通过 `postMessage` 转发到 Worker |

## 验证建议

1. 默认进入即为离屏模式，日志显示「Worker 就绪」。
2. 点「阻塞主线程 2s」：离屏模式画面依旧流畅、长任务计数 +1；切到主线程模式再点，画面卡死 2s——直观体现响应性差异。
3. 点「模拟上下文丢失」：banner 提示后自动恢复渲染。
4. 两种模式各运行约 30s，「历史帧率对比」面板给出量化结论。
5. 用 `file://` 直接打开 `index.html`：应出现 Worker 初始化超时提示并降级主线程绘制。
