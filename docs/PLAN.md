# 架构与决定

产品方向和整体分层先读 [愿景与设计思路](VISION.md)；要做什么、做到哪了，看 [TODO](TODO.md)。本文记录现有架构与技术决定，未实现的方案单独标注。

## 结构

```
浏览器（手机和桌面同一套代码）
   │  HTTP + SSE，Authorization: Bearer <token>
   ▼
daemon（Node.js，跑在远程主机上）
   ├─ http.ts         路由、鉴权、SSE、静态文件、私有 Unix socket
   ├─ hosts.ts        机器登记、SSH 隧道、健康检查与流式代理
   ├─ threads.ts      线程生命周期、turn、审批、设置
   ├─ store.ts        SQLite：threads、events、sections
   ├─ attachments.ts  图片与视频落盘、引用校验（videos.ts 流式保存视频）
   └─ adapters/       每个 agent 一个适配器，对上输出统一事件
```

前端只认统一事件，不知道后面是哪个 agent。能力差异通过 `capabilities` 和模型列表里的字段表达。

## 各 agent 怎么接

| Agent | 方式 | 已验证的能力 |
|---|---|---|
| Claude Code | ACP，`@agentclientprotocol/claude-agent-acp@0.89.0`（stdio JSON-RPC） | 流式、审批、图片输入、`session/list`、`session/load`（回放历史）、`session/fork`、`session/delete`、`session/set_mode`、`session/set_config_option`（模型、强度）、斜杠命令 |
| pi | `pi --mode rpc`（stdin/stdout JSON 行） | 流式、图片输入、`set_model`、`set_thinking_level`、`get_available_models`（含每个模型的强度映射和是否支持图片）、`get_commands`、`clone`、`fork`、`get_messages`；没有审批 |
| Antigravity | `agy --input-format stream-json --output-format stream-json … -p=` | 流式、多轮（一个进程，每行输入一轮）、`--conversation` 恢复、`--model`、SIGINT 停止。输入是 `{"event":"user","message":{"content":…}}`，输出是 `init`、`step_update`、`result`。无界面模式不能询问权限，需要批准的操作会被拒绝；输入只有文字；流里没有思考过程和文件内容 |
| Codex | `codex app-server`（自有 JSON-RPC v2 线程协议，stdio） | 流式、审批（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`，选项按 `availableDecisions` 生成）、`thread/resume`、`model/list`（含强度和图片输入）、`thread/turns/list`（回放历史）、`thread/fork`、`thread/delete`、`thread/compact/start`（`/compact`）；`turn/start` 携带模型/强度/沙箱覆盖，`thread/tokenUsage/updated` 映射上下文占用 |
| TraeX | 执行与命令走 `traex app-server`，复用 Codex 线程协议；模型、历史、分叉仍走 ACP | 原生 `/goal`、多轮流式、审批、恢复、压缩、模型/强度/权限；额度保留 `traex models --json`。已有 ACP 会话通过同一原生会话 ID 恢复，入口命令配置无需迁移 |
| zcode | `zcode app-server`（无 jsonrpc 字段的 NDJSON） | 精简协议接入：关闭自动记忆、基础工具白名单、流式、审批回调、取消、恢复、模型/强度、图片输入（按原生模型能力）、`/compact`；无权限档位，扩展全局关闭需另配，见 `zcode-minimal-design.md` |

注意：`@zed-industries/claude-agent-acp` 已停更（0.23.1，模型列表过时），不要用回去。

Plan 交互参考了 [Cline 的 Plan / Act](https://docs.cline.bot/core-workflows/plan-and-act)：先讨论，切换后延续同一上下文；[OpenCode 的 Plan / Build](https://opencode.ai/v2/docs/agents) 将计划作为限制普通项目编辑的独立模式。[pi 官方说明](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md) 明确不内置 Plan，交给扩展实现。Hub 据此统一入口和交互，执行策略仍接各 agent 的原生协议；协议依据包括 [Codex app-server](https://learn.chatgpt.com/docs/app-server) 与 [ACP Session Modes](https://agentclientprotocol.com/protocol/v1/session-modes)。

## 历史加载

历史直接在服务端过滤，先返回最近 8 轮的正文、状态与起止时间，再按「工作记录 → 单项详情」逐层读取；首屏不等待投影补建。首次历史响应同时返回仅含轮次 ID 的完整索引，导航刻度不依赖正文加载或 DOM 折叠；实时轮次从事件流追加。点击未加载轮次沿历史游标补读正文后定位，不提前读取工作详情。持续连接时完整推送新事件，重连时先补轻量快照再接完整实时流，已收到的详情在本地展开。统一覆盖所有 agent、主对话、协作成员和侧聊；已有投影只是可选的加速数据，旧详情仅在展开后构建。原始事件分页与完整导出接口保留兼容。具体结构与验收见 [历史正文优先与详情按需加载](history-loading-design.md)。

## 统一事件

| 事件 | 含义 |
|---|---|
| `thread.created` / `thread.updated` | 线程元数据变化 |
| `turn.started` | 用户发出一轮。`text`，可带 `images: [{id, mimeType, size}]`、`videos: [{id, name, mimeType, size}]`；`displayText` 保留用户原文 |
| `turn.done` / `turn.error` | 一轮结束。`turn.error` 可带 `code`，界面据此给出说明 |
| `message.delta` | 助手文本增量 |
| `reasoning.delta` | 思考过程增量 |
| `tool.start` / `tool.update` / `tool.end` | 工具调用。`content` 里的 `{type:'diff', path, oldText, newText}` 是文件改动。`tool.start` 可带 `tool`（模型看到的原始工具名，如 `mcp__服务__工具`）和 `server`（Codex 的 MCP 服务名），供概览统计；旧事件没有 |
| `context.compaction` | 原生上下文压缩。`id` 标识同一轮内的操作，`status` 表示进行中、完成、失败、取消、跳过或中断；`automatic` 可选，未知触发方式时不标“自动” |
| `approval.request` / `approval.resolved` | 审批。`toolCall.content` 里同样带 diff |
| `input.request` / `input.resolved` | 原生提问与计划审批，包含问题、选项、自由输入能力及提交结果；由所属轮次管理生命周期 |
| `plan.delta` / `plan.completed` | 提议的计划正文；完成事件以原生最终正文覆盖流式草稿 |
| `plan.updated` | agent 的任务清单 |
| `usage.updated` | 当前上下文占用：`used`、`size`，可带累计费用 `cost`。`used: null` 明确表示占用未知，清除旧读数 |

## 定下来的事

- **多机管理：** 每台机器运行同一个 daemon，主 hub 通过 SSH 隧道接入目标的私有 Unix socket；agent、线程、图片和计划留在目标机器。浏览器一次查看一台机器，切换时整体替换 API 前缀，草稿按机器隔离。目标 daemon 需先安装并启动，不做级联。详见 `multi-host-design.md`。

- **事件日志是唯一真相。** 每个事件有递增的 `seq`，SSE 断线后用 `after=<seq>` 续传。
- **上下文占用和累计用量分开。** Codex 取 `tokenUsage.last.totalTokens`，不能取会话累计的 `total`；pi 取 `contextUsage`，压缩后返回 `tokens: null` 时隐藏旧占用，等下一次响应更新；Claude 和 TRAE 取 ACP 的 `usage_update.used / size`。agy 尚未提供占用数据。前端只消费统一事件，不按 agent 分支；80% 提示只是界面阈值，不表示 agent 已触发自动压缩。
- **压缩只认原生信号。** Codex / TRAE 的 `contextCompaction`、Claude ACP 的带标识工具事件或 `compaction_update`、Pi 新旧 compaction 事件、ZCode 保留在 `session.updated` 的原生压缩操作载荷，统一映射到 `context.compaction`。在工作记录中按发生顺序独立显示，不计入工具步数；重复通知只更新同一行，未收到成功通知不显示“已压缩”。手动 `/compact` 沿用现有操作行，不重复展示。刷新与翻页从事件日志回放；旧日志缺失的事件不倒推补造，agy 暂无可靠信号。
- **原始事件接口按轮次分页（兼容）。** 文字和思考是一个片段存一条，长轮次有上万条。打开线程最多取最新 3 轮（`events?tail`），同时按 2,000 条事件预算确定边界；更早的从顶部一页页取（`events?before=<seq>`）。一页总是从某一轮的开头开始，单轮再长也整轮给。轮次起点有独立索引，避免扫描工具输出。数据库游标逐条读取并立即合并连续工具快照，避免把整页原始快照同时放进内存；随后把同一轮里连续的同类文字片段合并成首尾两条，原始存储不变。SSE 续传把游标之后的全部补完再接实时事件，不按页截断。
- **一轮一个工作块。** 一轮里做的事（思考、工具调用、中途说的话）按发生顺序收在一个块里，运行中展开并显示“工作中 · 已用时长 · N 步”，计时按轮次开始时间每秒更新，不依赖新事件，刷新后继续；只刷新时间文字，不重绘 Markdown 和工具内容。停止或完成后计时固定，结束后折成"用时 X · N 步"；块后面的文字才是回答。思考只露最新几行，想完是一行。
- **工作图标按操作统一。** 摘要和明细共用同一套图标：读取用展开的书页，编辑用铅笔，命令用带边框的终端，搜索用放大镜，网页用地球，其他工具用扳手。统一 18 px、圆头线条与文字间距，窄屏长命令不挤压图标；仍按统一事件里的操作类型呈现，不在前端按 agent 分支。
- **页面自己发现断线和新版本。** 事件流 40 秒没有任何字节（daemon 每 15 秒发一次 ping）就当它死了重连，回到前台时静默超过 5 秒也立刻重连；线程列表流重连后重新拉一次列表。回到前台或重连时比对 `index.html` 里的入口脚本，不一样就提示"有新版本"。
- **手机键盘。** 键盘不改变页面大小，只是盖住下半部分，浏览器再把剩下的可视区平移到输入框那里。所以 app 整个画在可视区所在的位置：高度取 `visualViewport.height`，位置取 `visualViewport.pageTop`；弹层都在 app 这个盒子里定位，跟着一起到可视区。只跟高度不跟位置，输入框会被顶到屏幕顶部、下面空一片。不要再加 `interactive-widget=resizes-content`。
- **daemon 重启时收尾。** 启动时把还标着"运行中"的线程里没结束的那一轮记为 `turn.error`（`code: interrupted`）。
- **同一个会话，两个入口。** 线程保存 agent 侧的会话 ID。网页和终端操作的是同一份会话；daemon 重启后用这个 ID 恢复。
- **不在 agent 那边留痕迹。** 探测模型和命令用临时进程（pi 加 `--no-session`；Claude 不发消息就不会落盘）。
- **设置按线程保存：** 权限、模型、思考强度。运行中修改会直接作用到会话上，做不到时重启会话并恢复。
  - 权限三档：请求批准 → `default`；帮我批准 → `auto`（没有就退到 `acceptEdits`）；完全访问 → `bypassPermissions`。pi 没有权限模式。用户最后一次选择的档位作为 daemon 全局单值保存，所有支持该档位的 agent 后续新会话共同继承；不支持时使用该 agent 自身默认档位。新会话草稿和服务重启后仍读到这份偏好；已有会话继续保留各自存储的权限值，不被全局默认值批量改写。
  - 模型列表、每个模型支持的强度、是否能读图片，都从 agent 读，不写死。Claude 要逐个模型探测（约 12 秒），所以 daemon 启动时就在后台做并缓存。
  - 速度同样按模型发现：`capabilities.speed` 表示适配器能设置速度，`ModelOption.speeds` 提供实际档位，适配器用 `isFast` 标记加速档，避免把经济或未知档位当作加速。Codex 读取 `model/list.serviceTiers`，旧协议的 `additionalSpeedTiers.fast` 映射为 `priority`；Claude 在现有逐模型探测中读取 ACP `fast` 的 on/off 选项，不增加模型请求。TraeX 仅合并执行协议中匹配模型的速度能力。
  - 模型弹层左上角的闪电直接切换加速：开启为绿色实心，关闭为灰色轮廓；不再单独占一块速度选项。关闭显式恢复标准速度，模型不支持时隐藏；模型列表标注「可加速」。尚未选择时保留原生设置，按钮提示说明继承状态及加速可能增加用量。前端先于 Hub 更新、旧响应尚无 `isFast` 时，兼容已返回的快速档位 ID；明确的 `isFast: false` 优先，经济与未知档位不猜测为加速。
  - 线程 `speed` 未设置时不覆盖原生速度；选择后通过原生会话接口应用并保存。标准档为 `default`，切换到不支持原档位的模型也显式保存标准档，避免恢复时继承旧加速设置。Codex 通过 `thread/settings/update` 和 `turn/start.serviceTier` 应用，Claude 通过 `session/set_config_option` 应用并从 `config_option_update` 同步原生降速。切换速度不改变思考强度、权限、工作模式或会话。界面提示加速可能增加用量，不把固定价格或账户资格写死；参见 [官方 Speed 说明](https://learn.chatgpt.com/docs/agent-configuration/speed)。
- **审批：** 只接受 agent 给出的选项 ID，其他一律拒绝。取消 turn 时，未决的审批自动按取消处理。
- **工作模式与权限分开。** `workMode: execute | plan` 按线程保存，前端只看 `capabilities.workModes`。运行中禁止切换，原生计划审批导致的模式变化由适配器回报；排队消息保留入队时的模式。进入计划不会改写用户的执行权限，回到执行继续使用原模型、强度、会话和权限。计划模式不能启动或恢复长期目标。
  - 输入框「＋」菜单合并附件与「计划模式」开关，开启时菜单打勾、底栏「＋」旁出现「计划」胶囊（列表图标 + 计划 + ×，点 × 退出），输入框提示先讨论方案，关闭即回到执行。手机模型仪表按钮及其容器保持固定正圆，停止和发送同时出现时也不压缩；手机上运行中的一轮遇到空输入框折叠为一行（＋、追加一条…、停止），点按输入行立即展开回两行。
  - Codex / TraeX 通过 `collaborationMode/list` 探测，再随 `turn/start` 传原生 `collaborationMode`；模型和强度取当前会话，不套用另一套默认值。旧版本不支持时明确报错。
  - Claude 使用 ACP `session/set_mode`，`current_mode_update` 同步界面；原生 ExitPlanMode 审批按用户已选权限批准，不清空上下文。zcode 使用 `session/setMode` 的 plan/build，并读取原生模式事件。agy 通过 `--mode plan`，切换后恢复同一 conversation。pi 使用适配器内的简短提示词接入同一开关：计划时先讨论方案，切回执行或恢复执行会话时明确解除旧的讨论限制，不重启会话、不安装扩展、不改配置。此模式仅为对话约定，不提供工具只读拦截；斜杠命令保持原样交给 pi。
  - Codex / TraeX 的 `requestUserInput`、Claude 的 form elicitation、zcode 的 `requestUserInput` 统一为问题卡。`POST /api/inputs/:id` 校验字段与选项、单选/多选和自由输入；停止、原生问题过期、轮次结束后释放等待，重复答复返回 404。浏览器重连从事件日志恢复；daemon 重启时原轮次标记中断，问题失效。
  - 原生计划审批直接回复当前请求，后续由 agent 继续。其他 agent 的计划一出（`plan.completed`），Hub 就把线程切回执行：之后说的话，无论是开工还是修改方案，都按正常模式发；想再规划就重新打开计划模式。方案是线程里的一张小卡片（左上列表图标和「计划」，右上下载与拷贝，正文只露开头、底部渐隐，点卡片整页阅读，Esc 或点背景关闭），原生计划审批的方案正文也画成同一张卡片。要不要执行、怎么改，统一在底部 sheet 里问（见下）。Codex / TraeX 用原生 plan 条目；pi 和 agy 没有自己的计划条目，适配器把计划模式下结束这一轮的那段回答作为方案上报，工具调用前的话照常作为消息，停止或出错时整段退回为消息。除 pi 的轻量提示词模式外，Hub 不额外编写规划提示词；不另建 agent 或计划文件。原生接入的只读约束由各 agent 的 Plan 行为负责，pi 不提供这一保证。
  - 需要用户拿主意的事都在一个底部 sheet 里问，暂时代替输入框（输入框只隐藏不卸载，草稿不丢）：hub 计划决策（「是否执行该方案？」：确认执行 / 填写拒绝并说明修改要求 / 跳过，跳过记在本机、刷新后不再问）、原生计划审批（同一问法，答案走 `POST /api/inputs/:id`）、agent 提问（一次一问，可回退，多选带勾选圈和「下一步/提交」，自由输入回车发送，跳过即取消）、工具权限审批（标题、命令或改动文件、「允许这一次」加重、始终允许的说明、拒绝）。确认执行发送「按我们讨论的计划开始执行。」；拒绝修改意见通过 `POST /api/threads/:id/turns` 带 `workMode: 'plan'` 发送，线程回到计划模式。已回答的提问、计划决策和审批在线程里留一行浅色痕迹（已回答/已跳过/已确认执行/已退回方案/已允许/已拒绝），不抢眼；hub 计划决策不留痕，后面直接是用户的话。
- **图片：** 类型按文件头判断，不信客户端声明；只收 PNG、JPEG、GIF、WebP；每条消息最多 6 张，每张 5 MB；文件存在数据目录，事件里只有引用。
- **视频：** `POST /api/threads/:id/videos` 鉴权后接收二进制文件流，按文件头识别 MP4、MOV、WebM，每个最多 100 MB，每条消息最多 3 个。完整校验后才发布文件，断开或超限清理临时文件；发送消息只接受本线程的视频引用，不接受任意路径。视频原文件路径作为文字说明交给 agent，不冒充原生视觉输入。网页发送前可预览，历史视频点击后才通过鉴权接口加载成 blob 播放；编码不兼容时可下载原视频。排队撤回带回引用，重发复用已上传文件；分叉复制视频与元数据。
- **斜杠命令按目录取**，因为项目级命令各不相同。
  - 桌面端「＋」与「/」共用命令面板和条目顺序，在输入框上方按同等宽度展开，附件、计划、目标、操作、原生命令与技能直接分组列出。「＋」有独立搜索框，不改草稿；「/」继续从输入文字过滤。支持方向键、Enter/Tab、Esc 和点击外部关闭。手机「＋」保留紧凑首页，点「操作」「技能」后关闭小菜单，复用输入框上方的等宽命令面板并过滤对应条目，名称与描述分行显示；搜索框在点击手势内挂载并获得焦点，面板按键盘上方可视高度限高，不遮暗对话。面板自身承接纵向触摸和滚轮滚动，搜索框与技能管理入口固定在上下边缘；列表手势不触发侧栏导航，只有方向键选择会自动滚动到当前项，避免触摸滑动被悬停选中打断。技能和命令选择后填入输入框，保留原有文字；已有命令前缀仅在可识别时替换。Hub 操作直接打开对应面板，不清空草稿；未区分类型的原生条目不强行归类。
- **原生目标：** `/goal` 复用 agent 自己的目标状态和续跑。Codex、TraeX 使用 `thread/goal/get|set|clear`，目标启动前通过 `thread/settings/update` 同步线程设置；Claude 使用 ACP 的 `/goal` 和 `_session/goal`；zcode 使用 `session/goal`，等待原生整个续跑结束再释放线程。多轮输出、审批、错误继续走统一事件，Hub 不另做续跑循环、不写 agent 的状态文件。
  - Codex、TraeX、zcode：`/goal 目标` 设置，`/goal` 查看，`/goal pause` 暂停，`/goal resume` 继续，`/goal clear` 清除。Claude 支持设置、查看、清除，停止用现有停止按钮。
  - `capabilities.goal.controls` 声明运行中可立即执行的操作：Codex/TraeX 查看/暂停/清除、Claude 清除、zcode 暂停。这些操作复用发送接口，单独记录结果，不排到目标后面，也不抢占原轮次的输出或审批。会话尚未启动时返回可重试的错误，避免操作排队后无法执行；其他消息沿用原有排队规则。
  - `capabilities.goal.actions` 声明空闲时支持的目标操作；前端据此生成桌面命令面板中的目标条目、手机「＋ → 目标模式」菜单，设置目标打开中文表单，其余按钮发送对应原生命令。运行中只开放 `controls` 中的操作，计划模式下禁用设置与继续；这些按钮独立于当前草稿，不发送或清除草稿里的文字、图片、视频与协作对象。
  - 目标完成只表示原生 agent 的判断，Codex/TraeX/zcode 的状态摘要写「原生 agent 报告已完成」，Claude 保留原生回复。不支持原生目标的 agent 不补造能力；旧版本 RPC 不支持时显示错误。
- **Codex 命令走正式协议：** 额度通过 `account/rateLimits/read` 接入统一面板，优先读取多额度池，兼容旧版单池；`/review` 调用 `review/start`，`/mcp` 分页读取服务状态，`/skills` 和技能菜单按当前目录调用 `skills/list`。选择技能后发送结构化 `skill` 输入；查询命令不触发模型推理。终端专用操作仍由 hub 的模型、权限、状态等入口承接，不把未知斜杠命令当普通提示词发送。
- **选择账号时比较剩余额度：** 新线程与接手弹窗的账号选择器，在账号下用单行小圆环展示少量额度概况，正常状态用中性色；空间不足的周期收起，通过详情入口查看，不为展示全部数据撑高列表。桌面支持 hover 与键盘查看，手机点击查看；查看额度与选择账号是独立操作。详情展示全部实际返回的窗口、范围、重置与更新时间，不补造缺失周期。前端只看 `capabilities.quota`，复用现有额度接口与按主机、实例隔离的缓存；弹层可见时查询并每分钟更新，关闭后停止轮询。未读到额度不画空环，刷新失败保留旧值并提示；额度看板仍展示已用比例。
- **归档不删东西：** 归档只是从侧边栏隐藏并停掉 agent 进程，随时能恢复。永久删除默认只删 hub 的记录，可以勾选同时删 agent 自己的会话（agent 支持时）。
- **导入：** 只列出白名单目录里、目录还在的会话。历史由 agent 回放后一次写入事件日志（`turn.started` 带 `imported: true`）。导入后的线程继续用原来的会话 ID，一个会话只能对应一个线程。
- **分叉：** agent 复制自己那边的会话，hub 复制事件日志和图片，新线程记下 `forkedFrom`。可以到某一轮为止：两边各有各的轮次编号，所以 hub 先读 agent 的历史（`loadHistory`，每轮带一个 `forkRef`），用和终端同步同一套办法按提问文字对齐，再把那一轮的 `forkRef` 交给 `forkSession`；事件日志只复制到下一轮开始之前。最后一轮等于整个线程，不读历史。
- **斜杠命令分三层：** agent 报的照常列出；agent 只在终端界面里回答、但无界面下另有出路的，由适配器补上（agy 用单次 `agy -p /usage` 运行，pi 用 RPC 的 `compact`、`get_session_stats`，Claude 的 `/cost` 能答只是没列出）；实在没有的（Claude 的 `/status`、`/help`）由 hub 自己做，并把终端里的原名放进搜索关键词。
- **消息编辑：** 用户改自己已发的消息时，先让 agent 复制到这条消息**之前**的会话（`forkBeforeRef`：pi 是这条用户消息的 entry，Codex/TRAE 是这一轮的 turn，Claude 用前一轮最后一条消息），再从修改后的内容发一轮。当前对话从这条消息重新开始，后面的旧轮次移出当前事件日志，原样存进 `edited_events`，原线程 ID、标题和原生会话路径都不变，也不新建可见线程。原始 `seq` 只增不减（`event_sequences` 记住已用过的最大值），`turn_text` 同步删除旧轮次，搜索和导出因此只看当前对话。前端收到 `thread.historyChanged` 后重新读取历史，不靠隐藏消息或前端过滤。文件不回滚。能力 `editMessage`，与 `fork`/`forkAt` 分开；请求带请求 ID 与来源版本，重复请求返回同一轮，历史已被替换时要求刷新。
- **图片按 agent 的能力走：** 能直接收图的发图片本身；agy 只收文字，发文件路径让它自己打开；pi 的纯文本模型在装了 `pi-aux-vision` 后发路径，由它的 `describe_image` 工具交给视觉模型，没装就拦下并提示换模型。
- **排队：** 运行中发的消息排队（内存里，最多 5 条），每轮结束后发下一条；"立即发送"打断当前这轮；按停止则不发，文字退回输入框。
- **未读存在服务器上，** 所以手机上看过，电脑上也算已读。
- **等待状态：** 线程接口保留 `waiting`，并返回 `waitingReason`（`question` / `plan` / `approval`，无待处理请求时为 `null`）。从当前未解决的原生请求推导，回答、取消和到期后清除；多请求时权限审批优先，其次取最早未回答的提问或计划确认。前端统一映射文案，不按 agent 名称判断；旧 daemon 缺少类型时使用「等待处理」。
- **终端（第 10 节）：** 真终端要 PTY，首选 `node-pty`（退路 `script -qfc`）；传输沿用 HTTP + SSE（输出 SSE + base64，输入 POST），不引 WebSocket；终端是临时会话，不写 SQLite，daemon 重启即消失，空闲 30 分钟回收，最多 3 个；起始目录限白名单，之后 cd 不管。
- **agent 做不到的事不假装：** 没有审批的 agent 不显示"请求批准"；agy 因为不能询问而拒绝操作时，`turn.error` 带 `code: permission_refused`，界面提示切到"完全访问"。
- **工作目录白名单：** 只能在 `CALLI_WORKDIRS` 列出的目录里建线程。
- **回复引用的文件：** 图片与文本读取在原有目录校验外，允许当前线程已结束回复中以绝对路径明确引用的单个文件，位置不限（同仓库的其他 worktree、别的项目、系统临时目录）。用已有 `turn_text` 索引匹配完整路径，兼容旧记录与重启，不改 agent 会话、不复制文件。一般路径先解析符号链接（家目录常是链接）；系统临时目录是共享的，其内部符号链接一律拒绝。目录浏览与独立 HTML 预览仍限原有范围。文件不在返回 404，在但没被引用返回 403，图片接口里存在但不是可显示的图片返回 415，前端据此区分「文件不存在」和「无法预览」。
- **选择其他项目：** `GET /api/project-directories` 默认从当前 daemon 用户的家目录开始，按层只列文件夹，也可浏览已有可用目录；符号链接解析后仍须位于这些范围内，不提供文件内容。浏览不改变白名单，用户点击「添加并使用」后才通过已有 `POST /api/workdirs` 保存具体项目。家目录与根目录本身仍不能通过页面添加。远程请求全程走所选机器的代理；旧 daemon 保留已有目录浏览和手填添加，并提示升级服务。工作目录白名单是 hub 的入口校验，不替代 agent 自己的沙箱和权限策略。
- **agent 实例（多账号）：** 一个适配器可以起多个实例。实例来自 `data/agents.json`（或 `CALLI_AGENTS_JSON` 内联 JSON）：`{ id, adapter, label?, command?, env? }`，adapter 指到 `adapters/` 里的实现，command 不写就继承该适配器的默认。实例 env 合并进它起的所有进程（第二个 Claude 账号带自己的 `CLAUDE_CONFIG_DIR`），所以账号隔离和会话目录隔离都是实例属性。线程的 `agent` 字段存实例 id；内置实例沿用 claude/pi/agy(/traex) 这些名字，老数据零迁移。`GET /api/agents/discover` 扫 PATH 找同类 CLI（名字是 CLI 本身或数字后缀，如 `agy2`、`claude-2`；`ping`、`pix`、`claude-agent-acp`、`traex-bridge` 不算；同一可执行文件的多个别名只列一次，已挂在实例上的也不再列），`POST /api/agents` 添加后立即生效并写回 agents.json。已登录账号的发现：`GET /api/agents/accounts/discover` 让适配器找自己已登录的账号（Claude 扫 `~/.claude*` 目录、逐个 `claude auth status` 验证），已挂到实例上的不列，前端一键链接，差异（找哪里、用什么环境变量）都在适配器里。`#/agents` 管理页按适配器列出现有实例；`PATCH /api/agents/:id` 只改显示名，id 不变；`DELETE /api/agents/:id` 只删 hub 登记，线程（含归档）、定时任务、团队或自动交接顺序仍在引用时返回 409 和数量，不级联删除，也不碰配置目录、凭据和原生会话。适配器的 `loginCommand()` 生成终端登录命令，`POST /api/agents/:id/login-terminal` 在实例自己的 env 下新建 web 终端并执行；页面只拿到终端 id，不接收任意命令，不保存凭据。
- **独立账号与页面登录：** `POST /api/agents/accounts` 收 `adapter`、可选 `sourceId`/`label`，适配器的 `createAccount(directory)` 复制配置并返回隔离环境，registry 负责私有目录、唯一 id、失败回滚和持久化。Claude 只复制 `settings.json`、`settings.local.json`、`CLAUDE.md`、`skills/`、`agents/`、`commands/`、`hooks/` 与 `.claude.json` 的 `mcpServers`；去掉 API key / OAuth 环境覆盖、`apiKeyHelper` 与原组织绑定，不复制凭据、插件缓存、项目授权和会话。符号链接复制为独立内容。新实例的 `account: null` 表示待登录，缺字段仍表示原有本机账号状态未知。配置变更和登录回写排队，通过临时文件原子替换 `agents.json`。`GET /api/agents/supported` 的能力字段控制添加入口，`login: wizard` 控制页面登录，前端不按厂商名分支。
- **登录生命周期：** `POST /api/agents/:id/login` 启动或复用该实例的登录；`GET/POST/DELETE /api/agents/:id/login/:loginId` 分别查询、提交验证码和取消。适配器 `startLogin()` 起原生 `claude auth login --claudeai`，关闭远端自动开浏览器，用管道提取完整 HTTPS 授权链接并写入验证码；不自行实现 OAuth，也不向前端暴露 CLI 原始输出或 token。成功退出后再用同目录的 `auth status` 验证；超时 10 分钟、明确取消、移除实例、daemon 退出都会清理进程。页面离开或刷新可以重新点击「登录」接回尚未过期的流程；旧 loginId 不能向新流程写验证码。凭据只由 CLI 保存在实例目录，hub 持久化邮箱，不保存验证码或授权链接。
- **终端同步：** 打开线程时和每 30 秒（页面可见时）调 `POST /api/threads/:id/sync`，把 agent 那边的历史读回来（临时进程，只读），从头部逐轮和 hub 的事件对齐：hub 独有的取消轮最多跳过 3 条，对不齐就什么都不写。对齐之后多出的轮次整段补进事件日志，带 `fromTerminal` 标记（界面上一个小"终端"徽标），并记下 `externalAt`。`externalAt` 晚于最近一次 hub 轮（`hubTurnAt`）时，网页发送前弹确认——两边同时写同一个会话会乱序；从网页再发一轮后警告自动解除。同步本身有去重锁，轮询和手动拉不会重复导入。

