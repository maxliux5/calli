# Mac 桌面版（Electron）

状态：阶段 0 与阶段 1 已实现并在 Linux 构建机上经真实 Electron 冒烟验证（Xvfb + 假 hub，亮/深色截图见 `packages/desktop/e2e/shots/`）；阶段 2（签名、公证、自更新）未做。未在真机 Mac 上跑过。产品方向见 [VISION](VISION.md)，架构见 [PLAN](PLAN.md)。

## 目标

把现有的 Web 界面装进原生 Mac 壳，补浏览器给不了的东西：

- **系统通知**：浏览器侧因为是 HTTP 非安全上下文没有 Notification API（见 PLAN「网络与安全」）；等批准、等回答、轮次失败这些事现在只有 BotMux 推送一条路。
- **Dock 徽标**：需要注意的线程数。
- **原生菜单和快捷键**：新会话（Cmd+N）、连接管理（Cmd+K）。
- **通知点击深链**：直接跳到对应线程；`calli://connect?host=…` 预填地址本。
- **剪贴板**：替代 HTTP 页面里 `execCommand` 的降级路径。

## 非目标（当前版本）

- 不打包本地 daemon：agent 仍然跑在远程主机上，Mac 只是操作端（本地模式见阶段 3）。
- 不在壳里新做界面功能：界面继续由 hub 服务，Web 和桌面同步演进。
- 不做 Windows / Linux 桌面包（Electron 天然可移植，但先只验 Mac）。

## 形态：壳 + 远程 UI

BrowserWindow 直接加载 hub 的 `http://host:port/`。UI 与 daemon 同源同版本，**零版本偏差**：token 输入（ConnectDialog）、断线重连、新版本提示、多机切换全部复用现有网页。原生能力经 preload 注入 `window.calliDesktop` 桥，Web 端按能力检测可选调用（`packages/web/src/desktop.ts`），浏览器里没有这个对象，一切照旧。

```
packages/desktop/
  src/main/        主进程：窗口、菜单、通知、徽标、深链、地址本、打包脚本都在这里接线
  src/preload/     contextBridge：hub 页面得 calliDesktop，本外壳页面得 calliShell
  src/shell/       壳自己的两个页面：地址本与离线页（复用 web 的 i18n 与设计变量）
  e2e/smoke.mjs    真实 Electron 冒烟：首连、token、桥、菜单语言、离线页（Xvfb 可跑）
```

已定的实现口径：

- **地址本**（`hubs.json`，原子写）：hub 地址去 `http(s)://` 之外不收 scheme，路径丢弃归一成 origin；添加时探测一次免 token 的 `/api/health`，连不上不给加。上次连接的 hub 记为 active，启动即载入；加载失败进壳的离线页（重试 / 换一个）。
- **地址和 token 一次收齐**：壳的表单同时收 hub 地址和访问 token。token 只存内存，页面加载时由 preload 在任何页面脚本之前写进 hub 自己的 `calli.token`（`ipcMain` 同步一次性发放，按 origin 限定、取后即焚），hub 页面开机即登录，不再弹自己的连接框。不填 token 则保持原有行为（页面自己问）。壳不落盘 token，也不持久化它。
- **从 hub 页面一键进入 app（配对码）**：hub 页面「配置 → Mac app」铸造一枚 96 位一次性配对码（`POST /api/devices/pair`，需登录），浏览器跳 `calli://connect?host=…&code=…`；app 用 `POST /api/devices/exchange`（免 token）换得 hub token，直接进入并登录。token 不进链接：链接里只有短时效的码，60 秒内一次性使用，内存保存，猜中概率忽略不计。冷启动时 macOS 走 open-url，Linux/Windows 的启动参数也扫描 `calli://`。
- **桥的边界**：`contextIsolation: true`、`sandbox: true`，表面只有 notify / setBadge / copyText / setLocale；主进程对每次调用校验 sender origin 必须在地址本里。壳页面（file:）只能走 `calliShell` 的地址本操作。网页里的外链一律丢给系统浏览器，窗口不离开 hub。
- **通知**：Web 端 `threadNotices()` 的输出（别的线程刚开始等 / 失败了）在 `document.hidden` 时逐条发系统通知，点击聚焦窗口并跳 `#/thread/<id>`；前台时维持页内 toast，不重复打扰。口径与 BotMux 推送、状态点同源（同一个 notices 计算）。
- **徽标**：直接用 `attentionCount`（等待 + 未读），与浏览器标签页标题的计数同一口径；零时清空。
- **菜单**：语言跟随 hub 页面上报的 `calli.locale`（bridge `setLocale`，无桥时用系统语言）。「新建会话」走新增的 `#/new` 路由，等价于点击侧栏「新线程」。
- **窗口**：记住大小和位置（限制在屏幕内）；`calli://` 已在 Info.plist 声明并运行时注册。

## 构建

- `npm run dev:desktop`：本机起 Electron 调试（Mac 上直接可用）。
- `npm run dist:mac`：`packages/desktop/scripts/assemble-mac.mjs` 在任何有 node、unzip、python3（PIL）的机器上组装 Mac 包：下载官方 Electron darwin zip（`ELECTRON_MIRROR` 可换源，默认 npmmirror）、改 Info.plist、由 `calli-icon.png` 生成 icns、把 `dist/` 放进 `Resources/app`，python 打出保留符号链接与权限的 zip。**未签名**：目标机首次打开可能要 `xattr -cr Calli.app`。
- 镜像没有 universal 时分架构出包：`node scripts/assemble-mac.mjs arm64|x64`。Electron npm 包本身在无外网的构建机上用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`；跑 e2e 需要手动补 Linux 二进制到 `node_modules/electron/dist`（`path.txt` 写 `electron`，无换行）。
- 冒烟：`cd packages/desktop && xvfb-run -a node e2e/smoke.mjs`（Mac 上不需要 xvfb）。

## 阶段 2（未做）：分发与打磨

- electron-builder / 签名 / 公证（Developer ID，凭据走环境变量）；自动更新（electron-updater + Releases）；开机自启。手工组装包已可用，缺的是分发层的信任链。

## 阶段 3（评估后再做）：本地模式

- daemon 打包为子进程，本地 agent 与远程 hub 并存。**原生模块不再是阻碍**：node-pty 1.1.x 是 N-API 模块，npm 包自带 `prebuilds/darwin-arm64` 与 `darwin-x64`，塞进 Electron 无需重编，也不需要 Mac 构建机。真正的成本在产品层：daemon 子进程生命周期、本地数据目录、机器列表里「本机」与远程 hub 的统一形态。

## 安全

- 桥没有 shell、文件、网络能力；主进程逐调用验 origin（`packages/desktop/test/bridge.test.ts`）。
- token 仍存 hub 源的 localStorage（Electron 持久分区，同浏览器行为）；不设 `webSecurity: false`。
- 外链 `shell.openExternal`；页面权限请求一律拒绝。
- 仓库不写入 token、IP、主机名；签名与更新凭据只来自环境变量。
