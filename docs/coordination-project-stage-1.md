# 项目模型阶段 1：一个数据库一张看板，分支是路线

状态：**已实现，待评审**（2026-10-02）。分支 `claude/shared-project-board`，基于 `cb850d2`；协调层提交 `dc2f143`，
前端提交 `3a1c668`，文档与本报告在其后一个提交。没有合入 `codex/mathdoc-coordination`。

## 目的

本文回答：`docs/coordination-project-model.md` §8 阶段 1 是否达到它的两条验收标准。

1. 两个分支选用不同的根拆法、共用引理 B。在一个分支证出 B 之后，另一个分支的 B 节点同时显示已证出，并且不需要任何导入。
2. 现有按分支建立的证明请求仍然可读，但不再接受命令。

## 背景

### 术语

| 术语 | 含义 |
|---|---|
| 项目看板 | 一个数据库在一个证明环境下的协作状态：目标、认证、任务、租约、预算。存在 PostgreSQL 里 |
| 挂载分支 | 把一个分支的文档从项目根节点开始转换，登记定义、解析陈述、提交带证明的节点，结果记在看板的 `branches[分支名]` 下 |
| 选择（pick） | 分支在某个目标上选用的认证（拆法或完整证明）。一个分支所有选择的集合就是它的路线 |
| 路线闭合 | 按分支的选择、在启用的认证中，能从根推到完整证明。目标状态是各分支共享的，路线闭合是每个分支自己的 |
| 被取代（superseded） | 数据库的证明环境改变之后，旧看板被标记为被取代：仍然可读，不再接受命令 |
| 旧证明请求 | 阶段 4 中按（数据库, 分支, 根节点）建立的看板 |
| GoalKey | LeanGround 对「某个环境下的一条命题」算出的身份，同一命题得到同一个 key |

### 已有的决定

- **A**：一个 Project 对应一个数据库。
- **C**：分支路线存在看板里。
- **D**：旧证明请求只读保留，新请求一律进入 Project 看板。

（见 `docs/coordination-project-model.md`「已决定」。）

改动之前，一个证明请求绑定（数据库, 分支, 根节点），并在 LeanGround 注册独立的项目范围。所以不同分支之间不共享认证。
[实测：`cb850d2` 的 `coordinator/src/domain.ts`、`http.ts`]

## 方法

### 改动

下表回答：每个文件改了什么。

| 位置 | 改动 |
|---|---|
| `coordinator/src/domain.ts` | 看板新增 `project`（数据库、环境、根节点、是否被取代）和 `branches`（每个分支的请求、节点绑定、选择、回写）；新增 `attach`、`pick` 命令；`submit_node`、`assemble` 增加 `branch` 参数；选路遵守选择；旧证明请求和被取代的看板拒绝一切命令 |
| `coordinator/src/store.ts` | 唯一索引「数据库 + 环境」；`submitBranch`：在一个事务里创建看板或挂载分支，同一（操作者, 幂等键）重放时返回第一次的结果；`supersede`；旧看板和被取代的看板不再参与周期同步 |
| `coordinator/src/worker.ts` | `bind` 按分支进行，根陈述不同时什么也不提交；新增 `attach` 作业；`provision` 挂载创建时提交的分支；`submit_node`、过期检查、回写都按分支进行 |
| `coordinator/src/http.ts` | 环境接口改为 `/environments/DB`，修改环境时取代旧看板；`POST /projects` 改为「创建或挂载」；看板访问以 `main` 的读权限为准，读不到的分支不返回；草稿接口需要 `?branch=` |
| `coordinator/src/proof.ts` | 环境按数据库存储（新表 `mdc_project_environment`），未设置时沿用旧表里 `main` 分支的环境 |
| `coordinator/src/certification.ts` | 节点状态的来源顺序：本分支自己的转换；其他已挂载分支上文本相同的同一节点；旧证明请求 |
| `coordinator/src/writeback.ts`、`cli.ts` | 回写使用分支的请求和节点绑定；`mdc proof env` 按数据库读写 |
| `web/` | 协作对话框改为按当前分支显示：分支表（状态、选择数、路线是否闭合）、「Attach this branch」、每条拆法被哪些分支选用以及「Use on this branch / Unpick」、按当前分支组装；只读看板显示原因并禁用命令 |
| `docs/src/content/docs/` | 协作概念、证明参考、Agent 接口、HTTP API、命令行、界面等 11 页 |

