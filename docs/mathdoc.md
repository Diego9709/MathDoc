# MathDoc：产品规划、研发进度与技术细节

状态：2026-10-08 整理。本文取代 `docs/` 下原有的 10 份规划、阶段报告与规范文档（见附录 A），是 MathDoc 唯一的
内部规划文档。面向用户的英文参考在文档站 `docs/src/content/docs/`，不在本文范围内。

对应代码：主要工作分支 `codex/mathdoc-coordination`；LeanGround `main` 的 `3965273`。

## 1. 本文与阅读方法

本文回答三个问题：

1. **产品规划**（§2）：MathDoc 要做成什么、为什么这样做，以及已经做出的决定；
2. **研发进度**（§3）：每个阶段做到哪里、测出了什么、还卡在哪里；
3. **技术细节**（§4）：架构、数据、规则和接口。代码注释引用的就是这里的章节号。

**维护规则**：

- 每完成或验收一个阶段，更新 §3；
- 技术规则变化时同步更新 §4；
- 新的决定写进 §2.6；
- 不再为每个阶段另写报告文件。原始测量记录保留在 git 历史中（附录 A）。

**来源标注**：`[实测]` 表示运行或读代码确认过，并附条件；`[推断]` 是推理；`[未验证]` 是尚未核实的前提；
`[测量伪影]` 是由测量方式造成、不代表系统性质的结果。

### 1.1 术语

| 术语 | 含义 |
|---|---|
| TerminusDB | 带分支与版本历史的图数据库。MathDoc 把文档节点（文字、LaTeX、Lean、Rocq 块与依赖边）存在这里 |
| 数据库 / 工作区 | 一个 TerminusDB 数据库，有一个 owner 和按分支的角色（owner、editor、viewer） |
| LeanGround | 外部证明服务：登记命题身份与定义、检查证明、保存认证、组装完整证明 |
| 认证 | LeanGround 记下的一条事实：「在这些前提下，这条命题成立」。写入后不改也不删 |
| 草图（sketch） | 带前提的认证：子引理写成证明为 `sorry` 的「前提占位」，再用它们证出目标。由组件 `lean-worker-sketch` 检查 |
| 完整证明（leaf） | 没有前提的认证，由组件 `lean-worker` 检查 |
| GoalKey | LeanGround 对「某个环境下的一条命题」算出的 64 位十六进制 SHA-256 身份。变量改名不改变它，陈述一改就是另一个目标 |
| 目标 | 一条待证的命题，身份是 GoalKey，本身没有名字 |
| 拆法 | 一条草图认证：把目标化成几个子目标 |
| AND-OR 图 | 证明图的形状：目标只要有一种拆法走通就算证出（或），一种拆法要所有子目标都证出（且） |
| 证明环境 | 基座（Lean 版本与库）、上下文（`open`、`set_option` 等）、选项、最低信任等级。环境是 GoalKey 的一部分 |
| 项目看板 | 一个数据库在一个证明环境下的协作状态：目标、认证、任务、租约、预算、各分支的路线。存在 PostgreSQL 中 |
| 挂载分支 | 把一个分支的文档从项目根节点开始转换，并提交给 LeanGround |
| 选择（pick）/ 路线 | 分支在某个目标上选用的认证；一个分支全部选择的集合就是它的路线 |
| 租约 | 领取任务后获得的限时占用权，可以续期；带 epoch（代次号），过期或被他人接手后，旧持有人不能再结束任务 |
| 组装 | 把一条路线上的认证拼成一份没有前提的源码，由 `lean-worker` 从头检查 |
| 回写 | 把组装通过的源码写回 TerminusDB 的某个分支 |
| 幂等键 | 请求附带的唯一 ID，服务端见到同一个键时返回第一次的结果，不会再执行一次 |
| `mdc` | MathDoc 的命令行，是 HTTP API 的客户端 |
| 目标草稿 | 服务端为一个目标给出的材料：结论的名字与签名、可用前提、所用定义的源码、环境上下文、任务与租约。`mdc pull` 据此写出工作文件 |
| 工作文件 | `mdc pull` 写出的 Lean 文件，格式为 `mdc-goal-file/1`：分隔行以上是只读前段，以下是可编辑正文（§4.11） |
| `.mdc/` | 工作文件旁的记录目录：每个文件对应哪个目标、租约、每次提交的幂等键与修订号。不保存令牌 |

## 2. 产品规划

### 2.1 定位与边界

MathDoc 是数学知识的协作应用。它负责提出问题、组织协作、审阅成果、展示知识：数学知识以带版本的依赖图保存，
人和 Agent 一起把其中的定理证完。

| 由 MathDoc 做 | 不由 MathDoc 做 |
|---|---|
| 文档、依赖图、LaTeX 展示、分支与历史 | 证明的对错：由 LeanGround 的验证组件裁决 |
| 目标、任务、租约、预算、拆法的启停与选择 | 证明搜索：由 Agent 自己完成 |
| 把文档节点转换为 LeanGround 请求，并把结果回写文档 | 本地 Lean：已从默认构建与部署中移除 |
| 身份与文档权限 | 与 EvoHarness 的集成（不在本轮范围） |

本文只描述 `codex/mathdoc-coordination` 及由它派生的分支（§3.5）：TypeScript 后端，证明交给 LeanGround。
`main` 上的旧 Rust 应用不在本文范围内。

### 2.2 分工

下表回答：协作中谁负责什么。

| 参与方 | 负责 | 产出 |
|---|---|---|
| MathDoc 协调层 | 哪些目标值得做、谁来做、投入多少、用哪种拆法；文档审阅与回写 | 任务、选择、组装请求、文档修订 |
| LeanGround | 命题身份、定义登记、认证事实、推导、固定计划、组装认证 | GoalKey、定义 ID、认证 ID、计划 ID |
| 验证组件 | 裁决一份证明本身对不对：`lean-worker`（完整证明、组装）、`lean-worker-sketch`（草图） | 验证证据 |
| Agent（Codex、Claude Code、脚本） | 写证明、提拆法，通过 `mdc` 或 HTTP 接口交付 | 提交 |
| 维护者 | 冻结根陈述，审阅拆法是否值得做，组装、接受回写 | 决定 |

协调层可以记录「某个 Agent 声称完成了」，但只有读取并核对 LeanGround 的认证之后，才显示数学上的进展。

### 2.3 Project 模型：一条定理，一张共享证明图，分支是路线

**一个 Project 对应一个数据库，证明一条定理（根）**，它由三样东西固定：

- 数据库的证明环境；
- 根节点；
- owner、成员和预算。

**所有分支共享一张看板**：目标按 GoalKey 去重，认证只追加。所以一个分支证出的引理，在所有分支上同时生效，
不需要导入。

**分支不是图的拷贝，而是共享图上的一条路线**：在沿途的目标上各选一种拆法，再加上分支自己的文档。
这和 git 的结构相同：git 的对象库按内容寻址、所有分支共享，分支只是指针。对应到这里：

- LeanGround 的事实库相当于共享对象库（GoalKey 和认证 ID 都按内容寻址）；
- MathDoc 的分支相当于指针（路线加蓝图文档）。

```
Project（= 一个 TerminusDB 数据库）
│  根陈述 T（冻结）+ 证明环境（冻结）+ 成员
├─ 共享证明图（一张看板，一个 LeanGround 项目范围）
│     T ──┬── D1 ⇒ {A, B, C}
│         └── D2 ⇒ {B, E}          ← B 被两种拆法共用，只证一次
│                  C ──┬── D3 ⇒ {C1}
│                      └── D4 ⇒ {C2, B}
├─ 分支 main        路线 {T: D1, C: D3} + main 上的蓝图节点
├─ 分支 strategy-2  路线 {T: D2}        + strategy-2 上的蓝图节点
└─ 形式化证明：某个分支的路线闭合 → LeanGround 组装出无前提的认证
```

为什么不让每个分支各存一份图？原因有三：

- **分解是递归的**：根有 2 种拆法、每种下面 3 个子目标各有 2 种时，完整组合就有 2×2³ = 16 种 [推断：组合计数]，
  所以用分支只能表达顶层选择；
- **进度要共享**：各存一份时，一个分支证出的引理，其他分支还要手动导入；
- **认证只追加、按 GoalKey 合并**，天然没有冲突。各存一份可变文档，就把合并冲突又引了回来。

子目标上的替代拆法不需要开分支，作为目标上的并列选项存在即可。只有替代方案大到需要单独写蓝图、单独组织人力时，才开分支。

**路线的语义**：

- 已选择的目标，严格使用所选的认证；
- 未选择的目标，在启用的认证里自动选，前提少的优先；
- 节点转换或重新提交时得到的认证，自动成为该分支在这个目标上的选择；owner 可以改。

**目标状态与路线状态不同**：目标状态（`insufficient` / `derivable` / `certified`）各分支共享，表示存在某种组合
能证出它；路线是否闭合是每个分支自己的。界面分别显示这两者。

### 2.4 大规模协作的原则

1. **人的审阅只花在机器替代不了的地方。** 组装会把整条路线从头检查，所以证明写得对不对不需要人看。必须由人看的只有两件事：
   - 根陈述（及其用到的定义）是否忠实表达了要证的数学。这是唯一的信任根，开局就冻结。
   - 拆法是否值得做。草图检查只保证「子目标全真 ⇒ 目标真」，不保证子目标为真，也不保证子目标更容易。
     拆法新引入的定义不需要做忠实性审阅（最终组装的结论是根陈述）[推断]。
2. **拆法有生命周期，类似合并请求（PR）**：`proposed` → `active` → `paused` / `retired` / `refuted`。
   新拆法默认 `proposed`，未经审阅不参与调度（项目决定 B）。**尚未实现**：现在认证进入看板就是 `active`。