- **交接定位：** 打开交接即由 hub 只读拼接实例 ID、项目 cwd、agent 配置/数据目录、原生 session ID 和实际文件地址，再附日志摘要。原生目录布局由适配器的 `sessionLocation()` 负责，前端不按 agent 名分支。Claude 恢复命令带对应 `CLAUDE_CONFIG_DIR`，不混用同名实例；找不到文件则明确标注，不回退到其他账号。`POST /api/threads/:id/handover-thread` 根据源线程创建独立空线程，沿用原 cwd、worktree 元数据和分区，按目标实例的默认权限初始化；不分叉原生 session，也不创建 worktree 或发送消息。前端先保存按机器/线程隔离的交接草稿，再打开接手线程，用户编辑后发送。复制内容要求接手 agent 使用自己的会话在原 cwd 继续；已有 worktree 通过只读 Git 探测定位，保留分支与未提交改动，不另建目录或要求用户手动开会话。
- **交接关系：** 独立保存 `handover`（来源线程 ID、标题与 agent 快照），与原生 fork 分开。同一机器、同一侧边栏分组内的交接链合为一个可展开入口，点击标题打开最新接手会话，整组按最近活跃时间排序；展开可切换每段会话，折叠时保留其他成员的运行、未读、错误或待批准标记。置顶和手动分区不被自动迁移，活动视图保持逐条显示。会话顶部的「交接记录」支持双向跳转；来源已不在当前列表时保留快照说明。升级只根据首轮中明确的本机交接信息、线程 ID、相同 cwd 和先后创建时间补全旧关系，不按同名标题猜测，也不跨机器猜关联。
- **交接即压缩：** 交接关系在 hub 中保存 `mode: continue | branch`。只有自动接力（continue，含额度快用完/用完触发、协作成员自动交接和额度报错卡片一键接手）合并为一段对话，前段只读，输入发给最新接手段；底层仍一段一个 hub 线程、一个原生会话。同实例支持换模型时仍在原线程中以分隔行标记。手动交接（branch）一律是独立会话，不提供方式选择，不停止来源，两个会话各有输入框，保留来源导航。侧边栏不按 mode 拆组：所有交接链都聚合成最新会话在上的一张卡片，可展开「N 个会话」，保留叠放 agent 小图标；普通行只保留 agent 图标与状态点，不显示分叉、工作树、交接符号，相关信息通过顶部或悬停查阅。记录标出自动接力/手动交接。旧关系没有模式，或自动接力后来源又开始新轮时，daemon 将正文关系推导成独立会话，不改写旧数据；用来源事件序号区分同时刻的轮次。不让一个线程中途换 agent：模型、权限、分叉和恢复命令都绑在线程的 agent 上；「只看这一段」只切换显示，而前段只读提示与交接记录里的「取消这次接力」会显式拆开来源段的所有直接 continue 出口，使来源和各接手会话分为独立侧边栏卡片，不删除任一原生会话或历史；来源段关闭后续自动交接，接手段设置不变，接手段后续的接力链也不受影响。同一来源存在多个接手分支时一起拆掉直接出口，否则任一旁支仍会让来源只读。协作成员接力拆开后，退休的旧段退出协作并恢复普通输入，接手段继续持有成员名字、未返回任务和消息路由，不做会造成重复执行的任务倒搬。交接摘要承担压缩：原 agent 还能运行时由它自己写（`handoverPrompt`），额度已用完则由 hub 从事件日志合成（`synthesizeHandover`），接手方可按交接信息只读查阅原会话文件。自动交接按会话、协作、全局三层取值：会话覆盖协作，协作覆盖全局，全局默认关、协作成员默认开，不设实例默认开关；轮次结束刷新额度，达到全局阈值（默认已用 90%）时优先让原 agent 写摘要，`plan_exhausted` 用日志摘要兜底。每个实例的有序目标可指定模型；模型额度由适配器映射，未知映射不用于同实例换模型。支持保留会话的模型切换在原线程进行，无需摘要；否则创建新接手线程。倒计时可取消，失败轮次和排队消息转交接手方，耗尽记录与会话去重分别保存，避免来回交接；只在轮次之间触发，hub 发起的交接轮带 `handover` 标记，不算用户提问。开关和每个实例的接手顺序存在 daemon（hub 自己的配置，不写 agent 的配置），由 daemon 判断是否触发，页面没打开也能自动交接；规则按机器保存，交接不跨机器。接手线程拿到只限本条交接链的只读 `calli` 凭证，按需读取来源线程的概况和历史，不能读别的线程，也不能写；不依赖是否开启协作。协作成员交接时成员名字不变，消息与结果投递改到接手会话，主控收到通知；接手首轮在领取任务时迁移成员身份，旧凭据撤销。实现与验证见 `auto-handover.md`。
- **定时任务（见 `scheduled-tasks-design.md`）：** 任务 = agent 实例 + 白名单内目录 + 提示词 + 5 字段 cron（预设生成）+ 执行模式（每次新线程 / 固定线程继续）+ IANA 时区（空 = daemon 本地）+ 错过可选补跑。调度器在每台 daemon 内（线程在哪台、任务在哪台），30 秒 tick；上一轮未结束跳过记 `skipped`，停机错过的记 `missed`（勾了补跑的再补一次），重启时收尾遗留的 running。线程带任务徽标，`turn.started` 带 `scheduled` 标记；权限档位建任务时显式选，默认「请求批准」。自写 cron 解析（含时区，`Intl` 取分量），不加依赖。已实现。