### 实现中定下的细节（需要评审）

这些细节设计文档没有规定，是实现时定下的，列出来供评审：

1. **创建项目只限数据库 owner**，因为它为整个数据库固定根定理；挂载分支只需要该分支的 editor 权限。
2. **分支一律从项目根节点（按 UUID）转换**，与点击了哪个节点无关。分支上的根如果解析出不同的 GoalKey，就以
   `root_statement_differs` 拒绝，而且不提交任何认证。
3. **看板可见性以 `main` 的读权限为准**；成员读不到的分支，连同它的组装记录，都不出现在返回结果里。
4. **选择的来源**：节点在转换或重新提交时得到的认证，自动成为该分支在这个目标上的选择；owner 可以用 `pick` 修改。
5. **状态共享规则**：一个节点在本分支没有转换时，如果另一个已挂载分支上同一节点的 Lean 文本、以及它所用定义的文本完全相同，
   就借用那里的状态。
6. **LeanGround 项目 ID 改为随机**（`mdc-…`），不再由（操作者, 幂等键）派生；创建的幂等性改由唯一索引和命令表保证。
7. **前端顺带的两处修正**：
   - 「Resubmit」以前对 open 节点隐藏，替换 `sorry` 之后无法从界面重新提交，现在对所有定理节点显示；
   - 提交弹窗的说明文字加长后，顶部被面板裁掉约 30 像素，已缩短到原来的长度。

### 测试条件

- **PostgreSQL 17 和 TerminusDB**：用本机已有的 `postgres:17-bookworm` 镜像和 `compose.yaml` 固定的 TerminusDB 镜像，
  另起两个容器（端口 25432、26363，随机密码），与正在运行的 `mathdoc-demo` 容器隔离。每个测试使用独立的 schema 和数据库。
- **LeanGround 是确定性合同替身**（`coordinator/test/leanground-double.ts`）：
  - GoalKey 是「陈述文本 + 上下文 + 选项」的哈希；
  - 前提就是源码里证明为 `sorry` 的定理；
  - 组装总是认证。

  它**不检查任何 Lean 证明**，也不检查 `subgoal_unused`、定义同名等 LeanGround 自己的规则。所以下面凡是标「替身」的结果，
  证明的是协调层的逻辑，不是与真实 LeanGround 的配合。
- **浏览器**：内置浏览器打开本机预览（同样的容器加替身，API 端口 17999）。

## 结果

### 自动测试 [实测，2026-10-02，n = 1 次完整运行]

| 范围 | 结果 |
|---|---|
| `coordinator` 测试，37 项 | 34 项通过，3 项跳过：`cli`、`scenario`、`mathlib` 都要求配置真实 LeanGround |
| `cli.test.ts` 单独运行，LeanGround 地址指向不可达端口 | 1 项通过。该测试不调用证明命令，所以不需要 LeanGround |
| 类型检查 | `tsc` 0 错误；测试文件另做一次类型检查，0 错误 |
| `web` | vitest 29 项通过；svelte-check 0 错误、0 警告；vite 构建成功 |

所以 37 项里有 35 项实际运行并通过；`scenario` 和 `mathlib` 两项**没有运行**。它们已经按新接口修改（`mathlib` 的第二个根移到
另一个数据库；`scenario` 末尾的拒绝检查改在分支 `bad` 上做）。

**[测量伪影]** 有一次运行我给全部测试都设置了不可达的 LeanGround 地址，`scenario` 因此被启用，并在设置环境时以
`502 leanground_unavailable` 失败。这是我的环境设置造成的，不是代码问题；上表不含那次运行。

### 验收测试 `project.test.ts` [实测，替身，n = 1 次运行约 2.2 秒]

下表回答：验收要求的每一项，测试里实际观察到了什么。