3. **证否是必需品。** 证出 ¬P 后，含 P 的拆法自动标为 `refuted`。需要 LeanGround 侧的契约，**尚未实现**。
4. **共享失败记忆。** LeanGround 按设计不保存失败尝试；协调层给每个目标挂尝试笔记（试了什么、卡在哪个证明目标）[推断：对 Agent 群体最省预算]。**尚未实现**。
5. **租约只用来减少重复，不是独占权。** 过期后才交上来的正确证明照样接收（已实现）。
6. **形式图由认证推导，不手工维护。** 「且」边来自草图的前提；手工维护的依赖边只保留给非形式化的知识依赖。
7. **调度信号来自图**：被多少条路线需要、所在路线离闭合还差多少、已失败几次。**尚未实现**（`mdc next`）。

### 2.5 `mdc` 的角色

**`mdc` 是所有执行者共用的唯一「动作面」。** 执行者包括 Codex、Claude Code、脚本、命令行里的人，以及以后的浏览器侧栏 Agent。
它把协作协议的细节（修订号、幂等键、租约续期、GoalKey 解析）封装成数学工作流层面的动词，地位类似 GitHub 协作里的 `gh` 加 `git`。

它不做四件事：裁判（由 LeanGround 负责）、事实来源（以服务端看板为准）、证明搜索（由 Agent 负责）、维护者决策。

**现状** [实测：读代码，2026-10-08，分支 `claude/mdc-verbs`]：
- 文档命令与 `proof env/submit/list/status/command` 仍是 HTTP API 的薄客户端。其中 `proof command` 读原始 JSON，每次都生成新的幂等键，
  所以断网重试会重复提交。
- 第一批动词 `pull / prove / split / done` 已在项目阶段 2 实现（§3.4）：它们封装了修订号、幂等键、续租和 GoalKey 解析；
  拆法产生的子目标由服务端自动登记陈述，不再需要手写。

**动词层**（项目阶段 2）：在现有命令之上，加一层以证明工作流命名的命令。第一批：

| 动词 | 做什么 |
|---|---|
| `mdc pull GOAL [--branch B]` | 领取目标，写出工作文件（§4.11）；之后的 `mdc` 调用顺带续租（项目阶段 2 决定 1） |
| `mdc prove FILE` | 把文件作为完整证明提交 |
| `mdc split FILE -m 说明` | 把文件作为拆法提交；服务端自动为新子目标登记陈述 |
| `mdc done [--spent N]` | 结束租约并报告实际花费 |

之后的动词：

- `mdc check FILE`：只检查不入库，等 LeanGround 提供接口（项目决定 E）；
- `mdc goals`、`mdc next`、`mdc show`、`mdc note`；
- 维护者用的 `mdc review` 和 `mdc branch new --pick`。

工程性质：

- 默认输出 JSON，错误码稳定；失败时 stderr 输出一行 JSON `{reason, status?, details?, uncertain?}`；
- `.mdc/` 只保存重放记录，不保存令牌；
- 每个 Agent 使用自己的委托子令牌（阶段 4）；
- `mdc mcp` 把同一组动词暴露为 MCP 工具（MCP 即 Model Context Protocol，让聊天式 Agent 调用外部工具的标准协议）。

**浏览器侧栏 Agent 暂缓实现**（项目决定 F）。以后实现时遵守三条约束：身份是用户的委托子令牌，工具只有 `mdc` 动词，
维护者级操作只生成待确认按钮。

### 2.6 已决定事项

下面按时间汇总所有已经定下的事项。各组编号相互独立，引用时带上组名，例如「合同决定 C」「项目决定 A」。

**迁移的基本决定**（2026-09-28）：

- MathDoc 是顶层协作应用；
- 后端改为 TypeScript，以 `coordinator/` 为基础，并保留完整的知识编辑界面 `web/`；
- 文档继续存在 TerminusDB，不迁移数据；协作数据存 PostgreSQL；
- 认证事实与源码由 LeanGround 持有，MathDoc 只引用 ID；
- 草图检查用 LeanGround 内置组件，定义使用 LeanGround 的定义登记；
- 本地 Lean 移出默认路径，不涉及 EvoHarness；
- 顺序是先隔离，再切换默认入口，最后清理。

**合同决定 A–D**（2026-09-29，编码进 v1 合同，§4.6）：

| 编号 | 问题 | 决定 |
|---|---|---|
| A | 项目内同名定义 | 明确拒绝（`definition_name_taken`），作者改名后重试；不自动改名 |
| B | 怎样判定定义节点与定理节点 | 保守语法扫描，加上 metadata 显式标注（`lean_role`、`lean_conclusion`）；仍不清楚就拒绝 |
| C | 多节点回写冲突谁优先 | 当前文档优先，整批终止（`abort_entire_batch`）；禁止强制覆盖 |
| D | 文档权限矩阵 | 见 §4.3 |

**阶段 4–5 的实现选择与维护者决定**（2026-09-29）：

- 节点与定义 ID 的对应存在 PostgreSQL，不写进块 metadata。原因：写 metadata 会改变节点修订号，让正在编辑的人遇到冲突。
- 回写直接写入目标分支，不另开审阅分支。
- 自阶段 4 起不再维护旧 Rust 应用的兼容；旧 Rust 代码直接删除，另写一个薄的 TypeScript 版 `mdc`。
- 切换默认入口之前，先在 Mathlib 基座上验收。

**项目决定 A–F**（2026-10-01）：

| 编号 | 决定 |
|---|---|
| A | 一个 Project 对应一个数据库 |
| B | 新拆法默认 `proposed`，可以按项目配置（尚未实现） |
| C | 分支路线存在看板里 |
| D | 现有按分支建立的证明请求只读保留；新请求一律进入 Project 看板 |
| E | `mdc check` 需要的草稿检查由 LeanGround 提供接口 |
| F | 侧栏 Agent 暂缓实现 |

**工作文件决定 G1–G4**（2026-10-01，§4.11）：

- G1：未被引用的可用前提，提交时自动删去；
- G2：尝试笔记放进文件的只读前段；
- G3：生成的注释用英文；
- G4：一个文件只对应一个目标。

**项目阶段 1 实现中定下、待评审的细节**（2026-10-02）：

1. 创建项目只限数据库 owner；挂载分支需要该分支的 editor 权限。
2. 分支一律从项目根节点（按 UUID）转换。分支上的根解析出不同的 GoalKey 时，以 `root_statement_differs` 拒绝，不提交任何认证。
3. 看板可见性以 `main` 的读权限为准，读不到的分支及其组装记录不返回。
4. 节点转换或重新提交得到的认证，自动成为分支的选择。
5. 本分支没有转换某节点时，借用另一个已挂载分支上文本相同（含所用定义）的同一节点的状态。
6. LeanGround 项目 ID 随机生成；环境改回以前的值时，恢复那时的看板。

**项目阶段 2 实现中定下、待评审的细节**（2026-10-08）：

1. **续租**：每次运行 `pull / prove / split / done`，都顺带为本工作区内、本人持有、剩余时间不足一半的租约续租；
   是否已过期由服务端判断。不启动常驻进程。`pull` 的 `--ttl` 默认取上限 3600 秒。即 §2.7.2 关键设计 1 的第一种做法。
2. **预算**：`pull` 默认预留 0（`--allocation N` 可改），所以 `done --spent` 默认 0。外部 Agent 的花费只能自报（§4.8）。
3. **拆法说明**：`split` 必须带 `-m`；最长 2000 字符；同一条认证保留第一次的说明。
4. **结论签名的来源**依次是：分支 B 上转换后未改动的节点；看板上记录的声明；只有命题时写成 `theorem goal_<前 8 位> : 命题`。
   看板上的声明合并了 §2.7.2 原计划的第二、三种来源：它取自引入该目标的草图占位，或任一分支上陈述该目标的节点，先记下的保留。
5. **定义 ID 的来源**：目标上只记录 LeanGround 报告的定义 ID，即 `resolve` 响应中被陈述引用的定义、本项目认证的 `definitions`、
   本项目节点登记的定义；不记录请求里给出的定义 ID。原因：目标草稿返回定义源码，而 GoalKey 不受未引用定义的影响，
   如果照抄请求里的 ID，成员就能借一个 `resolve` 读到协调服务可见、但属于其他项目的定义源码。GoalKey 只取被引用的定义
   [实测：读 LeanGround `fact_components.py:93-97`]；这个风险也在本机 LeanGround 上复现过：把代码改回照抄请求 ID 后，
   另一个项目的定义 ID 被 `resolve` 接受并记到了目标上 [实测，2026-10-08，§3.4]。
6. **自动陈述失败的处理**：LeanGround 拒绝或 GoalKey 不一致，只记在作业结果上；LeanGround 暂时不可用时，整个 `submit` 作业重试，
   重试会再提交一次同样的源码。
7. **工作文件前段的上下文顺序**改为 LeanGround 构造检查前言的实际顺序（§4.11），修正原规范中未核实的写法。
8. **租约不独占**：他人持有任务时，`pull` 以 `task_unavailable` 拒绝，并给出持有人和到期时间；`--no-claim` 只写文件、不领取。
9. **工作区记住服务器**：`.mdc/workspace.json` 记录服务器地址，在工作区内运行动词时可以不设 `MDC_URL`；
   设了而不一致时拒绝（`workspace_server_mismatch`）。

### 2.7 路线图

迁移阶段 0–5 已经完成（§3.2），后续工作按项目阶段推进。下表回答：每个阶段做什么、怎样算完成。

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 1 共享看板 | 环境和看板改为按数据库；分支是路线；节点状态按 GoalKey 读共享看板；旧请求只读 | 两个分支选不同的根拆法、共用引理 B：一个分支证出 B 后，另一分支的 B 节点同时显示已证出，不需要导入；旧请求可读、拒绝命令 | 已实现，待评审；本机 LeanGround 上的验收测试通过（§3.3） |
| 2 `mdc` 动词层 | `pull / split / prove / done`、`.mdc/` 重放、自动续租、服务端按目标生成草稿、自动 `resolve`；`check` 等 LeanGround 接口 | 断网重试不重复提交；一个 Agent 只用这四个动词就能把一个目标拆开并证完 | 已实现，待评审；本机 LeanGround 上的验收测试通过（§3.4） |
| 3 审阅 | `proposed` 状态、审阅视图、尝试笔记 | `proposed` 的拆法不产生可领取的任务，启用后才产生 | 未开始 |
| 4 Agent 身份 | 委托子令牌、`mdc mcp` | 两个命令行 Agent 各用自己的子令牌：审计记录可以区分，子令牌无法执行维护者命令 | 未开始 |
| 5 规模与证否 | 看板拆表、证否、`mdc next` 调度 | 参与者数、目标数和写入延迟的目标值在本阶段开始前定下 | 未开始 |