- **概览（见 `activity-design.md`）：** 每天的提问与工具调用从 hub 自己的日志出（`turn_text` 与 `events` 的 `tool.start`，事件里补存原始工具名，旧记录不回填）；整段系统提示词只读 agent 落盘的会话文件（Claude 的 `prompt_snapshot`、Codex 的 `base_instructions`、pi 的 system 消息），能力 `capabilities.systemPrompt` 控制，agy/zcode 未开。接口 `GET /api/activity` 与 `GET /api/threads/:id/system-prompt`；页面 `#/activity`。已实现。

## 网络与安全

- TCP HTTP API 验证 token（健康检查除外）；私有 Unix socket 免 token，目录与 socket 权限均为 `0700`。默认位于 `~/.local/state/calli/daemon.sock`，`CALLI_SOCKET=off` 可关闭。
- SSH 由 hub 的服务用户发起，使用其 SSH 配置和凭据，要求免交互认证。代理不转发 hub token，不在机器表保存密钥；主 hub token 的权限覆盖所有已添加机器。

- 通过 VPN 访问，HTTP + token。daemon 绑定内网地址，不绑 `0.0.0.0`。
- daemon 相当于远程 shell，只放在可信网络里。
- 因为是 HTTP，不是安全上下文：没有 Service Worker、系统通知和剪贴板 API。复制要用 `execCommand` 降级。

