# AGENTS.md — zterfusion

> 写给 AI 编码代理的项目说明。读完后你应当能直接上手改代码，无需再问项目背景。

## 项目概述

**zterfusion**（内部代号 / 注释中常称 "Rhythm Party"）是一个纯前端的本地多人同屏节奏对战游戏，像素风 UI。

- **玩法**：2–6 名玩家共用一台键盘（含鼠标按键）。配置界面顶部有 MODE 选择（`config.mode` 持久化）：
  - `casual`（休闲模式）：每个回合由一名玩家担任进攻方，其余为防守方；
  - `challenge-a`（挑战模式 A）：系统作为虚拟 P0（`SYS_PLAYER`，id `sys`，进攻方 idx 固定为 -1）随机生成节奏，所有玩家都是防守方复刻计分，系统不计分；`rounds` 仍表示局数；
  - `challenge-b`（挑战模式 B）：合作冲分。轮换进攻与休闲相同，但每个进攻小节音数 ≥ `challengeB.minNotes`，且节奏型不能与**自己上一段**进攻相同（按玩家各自记录 `prevRhythm[pid]`，换人互不误伤；节奏型按拍归一化再比较，加速后同一手法仍能判重）；违规小节不作废（防守照常复刻得分），只记 MISS，满 `maxStrikes` 立即结束（`forcedEnd`）；团队总分每 `scorePerStep` 分升 `bpmStep` BPM（上限 `maxBpm`，只在回合边界换速，避免小节时长突变）；TEAM 总分显示在头部 `mode-info-display`，最高分存 `localStorage` 键 `rhythm-party-best-b`（RESET 不清）；
  - `challenge-c`：预留占位（按钮 disabled，未实现）。
  - 偶数小节 = 进攻小节：进攻方按键打出节奏（音符自动吸附到勾选的 8/12/16/24 分音网格）；
  - 奇数小节 = 防守小节：所有防守方复刻进攻方的节奏；
  - 防守小节结束后延迟 80ms（`tolerance`）统一比对，每个进攻音与最近的防守音按误差计分；休闲模式攻守双方同时加分，挑战模式只有防守方加分。
- **技术栈**：Vue 3 + Vite + TypeScript，Web Audio API 做音频，Canvas 2D 做节奏轨道渲染，`localStorage` 持久化设置；联机使用 Node.js + Socket.IO，Docker Compose 中由 Nginx 发布页面并反代 WebSocket。游戏引擎仍保持原生时间轴，不把音频精度交给响应式渲染。
- **运行前提**：先执行 `npm install`，再用 `npm run dev` 或 `启动游戏.bat` 访问 Vite 服务；直接双击 `index.html`（file:// 协议）不能运行模块入口和音效资源。

## 运行与构建

项目使用 npm 管理依赖和 Vite 构建。`npm run dev` 同时启动 Vite 和 Socket.IO；没有浏览器自动化游戏测试。

- **启动**：双击 `启动游戏.bat`（Windows），它安装依赖（首次运行）并启动 Vite；或手动在项目根目录执行：
  ```
  npm install
  npm run dev
  ```
  然后访问 Vite 输出的 http://localhost:8999 。生产构建使用 `npm run build`，预览使用 `npm run preview`（同样使用 8999 端口）。
- **验证改动**：开发服务器支持 HMR。根目录的 `_wb_*.json` 是浏览器调试（web-bridge 类工具）留下的请求快照，不属于应用代码，不要依赖它们。

## 代码结构

新版使用 Vue 单文件组件和 TypeScript 模块，由 Vite 从 `src/main.ts` 作为入口构建。根目录旧版 JS 文件仍保留作迁移对照，但不是新入口：

| 文件 | 职责 |
|---|---|---|
| `src/config.ts` | 游戏数值配置 |
| `src/audio/AudioEngine.ts` | Web Audio：节拍器、攻守音效、预约与清理 |
| `src/input/InputSystem.ts` | 键盘/鼠标捕获、按键绑定、冲突检测和快速开始 |
| `src/game/GameEngine.ts` | 时间轴、状态机、回合推进、计分、挑战模式、Canvas 和持久化 |
| `src/network/OnlineClient.ts` | 联机连接、校时、本地低延迟反馈和联机 Canvas |
| `src/shared/protocol.ts` | Socket.IO 前后端共享事件协议 |
| `src/components/*.vue` | 配置、游戏、暂停和结算界面 |
| `server/RoomManager.ts` | 内存房间、权威 Casual 时间线和计分 |
| `server/index.ts` | Socket.IO 服务入口 |

其他资源：

- `src/App.vue`：三个全屏界面（`config-screen` / `game-screen` / `result-screen`）+ 绑键弹窗 + 暂停遮罩，靠 `.active` / `.hidden` class 切换。
- `style.css`：像素风样式，CSS 变量定义配色（`:root`），字体用 Google Fonts 的 Press Start 2P。
- `public/audios/`：Vite 发布的官方音效库（`attack.wav`/`defend.wav`/`tick.wav` 是默认音，其余进音效库下拉框）。玩家也可上传自定义音效（仅存内存，刷新需重传）或用音效库音效（选择会持久化）。根目录 `audios/` 保留给旧版实现。

## 关键架构细节（改代码前必读）