下面 §2.7.1–§2.7.6 是各阶段的要点：目标、改动、关键设计、验收、待定事项。凡涉及现有代码的地方都核对过 [实测：读代码，
2026-10-08]，凡属设计推理的地方都标了 [推断]。

#### 2.7.1 进入阶段 2 之前

- **阶段 1 的真实验收**：在真实 LeanGround 上运行 `scenario.test.ts`、`mathlib.test.ts` 和浏览器 e2e 的协作用例。
  三者都需要 LeanGround 令牌（§4.12）。运行之前，阶段 1 只能算「待评审」。
- **主工作区里那组未提交的改动**（删除 `app/` 原型）要由它的作者提交。否则之后的每次提交都得用路径限定，避开它。

2026-10-08 开始阶段 2 时，这两项都没有完成：没有 LeanGround 令牌，所以阶段 1 的真实验收没有运行；那组改动仍未提交，
其中也改了 `coordinator/src/http.ts`。所以阶段 2 在单独的工作树和分支 `claude/mdc-verbs` 上开发（§3.5），主工作区保持原样。
同日阶段 2 合并之后，用本机 LeanGround 服务补跑了阶段 1 的三项真实验收，全部通过（§3.3）；那组改动仍未提交。

#### 2.7.2 阶段 2：`mdc` 动词层

**目标**：一个 Agent 只用 `pull / split / prove / done` 四个动词，就能把一个目标拆开并证完；断网后重试不会重复提交。

**服务端改动**：

| 改动 | 位置 | 要点 |
|---|---|---|
| 按目标生成草稿 | `http.ts`，新路由 `GET /projects/ID/goals/KEY/draft?branch=B` | 现有草稿只能按文档节点生成。新路由按目标返回 §4.11 前段需要的全部材料（`root_module`、context、所用定义的 ID 与源码），以及结论名与签名、可用前提、笔记（阶段 3 起）。结论签名依次取自：分支 B 上绑定该目标的节点；引入该目标的草图里同名的占位声明；看板上已登记的陈述 |
| 自动登记子目标陈述 | `worker.ts` 的 `submit` 作业 | 草图认证吸收后，逐个处理没有陈述的前提目标：按认证的绑定名在源码里找到占位声明，转成陈述，带上认证的定义 ID 调用 `resolve`。GoalKey 一致才记下陈述，不一致就只在作业上记原因，不让整个作业失败 |
| 拆法说明 | `submit` 命令加可选的 `description`，吸收时记在认证上 | `mdc split -m` 写的说明，供阶段 3 审阅时显示 |

**客户端改动**：把 `cli.ts` 拆成几个模块：目标引用解析、工作文件的生成与解析（与服务端共用 `lean-source.ts`）、`.mdc/` 记录、各个动词。

**关键设计**：

1. **续租方式（已定：第一种，见 §2.6 项目阶段 2 决定 1）。** CLI 是短命进程，没法像常驻程序那样定时续租。可选的做法有三种：
   - 每次调用 `mdc` 时顺带续租；`pull` 可用 `--ttl` 设到最长 3600 秒（命令允许的上限 [实测]）；
   - `pull` 启动一个常驻的续租进程，`done` 时结束它；
   - 完全不续租，到期由服务端回收（现在的行为）。

   倾向第一种，因为不会留下孤儿进程。代价是：Agent 超过一小时不调用 `mdc`，租约就会过期。但过期只撤销调度权，
   之后的提交仍然有效（§4.8），所以代价可以接受 [推断]。
2. **幂等。** 幂等键由请求内容和修订号决定，先写入 `.mdc/` 再发送（§4.11）。服务端先查幂等键、再查修订号 [实测：`store.apply`]，
   所以同一个请求可以原样重发。
3. **目标引用**：可以写完整 GoalKey、至少 8 位的唯一前缀，或分支上节点的标题或 UUID。`--branch` 默认取 `-p` 指定的分支。
4. **`done` 的结果**：有提交记录就报 `submitted`，否则报 `no_progress`；`--spent` 由 Agent 自报。
5. **`check` 不在本阶段**：它需要 LeanGround 先提供草稿检查接口（项目决定 E）。

**验收**：

- 集成测试（LeanGround 替身）只用四个动词走完：`pull` → 编辑 → `split`（新增一条占位）→ 新子目标自动得到陈述 → `pull` 子目标 → `prove` → `done`。
- 重放：在请求发出之后、响应到达之前中断，再重跑同一条命令，看板上只有一次提交、一个作业。
- 在真实 LeanGround 上把同一流程跑一次。

#### 2.7.3 阶段 3：审阅

**目标**：未经审阅的拆法不参与调度；失败的经验留在目标上，供后来者参考。

| 改动 | 要点 |
|---|---|
| 认证状态增加 `proposed` | 选路、可领取目标的判断和组装本来就只看 `active` 的认证 [实测：`activeGoals`、`selectRoute` 都过滤 `state === "active"`]，所以 `proposed` 自动不参与调度，不需要改选路代码 |
| 默认状态规则（待定） | 倾向：完整证明直接 `active`，因为它不存在「值不值得做」的问题；Agent 用 `submit` 交的草图默认 `proposed`；挂载或重新提交文档节点得到的草图默认 `active`，因为该分支的 editor 已经对文档内容负责 [推断]。允许项目设置为全部直接 `active` |
| 审阅命令 | 复用 `decomposition` 命令，允许从 `proposed` 转为 `active` 或 `retired`，并附审阅意见。只有 owner 能审；是否增设审阅者名单，待定 |
| 提交者与说明 | 吸收认证时记录提交者（现在没有记录 [实测]）和阶段 2 的拆法说明 |
| 无意义拆法自动处理 | 前提里包含结论自身的认证（T ⇐ {T}），直接记为 `retired`，不进入审阅队列 |
| 尝试笔记 | 新命令 `note {goal, text}`；`finish` 也可以附一条笔记。每个目标保留最近 50 条，每条最多 500 字符（与 §4.11 G2 一致）。`mdc pull` 把笔记写进文件前段；`mdc show` 和任务板也显示 |
| 审阅视图 | 拆法页增加「待审阅」分组，显示前提的陈述、说明、提交者、被几条路线需要，可以一键启用或退役 |
| 旧数据 | 已有的认证保持 `active` |

**验收**：

- `proposed` 的草图产生的新子目标，领取时以 `inactive_goal` 被拒；启用之后可以领取；
- 完整证明立即生效；
- 笔记出现在 `pull` 写出的文件前段和界面上；
- 旧看板的行为不变。

#### 2.7.4 阶段 4：Agent 身份

**目标**：每个 Agent 进程用自己的令牌，审计和预算可以区分到具体 Agent；令牌的权限可以收窄。

**现状** [实测]：

- 身份来自静态的 `MDC_ACTORS`，修改后要重启服务；
- 成员和 owner 的判断都按完整的身份字符串比较；
- 修改成员名单时，会撤销身份不在名单里的租约；
- 所有 LeanGround 提交都使用协调服务自己的令牌，所以 LeanGround 看到的提交者只有一个。

**改动**：

| 改动 | 要点 |
|---|---|
| 子令牌表 | PostgreSQL 新表，字段包括：所属身份、名字、令牌哈希（只存 SHA-256，明文仅在创建时显示一次）、权限范围、过期时间、撤销时间 |
| 身份写法 | 子令牌的身份写作 `alice/codex-1`。权限判断（文档角色、成员、owner）用主身份 `alice`；审计、租约、预算用完整身份 |
| 必须同时修改的比较 | `member()`、`owner()`、`submitBranch` 中的成员检查、作业保存时对作业身份的成员检查、修改成员名单时撤销租约的比较，都要改为按主身份比较。漏掉任何一处，子令牌就会被当成非成员，或者在成员变更时被误撤租约 |
| 权限范围 | `work`：读、领取、续租、结束、`submit`、`resolve`、`note`；`maintain`：owner 命令；`edit`：写文档。默认只给 `work`。即使主身份是 owner，子令牌执行 owner 命令也需要 `maintain` |
| 管理 | `mdc token new NAME [--scope S] [--expires D]`、`mdc token list`、`mdc token revoke NAME`，以及 HTTP `/api/tokens`。撤销立即生效 |
| 预算 | 看板按完整身份汇总花费，在任务板上显示 |
| `mdc mcp` | 通过标准输入输出运行的 MCP 服务，把阶段 2 的动词暴露成工具。为了照顾没有文件系统的聊天客户端，工具直接收发源码文本，而不是文件路径 |
| LeanGround 侧 | 不变：仍以协调服务的身份提交；Agent 的来源只记在 MathDoc（可以写进 `caller_ref`） |

**验收**：

- 两个命令行 Agent 用各自的子令牌完成领取和提交，事件和租约记录能区分两者；
- 只有 `work` 权限的子令牌执行 `assemble` 被拒；
- 撤销之后的下一次请求返回 401；
- 修改成员名单时，只要主身份仍是成员，其子令牌的租约不被撤销；
- 一个脚本化的 MCP 客户端完成 `pull` → `prove`。

**待定**：子令牌是否默认可以写文档（倾向默认不给 `edit`）。

#### 2.7.5 阶段 5：规模与证否

**目标**：在定下的规模下延迟可以接受；错误的子目标能被证否，并自动停止相关调度；Agent 能拿到「下一个最该做的目标」。

**一、先测量，再拆表。**

- **现状** [实测]：
  - 一个项目的全部状态是一行 JSONB，每条命令都在行锁下读出整行、修改、再整行写回；
  - 同步每 15 秒加载一次每个已挂载分支的文档快照。

  所以写入成本随看板变大而增长，同一项目的命令完全串行。
- **负载测试**：k 个 Agent 并发执行 `claim`、`heartbeat`、`submit`，图里有 n 个目标；记录每条命令的 p50/p95 延迟、吞吐和看板体积。
  k、n 和延迟目标由维护者在本阶段开始前定下。
