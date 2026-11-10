# 自动交接（第三阶段）

交接由 daemon 在轮次之间执行，浏览器不在线也生效。本阶段不加入 `/handoff`。

## 行为

- 开关优先级：会话 > 协作 > 全局。全局默认关，但从没保存过这项设置的 hub 在 daemon 启动时写入「开」（`seedDefault`），之后在设置页关掉就一直关；协作成员默认开，协作可整体关闭，成员会话可覆盖；主控会话独立取自己的会话或全局值。
- 全局阈值默认已用 90%，可设 1～99%。轮次结束强制刷新实例额度；`checkedAt` 超过 30 秒、查询失败或空数据，不触发主动交接。一次运行、待批准或待回答期间不会交接。
- 接近阈值时原 agent 在原会话里接收 `handoverPrompt`，其回复作为摘要；摘要轮失败则用日志摘要。套餐已耗尽的 `plan_exhausted` 直接使用日志摘要，并重试失败的用户消息。图片、视频及等待中的消息保留并转交。
- 摘要准备完毕，显示 5 秒倒计时，可取消。取消本次额度事件后不立即反复提示，观察到额度恢复才重新允许；不同会话独立去重。
- 配置里的顺序可以是实例，也可以是实例加模型；没有配置才使用同类型其他实例优先。没配置顺序时候选还必须读得出套餐额度窗口，也就是订阅账号交给订阅账号；同一适配器下接第三方端点的桥接实例（读不出套餐）不会被默认选中，只有顺序里明确写出才会用。已知耗尽/接近阈值、未连接及无法保持来源权限级别的目标会跳过，没有可用目标时保留队列并显示停止提示。目标在倒计时结束后再次验证。
- `QuotaWindow.modelIds` 由适配器提供。agy 映射 Gemini、Claude、Claude and GPT 模型组及精确模型名；TRAE 用 `config_name` 或模型标识关联。未映射窗口可以决定跨实例交接，不能据此选择同实例的另一个模型。目标模型需要有明确、健康的独立额度窗口。
- `capabilities.modelSwitch` 表示模型切换保持原生会话；包括 agy 用原 conversation ID 重启 CLI。此时保持原线程、不写摘要，时间线记录模型切换。没有此能力则新建接手线程。已耗尽时切换模型后先重试失败轮次。
- 协作成员迁移在接手首轮领取任务时进行，成员名字、角色和目录不变，排队消息、未完成投递及结果改到接手会话；原凭据撤销，旧会话不再投递结果。主控收到通知。主控自己交接时也迁移协作根。

## 存储与接口

本机 SQLite 的 `hub_settings` 存全局开关、阈值、有序目标、会话覆盖、已知耗尽记录和额度事件去重；协作开关随已有协作记录保存。不修改 agent 目录、配置或原生会话文件。倒计时不跨 daemon 重启恢复，避免重启后突然发起新工作；已保存的耗尽和去重记录仍然生效。

- `GET/PUT /api/handover-settings`：读取和保存 `{ enabled, threshold, orders }`。
- `GET /api/threads/:id/auto-handover`：生效值、来源、进展和首个可用目标。
- `PATCH /api/threads/:id/auto-handover`：`enabled: true | false | null`，`null` 恢复继承。
- `DELETE /api/threads/:id/auto-handover`：取消当前交接。
- `PATCH /api/threads/:id/collaboration-handover`：协作成员整体开关。
- 原 `handover-thread` 接口增加可选 `model`。原手动摘要接口仍拒绝相同实例；自动流程内部允许不支持模型保留时在同实例创建新会话。

新接口延用本机鉴权和多机器代理边界。会话列表随 SSE 提供简短状态，设置页逐个展开实例时才加载模型选项。

## 额度读数的三个来源

参考 magpie（yetone/magpie）的三层方案，同名常量与解析对齐：

1. **随回答上报（首选）**：Claude Code 应答时经 ACP `usage_update` 的 `_meta._claude/rateLimit`（即它的 rate_limit_event，来自 Anthropic `anthropic-ratelimit-unified-*` 响应头）带出 `unifiedWindows`。适配器经 `onQuotaObserved` 上报，daemon 写入额度缓存（`observeQuota`）：零探测成本、每轮新鲜，探测被 429 挡住也可用。
2. **后台轮询**：活跃实例每 3 分钟探测一次（`refreshQuotas`，走各适配器自己的 `fetchQuota`）。
3. **快照兜底**：探测失败时接受 15 分钟内的最近读数（`decisionQuota`），避免“快没额度也不动作”；压缩与交接的轮间判定都走它。

