# 直播诊断卡 · POLYV 1024 Hackathon 参赛作品

> 讲师在浏览器里推流，观众在观看页实时观看；**开播前预检拦截、出问题给一条结论 + 一个下一步、事后可导出证据**。

演示视频：POLYV 频道 8636539（录屏 2 分 20 秒，含中文配音）。
本仓库为参赛作品源码（Vue3 + NestJS monorepo）。

---

## 一、它解决什么问题

网页开播最常见的失败反馈是一句「老师网络不好」——讲师不知道该点哪里，运营拿不到客观数据。
本项目把**诊断能力**做进推流链路：

| 能力 | 做法 |
| --- | --- |
| 开播前拦截 | 载入频道即预检：推流模板、采集设备、推流地址有效期、服务端到 Polyv 的连通性 |
| 一次一条结论 | 7 条诊断规则按优先级收敛，只展示最高优先级的一条：**原因 + 一个可点击的下一步** |
| 一键修复 | 重新检测摄像头 / 换麦克风 / 自动重连 / 降低分辨率，修复中不重入、失败回到同一结论 |
| 证据留痕 | 每次诊断 > 服务端内存留痕（每频道 50 条）；推流中每 5 秒采一次码率/帧率/连接态（每频道 300 条），可导出 CSV |
| 观众侧自检 | 连不上服务器 / 播放器出错 / 黑屏 / 画面卡住，直接告诉观众该做什么 |
| AI 归因（可选） | 把诊断历史 + 码率序列 + 设备信息交给 LLM，输出因果解释与 3 步建议；**只是建议层**，结论仍由规则给出 |

### 诊断规则（一期 7 条，优先级从高到低）

| 编号 | 结论 | 触发条件（阈值见 `packages/shared/src/diagnostics.ts`） |
| --- | --- | --- |
| D2 | 频道不是纯视频模板 | 服务端返回模板不匹配 |
| D1 | 推流地址即将/已经过期 | 剩余有效期 < 3 分钟 |
| D3 | 连不上推流服务器 | 推流连接失败 / 网络探测失败 |
| D9 | 摄像头没有画面 | 黑屏 3 秒（亮度 < 8/255）或采集失败 |
| D6 | 编码器无输出 | fps = 0 连续 5 秒 |
| D7 | 没有检测到麦克风声音 | RMS < −60 dBFS 连续 8 秒 |
| D5 | 上行带宽不足 | 码率连续 5 秒 < max(150 kbps, 峰值 40%) |

另有 advisory（不抢硬结论）：码率掉到基线 60%–100% 连续 5 秒 → 「网络波动，可能会断流」。

---

## 二、用到的 POLYV SDK 与开放 API

> 说明：本作品是**全新项目**，没有修改任何 Polyv 非开源仓库代码，全部基于公开 SDK / 开放接口开发。

### 1. 推流（讲师端）

| 项 | 用法 |
| --- | --- |
| SDK | 腾讯云公开 Web 推流 SDK `TXLivePusher-2.1.1`（`apps/pusher/src/transports/tx-live-pusher.ts` 动态加载） |
| 协议 | 浏览器 WebRTC 直推（`webrtc://` 推流地址） |
| 推流地址 | **由服务端向 Polyv 申请并签名后下发**，浏览器永远拿不到 `appSecret` |

### 2. Polyv 开放 API（服务端调用，`apps/server`）

| 接口 | 用途 |
| --- | --- |
| `GET /live/v4/channel/basic/get` | 取频道信息：模板（纯视频/云课堂）、名称、状态 |
| `GET /live/v3/channel/stream/get-push-url` | 取推流地址（含有效期），前端据此推流 |
| `POST /live/v4/channel/create-init` | 创建频道（含模板、视图方向） |
| `GET /live/v4/channel/live-status/list` | 查直播状态（用于观看页「直播中/已结束」判定） |
| `POST /live/v4/channel/update-template` | 改频道模板（本作品只读校验，未在运行时调用） |

签名：`MD5(appSecret + 参数按 key 升序拼接的 k+v + appSecret)` 大写（`apps/server/src/polyv/sign.ts`，含固定向量单测）。