- **按测量结果拆表**：目标、认证、任务、尝试、分支节点绑定、选择各自成表；`heartbeat` 只锁尝试表的一行；选路只读认证和选择。
  领域逻辑仍写成纯函数，按需载入数据。
- **同步优化**：先比较分支的数据版本，没变就跳过快照加载。

**二、证否。**

- **需要 LeanGround 配合**：命题展开后形如 `¬ T` 时，`resolve` 和 `submit` 一并返回 T 的 GoalKey（新字段 `negates`）。
  MathDoc 不自己比较陈述文本，因为同一命题可以有多种写法，文本比较不可靠 [推断]。
- **MathDoc 侧**：¬P 得到完整认证后，P 标为 `refuted`；前提里含 P 的认证随之标为 `refuted`，不再参与选路；
  只能经由这些认证到达的目标，其任务被取消，并通知相关的提交者。
- 命令 `mdc refute GOAL FILE`，文件里写 ¬P 的证明。界面在拆法页标出 `refuted` 及原因。

**三、`mdc next` 调度。**

- 由服务端计算（`GET /projects/ID/next?branch=B`），任务板的排序也用同一套逻辑。
- 候选：未证出、可以领取、没有被租用的目标。
- 打分：被多少条分支路线需要，按路线离闭合的远近加权（离闭合越近，权重越大），再除以「1 + 已失败次数」。
  失败次数来自阶段 3 的笔记和 `finish` 结果。具体权重等测量之后再定 [推断]。
- `mdc next --claim` 直接领取推荐的目标。

**验收**：

- 负载测试在定下的规模下达到延迟目标；
- 证否：构造一个错误的子目标，证出它的否定后，含它的拆法不再出现在任何路线中，相关任务被取消；
- `next`：在一张手写的图上，推荐顺序与人工排序一致。

#### 2.7.6 顺序与依赖

- **2 → 3**：审阅要显示阶段 2 记录的拆法说明，笔记要写进阶段 2 的工作文件。
- **2 → 4**：`mdc mcp` 暴露的就是阶段 2 的动词。3 与 4 互不依赖，可以并行。
- **5 最后**：拆表要先有测量结果。证否需要 LeanGround 的新字段，建议和项目决定 E 的草稿检查接口一起提给 LeanGround，一次沟通处理两件事。

## 3. 研发进度

### 3.1 总览

| 工作 | 状态 | 时间 | 提交 |
|---|---|---|---|
| 迁移阶段 0：保全与回退 | 已完成 | 2026-09-28 | `3e1c9f5`、`53ac7f3`、`527f415` |
| 迁移阶段 1：v1 合同冻结 | 已实现，待评审 | 2026-09-28/29 | `e8f8b96` 至 `0a36348` |
| 迁移阶段 2：文档接口移植 | 已实现，待评审 | 2026-09-29 | `e26ca79`、`0a7c42d` |
| 迁移阶段 3：移出本地 Lean | 已实现，待评审 | 2026-09-29 | `4d8ccaa` |
| 迁移阶段 4：协作视图与闭环 | 已实现，待评审 | 2026-09-29 | `ba02fef` |
| 迁移阶段 5：切换默认入口、删除 Rust 应用 | 已实现，待评审 | 2026-09-29 | `d8abcb9`、`cc8ef1f`（合并 `main`） |
| Project 模型与工作文件规范（设计） | 已决定 A–F、G1–G4 | 2026-10-01/02 | `d7a1ff3`、`cb850d2` |
| 项目阶段 1：共享看板 | 已实现，待评审；本机 LeanGround 上验收测试通过（2026-10-08） | 2026-10-02 | `dc2f143`、`3a1c668`、`99060b4`、`2d9fa39` |
| 项目阶段 2：`mdc` 动词层 | 已实现，待评审；本机 LeanGround 上验收测试通过 | 2026-10-08 | `ce42e5a`（计划）、`c163316`、`9cb1914`、`23bfa05` |
| 项目阶段 3–5 | 未开始 | — | — |

「待评审」的意思是：作者已按验收标准自测，还没有经过维护者评审，也没有在真实部署上验收。

### 3.2 迁移阶段 0–5 的要点

**阶段 0**：把 Codex 的原型原样提交存档，再把默认入口文件恢复到基线 `a4d61e3`。所以在阶段 5 之前，旧应用一直照常构建。

**阶段 1**：四份 v1 合同（§4.6）冻结为 JSON Schema 和固定 fixture，过期判定改为按 Lean 内容指纹（§4.9）。

- [实测，2026-09-29] TypeScript 测试 16 项通过；Rust 与 TypeScript 对同一 fixture 中 4 个节点算出相同的修订号。
- 第二轮评审纠正了一个说明错误：用整节点修订号判断过期，会让协作层自己写入的 metadata 把请求打成过期。

**阶段 2**：TypeScript 后端移植全部文档与图接口，并新增令牌身份与工作区权限。

- [实测，macOS，TerminusDB 12.0.7]
  - 同一节点在两个后端上的修订号一致；
  - 两个后端交替写同一数据库，只出现预期的冲突错误；
  - 猜测其他分支的 URL 一律 404；
  - 除本地 Lean 用例外，e2e 12 项通过。
- 当时 LaTeX 渲染运行时未获准下载，两项 LaTeX 用例到阶段 5 才验证。
- 顺带修复：旧修订号算法里 metadata 键的排序与 Rust 不一致。
- 本阶段的提交让旧应用无法登录，阶段 3 的 `0a7c42d` 修复。

**阶段 3**：默认构建不再包含本地 Lean。

- [实测] 在 `web/dist` 中搜索 Infoview、lean4monaco、Lean WebSocket 的标识，结果为 0 个文件；作为对照，带开关的构建都能搜到，说明搜索有效。
- [实测] 从 `PATH` 去掉 elan 之后，e2e 照常通过。
- 节点状态拆成两个维度（§4.5）。

**阶段 4**：节点转换、协作视图、批量回写。

- [实测，真实 LeanGround `Init` 基座，n = 1 次完整场景，约 34 秒] 覆盖了以下场景，全部通过：
  - 两人共享同一引理；
  - 一人掉线，迟到的证明仍被吸收；
  - 循环拆法记录下来但不成立，暂停后不进入路线；
  - 引入新定义的拆法；
  - 服务重启后继续；
  - 组装成功；
  - 冲突时整批终止，恢复后同一批次提交，重放不新建节点；
  - 定义被编辑后不再显示已认证；
  - 同名定义和不支持的形态带原因拒绝。
- [测量伪影] 场景测试最初复用幂等键，吸收了上一轮测试留在 LeanGround 里的认证。

**阶段 5**：Docker、compose、CI 和 `mdc` 都切到 TypeScript 后端，删除 Rust 代码。

- **Mathlib 统计** [实测：`perf/lean-block-scan.ts`，8,311 个文件，534,073 条顶层命令]：
  - 整个文件当作一个节点时，0 个能转换；
  - 逐条命令时，定理 31.6%、定义 6.4% 能直接转换，主要的拒绝原因是属性约 18%、section/namespace 11.6%、instance 4.8%。
  - 所以 MathDoc 的节点需要按陈述粒度编写。
- **Mathlib 端到端** [实测，n = 2]：带参数的 `structure`、`extends`、ℝ 上的定义都能登记；错误证明被拒；组装与回写成功。
  worker 已热时整个测试约 2 秒，首次加载约 30 秒。
- **其他检查**：
  - 后端测试 34/34；
  - 浏览器 e2e 两次全套，一次 14/15、一次 15/15，唯一的不稳定用例是 Monaco 着色；
  - 渲染器测试 15/15；
  - 容器冒烟 2 次通过；
  - 文档站 25 页，0 错误。
- 合并 `main` 时，采用了它的部署设计（GHCR 镜像、无源码部署包、密钥文件），放弃了它的 Rust 与本地 Lean 改动。

### 3.3 项目阶段 1 的要点

**改动**：

- 看板按「数据库 + 环境」唯一；分支挂载到看板，各存节点绑定、选择、过期状态和回写；
- 新命令 `attach`、`pick`；组装与回写按分支进行；
- 环境按数据库存储，改环境时取代旧看板；
- 旧请求只读；
- 前端新增分支表、「Attach this branch」、按分支的选择与组装。

**测试条件**：本机两个新容器，PostgreSQL 17 和 TerminusDB，与 `mathdoc-demo` 隔离。LeanGround 换成确定性的合同替身
（`coordinator/test/leanground-double.ts`）：GoalKey 取陈述文本的哈希，前提就是源码里的 `sorry` 定理，组装总是认证。
**替身不检查 Lean 证明。**

**结果** [实测，2026-10-02]：

- 协调层 37 项测试：34 项通过，3 项跳过（都需要真实 LeanGround）；`cli` 测试另以不可达的 LeanGround 地址单独运行通过。
- 前端 vitest 29 项通过，svelte-check 0 错误。
- 验收测试 `project.test.ts`（替身，约 2.3 秒）：
  - 在 `main` 证出共用引理后，`alt` 不经导入就显示已证出；
  - `main` 的路线未闭合时，组装被拒；`alt` 组装、回写，只写入 `alt`；
  - 根陈述不同的分支被拒，且没有提交任何认证；
  - 只能读 `main` 的成员看不到 `alt`；
  - 旧请求拒绝命令；
  - 改环境后旧看板只读，改回原环境后恢复。
- 变异检验：让选路忽略分支选择后，测试失败。说明测试能发现选路方面的回归。
- 浏览器按「建项目 → 挂载 `alt` → 在 `main` 证引理 → `alt` 显示 Certified → 在 `alt` 组装、回写」完整走了一遍。

过程中修正的问题：

- 环境改回旧值会让项目卡死；
- 「Resubmit」对还没证出的节点隐藏，导致替换 `sorry` 后无法从界面提交；
- 提交弹窗的文字加长后被面板裁切；
- 共享的目标状态会被误读成本分支的路线状态，因此新增了 Route 列。