## 扩展机制（内置宿主与外部工作数据源已实现）

实时语音按可选内置扩展设计，安装依赖本机可用的原生语音提供者（当前为 Codex），通过宿主受控接口接入输入框与实时会话；跨 agent 转交单独验证。方案、所需 hook 与原生探测记录见 [实时语音接入设计](voice-design.md)。首版扩展、生产接线与假 agent/浏览器自动化已落地；真人听说、原生后台委托与计费仍待验收。

方向是「用一个简单的界面，把 agent 和它周边的工具串起来」。连接、会话、消息、进展、审批及其鉴权和协议适配留在核心，不装扩展也能完成基础流程；新增外围能力优先以扩展接入。统一入口同时管理两类生态：各家 agent 的 skills、MCP、插件等，以及 BotMux、LoopX 等独立工具。统一管理不等于格式互通，只向兼容的 agent 实例安装，并展示机器、实例和各目标的操作结果。现有技能页和 MCP 页仍是核心实现，其余形式待调研。

扩展宿主已支持内置看板与可独立安装的外部工作数据源，具体接口和首版限制见 [LoopX 接入记录](loopx-integration.md)。后续能力以清单声明状态、操作和设置，需要逻辑时使用独立进程，界面由宿主统一绘制；命令声明参数、目录、超时、取消和副作用，按授权范围执行。进程外运行不等于沙箱。先用真实集成提炼接口，再定协议；是否采用 MCP 及其界面扩展待调研。界面逐步汇入「配置 → 扩展」，只开放实际需要的位置，同一位置的信息由宿主聚合。