## 自动压缩（额度阈值）

- 全局默认关，`GET/PUT /api/autocompact-settings` 读写 `{ enabled, threshold, agents, minChars, chunkChars, maxChars }`，`agents` 是按顺序尝试的压缩 agent（`{ agent, model? }` 列表，最多 8 个，前一个不可用或失败就换下一个；旧的单个 `agent`/`model` 读取和保存时都折成一项的列表）；阈值须低于交接阈值（默认 85% < 90%）。
- 轮次结束、额度达到阈值且转录不短于 `minChars`（默认 24 万字符）时：配置了压缩 agent（如 magpie 桥接的第三方模型）则由它把转录压成富摘要，同账号新会话带摘要继续；未配置则原地 `/compact`。一个会话只压一次；压缩不消耗官方账号额度。
- 同一组压缩 agent 也用于交接：原 agent 写不了摘要（套餐耗尽，或摘要轮失败）时，由它们读 hub 记录写一份摘要，放在接手提示里「接手」与日志整理的事实之间；全都不可用或失败才退回只用日志整理的简报。原 agent 还能回答时仍由它自己写。上下文超过 5 万 token 的会话不走 resume 复制，自动改用摘要交接。
- 压缩和交接摘要的提示词在 `packages/daemon/src/compress-prompts.ts`，只含措辞，改它不用碰流程。
- 压缩后交接复制的就是小会话：resume 首轮只重读摘要体积，而不是压缩前的整段历史。

## 额度恢复自动续跑

额度耗尽后没被交接走的会话（自动交接关闭、没有可用目标、或取消了倒计时）停在原实例上。可在出错卡片上点「等额度恢复后自动继续」，daemon 记一条守候；设置页「额度恢复后自动继续」开关（默认关）则让之后所有这样停下的会话自动进入守候。已交接的会话不接回：工作已经移到接手方，接回会双跑。

- 守候记录 `{ agent, failedTurn, origin, resetsAt, nextCheckAt, probes, createdAt }` 存 `hub_settings`（`handover.resumes`），daemon 重启后仍在；恢复动作必须以一次新鲜的额度读数为准，不盲信重置时间。
- 唤醒：按额度窗口的 `resetsAt`（加 2 分钟余量）唤醒；未知则退避轮询（5/15/30/60/120 分钟）。探测有成本（Claude 要起一次 CLI），不空转。探测 10 次或等待超过 24 小时仍未恢复则放弃，卡片上的入口重新出现。
- 恢复：清掉停止提示 → 时间线记 `handover.resume` 分隔行 → 原样重发失败那一轮（同模型切换重试的路径）→ 释放排队消息。手动交接、删除线程、归档或线程自己跑起来时丢弃守候。
- 界面：出错卡片在「交给 X 接手 / 选择其他智能体」下面加一行安静的文字链接，不挤按钮行；已守候时变成「额度恢复后自动继续 · 预计 {时间}」加「取消等待」。手机上独立一行。一键接手目标按最新额度即时计算；暂时没有可用目标时出错卡片每 30 秒重查，额度回落或目标恢复后按钮自己出现，不必重开线程。
- 接口：`PUT /api/handover-settings` 增加 `resume: boolean`；`PATCH /api/threads/:id/auto-handover` 接受 `resume: boolean`（true = 本会话守候，false = 取消）。`GET` 与会话视图返回 `autoHandover.resume`。
- 测试杠杆：`CALLI_RESUME_TICK_MS`、`CALLI_RESUME_GRACE_MS` 环境变量可在测试里缩短周期，生产默认 30 秒 / 2 分钟不变。

## 套餐耗尽证据

2026-10-21 只读检查本机安装 CLI，未人为耗尽真实账号：

| 适配器 | 实际内置文本 | 本阶段处理 |
|---|---|---|
| agy | `You have exhausted your quota on this model.` | 精确匹配该句；`fake-agy.mjs` 的 `quota-exhausted` 返回该错误 |
| TRAE | `You've hit your usage limit for …`、`You've hit your usage limit.` 等 usage-limit 文本 | 识别明确套餐限制；TRAE 使用的 `fake-codex.mjs` app-server 输入 `quota-exhausted` 返回相同格式 |
| zcode | 发现的是工作流子任务的 provider 配额说明和工具的 `quota_exceeded` | 不能证实是主会话套餐耗尽错误，不新增规则；仍可利用已报告的额度做跨实例主动交接 |

