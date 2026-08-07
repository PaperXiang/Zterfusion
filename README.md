# zterfusion

`zterfusion`（内部代号 Rhythm Party）是一个纯前端的本地多人同屏节奏游戏：2–6 名玩家共用一台键盘或鼠标，一人进攻打节奏，其余玩家复刻防守，按准确度计分。

当前版本使用 **Vue 3 + Vite + TypeScript**，并提供基于 **Node.js + Socket.IO** 的 Casual 联机模式。Vue 负责组件和响应式 UI，节奏引擎仍使用原生 `Canvas 2D`、`Web Audio API` 和 `requestAnimationFrame`。

## 运行

需要 Node.js 20.19+（当前 Vite 要求）和 npm：

```bash
npm install
npm run dev
```

`npm run dev` 会同时启动 Vite（默认 http://localhost:8999）和 Socket.IO（内部使用 3000 端口），Vite 会把 `/socket.io/` 代理到联机服务。Windows 也可以双击 `启动游戏.bat`。

生产构建和预览：

```bash
npm run build
npm run preview
```

音效资源位于 `public/audios/`，会被 Vite 作为静态资源发布。根目录的 `audios/`、4 个旧版 JS 文件和旧版实现仍保留，便于迁移期间对照；新入口只加载 `src/main.ts`。

## Casual 联机

配置页点击 `ONLINE` 后，每个浏览器作为一名玩家：

- 创建房间会获得 6 位房间码，其他玩家输入房间码加入；
- 房主设置 BPM、拍数、轮数与每名进攻者的时长，并负责开始、暂停和重开；
- 游戏开始时间、进攻顺序、节奏与得分由服务端决定；客户端本地立即发声，再上报按键时间；
- 玩家短暂断网或刷新页面时，会使用保存在 `sessionStorage` 的房间身份恢复；不同标签页身份相互隔离；
- 首版房间保存在 Node.js 内存中，服务重启后房间会消失，也不支持多实例负载均衡。

当前联机首版只支持 Casual。为了让不同网络环境下的判定更稳定，客户端连接后会采样服务器时钟并显示估算的单程延迟。

## Docker / VPS 部署

一台 VPS 可以直接运行：

```bash
docker compose up -d --build
```

默认映射到 VPS 的 `8999` 端口。Compose 内包含两个服务：Nginx 发布 Vue 静态文件并反代 `/socket.io/`，Node 容器维护联机房间。浏览器访问 `http://VPS-IP:8999` 即可验证。

正式域名建议在 VPS 已有的 Caddy/Nginx/云负载均衡上配置 HTTPS，再反代到 `127.0.0.1:8999`。外层代理必须保留 WebSocket 的 `Upgrade`/`Connection` 请求头。生产环境还应在防火墙中只开放 80/443，不直接开放 Node 的 3000 端口。

## 玩法

- 偶数小节是进攻小节，进攻方按键打出节奏。
- 奇数小节是防守小节，其余玩家复刻刚才的节奏。
- 进攻音符会吸附到勾选的 8/12/16/24 分音网格。
- 防守小节结束后统一匹配音符，按误差计算分数。
- `CASUAL`：玩家轮换进攻，攻守双方都能得分。
- `CHALLENGE A`：系统随机生成节奏，所有玩家共同防守。
- `CHALLENGE B`：合作冲分，节奏不能重复且音数有下限；MISS 达到上限结束，团队分数还会推动 BPM 加速。
- `CHALLENGE C`：预留占位，尚未实现。

配置界面支持玩家自定义按键、鼠标按键、音效库、自定义音频、音量、BPM、拍数、局数和回合时长。设置保存在 `localStorage` 的 `rhythm-party-settings` 中。

## 新版代码结构

| 文件 | 职责 |
|---|---|
| `src/App.vue` | 应用装配、屏幕切换和事件连接 |
| `src/components/ConfigScreen.vue` | 模式、玩家、设置和音效配置 |
| `src/components/GameScreen.vue` | 游戏 HUD、Canvas 容器和玩家状态 |
| `src/components/ResultScreen.vue` | 结算和挑战 B 团队纪录 |
| `src/game/GameEngine.ts` | 时间轴、小节推进、计分、挑战模式和 Canvas 绘制 |
| `src/audio/AudioEngine.ts` | Web Audio、节拍器、攻守音效和预约音清理 |
| `src/input/InputSystem.ts` | 键盘/鼠标输入、按键绑定和快速开始 |
| `src/network/OnlineClient.ts` | Socket.IO 连接、时钟同步、联机输入和 Canvas |
| `src/shared/protocol.ts` | 前后端共享的房间协议与类型 |
| `server/RoomManager.ts` | 房间、房主、联机时间线和权威计分 |
| `server/index.ts` | Socket.IO 服务入口和健康检查 |
| `Dockerfile` / `docker-compose.yml` | Nginx 与 Node 的生产部署 |
| `src/config.ts` | 游戏数值配置 |
| `style.css` | 原像素风样式，继续由 Vite 直接导入 |
| `public/audios/` | Vite 发布的官方音效资源 |

没有自动化游戏测试；提交前至少运行 `npm run build`，再用浏览器手动验证：

- PLAY / PAUSE / RESUME / QUIT 按钮和 ESC 暂停；长按 ESC 不应反复切换状态。
- 暂停期间播放头、计时、节拍器和已预约的系统音应一起冻结，恢复后从原位置继续。
- 配置界面的绑键冲突、鼠标绑定、快速开始、音效试听和自定义音效。
- CASUAL、CHALLENGE A、CHALLENGE B 的攻防、计分、MISS、加速和结算。
