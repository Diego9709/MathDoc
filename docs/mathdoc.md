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

本文只描述 `codex/mathdoc-coordination` 及由它派生的分支（§3.4）：TypeScript 后端，证明交给 LeanGround。
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

**现状** [实测：`coordinator/src/cli.ts`]：`mdc` 是 HTTP API 的薄客户端，证明相关只有 `proof env/submit/list/status/command`。
其中 `proof command` 读原始 JSON，每次都生成新的幂等键，所以断网重试会重复提交；它也没有自动续租，拆法后需要手写子目标陈述。

**动词层**（项目阶段 2）：在现有命令之上，加一层以证明工作流命名的命令。第一批：

| 动词 | 做什么 |
|---|---|
| `mdc pull GOAL [--branch B]` | 领取目标，写出工作文件（§4.11）；领取期间在后台自动续租 |
| `mdc prove FILE` | 把文件作为完整证明提交 |
| `mdc split FILE -m 说明` | 把文件作为拆法提交；服务端自动为新子目标登记陈述 |
| `mdc done [--spent N]` | 结束租约并报告实际花费 |

之后的动词：

- `mdc check FILE`：只检查不入库，等 LeanGround 提供接口（项目决定 E）；
- `mdc goals`、`mdc next`、`mdc show`、`mdc note`；
- 维护者用的 `mdc review` 和 `mdc branch new --pick`。

工程性质：

- 默认输出 JSON，错误码稳定；
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

### 2.7 路线图

迁移阶段 0–5 已经完成（§3.2），后续工作按项目阶段推进。下表回答：每个阶段做什么、怎样算完成。

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 1 共享看板 | 环境和看板改为按数据库；分支是路线；节点状态按 GoalKey 读共享看板；旧请求只读 | 两个分支选不同的根拆法、共用引理 B：一个分支证出 B 后，另一分支的 B 节点同时显示已证出，不需要导入；旧请求可读、拒绝命令 | 已实现，待评审（§3.3） |
| 2 `mdc` 动词层 | `pull / split / prove / done`、`.mdc/` 重放、自动续租、服务端按目标生成草稿、自动 `resolve`；`check` 等 LeanGround 接口 | 断网重试不重复提交；一个 Agent 只用这四个动词就能把一个目标拆开并证完 | 未开始 |
| 3 审阅 | `proposed` 状态、审阅视图、尝试笔记 | `proposed` 的拆法不产生可领取的任务，启用后才产生 | 未开始 |
| 4 Agent 身份 | 委托子令牌、`mdc mcp` | 两个命令行 Agent 各用自己的子令牌：审计记录可以区分，子令牌无法执行维护者命令 | 未开始 |
| 5 规模与证否 | 看板拆表、证否、`mdc next` 调度 | 参与者数、目标数和写入延迟的目标值在本阶段开始前定下 | 未开始 |

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
| 项目阶段 1：共享看板 | 已实现，待评审 | 2026-10-02 | `dc2f143`、`3a1c668`、`99060b4`、`2d9fa39` |
| 项目阶段 2–5 | 未开始 | — | — |

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

**未运行**：`scenario.test.ts`、`mathlib.test.ts`、浏览器 e2e 的协作用例，三者都需要 LeanGround 令牌。
所以阶段 1 只能算「待评审」，还不是「已验收」。

### 3.4 分支与合并状态

[实测：`git`，2026-10-08]

| 分支 | 位置 | 说明 |
|---|---|---|
| `codex/mathdoc-coordination` | 主工作区，远端 `colab` | **主要工作分支**（2026-10-08 起）。包含迁移阶段 0–5、Project 模型设计、项目阶段 1 和本文。项目阶段 1 的开发分支 `claude/shared-project-board` 已以快进方式并入后删除 |

主工作区里另有一组尚未提交的改动（不是本文作者所做）：删除归档原型 `app/` 及其开关 `MDC_APP_DIR`、删除部分 perf 报告，
并相应修改 `coordinator/src/http.ts`、`config.ts`、`package.json` 等。合并时这组改动原样保留在工作区；在它之上，
协调层测试 34 项通过、3 项跳过（需要真实 LeanGround），前端测试 29 项通过 [实测，2026-10-08]。

### 3.5 已知问题

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
| `coordinator/src/worker.ts` | 作业：`provision`、`attach`、`submit_node`、`resolve`、`submit`、`import`、`sync`、`assemble`、`writeback` |
| `coordinator/src/lean-source.ts` | 保守的 Lean 扫描器 |
| `coordinator/src/proof.ts` | 证明环境、节点转换、提交草稿、合同生成 |
| `coordinator/src/writeback.ts` | 回写批次 |
| `coordinator/src/certification.ts` | 文档视图中的认证维度 |
| `coordinator/src/contracts.ts` | v1 合同的运行时镜像；JSON Schema 在 `coordinator/contracts/v1/` |
| `coordinator/src/cli.ts` | `mdc` |

### 4.2 数据与存储