原生记忆看板以独立 `ext-memory` 包接入，默认未安装；在「配置 → 扩展」安装并授予 `memory.read` 后，通过适配器只读查询已有记忆，停用或卸载后撤销读取。

接口与生命周期先作为设计稿梳理：事后通知、按需请求结果、调用受控动作，不提供对核心发送或审批的拦截和改写。请求区分只读查询、续轮决策和有副作用的渠道投递：查询失败降级，续轮决策失败暂停推进，投递超时结果未知、有限重试仍可能重复。扩展接口按权限输出数据，不直接转发原始事件；停用或撤权后，宿主不采纳旧响应来发起后续动作。核心逐步补齐轮次来源和线程变更字段，兼容现有事件，按首批集成需要实现，不把全部候选接口作为首版前提。

首个界面集成采用「线程执行看板」：独立包走公开契约，宿主统一提供页面注册、路由、侧栏入口、看板与手机列表原语；不为每个扩展在 App 里增加分支。启用后可固定到侧栏，与计划、定时任务并列；配置页只负责管理。卡片是线程，进行中、等你、待验收、已完成四列由线程状态和 agent 的 `[进度]` 报告推出，避免和侧栏重复。看板经 `progress.report` 授权后，hub 请每个线程的 agent 在回复末尾报告进度；agent 只能请用户验收，完成由用户在卡片上勾选，新消息会重新打开。