### 3. 观看（观众端）

| 项 | 用法 |
| --- | --- |
| SDK | 公开 npm 包 `@polyv/live-watch-sdk@2.20.0`（`apps/watch`） |
| 能力 | 拉流播放、直播状态、播放器事件（用于观众侧自检条的「画面卡住 / 黑屏 / 出错」判定） |
| 前置 | 需在 Polyv 后台为该频道配置观看域名白名单 |

### 4. 自建服务端（不属于 Polyv 侧改动）

| 接口 | 用途 |
| --- | --- |
| `POST /api/channels/:id/diagnostics`、`GET` | 诊断留痕（每频道 50 条环形） |
| `POST /api/channels/:id/metrics`、`GET` | 指标时间序列（每频道 300 条环形，5 秒一采） |
| `GET /api/health` | 服务端探测 Polyv 上游可达性（前端预检用；上游网络层失败返回 503） |
| `POST /api/channels/:id/analyze` | AI 归因（可选，见下） |

---

## 三、AI 归因（可选，默认不影响主流程）

- 输入：该频道最近诊断记录 + 最近 120 个指标采样（降采样）+ 设备快照 + 当前结论
- 输出：严格 JSON `{summary, cause, steps[≤3], confidence, evidence[]}`
- **不发送**：`appSecret`、画面内容、上游原始报文
- 兜底：无 key / 超时 25 秒 / 解析失败 → 走规则模板，响应里 `source: "rules"`，界面明确标注「规则建议」
- 模型通过环境变量配置（OpenAI 兼容协议），仓库内不含任何密钥

---

## 四、目录结构

```
apps/
  server/   NestJS：频道、推流地址签名下发、健康探测、诊断/指标留痕、AI 归因
  pusher/   Vue3 + Vite（5173）：讲师推流端（设备、预览、开播/停播、指标条、诊断卡）
  watch/    Vue3 + Vite（5174）：观看页（@polyv/live-watch-sdk + 观众侧自检条）
packages/
  shared/   共享类型与诊断契约（诊断项、阈值、优先级、文案）、设计 token
e2e/        Playwright 端到端（不出网，mock Polyv 接口）
```

---

## 五、快速开始

```bash
npm ci
cp .env.example .env     # 填入你的 POLYV_APP_ID / POLYV_APP_SECRET / POLYV_USER_ID
npm run dev              # server:3000 + pusher:5173 + watch:5174
```

- 讲师端 http://localhost:5173 → 填入频道号 → 「开始直播」
- 观看页 http://localhost:5174/?channelId=xxx

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `POLYV_APP_ID` / `POLYV_APP_SECRET` / `POLYV_USER_ID` | Polyv 账号凭证，**只在服务端进程内使用** |
| `POLYV_HEALTH_CHANNEL_ID` | 健康探测用频道号（可选） |
| `PORT` | 服务端端口（默认 3000） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | AI 归因（不填则自动走规则兜底） |

`.env` 已在 `.gitignore` 中，仓库不含任何真实密钥。

### 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 三个服务同时启动（热更新） |
| `npm run typecheck` | TypeScript / vue-tsc 全量类型检查 |
| `npm run lint` | ESLint |
| `npm run build` | server `nest build` + 两个前端 `vite build` |
| `npm test` | Vitest 单元测试（server / ui 两个 project） |
| `npm run test:e2e` | Playwright 端到端（自动起 dev server） |

---

## 六、质量现状

| 项 | 结果 |
| --- | --- |
| 类型检查 | 0 error |
| 单元测试 | 260 passed |
| 端到端 | 41 passed（诊断规则 D1–D9、预检、一键修复、历史抽屉与 CSV 导出、观看页自检、AI 面板交互） |

---

## 七、安全与合规

- `appSecret` 只存在于服务端进程；浏览器仅拿到服务端签好的推流地址与频道公开信息
- 仓库不含任何真实凭证、频道号、账号 ID；`.env.example` 全部为占位符
- 诊断与指标数据仅存于服务端内存（每频道环形 50 / 300 条），不落盘、不外发
- AI 归因链路按最小必要原则发送数据，不含密钥与画面内容