| 检查 | 观察 |
|---|---|
| 环境按数据库设置 | editor 设置被拒（403）；owner 设置后 editor 可读 |
| 创建项目 | editor 被拒（403）；owner 得到 201；同一幂等键重放返回同一看板，状态码仍是 201 |
| `main` 的根拆法 | 根 ⇐ {double_two, double_three}，自动成为 `main` 的选择 |
| 挂载 `alt`（editor） | 200；`alt` 的根 ⇐ {double_eq}；两个分支的根是同一个目标，double_eq 也是同一个目标，只有一个任务 |
| **验收 1**：在 `main` 证出 double_eq | `main` 和 `alt` 上的 double_eq 都显示 certified；`alt` 显示的是它自己的转换（`branch: "alt"`）；替身没有收到任何导入调用 |
| 路线按分支选择 | `main` 组装以 `no_active_route` 拒绝（还需要两条引理）；`alt` 组装通过，路线的根步骤是 `alt` 的拆法 |
| 回写按分支 | 接受后只写入 `alt`；`main` 的根文本不变 |
| `pick` | owner 让 `main` 选用 `alt` 的拆法之后，`main` 组装通过 |
| 根陈述不同的分支 | `other` 得到 `root_statement_differs`，未挂载，看板上的认证数量不变 |
| 分支可见性 | 只能读 `main` 的成员看不到 `alt` 和它的组装；读 `alt` 的草稿得到 404 |
| **验收 2**：旧证明请求 | 命令得到 `proof_request_read_only`，读取正常 |
| 修改环境 | 旧看板 `superseded`，命令得到 `project_superseded`；再次提交创建新看板（201），新根目标的身份不同；节点状态改由新看板提供 |

**变异检验** [实测，n = 1]：临时让选路忽略分支的选择后，这项测试在「`main` 组装应被拒」处失败；还原后通过。
所以这项测试能发现选路方面的回归。

### 浏览器检查 [实测，替身，n = 1 次完整操作]

1. 在 `main` 的根节点点「Submit to LeanGround」，创建了看板；约 7 秒后 `main` 显示为 attached，有 1 个选择，5 个节点完成转换。
2. 在 `alt`：根节点（证明不同）显示「Not submitted」；它未改动的依赖 double_eq 已经借用 `main` 的转换显示状态。
   点 Submit 挂载 `alt`，分支表显示两个分支都是 attached。
3. 「Decompositions」页列出根的两条拆法，分别标着「picked by alt」「picked by main」。
4. 在 `main` 把 double_eq 的 `sorry` 换成证明，点「Resubmit」之后，`main` 上它显示 certified。
   切到 `alt`：double_eq 的文本仍是 `sorry`，状态显示「Lean Certified」。
5. 分支表的「Route」列：`alt` 是 closed，`main` 是 open。与此同时，根目标的状态是共享的 derivable。
6. 在 `alt` 组装通过，路线由 `main` 的 double_eq 证明和 `alt` 的根拆法组成；接受之后回写提交，`alt` 的 double_eq 写入了证明文本；
   `main` 的根文本不变。
7. 浏览器控制台只有一条错误：登录前的 401，属于预期行为。

## 结论

1. 在替身之下，两条验收标准都达到了：共用引理在一个分支证出后，另一个分支不经导入就显示已证出；旧证明请求可读、拒绝命令。
2. 每个分支选用不同的根拆法、按自己的路线组装、只回写自己，这几点由测试和浏览器操作共同确认。
3. 与真实 LeanGround 的配合没有验证：`scenario`、`mathlib` 两项测试和浏览器端到端测试都需要 LeanGround 令牌，本次没有运行。
   所以阶段 1 只能视为「待评审」，还不是「已验收」。

## 未覆盖

- **真实 LeanGround**：`scenario.test.ts`、`mathlib.test.ts` 已改写但没有运行；`web/e2e` 的协作用例没有运行。
  替身不检查证明，也不检查 `subgoal_unused`、定义同名等规则。
- **同一数据库内的定义名冲突**：所有分支共用一个 LeanGround 项目范围，两个分支以同名不同内容登记定义时，后者得到
  `definition_name_taken`。这符合「一个 Project 一个命名空间」的意图，但没有用真实 LeanGround 验证过。
- **写入热点**：所有分支共用一行 JSONB 看板，同一项目的写入仍然串行；没有做负载测量。
- **同步开销**：每次周期同步都要加载每个已挂载分支的 TerminusDB 快照，分支多时开销按分支数增长；没有测量。
- **分支级权限**：选择和组装只限 owner；分支 editor 不能修改自己分支的选择。
- **分支删除**：同步时只把已删除的分支标为 stale，没有自动移出看板。
- **状态借用规则**：只按节点 UUID 加文本比较。在分支外另建一个陈述相同但 UUID 不同的节点，不会借用状态。
- **旧数据迁移**：旧证明请求只读，它们的认证不会自动导入新看板（决定 D）。
- **本地测试环境**：两个测试容器 `mdc-stage1-pg`、`mdc-stage1-terminus` 和预览进程仍在运行，需要另行清理。