- **时间轴**：一切基于 `performance.now()`。`gameState.startTime` 在 READY 阶段设在未来，因此 `elapsed` 从负值走到 0 才正式开始；READY 长度 = `CFG.readyBars`（2）个小节。
- **小节角色**：`barIndex % 2 === 0` 为进攻小节。判定有 `tolerance`（80ms）的跨小节容错：小节末提前按归下一小节（offset 为负，音效预约到小节点播放），小节初晚按归上一小节（只记录不出声）。
- **计分时机**：防守小节结束后延迟 `tolerance` 再 `scorePair()`（容纳晚按几十毫秒的防守音）；时间耗尽不立即结束，置 `ending` 等当前一组攻守走完。**触发 ending 时所在的进攻小节允许打完**（`endingAtBar` 记录小节号，`onPlayerKeydown` 按容错路由后的落点小节比较，更后面的进攻小节才忽略）；收尾阶段计时器显示 `LAST`。
- **挑战模式调度**：系统节奏在进攻小节开始前 0.1s 由主循环生成并预约音效（`systemScheduledFor` 防重复；预约窗口只留 0.1s，避免暂停时整小节预约音漏进暂停）；卡顿错过窗口时 `onBarBoundary` 兜底补生成。
- **暂停同步**：`GameEngine.pauseGame()` 同时停止 rAF 并 `AudioEngine.suspend()` 冻结音频时钟；恢复时给 `startTime` 补偿暂停时长，再恢复 AudioContext，不能只停画面循环。
- **输入去重**：`InputSystem` 必须同时检查 `KeyboardEvent.repeat` 和按下集合；否则长按 ESC 会反复暂停/恢复，玩家键也会被浏览器自动重复当成连打。
- **Vue 事件绑定**：不要在模板中直接写 `@pause="game.pauseGame"` 这类未绑定的 class 方法引用，组件 emit 调用时会丢失 `this`；统一经过 `App.vue` 中的包装函数调用。
- **BPM 取值**：所有节奏计算（小节时长、网格吸附、准确度、节拍器、模式 A 生成）必须走 `effectiveBpm()` 而不是 `config.bpm`——挑战模式 B 用 `gameState.bpm` 覆盖实现加速，其它模式原样返回设定值。
- **音画一致**：进攻音符吸附到网格后，音效也按吸附点预约播放；取消未发声的预约音时必须同步删音符（`removeLatestEarlyNote`）。
- **音效库列表**优先尝试 `fetch('audios/')` 的目录索引，在 Vite 无目录索引时回退到 `src/audioLibrary.ts` 的清单；新增官方音效时应同步放入 `public/audios/` 并更新清单。
- **设置持久化**：`localStorage` 键 `rhythm-party-settings`，存配置和玩家（名字/绑定键/音效选择/音量 dB），自定义上传的音频文件本身不保存。
- **联机权威状态**：每个浏览器只代表一名玩家；服务端决定房间玩家顺序、进攻方、时间线、合法按键和分数。客户端按键先本地发声再上报，不能等待网络回包后才反馈。房间当前只存在单 Node 进程内，服务重启即失效。
- **联机时钟**：客户端用多次 ping 的最低 RTT 样本估算服务端时钟偏移；服务端把开局安排在未来 3 秒。协议时间戳使用 Unix 毫秒，客户端音画循环内部再换算。
- **联机身份**：`sessionStorage` 键 `zterfusion-online-identity` 保存房间码、玩家 id 和恢复令牌，刷新保留且不同标签页互相隔离。快照绝不能广播令牌；主动 LEAVE 会清理身份，断网则保留 10 分钟房间恢复窗口。

## 代码风格约定

- **注释主要用中文**（`config.js`、`audio.js`、`game.js` 内部注释均为中文），新代码注释也请用中文，并保持现有“解释为什么这么写”的注释密度——大量注释记录了踩过的坑（rAF 一帧延迟、音画一致、边界截断等），改动相关逻辑时同步更新这些注释。
- Vue 界面使用单文件组件；游戏核心使用 TypeScript class，音频和 Canvas 等精确时序不放进模板。
- 数值/手感调优只改 `src/config.ts` 的 `GAME_NUMBERS`，配置界面状态放在 `GameEngine.config`。
- UI 文案用英文（像素风），界面切换用 `.active`/`.hidden` class。

## 测试

没有自动化测试。手动验证路径：

1. `npm install` 后运行 `npm run dev`，浏览器打开 Vite 输出地址；
2. 配置界面：双击 Enter/Space 快速开始（`quickStart: 'double'`）、绑键冲突提示、音效试听、READY 期间按数字键改拍数；
3. 游戏中：节拍器重拍、攻守小节交替、音符吸附、计分动画、ESC 暂停/恢复；
4. 结束后：结算界面名次与 REPLAY。
5. 联机：开两个浏览器窗口，创建/加入同一房间；确认只有房主能改配置和开始，双方攻守轮换、得分一致、房主暂停同步，刷新后能恢复房间。

## 安全与其他注意事项

- 纯本地前端，无后端、无密钥；开发时由 Vite 提供本地模块服务，样式仍会请求 Google Fonts。
- 渲染玩家名字等使用字符串模板拼 `innerHTML`（玩家名输入被 `maxlength="8"` 限制），如果重构 UI 请注意不要引入 XSS。
