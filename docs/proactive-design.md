# 主动行动分级：让大肥鱼敢动手

2026-11-01 · 设计稿。接在 [个人目录文件](personal-files-design.md) 的「提前行动」后面。

## 结论

大肥鱼现在只有 L0「主动发现」：找事、分轻重、早晚报，真正动手要人说「开始」。要更主动，前提是用户亲口总结的两条：**做错了不伤环境（沙盒），并且能回滚（git 标记）**。再加一条：**默认全关，用户主动开启**。分级如下，越往上越要人点头：

| 级别 | 她能做什么 | 在哪做 | 怎么撤回 | 默认 |
|---|---|---|---|---|
| **L0 发现** | 找事、分轻重、早晚报 | 只读 | — | 开（已上线） |
| **L1 准备** | 提前备材料：回复草稿、周报草稿、会前提纲、查背景、一页纸 | 只写个人目录 `matters/<id>-<slug>/artifacts/` | 不用就扔；个人目录 git 留底 | **关**，随总开关打开生效 |
| **L2 沙盒动手** | 代码类事项直接做：修 bug、补测试、改文档 | 独立 worktree，分支 `calli/proactive/<事项ID>`，跑测试 | 合入前「丢弃」；合入后按提交标记一键 revert | **关**；总开关之外还要按仓库单独允许 |
| **L3 对外动作** | 发飞书、推远端、付款、删除 | — | 撤不回 | **永远要人点头**，本设计不改变 |

## 开关（三档：关 / 观察 / 自动）

私人设置新增「主动行动」一节，默认整体关闭，存 hub 设置（不进仓库）：

- `mode: 'off' | 'observe' | 'auto'` 三档开关，默认 `off`。参考 DeepSeek 原型的 Accept mode：没人要求的工作，先只记录「本会做什么」，人看过觉得对再放开。
  - **观察（observe）**：tick 走同样的门控与候选规则，但不建沙盒、不开线程，只写一条 `{ status: 'observed' }` 记录，`summary` 由代码拼（不调模型），例：「会为「会前提纲」提前准备材料：重要，今天截止」「会在 repo 的沙盒里继续「修登录」：你之前开始过这件事」。每条可以点「这条可以」（`approve`，见 API）；看过几条再切到自动。
  - **自动（auto）**：行为与本节其余描述完全一致。
- 迁移：存量 `enabled: true` 读取时迁为 `auto`（已打开的人保持现状）；`false`/缺省迁为 `off`。保存接口兼容旧布尔：`enabled: true` → `observe`（新打开先观察），`false` → `off`；同时给了 `mode` 时以 `mode` 为准。返回值是新形状，带只读兼容字段 `enabled: mode !== 'off'`。
- `repos: string[]` 允许沙盒动手的仓库（绝对路径），逐个添加；为空则 L2 永不运行。保存时校验路径在允许的工作目录内、是 git 仓库。
- 每日上限固定默认：L1 ≤ 5、L2 ≤ 2，先不做界面调节。观察记录不计入每日上限，但计入 60 分钟间隔；同一事项同一 kind 24 小时内只记一条（`approved` 也算）。
- 关掉（`off`）：进行中的回合照常结束，不再开新的主动回合。

## 什么时候动（空闲判定，全部代码判定，不调模型）

同时满足才动，任一不满足就安静待着：

1. 不在安静时段（沿用私人盘点的安静时段，默认 23:00–08:00）。
2. 没有任何运行中的线程。
3. 距上一次主动回合 ≥ 60 分钟。
4. 今日主动回合数未达上限。
5. 候选为空不算错误：不推送、不开线程、不为了显得主动去凑活。

## L1 准备

- **候选**（确定性规则）：未完成、未提议（`proposed`）、重要（`importance: high`）或紧急，两天内有截止或当天的日程信号，尚无「已备好」材料，且无进行中工作线程。
- **动作**：像 `delegate` 一样开一个工作线程（cwd=个人目录），提示词说明这是提前准备：按接续说明产出材料，写入 `matters/<id>-<slug>/artifacts/<名称>.md`，用 `calli todo update` 在接续说明记一句「已备好 X」；不碰外部（不发消息、不改外部仓库）；没值得准备的就安静结束。
- **落盘**：回合结束后 daemon 把新增/变更的 artifacts 提交进个人目录 git（作者 Calli，信息写事项 ID 与操作名）。
- **可见**：桌面该事项摊开层出现「已备好」卡（由 run 记录驱动，列出材料文件名与摘要，不推送打扰）；run 的 `files` 字段存 artifacts 文件的相对路径。