**真实 LeanGround 上的验收**（2026-10-08 补跑）：当时 `scenario.test.ts`、`mathlib.test.ts`、浏览器 e2e 的协作用例都需要
LeanGround 令牌，没有运行。2026-10-08 在阶段 2 合并后的代码上补跑 [实测，各 n = 1]：

- 条件：本机开发用的 LeanGround 服务（`127.0.0.1:8765`，提交 `3965273`；基座 1 的根模块是 Mathlib，Lean 4.33.1），
  令牌的操作者不是 `coordinator`，所以测试工具新增 `MDC_TEST_LEANGROUND_ACTOR`（§4.12）；PostgreSQL 与 TerminusDB 同上。
- 协调层全套 47 项全部通过、0 项跳过，共 54 秒。其中迁移阶段 4 的完整场景 `scenario` 37.5 秒（大部分在等租约过期），
  `mathlib`（`MDC_TEST_MATHLIB_BASE_KEY=1`）3.4 秒。
- 浏览器 e2e 的协作用例（Chromium，只运行这一项）19.4 秒通过：在界面里提交 Lean 节点、组装、回写。

所以 §2.7.1 要求的三项真实验收都已通过；但这是本机服务上的单次运行，不是生产部署，阶段 1 仍是「待评审」，没有经过维护者评审。

### 3.4 项目阶段 2 的要点

**目的**：验证 §2.7.2 的两条验收标准：一个 Agent 只用 `pull / split / prove / done` 就能把一个目标拆开并证完；
回复丢失后重跑同一条命令，不会重复提交。

**背景**：阶段 2 之前，新子目标只有 GoalKey，Agent 要读认证源码、手写陈述、再发 `resolve`；`proof command` 每次生成新的幂等键，
重试会重复提交（§2.5）。LeanGround 没有按 GoalKey 读陈述的接口（§4.10）。

**改动**：

- 服务端：
  - 新路由 `GET /projects/ID/goals/KEY/draft?branch=B[&with=…]`（`goal-draft.ts`）：按目标给出草稿，不再限于文档节点；
  - `submit` 作业吸收草图后，为看板上还没有身份的前提自动登记陈述（`worker.ts` 的 `statePremises`），结果写进作业的 `result`；
  - `submit` 命令加 `description`，记在认证上，同步时保留；
  - 目标增加 `proposition`、`definitions`、`declaration` 三个字段（§4.2）；
  - 作业表增加 `result` 列，新路由 `GET /projects/ID/jobs/JOB` 读单个作业。
- 客户端（`coordinator/src/mdc/`）：`client.ts`（请求与错误码）、`goal-file.ts`（工作文件的生成与解析，复用服务端的 `lean-source.ts`）、
  `workspace.ts`（`.mdc/` 记录）、`verbs.ts`（四个动词、目标引用解析、续租、重放）。`cli.ts` 只负责参数与分派。
- 文档站：`reference/workspace-commands.md` 新增「Proof work」，`agents.md`、`proofs.md`、`http-api.md` 相应更新。

**方法**：

- 环境：本机 compose 的两个测试容器，PostgreSQL 17 与 TerminusDB，与 `mathdoc-demo` 隔离；LeanGround 是合同替身
  `leanground-double.ts`。**替身不检查 Lean 证明**；它的 `resolve` 按名字近似报告被引用的定义。
- 验收测试 `verbs.test.ts`，只经 `mdc` 的 `main()` 操作（另用管理员 HTTP 建库、建项目、触发组装）：
  bob 以 viewer 身份 `pull` 根目标 → 加一条占位后 `split --wait` → 新子目标自动得到陈述 → 按 10 位前缀 `pull` 子目标 → `prove --wait` → 两次 `done` → 组装。
  `--wait` 的轮询间隔改为「执行一遍作业队列」，所以 worker 与客户端在同一进程中交替运行。
- 两种重放，各用一个注入故障的 `fetch`：
  1. 请求已到达服务端，回复丢失；重跑之前另有一次写入，使修订号前进；
  2. 请求没有到达，之后修订号前进。
- 续租：把客户端时钟拨快 70 秒（租约 120 秒，剩余不足一半），再运行一个会被本地拒绝的 `prove`。
- 变异检验：逐个改坏 8 处实现，看测试能否失败。
- 合并之后，在本机 LeanGround 服务上运行同一测试的第二项（条件见 §3.3），并对「照抄请求里的定义 ID」再做一次变异检验。

**结果** [实测，2026-10-08]：

- 协调层测试 47 项：43 项通过，0 项失败，4 项跳过（都需要真实 LeanGround）；`cli` 测试另以不可达的 LeanGround 地址单独运行通过。
  其中新增 10 项：`goal-file` 7 项（纯函数）、`domain` 1 项、`verbs` 2 项（替身 1 项通过，真实 LeanGround 1 项跳过）。
  所以本阶段的改动没有让已有测试失败，但真实 LeanGround 上的行为仍未验证。
- `verbs.test.ts` 连续运行 5 次，5 次通过，每次约 1–1.5 秒。所以在替身上没有观察到时序上的不稳定；n = 5 不足以排除低概率的不稳定。
- 验收流程中：子目标的作业结果为 `{name: double_eq, new: true, statement: resolved}`，看板上该目标有身份和声明；
  第二次 `pull` 的签名来自 `declaration`；组装得到 `certified`。所以四个动词足以完成「拆开并证完」，在替身上成立。
- 重放 1：重跑后使用原幂等键与原修订号，看板上 `submit` 作业共 2 个（拆法 1 个、证明 1 个），记录中只有 1 条提交。
  所以回复丢失不会造成重复提交。重放 2：记录依次为 `not_applied`、`queued`，作业只多 1 个。所以过时的重发不会执行。
- 续租：拨快时钟后的那次调用把租约的到期时间推后。所以本地校验失败的调用也能续租。
- 变异检验：8 处改坏全部被测试发现，包括重发时不复用原记录、把 `revision_conflict` 当作拒绝、自动陈述不接受结果、
  G1 不删前提、不核对前段哈希、不续租、重新吸收时丢失说明、照抄请求里的定义 ID。所以这些测试能发现对应的回归。
  第一次检验时「丢失说明」没有被发现，因此补了 `domain` 测试。
- 构建出的 `mdc`（`dist/cli.js`）：失败时退出码 1，stderr 为一行 JSON；用法错误退出码 2。文档站 `astro check` 0 错误，构建通过。
- 本机 LeanGround（Mathlib 基座）：同一流程通过 2 次（单独运行 3.5 秒，全套中 4.0 秒）。子目标的作业结果同样是 `statement: resolved`，
  所以草图占位写成 `∀ binders, type` 再解析，得到的 GoalKey 与认证里该前提的 GoalKey 相同；两种重放同样各只产生一个提交作业；
  组装得到 `certified`。改回「照抄请求里的定义 ID」后测试失败，而且 LeanGround 接受了另一个项目的定义 ID，
  所以 §2.6 项目阶段 2 决定 5 防的是实际存在的泄露路径。

过程中修正的问题：

- 续租原先放在本地校验之后，文件被本地拒绝时不续租；
- 续租原先在客户端时钟显示过期时直接放弃租约，客户端时钟偏快时会误丢租约；
- 目标上原先照抄请求里的定义 ID，可能泄露其他项目的定义源码（§2.6 项目阶段 2 决定 5）。
- 在本机 LeanGround 上首次运行时，测试有两处只对替身成立的假设：写死了 `import Init`（实际基座是 Mathlib）；
  用编造的定义 ID 检查来源规则，替身会把它滤掉，LeanGround 则以 `unknown_definition` 拒绝。现在改为读基座的根模块，
  并另建一个项目登记真实的定义，用它的 ID 做检查。

**结论**：阶段 2 的两条验收标准在替身上和本机 LeanGround（Mathlib 基座）上都成立；「自动陈述得到相同的 GoalKey」
也在本机 LeanGround 上得到确认。真实环境的证据只有 2 次运行、一个简单的例子（`double n = n + n`），
带隐式参数、类型类参数或宇宙参数的占位还没有覆盖。

**未覆盖**：

- 占位签名更复杂时（隐式参数 `{}`、类型类参数 `[]`、宇宙参数、自动绑定的隐式变量），`∀ binders, type` 是否仍解析出相同的 GoalKey，
  没有在 LeanGround 上验证；不一致时作业结果记 `identity_mismatch`，该子目标需要手工 `resolve`。
- 生产部署上没有运行。
- 前提、定义的「是否被引用」按标识符文本判断，没有经过 elaboration，可能误判；误判由服务端拦下（多留占位得到
  `subgoal_unused`，漏报定义得到 `definition_not_registered`），不会产生错误的认证 [推断]。
- `mdc check`、`goals`、`next`、`show`、`note` 不在本阶段；尝试笔记在草稿中恒为空（阶段 3）。
- 多个 Agent 共用一个 `.mdc/` 时只续各自的租约，但记录文件可能被并发写；建议每个 Agent 使用自己的工作目录 [推断]。
- 界面不显示拆法说明（阶段 3 的审阅视图）。

### 3.5 分支与合并状态

[实测：`git`，2026-10-08]

| 分支 | 位置 | 说明 |
|---|---|---|
| `codex/mathdoc-coordination` | 主工作区，远端 `colab` | **主要工作分支**（2026-10-08 起）。包含迁移阶段 0–5、Project 模型设计、项目阶段 1–2 和本文。项目阶段 1、2 的开发分支 `claude/shared-project-board`、`claude/mdc-verbs` 都已以快进方式并入后删除 |

主工作区里另有一组尚未提交的改动（不是本文作者所做）：删除归档原型 `app/` 及其开关 `MDC_APP_DIR`、删除部分 perf 报告，
并相应修改 `coordinator/src/http.ts`、`config.ts`、`package.json` 等。两次合并时这组改动都原样保留在工作区。
项目阶段 2 合并时，它与本分支都改了 `http.ts`：先用带标签的 stash 只移开 `http.ts` 和 `docs/mathdoc.md` 两个重叠文件，
快进之后把它对 `http.ts` 的改动应用回去，并核对与原改动逐行相同；`docs/mathdoc.md` 原有的未提交内容即提交 `ce42e5a`。
在这组改动之上，阶段 2 合并后协调层测试 47 项：43 项通过、4 项跳过（需要真实 LeanGround），`cli` 测试单独运行通过，
前端测试 29 项通过 [实测，2026-10-08]。所以这组改动与阶段 2 的代码可以共存。