看板是视图扩展，LoopX 是工作数据源扩展。宿主用一个小型工作投影契约连接它们，会话摘要、看板和详情消费同一份状态；源系统拥有任务状态，宿主不造第二份任务存储或工作流引擎。来源 id、外部工作项 id、机器和线程显式关联，不能只看目录推断。步骤和任务文字需要内容权限，不能放进默认元数据。具体流程、数据契约和里程碑见 [工作台扩展](extension-workbench-design.md)。

「BotMux 外部提醒」并行验证通知出口：首版只覆盖 hub 本机，默认提醒等待审批、等待回答或计划确认和失败，成功可选；内存队列、超时、有限重试，重启丢失待发提醒，不补发历史。先实现统一的结束与等待语义及线程深链，再验证「Calli 推送」和「BotMux 订阅」两条接法。BotMux 若从外部订阅，可以先不依赖完整扩展宿主；重连后只能核对当前仍待处理的状态，不承诺恢复断线期间已经结束的事件。

LoopX 先验证结构化状态、关联与原生循环，接只读工作投影；操作逐项核实真实语义后再开放，额外的 Hub 自动推进后续单独设计，不替代已实现的原生 `/goal`。任务控制按线程授权，消息可见并带来源，入队前重新校验状态，与原生循环互斥。看板通过后再评估现有页面的一小块只读列表迁移。