## L2 沙盒动手

- **候选**：事项未完成、无进行中线程，**此前被「开始」过**（有关联工作线程，cwd 在允许列表的仓库内）——首次动手仍由人发起，主动只在已有授权的事项上继续。
- **动作**：
  1. `ProactiveSandbox.prepare(repo, matterId)`：在 `<repo>/.worktrees/` 建 worktree，分支 `calli/proactive/<事项ID>`（已存在则复用）。
  2. 开工作线程，cwd=worktree，提示词：这是沙盒，按接续说明推进；每个提交带 git trailer `Calli-Proactive: <事项ID>`；跑该仓库测试；不推送远端、不动主工作区；结束回复写改动摘要与测试结果。
  3. 回合结束：daemon 收集 diff（文件与行数统计）与 worker 自报的测试结果，写 run 记录，发一条 notice「已在沙盒做好：<事项>」。
  4. **静默试、成了才说**：测试结果明确失败，或没有任何可审的改动 → run 记 `discarded` 并附 `discardReason`（「测试未通过」/「没有可审阅的改动」），不发 notice、不出 ready 卡片。失败判定只看 worker 回复「## 测试结果」段落里的明确失败词（「失败」「failed」「not ok」），判不出来按通过处理，原文留在 `testReport` 里给人看。沙盒 worktree 与分支保留，由人手动「丢弃」。
- **人的决定**：桌面该事项摊开层一张「已在沙盒做好」卡：改动摘要、测试结果、文件数；三个动作：
  - **看改动**：Dialog 按文件列出新增/删除行数，整段 diff 按需再取。
  - **合入**：`merge --no-ff` 回仓库默认分支，合入提交带 trailer；只发生在本地，绝不推远端。
  - **丢弃**：删 worktree 与分支（`ready` 与已有分支的 `failed` 都可丢弃，后者的分支是启动失败留下的残留）。
  - 合入后卡变「已合入」，**撤回**对 HEAD 上该事项所有带 trailer 的提交逐个 revert（新提交，不改历史）。
- **筛选**：桌面可按「大肥鱼主动做的」筛出有主动 run 的事项；已合入的提供撤回。

## 记录与 API

- 设置：hubSetting `personalProactiveSettings { mode: 'off' | 'observe' | 'auto', repos: string[] }`，读取时带只读兼容字段 `enabled: mode !== 'off'`；存量 `enabled` 布尔读取时迁移（`true` → `auto`，`false`/缺省 → `off`）。
- 记录：hubSetting `personalProactiveRuns`，一条 run：
  `{ id, matterId, kind: 'prepare' | 'sandbox', repo?, branch?, threadId, startedAt, endedAt?, status: 'running' | 'observed' | 'approved' | 'ready' | 'merged' | 'discarded' | 'reverted' | 'failed', summary?, discardReason?, testReport?, files?: [{ path, additions, deletions }] }`。重启不丢；`running` 但线程已结束的启动时清为 `failed`。无产出或测试失败的成功回合记 `discarded`（保留限额与间隔审计，不发 notice、不显示 ready）；`observed` 是「本会做什么、为什么」的记录，`approved` 是人看完后的反馈（不触发执行，但使同一候选 24 小时内不再重复记录）；`ready` 或 `merged` 的沙盒不会被自动继续，审阅中的 diff 不会变。
- API（前端契约）：
  - `GET /api/personal/proactive` → `{ settings, runs }`；`?matterId=ID` 只返回该事项的 runs（摊开层按需取）；`?summary=true` → `{ settings, counts }`（事项→run 计数，设置面板与列表层用，不加载全量 runs；observed/approved 计入，discarded 不计）
  - `PUT /api/personal/proactive/settings`（`{ mode?, repos? }`，兼容旧 `enabled?` 布尔，同时给了以 `mode` 为准）→ settings
  - `GET /api/personal/proactive/runs/:id/diff` → `{ files: [{ path, additions, deletions }] }`
  - `POST /api/personal/proactive/runs/:id/merge` / `discard` / `revert` → run
  - `POST /api/personal/proactive/runs/:id/approve` → run（只对 `observed`；其他状态 409「只有观察记录可以标记」，未知 id 404）
  - `GET /api/todos` 每条事项带 `proactiveRunCount`（计数，无 run 时为 0）：列表层用它决定是否显示「大肥鱼主动做的」入口，不为此拉全量 runs。

