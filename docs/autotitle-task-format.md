# 自动取名任务标题格式

## 技术方案

增量扩展现有内置 `ext-autotitle`，不新增插件框架、Stop Hook、权限或接口。参考 Open WebUI 的独立标题任务与可配置提示词，以及 LibreChat 对手动标题所有权的保护；编号和真实状态由 Calli 宿主负责。

- 现有 `hub_settings.autotitle` 增加 `titleFormat: string | null`，默认 `null`。旧设置自动补默认值，原 Agent、模型、规则、首次发送／完成触发、第三轮再命名选项不变。
- 简短标题继续使用原 Prompt、单行输出与 40 字素清理逻辑。
- 任务标题预设为 `{state} [#{number}] [{topic}] {mandate} · {focus}`。支持单行自定义模板，最多 256 个字符串单元；仅允许 `{state}`、`{number}`、`{topic}`、`{mandate}`、`{focus}`，且至少含一个主题／主线／重点字段。不支持表达式、嵌套模板和大括号转义。
- 模型只返回 `topic`、`mandate`、`focus` 三个非空字符串，分别最多 16、34、30 字素。输入包含当前标题、最初请求、最近三轮用户消息与回答，并截断单段文字；发送时命名不读取尚在生成的回答。模型返回额外状态／编号不会被采用。无效 JSON 或空字段保留原标题、记录错误，不换 Agent 兜底。
- 宿主在应用时读取等待、运行、错误、用户明确完成标记，生成状态图标。一轮结束、模型声称完成、停止或中断均不自动等于整个任务完成。图标不是持续同步的状态徽标。
- 首次命名仍由 `trigger` 决定。新增 `every: number | null`：设置后在第 N、2N、3N… 个用户轮次正常结束时再命名，N 为 2–50 的整数；留空关闭。旧的 `again` 一次性第三轮设置继续兼容，读取时映射为 `every = 3`；界面保存间隔后不再使用旧开关。
- `threads.title_number` 是可空、唯一的持久编号；首次实际应用含 `{number}` 的标题时分配。下一编号单独保存到 `hub_settings`，编号递增且删除不复用；归档、恢复、切回短标题及再次命名均不改变已有编号。编号字段不扩展公开 ThreadRecord，也不从标题文字猜测。
- 预览仍返回 `{title: string}`，不写标题、不分配编号；未编号的线程显示 `[#?]`，已有编号原样显示。没有 `{number}` 的模板不占用编号。
- 分配编号、模板渲染与应用标题在同一事务中完成，失败回滚；过长任务标题报错而不是把末尾重点截掉。自动命名不改变最近活动排序。
- 任务标题生成期间若被停用、格式变化、用户改名或出现新一轮，则丢弃旧结果，不分配编号。原有手动标题归属保护继续生效。
- 设置页提供简短／任务标题切换、任务模式模板编辑、保存／恢复预设、占位符说明和失败提示。试标题前先保存有效的编辑内容。中英日文案同步。

### 跟随会话模型

- `hub_settings.autotitle` 增加 `modelSource: 'fixed' | 'session'`，默认 `fixed`。固定模式沿用原「指定 Agent + 模型」；跟随模式在触发时读取被命名线程的 `agent` 与当前 `model`，用它们执行命名。
- 跟随模式不要求配置固定 Agent；线程 `model` 为空时使用该 Agent 的默认模型，与线程自己的对话行为一致。
- 触发时形成快照：排队的命名在真正执行时再读取线程当前 Agent 与模型，因此切换过模型的会话按最新选择取名。
- 「重新取名」「整理现有线程」和自动命名共用同一解析逻辑；预览也按目标线程解析，不会改动线程。
- 设置页在「取名的 Agent」区域提供来源选择；跟随模式下隐藏固定 Agent／模型选择，并说明使用线程自身的 Agent 与模型。

本改动不增加思考强度、完整 Prompt 模板或每轮更新；这些与标题格式、模型来源独立，后续仍可在同一插件中增量扩展。不修改业务 Agent 的目录、配置或原会话，不承诺所有 Agent 都能硬性禁止命名任务调用工具；沿用 `askOnce` 的 scratch 隔离、超时和审批／输入取消。

## 代码修改方案

1. `packages/daemon/src/autotitle.ts`：增加可选设置及校验、`modelSource` 解析、任务字段 Prompt／解析、按字素截断、状态映射、单次模板替换、近期上下文和应用前校验。默认短标题分支与固定模型分支保持原协议。
2. `packages/daemon/src/store.ts`：幂等新增编号列及唯一索引，提供只读编号和事务分配方法；字段注释说明编号生命周期。
3. `packages/extension-api/web.d.ts`：仅扩展现有设置类型，不改宿主 facade 或返回值形态。
4. `packages/ext-autotitle/src/`：在原页面内增加来源选择、可选格式控件与错误反馈，复用宿主 UI 和样式变量。
5. `packages/daemon/test/autotitle.test.ts`：覆盖旧配置、模板校验、编号持久／回滚／不复用、预览、格式切换、主机状态、无效输出、过期、首次／第三轮触发及跟随会话模型。
6. `packages/daemon/test/fixtures/fake-acp.mjs`：仅任务命名请求返回字段 JSON，保留原短标题 fixture 行为；支持无效字段、长字段和延迟回复回归。
7. 前端回归与 `docs/PLAN.md`、`docs/TODO.md` 同步。

## 验证

2026-11-16 验证结果（最新 main 合并后）：

- 自动取名专项 26／26 通过，包含原 13 项、任务标题 11 项、跟随会话模型 1 项与轮次间隔 1 项。
- 扩展浏览器回归 12／12 通过，覆盖间隔输入、保存失败提示与来源选择。
- `npm run typecheck`（daemon、web、ext-autotitle）通过，`npm run build` 通过。
- daemon 全量：1,278 项，1,266 通过、11 失败、1 跳过；失败项与未修改 main 的既有 Claude 网关／额度／会话位置／SSE 失败一致，未发现自动取名相关失败。
- 已在隔离实例检查实际页面：桌面与手机视口、亮色与深色；核对简短标题、任务模板、后端校验错误、未分配编号预览、重复应用保持编号及保存 `null` 恢复简短路径；轮次间隔输入在上述四种组合下布局正常、无横向溢出。
- 假 Agent 回归不代表真实模型的命名质量或 JSON 遵循率；手机视口验收不等于实体手机／Safari 验收。

## 参考

- [Open WebUI 标题任务与 Prompt 配置](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/tasks.py)
- [LibreChat 显式标题所有权](https://github.com/danny-avila/LibreChat/blob/main/packages/api/src/conversations/title.ts)