首个官方看板放在本仓库的独立 package，契约单独成包；社区扩展可以放独立仓库。运行时安装固定版本的构建产物，清单声明版本、兼容范围、权限和贡献点，按机器启停；源代码仓库不等于运行时，也不承诺任意 Git 仓库可直接安装。首版不建市场。

Calli 扩展不进入 agent 的工具循环，不改用户消息、上下文或系统 prompt，不替人审批，宿主不向扩展提供原始 Api 或 Hub token。管理用户选择的 agent 原生扩展与此分层。通用的 agent 配置写入能力仍是待确认提案，受 `AGENTS.md` 当前原则约束；现有技能和 MCP 的特定操作不自动授权第三方扩展。若以后开放，须经宿主和适配器的受控操作，展示目标及改动，不提供任意文件写入接口。详细边界和验收见 [扩展设计](extensions-design.md)。

## 开源

- 不写入 token、IP、主机名、个人路径、内部链接。
- 路径来自配置或环境变量。agent 可执行文件从 `PATH` 找，或用 `CALLI_*_BIN` 指定。
- 许可证 MIT。

## 第三方扩展审查记录

装进 agent 的第三方代码要先读源码。

| 包 | 结论 |
|---|---|
| `pi-aux-vision@0.5.1` | 可以装。只注册 `describe_image` 工具，当前模型不能看图时才出现；调用视觉模型走 pi 自己的管线和登录，没有自己的网络请求；读文件前确认是真图片；只写自己的配置文件。唯一的命令执行是 Windows 上用 PowerShell 生成测试图 |
| `@z_ai/mcp-server@0.1.5` | 不推荐。没配 `Z_AI_API_KEY` 时会把 `ANTHROPIC_AUTH_TOKEN` 当成 key 发给智谱；模型给什么路径就读什么文件上传，不检查是否是图片 |
| `pi-vision-handoff`、`@getpipher/vision` | 没细审。前者自动转述（不是工具调用）；后者自己直连 `/chat/completions`，还写缓存和审计文件 |