## 模块与分工

- `packages/daemon/src/proactive-sandbox.ts`（新）：纯 git 层，类 `ProactiveSandbox`：`prepare / changes / merge / discard / revert`，自带 git 执行器，不 import store/http/threads，用临时仓库自测。
- `packages/daemon/src/proactive.ts`（新）+ `scheduler.ts` / `http.ts` / `personal.ts` 接线：三档设置、空闲判定、候选、观察记录、开线程、run 记录、通知、API。
- `packages/web`：三档开关、观察记录与「这条可以」、沙盒卡与三动作、筛选与撤回、i18n 三语、e2e。

## 不做（本轮）

日历空闲判定（接入日程信号后升级）、模型参与的候选判断、每日上限的界面调节、CLI 子命令、推送远端（永远不做）、把「这条可以」变成执行触发（批准只是人的反馈记录，执行仍由切到自动后的 tick 决定）。

## 验收

- 单测：三档设置与迁移（存量 `enabled` 读取、旧布尔写入）、设置校验（路径、git 仓库、工作目录内）、空闲判定每条、候选规则、观察记录（不建线程不建沙盒、summary 内容、不占每日上限、占间隔、24 小时去重、approve 状态流转）、run 生命周期（含沙盒测试失败/无改动静默丢弃且不发 notice）、`ProactiveSandbox` 全操作（合入带 trailer、revert 多提交、丢弃清理、复用已有分支）。
- 假 agent（`test/fixtures/`）：能对 prepare / sandbox 提示词产出可断言的行为。
- e2e（临时 hub + 假 agent）：三档开关、观察记录与「这条可以」、沙盒卡三动作、筛选与撤回。
- 真实浏览器桌面/手机 × 亮/暗截图。

## 第二期：推进（2026-11-11）

### 为什么

用户反馈「助手不够主动，好多问题没帮我解决」。实测一周：模式为观察、`repos` 为空，7 条观察全是同一件 11-05 已过期的事项，其余 17 件从未被看过。原因：

1. bug：`tick` 只取第一个候选，它 24 小时内已记过就整轮返回，不看下一件。
2. bug：`dueAt <= now + 48h` 把已过期的截止也算作「快到期」，过期事项永远占着第一位。
3. 准备只看「重要 + 两天内截止」，而大多数事项没有截止；沙盒要先在设置里填仓库；任何线程在跑就整体不动，而用户几乎总有线程在跑。

参考 Persona（`docs/assistant/agent-work.md`，#1686）：用户同样说过「不够主动」，它的解法不是知识库，而是让每个会话只处于三态之一——在干活 / 在等一个说得出名字的前提 / 已完成——并由助手推进前提：临时错误自动续跑、等外部的定时叫醒、等人的变成一点就答的卡片、完成的写一行结论。本期照这个思路做，知识库暂不加。

### 改动一览

| # | 改动 | 默认 |
|---|---|---|
| 1 | 修两个 bug：已记过的候选跳过、继续看下一件；截止早于今天 0 点的不算「快到期」 | — |
| 2 | 新动作 `advance`（推进）：事项的工作线程停下后分流并推进 | 随三档开关 |
| 3 | 空闲判定改为按事项：该事项没有运行中的线程即可；主动开出的运行中线程 ≤ 2 | — |
| 4 | 笼统事项拆解：没截止、没线程的事项也能准备材料（拆步骤 + 第一步方案） | 随三档开关 |
| 5 | 沙盒授权卡：事项线程在某个 git 仓库里但不在允许列表 → 卡片一键允许 | 随三档开关 |

L3 对外动作（推远端、发消息、合入）仍然永远要人点头，本期不变。

### 1. 候选修正

- `tick` 依次尝试候选；某候选 24 小时内已有同事项同 kind 的 `observed/approved` 记录（或其他不该重复的记录）就跳过，继续下一件，直到找到一件或没有。
- `preparationCandidate` 的 `soon`：`dueAt` 在今天 0 点（本地）之后且不晚于 48 小时后。截止已过（早于今天）的事项不再因截止成为准备候选（它仍可能因「今天有日程」或下面的拆解规则成为候选）。

### 2. 推进（advance）