### 3.6 已知问题

- **Monaco 着色用例不稳定**：[实测，16 次运行失败 2 次] 编辑器显示后 4–40 毫秒内会重新着色一次，测试恰好在这个窗口取样就会失败。
- **LeanGround 安装脚本原地覆盖已签名的二进制**：macOS 会拒绝运行；本机靠「写新文件再改名」绕过，LeanGround 仓库本身没有修改。
- **前端体积基线未更新**：`web/perf/baseline.json` 仍是移除本地 Lean 之前的数值。

## 4. 技术细节

### 4.1 架构与部署

```
web/（知识编辑界面 + 协作视图）
  │  /p/<库>/<分支>/api/...          /api/coordination/...
  ▼
coordinator/（TypeScript；三种模式 migrate / serve / worker）
  ├─ 文档接口 ──────────► TerminusDB（文档、依赖、历史）
  ├─ LaTeX 预览 ────────► renderer/renderer.py 常驻进程（plasTeX）
  ├─ 协作接口 + 作业 ───► PostgreSQL（工作区、环境、看板、命令、事件、作业）
  └─ worker 作业 ───────► LeanGround 事实接口（/v1/facts/…、/v1/bases/…）
```

- `serve`：一个 HTTP 进程服务所有数据库与分支。分支在第一次请求时加载，之后常驻；每次请求核对 TerminusDB
  的数据版本，只有版本变化时才重新加载。
- `worker`：周期同步与作业执行。可以运行多个；同一项目同一时刻最多只有一个作业在运行，作业的领取会续期，
  崩溃后的作业由其他 worker 重新领取。
- 部署（`compose.server.yaml`）由五个服务组成：
  - `database`（TerminusDB）、`postgres`；
  - 一次性的 `migrate`；
  - `runtime`（API）、`worker`。

  LeanGround 在外部，由 `LEANGROUND_SERVER_URL` 指定。
- 配置项：`MDC_ACTORS`、`MDC_HOST`、`MDC_PORT`、`MDC_TERMINUS_URL/USER/PASSWORD`、`MDC_DATABASE_URL`、
  `MDC_POSTGRES_PASSWORD`、`LEANGROUND_SERVER_URL`、`LEANGROUND_FACT_TOKEN`、`LEANGROUND_ACTOR`、`MDC_WEB_DIR`。
  机密项都可以改用 `*_FILE` 形式从文件读取；机密放在 `secrets/` 中，镜像以 uid 10001 运行。
- 检查脚本 `scripts/check`：
  - `fast`：类型检查、单元测试、构建、文档站、渲染器；
  - `native`：真实 TerminusDB 与 PostgreSQL 上的后端与浏览器测试；
  - `docker`：容器冒烟。

源码分工：

| 文件 | 职责 |
|---|---|
| `coordinator/src/http.ts` | 身份、协作路由、环境、创建或挂载项目、草稿、文档权限复核 |
| `coordinator/src/docs/*` | 文档接口：路由、按分支的服务、快照与校验、TerminusDB 客户端、工作区权限、LaTeX 桥 |
| `coordinator/src/domain.ts` | 看板与全部命令，写成纯状态转换 |
| `coordinator/src/store.ts` | PostgreSQL：看板、幂等命令记录、事件、作业队列、创建或挂载、取代 |
| `coordinator/src/worker.ts` | 作业：`provision`、`attach`、`submit_node`、`resolve`、`submit`（含为新前提自动登记陈述）、`import`、`sync`、`assemble`、`writeback` |
| `coordinator/src/lean-source.ts` | 保守的 Lean 扫描器 |
| `coordinator/src/proof.ts` | 证明环境、节点转换、提交草稿、合同生成 |
| `coordinator/src/writeback.ts` | 回写批次 |
| `coordinator/src/certification.ts` | 文档视图中的认证维度 |
| `coordinator/src/contracts.ts` | v1 合同的运行时镜像；JSON Schema 在 `coordinator/contracts/v1/` |
| `coordinator/src/cli.ts` | `mdc`：参数解析与分派 |
| `coordinator/src/goal-draft.ts` | 目标草稿（§4.11） |
| `coordinator/src/mdc/*` | `mdc` 的动词层：请求与错误码（`client.ts`）、工作文件（`goal-file.ts`）、`.mdc/` 记录（`workspace.ts`）、四个动词（`verbs.ts`） |

### 4.2 数据与存储

| 数据 | 位置 |
|---|---|
| 节点（`fnode` UUID、标题、`module`、`blocks`、`depens`）、LaTeX 设置、历史 | TerminusDB；模式与旧 Rust 应用相同，旧数据原样可读 |
| 工作区 owner 与角色 | PostgreSQL `mdc_workspace` |
| 证明环境 | `mdc_project_environment`（按数据库）；阶段 4 的按分支环境留在 `mdc_environment`，只作为回退来源 |
| 看板 | `mdc_project`，每张看板一条 JSONB；唯一索引 `mdc_project_scope`（数据库、环境） |
| 命令幂等记录、事件、作业 | `mdc_command`、`mdc_event`、`mdc_job`（`result` 列记录作业结果，阶段 2 起） |
| 认证与源码 | LeanGround；MathDoc 只存 ID |

**兼容规则**：

- 节点修订号算法与旧应用逐字节一致；
- 协作标记（认证 ID、批次 ID、定义 ID）只写进块的 `metadata`，不改源码；
- `Project/lean`（旧 Lake 配置）原样保存，不写入新字段；
- 旧的本地认证缓存不迁移。

**看板结构**（`domain.ts` 的 `Board`）：

- 共享部分：`goals`（GoalKey → 展示用标签、状态，以及阶段 2 起的 `proposition`、`definitions`、`declaration`）、
  `facts`（认证 → 目标、前提、信任、`active/paused/retired`、是否仍可读、拆法说明 `description`）、
  `tasks`、`attempts`、`runs`（组装记录，带 `branch`）、`budget`/`spent`、`cursor`（LeanGround 事件游标）、`revision`。
- 项目看板另有：
  - `project`：数据库、环境、根节点、是否被取代；
  - `branches`：分支名 → 每个分支的 `request`（根节点、`bound`、`stale`、`error`、合同快照）、`nodes`（节点绑定）、`picks`、`writebacks`、`accepted`。
- 阶段 4 的旧看板把 `request`、`nodes`、`writebacks` 放在顶层，现在只读。
- 还有一种不绑定文档、由管理员直接给出陈述创建的看板（原型 `app/` 使用），保留未改。

### 4.3 身份与权限

- 每个 API 请求都带 `Authorization: Bearer <令牌>`；令牌在 `MDC_ACTORS` 中映射到操作者，不接受请求体自报身份。
  浏览器请求还要求同源。
- 工作区角色矩阵（合同决定 D）：

| 动作 | 允许的角色 |
|---|---|
| read、history、export | admin、owner、editor、viewer |
| write、branch_create、proof_request_create（提交/挂载分支） | admin、owner、editor |
| branch_delete、import、member_manage（授权、设置证明环境） | admin、owner |
| database_create、database_delete | admin |

- 新分支复制来源分支的授权规则。无权读取与不存在一律返回 404；能读但无权写返回 403。
  没有工作区记录的旧库只有管理员可见，由管理员用 `set_owner` 认领。
- **协作不扩大文档权限**：
  - 项目看板只对能读 `main` 的成员可见，读不到的分支（连同其组装记录）不返回；
  - 创建项目需要 `main` 上的 owner 权限；挂载分支需要该分支的 editor 权限；接受回写需要目标分支的 write 权限；
  - 成员必须能读 `main`。
- **已知限制**：目标和认证属于整个项目。读不到某个分支的成员，仍能看到由它产生的目标标题和认证源码。
  所以需要对部分成员保密的分支，应当放在另一个数据库里。

### 4.4 文档接口

路径为 `/p/<库>/<分支>/api/...`：图查询、节点读写、依赖、LaTeX、历史、导入导出。路由、状态码与旧应用一致：

- 428：缺 `If-Match`；
- 412：修订不符；
- 409：数据版本冲突；
- 422：校验失败。

全局接口 `/api/status`、`/api/projects` 处理目录操作：`init`、`remove`、`new_branch`、`delete_branch`、`grant`、`set_owner`。
没有按分支的启动或停止。分支接口的请求体上限是 256 MiB，协作接口是 2.2 MB。

### 4.5 节点状态的两个维度

`formalization.lean` 表示本地检查，新后端里恒为 `unverified` 或 `no_code`。`formalization.lean_certification`
表示 LeanGround 认证：

| 值 | 含义 |
|---|---|
| `null` | 没有 Lean 块 |
| `not_submitted` | 没有适用于该节点的转换 |
| `insufficient` / `derivable` / `certified` | 目标状态；附 `project`、`branch`（显示的是哪个分支的转换）、`goal`、`minimum_trust`、`checked_at` |
| `stale` | 节点或其陈述所用定义的 Lean 文本在转换后改了 |
| `rejected` | 转换器或 LeanGround 拒绝了它，附原因 |

**状态来源的优先顺序**：

1. 本分支在当前项目看板上的转换；
2. 另一个已挂载分支上文本相同的同一节点；
3. 被取代的看板或旧请求。

`truncated` 恒为假，因为状态由协作层推导，不调用 LeanGround 的 `query`。

### 4.6 v1 合同

四份合同都是 JSON Schema 2020-12，存放在 `coordinator/contracts/v1/`，由 `contracts.ts` 中的 Zod 定义生成。
修改任何一份都要升版本，并同步 fixture 与测试。下表回答：每份合同约束什么。