## 全局技能管理

跨 Agent 的能力借用采用统一 CLI、按需加载 Skill 和适配器提供的能力目录。支持反重力生图/搜索、Codex 搜索/网页读取，独立线程执行，返回可查询任务、来源或校验后的图片。Computer use 由 Codex 会话动态工具操作 Calli 独立浏览器，明确标注浏览器范围，逐步返回截图并在结束或取消时释放环境；尚未接入的原生桌面与反重力 IDE 浏览器不冒充可用。设计与调用方式见 [Agent 能力借用](borrowed-tools.md)。不新增 MCP 连接，也不把所有能力说明放进每轮上下文。

配置菜单中的「技能」按技能列行、按机器列列，单元格显示可见该技能的 agent 实例；手机将机器信息放到技能下方。支持搜索、说明预览、选择来源与目标同步、冲突后显式覆盖，以及删除指定位置的副本。离线机器保留列并显示读取失败。

参考 [Vercel skills](https://github.com/vercel-labs/skills) 的目录映射与文件复制方式，以及 [skills-manager](https://github.com/xingkongliang/skills-manager) 的跨 agent 可见性设计。目录知识只在适配器的 `skillDirs()` 中：实例自己的全局技能目录可作为安装目标，共享目录只作为发现来源。当前覆盖 Claude、Codex、pi、agy；Codex、pi、agy 同时发现共享用户技能。第一期不扫描项目技能、插件内技能，也不从市场下载或自动追踪上游更新。

各机器通过自身 daemon 提供 `/api/skills`、`/detail`、`/export`、`/install`；浏览器通过已有主机代理传递文件载荷。复制全部普通文件并保留可执行位，SHA-256 覆盖路径、完整内容与可执行位。相同内容跳过，不同内容默认不覆盖；先在同目录写完新副本，再替换目标，替换失败恢复旧副本。技能根目录可以是软链接，内部链接只允许指向技能内，循环或指向外部的链接拒绝导出。删除根软链接不删除其指向的技能。

同步限制为 400 个文件、单文件 4 MB、合计 16 MB。校验目录穿越、文件与目录冲突、缺少 `SKILL.md` 及非法编码。技能列表短暂缓存 3 秒，写入后失效。不改 agent 配置或会话；新增技能是否立即可用仍取决于各 agent 的重新加载机制。

## MCP 管理

「配置 → MCP」按业务线管理各机器各 agent 的 MCP 服务。哪个文件存 MCP 是适配器自己的知识（`mcpServers()`/`mcpInstall()`/`mcpRemove()`）：Claude 的 `~/.claude.json` 用户级（设 `CLAUDE_CONFIG_DIR` 时先看配置目录内）、Codex 的 `config.toml` `[mcp_servers.*]` 表、pi 的 `~/.pi/agent/mcp.json`。未实现的 agent 不出现在页面上；前端按接口返回的 `writable` 判断能否安装/移除，不按 agent 名字分支。

- 页面沿用技能页矩阵：行是服务、列是机器、格子是装了它的实例标志。hub 自己的 `mcp_entries` 表（SQLite，name 主键）按名字挂业务线与用途说明；带整份配置的条目就是手动登记的服务，装到任何机器前以「已登记」徽标显示。
- 配置原样旅行：安装携带配置对象本身，pi 的 `exposure` 等各 agent 私有字段随之保留。相同配置视为已装（`same`），不同配置默认拒绝（`exists`），显式确认才覆盖。
- 写入是外科手术式：JSON 只动 `mcpServers` 下那一个名字，TOML 只替换该服务的表块（含子表），文件其余字节不动；临时文件 + rename 原子落盘，保留原文件权限。服务名限 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`，不含点，避免 TOML 子表歧义。
- 环境变量只在详情弹窗里展示。这不是安全边界（hub token 本就能开终端），只是不让列表被密钥刷屏。
- 第一期只读用户级配置：Claude 项目级 `.mcp.json` 和 `.claude.json` 里 projects 下的本地 scope 不扫。

## 用量统计与诊断

已接入原生消耗采集、滚动 TPM、用量账本和实例诊断。统计粒度、未知字段、缓存与费用口径，以及接口和验证见 [用量统计与诊断](observability-design.md)。

## 多语言

界面支持简体中文、英文、日文。只翻界面，不翻 agent 的回答和用户自己写的内容。

- **字典：** `packages/web/src/i18n/locales/` 每种语言一个文件，键是英文点分名（`sidebar.newThread`）。`zh.ts` 是源语言，其他语言的类型就是它的类型：少键、多键、参数不一致都过不了类型检查。带数值的消息写成函数（`(n: number) => …`），参数有类型，各语言自己决定语序和单复数，不做 ICU 那种字符串插值。
- **取用：** 组件里直接 `t('key', ...args)`，不用 hook、不用 Context。语言在第一次渲染前定下，切换时存进 `localStorage`（`calli.locale`）并刷新页面，所以模块顶层算好的常量（权限名、外观选项）也是对的。
- **选哪种：** 没选过就按浏览器的 `navigator.languages` 找第一个支持的，都不支持用英文；选了以后以选的为准，「跟随系统」清掉选择。入口在「配置 → 语言」，每种语言用它自己的文字写（简体中文 / English / 日本語），看不懂当前语言的人也找得到。
- **格式：** 日期、数字、列表用 `Intl`，按 `localeTag()`（zh-CN、en-US、ja-JP）格式化。`<html lang>` 跟着设，字体按 `:lang()` 换：英文拉丁字体在前，日文日文字体在前，免得共用汉字显示成中文字形。
- **不翻的：** hub 和 agent 之间按字面解析的协议文字（注释格式、协作消息头、接手标题后缀）保持中文；斜杠菜单的搜索关键词保留中文别名。单元测试会扫 `src/` 里组件中的中文，除了这些例外都要走字典。
- **daemon：** 请求带 `Accept-Language`（用 hub 里选的语言，不是浏览器的），daemon 生成给人看的文字（错误、cron 描述、交接摘要）以后可以按它翻译；目前 daemon 仍输出中文。
