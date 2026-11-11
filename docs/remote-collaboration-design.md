# 远程协作：交接文件与 relay 文件读写

状态：使用真实 RelayClient 的本机双 daemon 测试；实体节点部署待验收。2026-11-11。

## 要解决的问题

主控线程在 hub 机器上，成员可能跑在另一台机器（例如 devbox）。现在跨机器协作只把任务文本经目标 daemon 的 HTTP 接口投进去，结果取轮次结束时的文字回答：

- 长交接没有文件形态，成员在任务中途不能重新打开原始要求；
- 结果被收尾文字限制在 16000 字符，无法交回报告、补丁或其他文件；
- 本机主控或 review 成员不能直接读写 devbox 上的代码，只能等远端成员用文字描述。

这个设计补上三件事：交接文件、结果文件、直接 relay 文件读写远端成员工作目录里的代码。

## 参考

| 项目 | 已核对的机制 | 本项目的取舍 |
|---|---|---|
| [agent-deck Conductor](https://github.com/asheshgoplani/agent-deck/blob/main/docs/conductor/README.md) | 协作目录里放 `CLAUDE.md`、`POLICY.md`、`state.json`、`task-log.md`，会话每次启动或恢复时读取；完成通知落盘后由主控取回 | 借鉴「任务与状态写成 agent 能直接读的 Markdown」；不引入常驻主控会话、tmux 或它自己的目录管理 |
| [A2A 1.0](https://a2a-protocol.org/latest/specification/) | Artifact 是任务的输出，由 Part 组成，Part 可以是文本、文件引用或结构化数据；任务可流式更新 artifact | 借鉴「结果不只一段文字，可以是文件」；不引入 A2A 的 AgentCard、任务状态机和 HTTP 协议 |
| [OpenAI Agents SDK Handoffs](https://openai.github.io/openai-agents-python/handoffs/) | handoff 是模型可调用的工具，默认把对话历史一起交给下一个 agent，可用 input filter 裁剪 | 借鉴「交接有明确边界和内容」；它的 handoff 在同一进程内传消息，不解决跨机器和文件产物 |

一句话结论：跨机器交接用「远端可读的 Markdown 文件」，结果用「文件 artifact」，读写用「按成员工作目录收口的relay exec 操作」，借鉴 agent-deck 与 A2A 的做法，同时不引入新的常驻组件或挂载。

## 交接文件

远端成员每次收到任务前，hub 先经 relay exec 在**那台机器**上写一份交接 Markdown：

```text
/tmp/calli-exchange/<主线程 ID>/<消息 ID>/
├── handoff.md    hub 写，成员读
└── result.md     成员写，hub 读完带回
```

- 放在 `/tmp` 而不是项目目录：不在仓库里留下未跟踪文件，不碰成员的分支和提交；主流 agent 的沙箱通常允许读写临时目录。
- 目录和文件权限 `0700` / `0600`。路径只由两个 UUID 组成，不接受用户输入。`/tmp` 是共享的：写入前检查交换目录及其父目录不是软链接、属于当前用户，结果文件也不能是软链接，防止别的本机用户抢先放置。
- 投给成员的消息只给路径、首行摘要和完成要求，完整任务在 `handoff.md` 里。成员要重新核对要求时直接再读文件。
- 显式交接：`calli spawn/send ... --handoff-file FILE` 把本地文件内容作为 `handoff.md` 正文；`--message-file` 仍作为消息文本。两者都给时，消息文本是简短说明，文件是任务正文。
- 远端命令写不进去时回退为现有的内联消息，不阻断协作；成员照常在回复里给出结果。

`handoff.md` 的结构是协议文字，不翻译：

```markdown
# Calli 交接

- 来自：<主控名>（线程 <ID>）
- 发给：<成员名>
- 消息 ID：<ID>
- 时间：<ISO>

## 任务

<正文>

## 结果

完成后把完整结果写到：<result.md 绝对路径>
最终回复里给出摘要。无法写文件时，把完整结果放在回复里。
```

## 结果文件

- 成员在轮次结束前把完整结果写到 `result.md`。hub 在轮次结束后经 relay exec 读回，存到主 hub 的数据目录 `coordination/files/<主线程 ID>/<消息 ID>.md`。
- 文件写进投递给发送者的结果消息：`calli result` 返回 `resultFile.localPath`，主控可以直接用自己的文件工具打开；界面在结果下面显示一个文件按钮，可下载。
- 结果文件最多 1 MB，超出部分截断并标明。成员没写文件、远端命令读不到或轮次失败时，沿用原来的文字结果，不把协作标成失败。
- 结果文件是远端成员写的内容，按纯文本下载，不在浏览器里当 HTML 渲染。

## `calli remote`

给协作里的 agent 直接读写远端成员工作目录：

```text
calli remote ls MEMBER [PATH]
calli remote read MEMBER PATH [--offset N] [--limit N]
calli remote write MEMBER PATH --file FILE|- [--expect-hash SHA256]
```

- `MEMBER` 是本机主控创建的远端成员名。作用根是该成员的远程 cwd（通常是那台机器上的临时 worktree）；相对路径相对它解析，绝对路径也必须落在它里面。
- 路径在远端用 `realpath -m` 解析后做前缀校验，`..`、指向根外的软链接一律拒绝。只接受 UTF-8 文本，含零字节按二进制拒绝。
- 读默认 256 KB、最多 1 MB，返回 `text`、`hash`、`size` 和 `truncated`。
- 写最多 1 MB，先写同目录临时文件再 `mv` 原子替换，保留原文件权限；`--expect-hash` 与当前文件不一致时返回 409，避免覆盖别人刚写的内容。
- 权限：主控可读可写；其他协作成员只读。写操作不因为协作自动放宽 agent 自己的权限。
- 通过已登记节点的 relay exec 执行，需要节点在线且两端支持 relay；离线时读写失败，协作消息仍按原有规则等待重连或回退内联。

## 接口与文件

| 位置 | 职责 |
|---|---|
| `packages/daemon/src/hosts.ts` | `HostRegistry.exec`：通过节点的 relay 连接执行一次远端命令，超时与输出上限 |
| `packages/daemon/src/remote-files.ts` | 路径校验、`ls/read/write`、交接文件与结果文件的读写；脚本从标准输入取路径，避免 shell 转义 |
| `packages/daemon/src/coordination.ts` | 投递前写 `handoff.md`；轮次结束后读 `result.md`、存本地副本、结果消息附 `resultFile`；`remote` 命令与成员权限 |
| `packages/daemon/bin/calli` | `--handoff-file`、`calli remote ls/read/write` |
| `packages/daemon/src/http.ts` | `GET /api/threads/:id/coordination/result/:deliveryId` 下载本地结果副本 |
| `packages/web/src/components/AgentPanel.tsx` | 结果消息下的文件按钮 |
| `docs/TODO.md` 第 12 节 | 任务与验收记录 |

Delivery 新增可选字段 `handoffPath`、`resultPath`、`resultFile: { name, size, localPath, truncated? }`；旧记录没有这些字段时行为不变。`view()` 只把 `resultFile.name/size` 给浏览器，不暴露 hub 本机路径。

## 不做

- 协作成员不开放任意远端 shell 或端口转发；只做读、写、列目录。hub 操作者的运维 exec 是单独的认证接口。
- 不开放成员工作目录以外的路径（用户已选「仅成员工作目录」）。
- 不在网页里编辑远端文件；文件面板维持只读。
- 不做远端目录挂载或持续同步，不做二进制和大文件分块传输。
- 要求两端 daemon 支持 relay；节点文件命令仍依赖 POSIX shell 与 `realpath`、`find -printf`、`sha256sum`。

## 验证

- 单元：`remote-files` 的读写、分页、二进制拒绝、大小上限、原子写、hash 冲突、`..` 与软链接越界；`HostRegistry.exec` 经真实 RelayClient 验证参数、标准输入、退出码和超时。
- 协作：两个本机 daemon 经真实 relay验证投递前生成 `handoff.md`、消息带路径、显式 `--handoff-file`、轮次结束读回 `result.md` 并生成 `resultFile`；远端不可用时回退内联。
- 接口：结果文件下载需要 token，越权与不存在分别 403/404。
- 浏览器：真实无头 Chromium 桌面/手机 × 亮/暗看结果文件按钮；实体手机未测。