**候选**：未完成、未提议的事项，有关联工作线程（`todoThreadIds`），该线程：不在运行、未归档、最后一轮由 hub 发起（不是终端导入或外部导入）、结束于 15 分钟到 7 天前、这一轮还没被推进过（以 `threadId + turnId` 去重）。主动 run 自己开的线程不在此列（由原有流程收尾）。

**分流：先规则，再模型。**

1. 这一轮以模型服务的临时错误结束（`turnOutcome` 为 error，文字匹配 408/429/5xx、`overloaded`、`rate limit`、`Connection error`、`timed out`、`ECONNRESET`、`fetch failed`、`socket hang up`）→ `transient`。认证、额度耗尽、上下文过长等不算临时（额度耗尽交给已有的额度恢复续跑）。
2. 否则用私人 agent 调一次 `askOnce`（归档的一次性线程，不碰工作线程的会话），输入：事项文字、接续说明（截前 2000 字）、这一轮人的要求、最终回复（首尾各 1500 字）、当前时间。要求只输出 JSON：

   ```json
   {"phase":"done|blocked|unsure","on":"user|external",
    "line":"不超过 30 字：结论，或在等什么",
    "question":{"text":"原样引用回复里的问题","options":["…","…"]},
    "wait":{"what":"在等什么","then":"等到后做什么","checkMinutes":10}}
   ```

   判断原则写进提示词：结尾「要不要我再…？」这类可选提议不算等人，任务做完就是 `done`；只有回复里确实在等人决定、提供信息或操作时才是 `blocked · user`；拿不准就 `unsure`。
3. 代码校验：`question.text` 必须是最终回复的子串（去首尾空白后），否则降为 `unsure`；`options` 最多 4 个、每个 ≤ 40 字；`checkMinutes` 夹到 2–240；`line` 截 30 字。解析失败按 `unsure`。

**动作**（`auto` 档全部执行。`observe` 档：`transient` 与 `blocked · external` 不自动发送，只写 `observed` 记录，`summary` 写「会怎么做」；`blocked · user` 与 `done` 照常出 `asking` 卡片，因为卡片本身不发任何消息，只有人点了才发）：

| 分流 | 动作 | run 状态 |
|---|---|---|
| `transient` | 退避后向该线程发 `继续`：1、2、4 分钟…上限 30 分钟，同一事项连续最多 3 次；第 3 次仍失败 → 变成 `asking` 卡片「模型服务连续出错：<原文>」，选项「再试一次」/「先放着」 | `waiting` → `continued` |
| `blocked · external` | 到 `wakeAt` 时向线程发叫醒消息：上一轮说在等什么、等到后做什么，请它自己检查；好了就继续，没好就说还要多久。间隔每次翻倍（≤ 1 小时），最多 6 次；之后变成卡片「等了 6 次还在等 X」，选项「继续等」/「不等了」 | `waiting` → `continued` |
| `blocked · user` | 卡片：问题原文 + 选项 + 自由回答；人点了就把 `关于你上面的问题：Q → A` 发给该线程 | `asking` → `answered` |
| `done` | 卡片「看起来做完了：<line>」，动作「关掉事项」/「还没完」 | `asking` → `closed` / `discarded` |
| `unsure` | 不动作，只留审计记录 | `discarded` |

- 卡片不是对外动作，`observe` 档也出卡片；人点卡片按钮就是授权，发出的消息走正常 `startTurn`（非 `scheduled`）。
- 每次自动发送前重查：线程仍停着、最后一轮仍是那一轮（人没有自己发过）、设置仍是 `auto`、不在安静时段。不满足则把这条 run 记 `discarded`（`discardReason` 写原因）。
- 线程开始新一轮（无论谁发起）时，该线程上 `waiting/asking` 的 run 作废为 `discarded`（`discardReason: '线程已继续'`）。
- 每日上限：自动发送（续跑 + 叫醒）≤ 20 次；分流的模型调用 ≤ 30 次。
- 有 `asking` 卡片时用 `manager.notice(..., proactive=true)` 推一条，标题「需要你：<事项>」。

### 3. 空闲判定

- 原「任何线程在跑就不动」改为：候选事项自己没有运行中的关联线程；主动开出的、仍在运行的线程数 < 2。
- 60 分钟间隔只约束开新线程的动作（prepare / sandbox / 拆解）；推进的分流与发送不受此约束（它们不开新线程），但同一线程两次自动发送间隔 ≥ 2 分钟。
- 安静时段仍然全部不动（卡片已发出的照常可答）。

### 4. 笼统事项拆解