Claude/Codex 原有匹配保留。不把普通 429、磁盘 quota exceeded 或图片生成额度耗尽视为模型套餐用完。真实线上耗尽响应的端到端触发未验证；上述文本证据来自安装产物，不是猜测 API 返回值。

## 验证

`packages/daemon/test/auto-handover.test.ts` 覆盖新接口校验/持久化、三层优先级、轮后刷新、不使用未知/陈旧数据、原 agent 摘要、摘要失败、耗尽兜底、队列迁移、取消/恢复再触发、模型切换与失败轮重试、无目标停止、禁止回接、不同成员会话独立去重、协作身份迁移、主控迁移及真实格式错误的适配器识别。`packages/daemon/test/quota-resume.test.ts` 覆盖守候的启停校验、退避与到点重发、排队消息跟进、重启恢复、全局开关收编与只保留手点守候、交接/接手后丢弃、多次探测后放弃、未来重置时间不提前探测。

`packages/e2e/test/auto-handover.spec.mjs` 使用真实 daemon、假 agent 和真实无头 Chromium，验证主动交接完整路径、同实例换模型且刷新后分隔仍在、取消、耗尽兜底、跳过未连接/高额度实例、设置保存、桌面拖动/手机点按排序、会话覆盖、协作开关优先级，以及主控通过真实 `calli spawn/send` 在成员交接前后派发消息。

浏览器检查覆盖 1440×960 桌面、390×844 手机尺寸，亮色与深色。截图保存在 `packages/e2e/shots/auto-handover/`，不纳入 Git。未测实体手机、真实账号耗尽/恢复、真实服务端的配额窗口更新延迟，也未把 zcode 未核实错误纳入识别范围。

## 改动范围

- 调度与持久化：`daemon/src/auto-handover.ts`、`threads.ts`、`coordination.ts`、`store.ts`、`http.ts`、`events.ts`、`history.ts`。
- 适配器：`daemon/src/adapters/types.ts`、`agy.ts`、`traex.ts`；`claude.ts`、`codex.ts`、`pi.ts`、`zcode.ts` 声明保持会话的模型切换能力。
- 页面：`web/src/components/AutoHandover.tsx`、`HandoverDialog.tsx`、`AgentPanel.tsx`、`ThreadView.tsx`；`App.tsx`、`api.ts`、`timeline.ts`、`styles.css`；`i18n/locales/zh.ts`、`en.ts`、`ja.ts`。
- 测试：`daemon/test/auto-handover.test.ts`、`history.test.ts`、`handover-api.test.ts`；`web/test/timeline.test.ts`；`fixtures/fake-agy.mjs`、`fixtures/fake-codex.mjs`；`e2e/test/auto-handover.spec.mjs`、`handover.spec.mjs`。原手动交接测试同步到第二阶段的合并会话输入框行为，并检查新的默认接手选择。
- 文档：`docs/TODO.md`、`docs/PLAN.md`、本文。上述包路径均位于 `packages/`。

## 本次验收结果

- `npm run typecheck && npm test && npm run build` 通过：940 项测试中 939 项通过，1 项真实 zcode 测试按默认条件跳过，其中新增自动交接 daemon 测试 18 项。
- 自动交接 E2E 8 项、手动交接 E2E 6 项通过；合并交接历史、普通懒加载历史、导入历史和重开会话合计另外 12 项通过。此前普通历史的偶发失败本次未复现。
- 初次回归发现的关闭时异步额度检查、手动摘要接口同实例校验、成员旧会话重复计数、手机实例名称隐藏问题已修复；旧手动交接测试更新为第二阶段的合并会话输入框语义。
- 仅在独立 worktree 分支验证，不重启现有 hub、不推送。测试 daemon 由测试 harness 保存 PID 并清理。

## 界面复验调整

接手目标行改成无边框的拖动手柄与更多菜单。桌面拖动手柄排序；手机、键盘通过更多菜单上移、下移或移除，实例名称保持可区分。

hub 发起的摘要轮次在合并视图和单段视图中统一显示为可展开的交接分隔行。历史快照、重连和实时流只传摘要状态，展开时通过 `GET /api/threads/:id/history/summary?turn=…` 读取提示词和摘要；摘要超过 16000 字符时继续分页。错误和待决定事项保持直接可见。接口补充鉴权、参数和读取测试，历史投影及时间线补充折叠测试。

重拍 `countdown-desktop-light.png`（含倒计时与取消按钮）、`model-phone-dark.png`（等待侧栏收起及正文归位），新增 `lead-notification-desktop-dark.png`（主控收到成员交接通知）。设置弹窗与会话设置的桌面/手机亮暗截图一并更新。
