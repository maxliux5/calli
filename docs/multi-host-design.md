# 多机管理：节点主动连接 hub

每台机器运行同一个 daemon，其中一台作为浏览器连接的 hub，其他节点主动连到 hub。agent、线程、工作目录和文件都留在各自机器上；节点断线不终止 agent 会话。浏览器只访问 hub，不需要直连节点或在节点开放端口。

参考 [frp](https://github.com/fatedier/frp) 的反向连接和 [Headscale](https://github.com/juanfont/headscale) 的集中节点登记，采用「hub 生成接入配置、节点主动连接」；保留现有 HTTP API，不引入网络隧道客户端或虚拟网卡。控制连接与数据分离的实现沿用 Mew 的思路。

## 连接结构

```text
浏览器 ──HTTP / SSE / WebSocket──▶ hub
                                  ▲
节点 ──WebSocket /api/relay/connect─┤ hello、唤醒通知
节点 ──POST /api/relay/poll─────────┤ 领取本机待办任务
节点 ──GET /api/relay/tasks/:id/body┤ 流式读取请求体
节点 ──POST /api/relay/tasks/:id/result  回传状态、响应头和响应体
节点 ──GET /api/relay/tasks/:id/tunnel   字节管道，承载桌面 WebSocket
  │
  └─本机私有 Unix socket → 节点 daemon → agent、线程、文件
```

hub 的 `HostRegistry` 统一提供 `proxy / call / exec / upgrade`。任务有三种：`http` 转到节点私有 socket（只接受 `/api/` 路径）、`exec` 执行协作文件读写或运维命令、`upgrade` 转发 WebSocket 握手和字节流。请求与响应流式传输，SSE 不等完整响应收齐才返回。

## 添加与迁移

1. 在节点安装 Calli，保持私有 socket 开启。
2. 浏览器打开「配置 → 机器 → 添加机器」，填写名称，生成 `CALLI_HUB_URL` 和 `CALLI_HUB_TOKEN`。
3. 将配置写入节点的 `~/.config/calli/.env`，安装服务用 `scripts/install-service.sh`；已有服务按 `scripts/restart.sh` 重启。hub 地址必须能从节点访问，通常使用 HTTPS。
4. 节点自动连接，机器列表显示在线、节点名称和版本。

令牌只显示一次；丢失后移除机器再添加。`hosts.json` 权限 `0600`，只保存 `id`、`label` 和令牌密钥的 `tokenHash`，不保存明文令牌。名称生成 URL 安全的 ID，重复名称加数字后缀。

不再使用 SSH。旧格式登记在加载时忽略，并只输出一次重新添加提示；读取不会修改或删除原文件。原型中带 `transport: "relay"` 的记录仍可读取，后续保存统一为无 transport 字段的格式。旧机器须重新生成接入配置；节点上的会话与文件不迁移、不删除。

## 权限与边界

- 浏览器访问 hub API 使用 hub token，权限覆盖所有登记节点；转发时剥离该 token。
- 节点令牌形如 `<机器 id>.<密钥>`，只允许自己的 `/api/relay/*` 操作，不能访问 hub 的普通 API，也不能领取其他节点的任务。移除机器后立即撤销令牌。
- 私有 socket 及其目录权限 `0700`，从 socket 进入的请求免 token，依赖本机用户权限；不开放级联代理。
- `CALLI_SOCKET=off` 会关闭私有入口，节点接入要求保持开启；可用 `CALLI_SOCKET` 指定本机自定义路径。
- relay exec 以节点 daemon 的系统用户执行。协作 `calli remote` 仍按成员工作目录及主控/成员权限收口；运维 exec 只允许持有 hub token 的操作者使用。
- 连接通过 hub 的 HTTPS/WSS 保护，开发环境可用可信网络内的 HTTP。不另行加密明文 HTTP。

## 状态与恢复

节点断线后按 1 秒到 60 秒指数退避重连。hub 每 20 秒 ping，未响应的连接会断开。节点每次连接都主动 poll；未领取的任务最多等待 15 秒，失败后由调用方决定是否重试。已领取 HTTP 任务等待响应头最多 60 秒，流式正文可继续传输。

| 错误码 | 含义 |
|---|---|
| `not_joined` | 节点还未连接，检查接入配置与节点是否已启动 |
| `relay_lost` | 连接中断，节点会自动重连 |
| `host_offline` | 节点离线或请求无法到达节点 daemon |
| `unreachable` | 命令或请求等待超时 |
| `too_large` | 命令输出超出本次操作上限 |

页面上的「重试」刷新当前状态；建立连接始终由节点负责。移除只断开登记关系，不删除节点数据。hub 重启后读取令牌哈希，节点可用原令牌重新连接。

## 接口与界面

| 接口 | 作用 |
|---|---|
| `GET /api/hosts` | 列出机器和连接状态 |
| `POST /api/hosts { label }` | 创建登记并一次性返回接入令牌 |
| `DELETE /api/hosts/:id` | 移除机器、撤销令牌 |
| `POST /api/hosts/:id/reconnect` | 刷新节点状态 |
| `/api/hosts/:id/proxy/...` | 代理节点 API、SSE 和桌面连接 |
| `POST /api/hosts/:id/exec { command, input? }` | 操作者运维命令，返回 base64 stdout、stderr 和退出码；默认 20 秒、2 MB 输出限制 |

没有其他机器时隐藏机器切换条。切换时一起替换线程、agent、目录、计划和 API 前缀；草稿按机器隔离。已缓存的线程列表保留到新数据到来，未知和空列表分开处理。离线原因直接显示，禁止继续发送；详情与移除操作分开。

## 节点更新

`scripts/update-hosts.sh [机器ID] [--check]` 通过 hub 的认证 API 与 relay exec 运行更新。读取本机 Calli 配置（`CALLI_ENV_FILE` 可覆盖），`CALLI_UPDATE_URL` 可指定 hub 地址。节点须在线、有 systemd 用户服务和可拉取的仓库克隆，默认 `~/code/calli`，可在 hosts.json 条目里配置 `repo`。

更新放进节点独立临时 systemd 单元，避免节点重启中断更新程序。沿用构建快照、等待空闲、切换和失败回滚；hub 轮询结果，节点重连后继续读取日志。30 分钟未结束会报告节点日志路径，任务不会被强制取消。`--check` 仍会 fetch 和快进节点克隆，但不构建或切换服务。离线节点无法更新。

## 验证与后续

自动测试使用真实 RelayClient 连接两个本机 daemon，覆盖 HTTP/线程/SSE、桌面票据和 WebSocket、协作 exec、远程文件权限、断线重连、令牌撤销和旧文件兼容。浏览器测试使用同一连接机制与假 agent；它们不能代替实体机器跨网络部署验证。

后续：协议版本与能力协商、令牌轮换、请求体限额、多 hub 任务路由，以及节点更新的真实 systemd 部署验收。