- **候选**：未完成、未提议、没有关联线程、接续说明里没有「已备好」、事项文字 ≥ 6 个字。按更新时间新→旧，每件 7 天内最多一次。
- **动作**：开 `prepare` 线程（`variant: 'plan'`），提示词：把事项拆成 3–7 步，写出第一步的具体方案（要改哪里、怎么验证、要问人什么），写入 `artifacts/plan.md`；可以只读查看相关仓库，不改任何仓库，不对外；用 `calli todo update` 在接续说明记一句「已备好 拆解与第一步方案」。其余与原 L1 相同（落盘、已备好卡、计入 prepare 每日 5 次）。
- 优先级：有截止的准备 > 推进 > 沙盒 > 拆解。

### 5. 沙盒授权卡

- 沙盒候选扫描时，若事项的关联线程 `cwd` 在允许的工作目录内、属于某个 git 仓库（取 `git rev-parse --show-toplevel`），但该仓库不在 `repos` 里 → 写一条 `kind: 'sandbox'`、`status: 'observed'`、`needsRepo: true`、`repo: <根目录>` 的记录，`summary`「这件事的线程在 <仓库名> 里，允许它在沙盒里继续吗？」。同一事项同一仓库 7 天内只出一次。
- 新动作 `allow-repo`：把该仓库加入 `repos`（走 `save` 的同一套校验），记录变 `approved`。之后的 tick 按原 L2 规则执行。

### 记录与 API 增量

- `ProactiveRun.kind` 增加 `'advance'`；`prepare` 增加可选 `variant: 'deadline' | 'plan'`；`sandbox` 增加可选 `needsRepo: true`。
- `status` 增加 `'waiting' | 'asking' | 'answered' | 'continued' | 'closed'`。
- `advance` 字段：`turnId`、`phase`、`on`、`line`、`question?: { text, options: string[] }`、`wait?: { what, then }`、`wakeAt?`、`attempts?`、`reason?: 'transient' | 'external' | 'user' | 'done'`。
- 新接口：
  - `POST /api/personal/proactive/runs/:id/answer` `{ answer: string }` → run：仅 `asking` 且 `reason` 为 `user/transient/external`；`transient` 的「再试一次」发 `继续`，`external` 的「继续等」重新排一次叫醒，「先放着」「不等了」记 `discarded`；其他回答按「关于你上面的问题」发出，记 `answered`。线程正在运行 → 409。
  - `POST /api/personal/proactive/runs/:id/close-matter` → run：仅 `reason: 'done'` 的 `asking`；把事项标为完成，run 记 `closed`。
  - `POST /api/personal/proactive/runs/:id/dismiss` → run：`asking/waiting` → `discarded`（「还没完」也走这里）。
  - `POST /api/personal/proactive/runs/:id/allow-repo` → run：仅 `needsRepo` 的 `observed`。
- `counts()` 与 `GET /api/todos` 的 `proactiveRunCount` 继续不含 `discarded`；`GET /api/personal/proactive?summary=true` 新增 `asking: Record<事项ID, number>`（每件事项等人处理的卡片数），列表层据此显示标记，总数由前端求和，不用展开。

### 界面

- 桌面事项摊开层（`ProactiveRuns`）新增四种卡：等你回答（问题原文、选项按钮、「其他回答」输入）、看起来做完了（关掉事项 / 还没完）、在等（「在等：X · HH:MM 再看」，可「不等了」）、允许沙盒（允许 / 不用）。拆解材料沿用「已备好」卡。
- 事项列表层：有 `asking` 的事项直接显示一个需要注意的标记（颜色只用在这里），不用展开就能看到；桌面顶部显示「N 件需要你」入口。
- 文案写进 i18n 三语；手机与桌面、亮暗色都要看过。

### 验收

- 单测：两个 bug 的回归；空闲判定按事项；推进的规则分流（临时错误各词、非临时不续跑）、模型输出校验（问题非原文降级、解析失败、checkMinutes 夹取）、各分流动作与发送前重查、线程继续后作废、每日上限、observe 只记录不发送；拆解候选与 7 天去重；授权卡生成与 `allow-repo`；新接口状态校验（409/404）。
- 假 agent（`packages/daemon/test/fixtures/`）：对推进分流提示词按约定关键字返回固定 JSON（done / user / external / unsure / 坏 JSON），对拆解提示词写出 `artifacts/plan.md`。
- e2e：推进卡片四种的显示与操作，`N 件需要你` 入口。
