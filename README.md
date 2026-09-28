# Canvas 离屏渲染 vs 主线程渲染对比

复杂 2D 场景（粒子 + 动态图表 + 热力地图）在两种渲染路径下的帧率与响应性对照实验。

## 运行

Worker 与 IndexedDB 需要 HTTP 环境（`file://` 下 Worker 会被拦截）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 技术栈

Canvas 2D · OffscreenCanvas（`transferControlToOffscreen`）· Web Worker ·
PerformanceObserver（`longtask`）· IndexedDB（采样持久化）

## 架构

- `js/scene.js` — 共享场景（粒子/图表/热力地图），主线程与 Worker 加载同一份代码，保证对比公平
- `js/render-worker.js` — 离屏渲染 Worker：接收画布控制权，独立模拟 + 绘制 + 上报帧率
- `js/main.js` — 主线程编排：模式切换、能力检测、降级、上下文丢失恢复、指令同步、指标采集
- `js/db.js` — IndexedDB 封装，每秒持久化 `{mode, renderFps, mainFps, frameMs, longtasks, tbt}`

## 验收标准对照

| 验收项 | 实现 |
| --- | --- |
| 离屏绘制正确 | Worker 与主线程共用 `scene.js`，画面一致；Worker 内 rAF 循环渲染 |
| 帧率对照可量化 | 侧栏实时显示渲染帧率/主线程帧率/单帧耗时；IndexedDB 持久化，可统计历史均值 |
| 控制权转移正确 | 每次切换重建画布后再 `transferControlToOffscreen`，try/catch 兜底并降级 |
| 上下文丢失可恢复 | 两侧监听 `contextlost/contextrestored`，`preventDefault` 后重取上下文恢复渲染；可按钮模拟 |
| 不支持时有降级 | 启动检测 OffscreenCanvas/Worker，缺失则提示并自动切主线程绘制 |
| Worker 创建失败有提示 | 构造 try/catch + `onerror` + 3s 就绪超时；勾选"模拟 Worker 创建失败"可复现 |
| 绘制指令同步正确 | 指令带递增 seq，Worker 应用后回传 lastSeq，面板显示"已发送/已确认" |

## 交互说明

- 移动指针吸引粒子，按住排斥；调节粒子数滑杆改变负载
- 「阻塞主线程 300ms」：主线程模式下渲染卡顿、离屏模式下画面依旧流畅（仅交互短暂延迟）
- 「统计历史均值」：从 IndexedDB 聚合两种模式的平均帧率与 TBT，输出到日志