| 合同 | 要点 |
|---|---|
| `document-permission.v1` | 工作区、分支继承、§4.3 的动作矩阵 |
| `proof-environment.v1` | 环境身份只由完整的 BaseRef、context、options、minimum_trust 决定；请求绑定数据库、分支、根节点与依赖节点的 Lean 内容指纹（Lean 块文本的 SHA-256，不含标题、其他块和 metadata）；定义依赖取传递闭包，定理前提只取直接依赖；`data_version` 只用于审计和回写前置条件，不进入身份 |
| `declaration-binding.v1` | 节点分为 `definition_only`、`theorem`、`unsupported` 三类；必须标明分类来源（`syntax_scan` 或 `explicit_metadata`）；草图必须配 `lean-worker-sketch`，完整证明必须配 `lean-worker`；`required_context` 与固定 context 逐行相等 |
| `writeback-batch.v1` | 批次 ID、重放键、目标分支及其数据版本、来源请求、有序操作（更新块 / 新建目标节点 / 新建定义节点）；`conflict_resolution` 固定为 `abort_entire_batch` |

### 4.7 节点转换（声明绑定）

挂载一个分支时，从根节点出发，沿依赖收集所有有 Lean 块的节点。没有 Lean 块的节点是非形式化说明，遍历不穿过它们。
逐个节点分类：

| 块内容 | 处理 |
|---|---|
| 只有 `def`、`abbrev`、`noncomputable def`、`structure`、`inductive` | 定义节点：按依赖顺序调用 `define` 登记，得到定义 ID |
| 恰好一条 `theorem`/`lemma`，或 metadata 的 `lean_conclusion` 指定了结论 | 定理节点：带上所用定义的 ID 解析陈述，得到 GoalKey |
| 定理的证明是 `sorry` | 成为开放目标，自动生成证明任务 |
| 定理带证明 | 依赖的定理写成前提占位，放在本节点声明之前一起提交：有前提时用 `lean-worker-sketch`，否则用 `lean-worker` |
| 其他 | 带原因拒绝 |

规则：

- `import` 丢弃；节点里的 `open`、`set_option`、`universe`、`variable` 必须与环境的 context 逐行相等（`local_context_mismatch`）；
- 定义节点不能依赖定理节点；
- 拒绝原因包括 `multiple_conclusions`、`mixed_declarations`、`unsupported_declaration`（instance、class、namespace、属性、`open … in`）、
  `premise_name_collision`、`definition_name_taken`、`ambiguous_binding`、`unregistered_statement_definition`；
- 依赖被拒节点的节点随之被拒，details 写明是哪个节点。

**分支级规则**：

- 根节点不在分支上时，拒绝为 `root_not_on_branch`；
- 根陈述与项目根目标不同时，拒绝为 `root_statement_differs`，而且什么也不提交；
- 所有分支共用一个 LeanGround 项目范围，所以两个分支以同名、不同内容登记定义时，后者得到 `definition_name_taken`。

`submit_node` 重新读取一个节点并提交它当前的证明；节点仍是 `sorry` 时，以 `open_goal` 拒绝。

### 4.8 协作看板与规则

**命令**：`POST /api/coordination/projects/<id>/commands`，带 `If-Match: "<修订号>"` 和 `Idempotency-Key`。
同一个键配同样的请求体，返回第一次的结果；配不同的请求体，返回 `idempotency_conflict`。

| 命令 | 谁 | 作用 |
|---|---|---|
| `claim` / `heartbeat` / `finish` | 成员 / 租约持有人 | 租约：30–3600 秒；`finish` 报告花费和结果 |
| `submit`、`resolve`、`import`、`submit_node`、`attach`、`sync` | 成员（`attach` 还需要分支的 editor 权限） | 后台作业；`submit` 可带 `description`，吸收草图时为新前提登记陈述（§4.11） |
| `task`、`members`、`decomposition`、`pick`、`assemble`、`retry`、`accept` | owner | 管理 |
| `notes` | 成员 | 项目备注 |

**规则**：

- 数学状态、任务、尝试、拆法状态、项目状态分开记录。
- 目标按 GoalKey 去重；每个新目标自动得到一个 `prove` 任务。
- 只有从根出发、经 `active` 认证能到达的目标才能领取（否则 `inactive_goal`）。
- **租约**：只有一个持有人；epoch 防止迟到者覆盖新状态；过期在下一次状态变化时记录，按预留额全额计费；
  过期只撤销调度权，迟到的正确证明仍然吸收。
- **预算**：领取时预留，结束时结算；超额以 `budget_exhausted` 拒绝。外部 Agent 的实际花费只能靠它自己上报。
- **同步**：每个就绪、未被取代的看板约每 15 秒同步一次：
  - 重新读取已知认证，读不到的标为不可用；
  - 读取 LeanGround 事件，事件与游标在同一事务里保存；
  - 记录到期的租约；
  - 检查各分支是否过期，已删除的分支标为过期。
- 目标状态从认证推导；没有叶子证据的环不能证出任何目标。
- **只读看板**：旧请求返回 `proof_request_read_only`，被取代的看板返回 `project_superseded`；二者都不再同步。

**读取**：除看板本身外，`GET /projects/ID/jobs`（最近 100 个作业）、`/jobs/JOB`（单个作业及其 `result`）、
`/goals/KEY/draft`（目标草稿，§4.11）、`/nodes/UUID/draft`（节点草稿）、`/facts/CERT`（认证及源码）。

### 4.9 组装、回写与过期

**组装**：

- 选路在协作层完成，只用 `active` 的认证；已选择的目标严格使用所选认证，其余选前提最少的；路线不闭合时以 `no_active_route` 拒绝。
- LeanGround 先固定计划，再组装。失败且可重试时，用同一计划重试；换路线就是新计划。组装用的尝试号就是运行 ID，所以响应丢失后可以重放。

**回写**（目标是组装记录所在的分支，其他分支不受影响）：

1. 路线上已有对应节点的，先核对其 Lean 文本仍是转换时的文本，否则整批 `aborted`（`document_conflict`）。
2. 由节点原文转换来的认证只写 metadata；在别处证出的，替换声明部分，保留节点原有的 import 与 context 行，
   且结论名必须保留（否则 `public_declaration_renamed`）。
3. 没有节点的子目标和定义新建节点，节点 ID 由批次 ID 派生，所以重放不会重复创建。
4. 写入的块带 `certification_id`、`certified_lean_sha256` 和批次 ID；根节点记录最终认证。
5. 整批作为一次 TerminusDB 提交，带读取时的数据版本作为前置条件；已提交的批次由根节点上的批次 ID 识别。

**过期**：

- **分支级**：根节点、直接前提或所用定义的 Lean 文本与转换时不同，即为过期，此时 `accept` 被拒（`proof_request_stale`），旧成果保留。
- **节点级**：节点自己或其所用定义的文本改了，就显示 `stale`。
- 回写自己写入的文本是新的基准。
- 已知取舍：前提只改证明、不改陈述时也会判为过期。这是保守的做法，不会错用旧成果。

**环境变化**：环境改了，看板就被取代；改回以前的值，恢复那时的看板。

### 4.10 LeanGround 接口与部署前提

**使用的接口**：

- `POST /v1/facts/{submit,define,resolve,read,plan,assemble,project,widen,events}`；
- `GET /v1/bases/{key}`。

带定义的命题必须用 `/v1/facts/resolve` 并传 `definitions`。定义只通过 ID 传递；新定义经 `new_definitions` 随提交一并登记。
组件与模式必须配对：`lean-worker-sketch` 对 `sketch`，`lean-worker` 对 `leaf` 和组装。

**部署前提**：

- LeanGround 的 `main` 不早于 `3965273`；
- 已执行 `leanground db schema --only 10-definitions`；
- worker 按新版重新安装：旧 worker 拒绝一切带定义的请求，症状是返回 `definition_is_proposition`；
- 草图组件没有被停用；
- 协调服务的身份（`LEANGROUND_ACTOR`）与令牌一致。

**LeanGround 侧的限制**：

- 源码形态较严，拒绝 `#` 命令、`open … in`、属性、`private`、`instance`、`class`、记号、宏等；
- 没有读取项目成员的接口；
- 没有按 GoalKey 读取陈述的接口，认证也只给出前提的 GoalKey，不给出完整身份。所以 `submit` 作业从草图的占位声明重新 `resolve`，
  GoalKey 一致才记下（§4.11）；
- `/v1/check` 按 import 选择基座，不认识项目里登记的定义，也不返回 `sorry` 处的证明目标（所以需要项目决定 E 中的新接口）。

### 4.11 目标工作文件规范 `mdc-goal-file/1`

本节规定 `mdc pull` 写出、`mdc check/prove/split` 读入的文件。规范已定（G1–G4），已在项目阶段 2 实现（`coordinator/src/mdc/`；
`check` 除外）。「必须」「不得」违反时 `mdc` 拒绝；「应当」违反时只警告。

**目标草稿**（`GET /projects/ID/goals/KEY/draft?branch=B[&with=K1,K2]`）：`pull` 只用这一个接口取材料。

- 结论的名字与签名依次取自：分支 B 上绑定该目标、转换后 Lean 文本未改的节点；看板上的 `declaration`（引入该目标的草图占位，
  或某个分支上陈述它的节点，先记下的保留）；看板上只有 `proposition` 时，写成 `theorem goal_<前 8 位> : 命题`。
  目标没有身份时报 `goal_unresolved`，因为没有身份就无法提交它的证明。
- 可用前提：节点来源时取该节点的直接前提节点；再加上 `with` 指定的目标。每个前提的签名按同样的顺序取得。
- 定义：结论与前提所用定义的并集，加上它们的依赖，按依赖顺序排列，源码从 LeanGround 读取。
- 另给出 `root_module`、`context`、`options`、`environment_id`、看板修订号、笔记（阶段 3 之前恒为空）和该目标的 `prove` 任务及租约。

**新子目标的陈述**：`submit` 作业吸收草图后，对看板上还没有身份的每个前提，按认证的绑定名在提交的源码中找到占位声明，
以 `∀ binders, type` 加上认证的 `definitions` 调用 `resolve`。GoalKey 一致就记下身份、命题、被引用的定义和声明；
不一致记为 `identity_mismatch`，LeanGround 拒绝记为它的原因码，都只写进作业结果。

**工作目录**：

