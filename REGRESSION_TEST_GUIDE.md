# AI Dashboard — Regression Test Guide

> 目标 / Goal: 每一次在上线新功能（feature / endpoint / UI change）之前，都要跑完这份清单，确保既有功能不被破坏。
> Every time you add a new feature, walk through this checklist to ensure nothing existing breaks.

---

## 为什么需要这份指南 · Why this matters

这次修复发现的 10 个 bug，核心根因只有一个：
**前端（dashboard.html）和后端（server.js）的数据契约 (data contract) 不同步。**

新版的 dashboard.html 期待 `/api/quick` 返回 `d.system.cpuPct`、`d.services[]`、`d.graphrag.entities`... 但 server.js 仍在返回旧的扁平结构。结果是 Overview / Services / GraphRAG / Memory / Logs / Skills 页面全部无数据显示。

> 一条规则：**跨端的修改必须先定义契约，再同时改两端，然后跑契约测试。**
> One rule: cross-layer changes must define the contract first, change both sides together, then run a contract test.

---

## Layer 0 — 准备工作 · Pre-flight (30 秒)

每次改代码前先跑一次基线，确保当前环境是健康的：

```bash
cd D:\AIAssist\dashboard\AI-Dashboard

# 1. 静态语法检查
node --check server.js

# 2. 契约 smoke test（存根 pm2/python/nvidia-smi）
node smoke_test.js
# 必须看到: "9 passed, 0 failed"
```

只要有任何一个失败，**先修复基线再开始开发**。不要在已破的代码上叠加新功能。

---

## Layer 1 — 开发中的回归测试 · During development

### 1.1 每次修改一个 endpoint 时

如果你 touch 了 `server.js` 里任何一个 `if (url === '/api/xxx')` 路由：

1. 先在 `smoke_test.js` 的 `CONTRACTS` 对象里**写下新契约**（即使是新 endpoint）。
2. 再写 / 改实现代码。
3. 跑 `node smoke_test.js`，确认：
   - 自己新写的 endpoint 通过契约。
   - **所有老 endpoints 仍然通过**（这是回归）。

### 1.2 每次修改 dashboard.html 的 JS 时

```bash
# 语法检查：在 Node 里 eval 页面里的 <script> 块
node -e "
const fs = require('fs');
const html = fs.readFileSync('dashboard.html', 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
new Function(m[1]);
console.log('DASHBOARD_JS_OK');
"

# DOM id 一致性检查：getElementById 引用的 id 是否都在 HTML 里存在
node -e "
const fs = require('fs');
const h = fs.readFileSync('dashboard.html', 'utf8');
const ref = new Set();
for (const m of h.matchAll(/getElementById\([\x27\x22]([^\x27\x22]+)[\x27\x22]\)/g)) ref.add(m[1]);
for (const m of h.matchAll(/setText\([\x27\x22]([^\x27\x22]+)[\x27\x22]/g)) ref.add(m[1]);
const dec = new Set();
for (const m of h.matchAll(/\sid=[\x27\x22]([^\x27\x22]+)[\x27\x22]/g)) dec.add(m[1]);
const missing = [...ref].filter(id => !dec.has(id));
console.log(missing.length ? 'MISSING_IDS: ' + missing.join(', ') : 'DOM_OK');
"
```

### 1.3 每次改变 API 的返回结构

**一定要同时改两端**，而且：
- `server.js` 返回的 key 是否与 `dashboard.html` 读的 key **完全一致**。
- 值的类型是否一致（字符串 vs 布尔 vs 数字）。本次发现的典型坑：
  - `setDot('wa', d.whatsapp === 'online')` —— 服务端返回 `true`（布尔）而非 `'online'`（字符串），永远不匹配。
  - `p.memory/1024/1024` —— 服务端已经格式化为 `"45.2"` MB 字符串，前端不要再除。
- 如果想保持向后兼容，可以同时返回新旧两种字段（例如 `memory` 字符串 + `memoryMB` 数字），让前端择优使用。

---

## Layer 2 — 上线前的完整回归 · Pre-deploy checklist

> 在 `pm2 restart ai-dashboard` 之前，按顺序跑完：

### 2.1 代码级（离线，~10s）

```bash
node --check server.js                        # server 语法
node smoke_test.js                            # 9 个 endpoint 契约
# 如果有其他 *.js，也跑 node --check
```

### 2.2 启动级（本地真实启动）

```bash
# 用临时端口启动，不干扰生产
PORT=7799 node server.js &
SERVER_PID=$!
sleep 3

# 核心 endpoint smoke
for path in /api/status /api/quick /api/services /api/graphrag/stats /api/skills /api/memory/milestones; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:7799${path}")
  echo "$path -> $code"
done

kill $SERVER_PID
```