| 数据 | 位置 |
|---|---|
| 节点（`fnode` UUID、标题、`module`、`blocks`、`depens`）、LaTeX 设置、历史 | TerminusDB；模式与旧 Rust 应用相同，旧数据原样可读 |
| 工作区 owner 与角色 | PostgreSQL `mdc_workspace` |
| 证明环境 | `mdc_project_environment`（按数据库）；阶段 4 的按分支环境留在 `mdc_environment`，只作为回退来源 |
| 看板 | `mdc_project`，每张看板一条 JSONB；唯一索引 `mdc_project_scope`（数据库、环境） |
| 命令幂等记录、事件、作业 | `mdc_command`、`mdc_event`、`mdc_job` |
| 认证与源码 | LeanGround；MathDoc 只存 ID |

**兼容规则**：

- 节点修订号算法与旧应用逐字节一致；
- 协作标记（认证 ID、批次 ID、定义 ID）只写进块的 `metadata`，不改源码；
- `Project/lean`（旧 Lake 配置）原样保存，不写入新字段；
- 旧的本地认证缓存不迁移。

**看板结构**（`domain.ts` 的 `Board`）：

- 共享部分：`goals`（GoalKey → 陈述、状态）、`facts`（认证 → 目标、前提、信任、`active/paused/retired`、是否仍可读）、
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
| `submit`、`resolve`、`import`、`submit_node`、`attach`、`sync` | 成员（`attach` 还需要分支的 editor 权限） | 后台作业 |
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
- 没有按 GoalKey 读取陈述的接口，所以拆法产生的新子目标需要有人写出陈述再 `resolve`；
- `/v1/check` 按 import 选择基座，不认识项目里登记的定义，也不返回 `sorry` 处的证明目标（所以需要项目决定 E 中的新接口）。

### 4.11 目标工作文件规范 `mdc-goal-file/1`

本节规定 `mdc pull` 写出、`mdc check/prove/split` 读入的文件。规范已定（G1–G4），实现属于项目阶段 2，**尚未实现**。
「必须」「不得」违反时 `mdc` 拒绝；「应当」违反时只警告。

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
  - 环境上下文：`set_option`、`open`、`universe`、`variable` 各组，组内保持原顺序；
  - 已登记定义的源码，按依赖顺序排列，每段前有一行 `-- definition <名字> (<ID 前 8 位>)`；
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

**记录字段**：`format`、`file`、`project`、`goal`、`environment_id`（环境变了就拒绝提交，报 `environment_changed`）、
`root`、`root_signature`、`definitions`、`premises`、`prefix_sha256`、`pulled_revision`、`lease`、`submissions`。

**待补**：在项目模型下，`pull` 需要 `--branch` 参数，决定从哪个分支的节点预填可用前提 [推断]。

### 4.12 测试与验收

| 测试 | 需要 | 内容 |
|---|---|---|
| `domain`、`lean-source`、`contracts`、`config` | 无 | 纯函数与合同 fixture |
| `integration`、`documents` | PostgreSQL | 并发领取、幂等、作业租约、事件游标；LeanGround 用 HTTP 替身 |
| `docs` | PostgreSQL、TerminusDB | 文档接口与权限矩阵 |
| `project` | PostgreSQL、TerminusDB | 项目看板验收；LeanGround 用 `leanground-double.ts` |
| `cli` | PostgreSQL、TerminusDB，以及配置好的 LeanGround 变量（不调用证明命令） | `mdc` 文档命令 |
| `scenario`、`mathlib` | 再加真实 LeanGround（`MDC_TEST_LEANGROUND_URL/TOKEN`；`mathlib` 另需 Mathlib 基座的 key） | 完整协作场景 |
| `web` vitest、svelte-check、`web/e2e` | e2e 需要 TerminusDB、PostgreSQL，协作用例需要 LeanGround | 界面 |

测试的环境变量：`MDC_TEST_DATABASE_URL`、`MDC_TEST_TERMINUS_URL`、`MDC_TEST_TERMINUS_PASSWORD`。
每个测试使用独立的 PostgreSQL schema 和 TerminusDB 数据库。

## 5. 未覆盖与待定

**真实环境**：

- 项目阶段 1 没有在真实 LeanGround 上运行（§3.3）；
- 整个协作应用没有在生产 TerminusDB 和生产 LeanGround 上部署验收；
- 新 CI 没有在 GitHub 上运行过；
- 本机没有真实的 MathDoc 文档库，Mathlib 统计与手写文档只是替代。

**规模**：

- 所有分支共用一行 JSONB 看板，同一项目的写入是串行的；
- 每次同步都要加载每个已挂载分支的快照；
- 都没有做负载测量，项目阶段 5 处理。

**协作功能缺口**：

- 证否、尝试笔记、`proposed` 审阅、`mdc` 动词层、委托子令牌；
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
| `docs/coordination-phase-2.md` … `phase-5.md` | 迁移阶段 2–5 报告 | §3.2、§3.5 |
| `docs/coordination-project-model.md` | Project 模型设计、项目决定 A–F | §2.3–§2.7 |
| `docs/coordination-goal-file.md` | `mdc-goal-file/1` 规范、决定 G1–G4 | §4.11 |
| `docs/coordination-project-stage-1.md` | 项目阶段 1 报告 | §2.6、§3.3 |

代码注释里原来的「plan §x」改为引用本文的章节：§4.1 架构与部署，§4.2 数据，§4.3 身份与权限，§4.4 文档接口，
§4.5 状态，§4.6 合同，§4.7 节点转换，§4.8 协作规则，§4.9 组装、回写与过期，§4.10 LeanGround 接口。