- `.mdc/workspace.json`（服务器地址、项目，不含令牌，令牌一律从环境变量 `MDC_TOKEN` 读取）；
- `.mdc/files/<文件名>.json`（每个工作文件一条记录）；
- 工作文件默认命名为 `<GoalKey 前 8 位>-<结论名>.lean`；目标文件已存在时拒绝覆盖（`file_exists`）。

**文件结构**：

- 文件为 UTF-8；读取时把 CRLF 换行统一为 LF。
- 全文有且只有一行分隔行 `-- mdc: edit below this line`，它是前段的最后一行。前段的 SHA-256 记在 `.mdc/` 中。
- **前段（只读）**，按顺序：
  - 第 1 行 `-- mdc-goal-file/1`；
  - 说明注释；
  - `import <root_module>`；
  - 环境上下文与已登记定义，顺序与 LeanGround 构造检查前言的顺序相同 [实测：LeanGround `Tools/VerifyWorker.lean:272-280`，`3965273`]：
    `raw`、`local_options`、由环境 `options` 生成的 `set_option` 行（按键排序）、`universe`、`open`、已登记定义、`local_notation`、
    `local_attrs`、`variable`。定义按依赖顺序排列，每段前有一行 `-- definition <名字> (<ID 前 8 位>)`。
    原规范写的是 `set_option`、`open`、`universe`、`variable`，并把定义放在上下文之后；那是未核实的推测，已按实际顺序修正；
  - 最近 20 条尝试笔记，用 `--` 注释写出，每条最多 500 字符；
  - 分隔行。
- **正文（可编辑）**，初始内容是可用前提（每行一个 `theorem … := sorry`）和结论定理。顶层命令只能是三类：
  - 结论：恰好一条，签名不得改动；
  - 前提占位：证明体恰好是 `sorry` 或 `by sorry`；
  - 辅助声明：已完整证明的引理，或 `def` 等定义。

正文规则（括号里是 `mdc` 报的原因码）：

- 不得含 `import`、`open`、`set_option`、`universe`、`variable`（`context_in_body`）；
- 不得含 `example`、`instance`、`class`、`namespace`、`section`、`#` 命令、属性、`private`（`unsupported_declaration`）；
- 声明的续行必须缩进；
- 声明名全文唯一（`duplicate_name`），且不含 `'`（`invalid_name`）；
- 结论缺失、重复或签名被改，分别报 `root_missing`、`root_duplicated`、`root_statement_changed`；
- 提交时结论的证明不得是 `sorry`（`root_is_sorry`）；`check` 不受此限；
- 前提占位与结论的签名文本相同时，报 `premise_equals_root`。

**从文件到请求**：

1. 规范化换行；
2. 核对分隔行和前段哈希（`separator_missing`、`prefix_modified`）；
3. 用与服务端同一份扫描器检查正文；
4. 删去拉取时写入、但正文中没有引用的可用前提（G1）。Agent 自己新增的占位不删，交给服务端以 `subgoal_unused` 拒绝；
5. 判断模式：没有占位就是 `leaf`，否则是 `sketch`。`prove` 要求 `leaf`（否则 `has_premises`），`split` 要求 `sketch`（否则 `no_premises`）；
6. 名字出现在某个前提陈述里的定义，列入 `new_definitions`；
7. 组成 `submit` 请求，只发送正文。`--dry-run` 打印实际要提交的源码。

**重放**：

- 发送前，先把幂等键 `submit-<请求 SHA-256 前 32 位>-r<修订号>`、修订号和请求哈希写入记录；
- 结果不确定时，原样重发。服务端先查幂等键、再查修订号，所以第一次如果已经生效，重发只会拿回第一次的结果；
- 收到 `revision_conflict` 时，说明之前的发送没有生效，用新的修订号新增一条记录。

**记录字段**：`format`、`file`（相对工作区根的路径）、`project`（看板 ID）、`database`、`branch`、`goal`、
`environment_id`（环境变了就拒绝提交，报 `environment_changed`）、`root`、`root_signature`、`definitions`、`premises`、
`prefix_sha256`、`pulled_revision`、`lease`（任务、尝试、epoch、持有人、到期时间、ttl、预留额、领取时间）、`submissions`。

**提交记录的状态**：`sending`（已落盘、结果未知）、`queued`（看板已接收）、`certified`（作业已记下认证）、`rejected`（被拒，附原因）、
`not_applied`（修订号过时，没有执行）。同一份正文已有 `queued` 或 `certified` 的记录时，只报告那次结果（`replayed: true`），
`--again` 强制重发；`--wait` 等作业结束（`--timeout` 默认 600 秒）。

**分支**：`pull` 的 `--branch` 默认取 `-p` 指定的分支，决定节点来源的签名和可用前提。

### 4.12 测试与验收

| 测试 | 需要 | 内容 |
|---|---|---|
| `domain`、`lean-source`、`contracts`、`config`、`goal-file` | 无 | 纯函数与合同 fixture；`goal-file` 是工作文件的生成与解析 |
| `integration`、`documents` | PostgreSQL | 并发领取、幂等、作业租约、事件游标；LeanGround 用 HTTP 替身 |
| `docs` | PostgreSQL、TerminusDB | 文档接口与权限矩阵 |
| `project` | PostgreSQL、TerminusDB | 项目看板验收；LeanGround 用 `leanground-double.ts` |
| `verbs` | PostgreSQL、TerminusDB；第二项另需真实 LeanGround | 项目阶段 2 验收：四个动词走完拆开与证完、两种重放、续租；第一项用替身 |
| `cli` | PostgreSQL、TerminusDB，以及配置好的 LeanGround 变量（不调用证明命令） | `mdc` 文档命令 |
| `scenario`、`mathlib` | 再加真实 LeanGround（`MDC_TEST_LEANGROUND_URL/TOKEN`；`mathlib` 另需 Mathlib 基座的 key） | 完整协作场景 |
| `verbs` 第二项 | 同上 | 阶段 2 的同一流程在真实 LeanGround 上运行 |
| `web` vitest、svelte-check、`web/e2e` | e2e 需要 TerminusDB、PostgreSQL，协作用例需要 LeanGround | 界面 |

测试的环境变量：`MDC_TEST_DATABASE_URL`、`MDC_TEST_TERMINUS_URL`、`MDC_TEST_TERMINUS_PASSWORD`；真实 LeanGround 另需
`MDC_TEST_LEANGROUND_URL`、`MDC_TEST_LEANGROUND_TOKEN`，令牌的操作者不是 `coordinator` 时设 `MDC_TEST_LEANGROUND_ACTOR`
（协调服务把这个操作者登记为每个 LeanGround 项目的成员）。浏览器 e2e 用的是 `LEANGROUND_SERVER_URL`、`LEANGROUND_FACT_TOKEN`、
`LEANGROUND_ACTOR`。
每个测试使用独立的 PostgreSQL schema 和 TerminusDB 数据库。

## 5. 未覆盖与待定

**真实环境**：

- 项目阶段 1、2 的真实 LeanGround 测试只在本机开发用的 LeanGround 服务上各运行过 1–2 次（§3.3、§3.4）；
- 整个协作应用没有在生产 TerminusDB 和生产 LeanGround 上部署验收；
- 新 CI 没有在 GitHub 上运行过；
- 本机没有真实的 MathDoc 文档库，Mathlib 统计与手写文档只是替代。

**规模**：

- 所有分支共用一行 JSONB 看板，同一项目的写入是串行的；
- 每次同步都要加载每个已挂载分支的快照；
- 都没有做负载测量，项目阶段 5 处理。

**协作功能缺口**：

- 证否、尝试笔记、`proposed` 审阅、委托子令牌；
- `mdc` 只有第一批动词，没有 `check`、`goals`、`next`、`show`、`note`；`proof command` 仍不能安全重放；
- 续租只在调用 `mdc` 时发生：Agent 超过租期不调用 `mdc`，租约就会过期（§2.6 项目阶段 2 决定 1）；
- 分支 editor 不能修改自己分支的选择；
- 删除的分支不会自动移出看板；
- 状态借用只按 UUID 加文本比较。

**权限**：分支的读权限不隐藏共享的目标与认证（§4.3）。

**LeanGround**：

- 定义同名在多分支下的行为没有用真实 LeanGround 验证；
- 草稿检查接口还没有设计（项目决定 E）；
- 安装脚本问题没有在 LeanGround 仓库修复。

**旧数据**：旧证明请求的认证不会自动导入新看板；旧库需要管理员认领；已有文档中不合规 Lean 块的比例没有统计。

**界面**：

- 没有工作区成员管理界面；
- 协作视图靠轮询（5 秒），没有推送；
- 只在桌面宽度下做过检查；
- Monaco 用例不稳定；
- 编辑器换成系统等宽字体后没有做截图比对。

## 附录 A：历史文档

以下文档已合并进本文后删除，原文可以用 `git show 2d9fa39:<路径>` 查看。阶段报告中的完整测量记录、评审往来与逐项自查表只保留在那里。

| 路径 | 原内容 | 现在的位置 |
|---|---|---|
| `docs/coordination.md` | Codex 原型的说明 | §4.1、§4.8（原型界面 `app/` 已不再使用） |
| `docs/coordination-migration-plan.md` | 迁移计划（§0–§12） | §2.1、§2.6、§3.2、§4 |
| `docs/coordination-phase-1-contracts.md` | v1 合同与合同决定 A–D | §2.6、§4.3、§4.6 |
| `docs/coordination-phase-2.md` … `phase-5.md` | 迁移阶段 2–5 报告 | §3.2、§3.6 |
| `docs/coordination-project-model.md` | Project 模型设计、项目决定 A–F | §2.3–§2.7 |
| `docs/coordination-goal-file.md` | `mdc-goal-file/1` 规范、决定 G1–G4 | §4.11 |
| `docs/coordination-project-stage-1.md` | 项目阶段 1 报告 | §2.6、§3.3 |

代码注释里原来的「plan §x」改为引用本文的章节：§4.1 架构与部署，§4.2 数据，§4.3 身份与权限，§4.4 文档接口，
§4.5 状态，§4.6 合同，§4.7 节点转换，§4.8 协作规则，§4.9 组装、回写与过期，§4.10 LeanGround 接口。