### 2.3 UI 级（浏览器手工，~2 分钟）

把生产切换到新代码前，在浏览器打开 `http://localhost:7788/dashboard`，**按顺序点击每个 Tab**，确认：

| # | Tab | 必须看到 | 不应出现 |
|---|-----|---------|---------|
| 1 | **Overview** | CPU/RAM/Uptime 有数字；Services 一列有条目；AI Processes 表有行 | 所有数值都是 "—" 或 "Loading…" |
| 2 | **Services** | 6 个服务卡片 | "Failed to load" 错误 |
| 3 | **Graph RAG** | Entities/Relations/Documents/Chunks 统计；Subject Distribution 列表 | 全是 "—" |
| 4 | **Memory** | Milestones 有时间线条目 | "Failed: undefined" |
| 5 | **Architecture** | 三个 SVG 切图都能渲染 | 空白 |
| 6 | **Skills & Stack** | Skills grid + Tech Stack 两块 | "No skills data" |
| 7 | **Logs** | 下拉选 process → 有日志行 | 永远 "Loading…" |

并打开浏览器 DevTools → Console，**不应该有红色报错**。

### 2.4 交互级（破坏性操作）

- Services 页 → 点 "Restart" 一个非关键服务（例如 `wechat-bridge`）→ 卡片状态应该在 2-3s 后刷新。
- Graph RAG → 粘贴一小段文字 + Ingest → 应看到 "Done: N chunks" 绿色提示。

---

## Layer 3 — 上线后的冒烟 · Post-deploy smoke

```bash
pm2 restart ai-dashboard
sleep 5
curl -s http://127.0.0.1:7788/api/quick | jq .system
# 应该看到 { "cpuPct": 12, "ramPct": 48, ... }  真实值
```

再次打开 dashboard，只验证 **Overview** 页有真实数字。5 秒内看到数据即算通过。

---

## 契约测试是怎么工作的 · How the smoke test works

`smoke_test.js` 做了三件事：

1. **桩 (stub) 掉 `child_process.exec`**：这样即使没装 pm2、python、nvidia-smi、lms，服务器的 poll() 也会走错误分支但不崩溃。
2. **在 127.0.0.1:7788 真实启动 server**，发 HTTP 请求，和生产一样。
3. **对返回 JSON 做 shape 断言**：遍历 `CONTRACTS` 对象里声明的 key 是否全部存在。

**添加新 endpoint 的流程**：

```js
// 在 smoke_test.js 的 CONTRACTS 里加一条
'/api/new-endpoint': {
  must: ['expectedKey1', 'expectedKey2'],
},
```

再跑 `node smoke_test.js`。**先写契约，再写实现**，就不会再出现本次这种"前端读 `d.stats.entities` 但后端只返回 `d.entities`"的事故。

---

## 本次修复涉及的 10 个 bug（附录，便于以后比对）

| # | 位置 | 症状 | 根因 |
|---|------|------|------|
| 1 | `/api/quick` | Overview 数值全空 | 服务端返回 `{cpu, ram, uptime}`，前端读 `d.system.cpuPct` 等 |
| 2 | `/api/services` | Services 页 "Failed to load" | 服务端返回数组，前端读 `d.services.map()` |
| 3 | `/api/graphrag/stats` | Graph RAG 统计空 | 服务端返回 `{entities}`，前端读 `s.stats.entities` |
| 4 | `/api/memory/search` | 搜索无响应 | 服务端只接受 POST + body，前端发 GET + `?q=` |
| 5 | `/api/memory/milestones` | Milestones 空 | 服务端返回 `{text, date, label}`，前端读 `m.content, m.created_at` |
| 6 | PM2 表格 | 内存/运行时间显示异常 | 服务端返回格式化字符串 `"45.2"` MB，前端再除 1024² |
| 7 | `/api/logs` | 日志空 | 前端传 `?process=`，服务端只认 `?name=` |
| 8 | `/api/skills` | Skills 页空 | endpoint 根本不存在 |
| 9 | `/api/graphrag/ingest-url` | 500 错误 | `require('axios')` 但 `axios` 不在 package.json |
| 10 | 状态小圆点 | 永远红色 | 服务端返回 `true`，前端比较 `=== 'online'` |

**10 个 bug、1 个根因：前后端契约漂移。** 这份文档存在的意义就是让契约漂移在合并前就被发现。

---

## 一句话总结 · TL;DR

> **改 server.js？先更新 `smoke_test.js` 的契约。改 dashboard.html？手动过一遍 7 个 Tab。两边都改？两件事都做，外加一次 `node smoke_test.js`。**
