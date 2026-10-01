# 目标工作文件规范 `mdc-goal-file/1`

状态：**提议，待评审**（2026-10-01；G1–G4 已决定，见文末）。属于 `docs/coordination-project-model.md` §5 的细化，没有改动代码。
基线提交 `cc8ef1f`；LeanGround 基线 `3965273`。

## 目的

本文回答：`mdc pull GOAL` 写出、`mdc check / prove / split` 读入的那份文件，必须长什么样；`mdc` 怎样把它变成提交给
服务端的请求；工作目录里的元数据怎样记录。目标是让任何 Agent 或人只看本文就能写出可提交的文件，也能判断一份文件为什么被拒。

## 背景

### 术语

| 术语 | 含义 |
|---|---|
| 目标 | 一条待证的命题。它没有自己的名字，身份是 GoalKey |
| GoalKey | LeanGround 根据命题、所用定义和 Project 环境算出的 64 位十六进制 SHA-256 身份。变量改名不改变它；陈述一改就是另一个目标 |
| 草图 | 带前提的证明：把子引理写成证明体为 `sorry` 的定理（「前提占位」），再用它们证出目标。由 LeanGround 组件 `lean-worker-sketch` 检查 |
| 完整证明 | 没有前提占位的证明，由组件 `lean-worker` 检查。提交时称为 `leaf` 模式 |
| 结论名 | 文件里要证的那条定理的名字，即提交请求里的 `expected_root` |
| 已登记定义 | 在 LeanGround 按内容登记过、有定义 ID 的 `def` 等。提交时只传 ID，由 LeanGround 把源码放进检查用的前言 |
| 环境上下文 | Project 固定的 `open`、`set_option`、`universe`、`variable` 行，是 GoalKey 的一部分 |
| 幂等键 | 请求上附带的唯一 ID。服务端见到同一个键时返回第一次的结果，不会再执行一次 |

### 必须遵守的已有约束

这份规范的规则不是新发明的，下表列出它们的来源：

| 约束 | 来源 |
|---|---|
| 提交的源码不含 `import`、`open`、`variable`、`set_option`；环境上下文另外以结构化字段传递 | [实测：LeanGround `docs/11` §7.4] |
| 前提占位是顶层 `theorem` / `lemma`，证明体恰好是 `sorry` 或 `by sorry`；结论是一个顶层 `theorem`；可以有已完整证明的辅助引理 | [实测：LeanGround `docs/11` §7.4、`docs/12`「内置草图组件」] |
| 结论必须确实用到每个前提占位，否则以 `subgoal_unused` 拒绝；结论自己的证明体是 `sorry` 时以 `invalid_bindings` 拒绝；结论类型与 GoalKey 不符时以 `proposition_differs` 拒绝 | [实测：LeanGround `docs/12`] |
| 陈述里用到的定义必须已登记，或者列入 `new_definitions` 随提交一并登记；只在证明内部用的定义可以留在源码里 | [实测：LeanGround `docs/12`「定义登记」] |
| 拒绝 `instance`、`class`、属性、记号、宏、`private`、`partial`、`unsafe`、`mutual`、`deriving`、`axiom`、`opaque` | [实测：LeanGround `docs/12`] |
| 声明名不能含 `'` | [实测：`docs/src/content/docs/reference/proofs.md`] |
| 顶层命令从行首开始：行首不是空白（注释除外）的行开始一条新命令，所以声明的续行必须缩进；支持的声明只有 `theorem`、`lemma`、`def`、`abbrev`、`noncomputable def`、`structure`、`inductive`；`open … in`、`namespace`、`section` 都拒绝 | [实测：`coordinator/src/lean-source.ts` 的 `scan`] |
| 基座记录带有 `root_module`（例如 `Mathlib`） | [实测：LeanGround `contracts.py` 的 `BaseRef`] |

## 方法

逐条对照上表的 LeanGround 文档、`coordinator/src/lean-source.ts`、`coordinator/src/proof.ts` 中现有草稿的生成方式
（`submission`、`placeholder`），推出文件规则和提交时的变换步骤。没有实现，也没有用真实 LeanGround 运行过本文的例子；
例子里的 Lean 证明只用于说明格式，未经检查 [未验证]。

## 规范

本节用「必须 / 不得 / 应当」表达约束强度：「必须」「不得」违反时 `mdc` 拒绝；「应当」违反时 `mdc` 只警告。

### 1. 工作目录

`mdc pull` 在当前目录下工作，布局如下：

```
work/
├── .mdc/
│   ├── workspace.json                       # {"format":"mdc-workspace/1","server":"…","project":"…"}
│   └── files/
│       └── 3f9a1c2e-double_eq.lean.json     # 每个工作文件一条记录，见 §5
└── 3f9a1c2e-double_eq.lean                  # 工作文件
```

- `mdc` 从文件所在目录逐级向上查找 `.mdc/`，方式与 git 查找 `.git/` 相同。
- `.mdc/` **不得**保存访问令牌，令牌一律从环境变量 `MDC_TOKEN` 读取。所以把 `.mdc/` 打包或分享出去，不会泄露身份。
- 工作文件默认命名为 `<GoalKey 前 8 位>-<结论名>.lean`，`-o FILE` 可以另起名字。
- 目标文件已存在时，`mdc pull` 拒绝覆盖（`file_exists`），以免覆盖 Agent 未提交的工作。

### 2. 文件整体结构

文件必须是 UTF-8 编码。`mdc` 读取时把 CRLF 换行统一为 LF，末尾缺换行时补上一个。

文件由一行**分隔行**分成两段：

```
┌─ 前段：mdc 生成，只读。内容的 SHA-256 记在 .mdc/ 中
│   第 1 行：格式标识
│   说明注释
│   import 行
│   环境上下文
│   已登记定义的源码
│   尝试笔记（注释）
│   分隔行
└─ 正文：可以编辑
    前提占位
    结论定理
    Agent 新增的内容
```

分隔行必须恰好是下面这一行，并且全文只出现一次：

```
-- mdc: edit below this line
```

分隔行是前段的最后一行。之所以既用分隔行、又核对哈希，是因为两者分工不同：分隔行让 `mdc` 找到边界，哈希保证前段没有被改过。

前段加正文是一份完整的 Lean 文件，可以直接交给 LeanGround 兼容 `lean` 命令的垫片程序检查。但垫片按 `import` 自动挑选基座，
不一定等于 Project 固定的基座 [实测：LeanGround `src/leanground/check.py`]，所以这种检查只是近似；以 `mdc check` 为准。

### 3. 前段（只读）

前段必须按以下顺序生成：

1. **格式标识**：第 1 行固定为 `-- mdc-goal-file/1`。`mdc` 遇到不认识的版本号时必须拒绝（`unsupported_format`）。
2. **说明注释**：以 `--` 开头的若干行，写明 Project、完整 GoalKey、结论名，并提示不要编辑分隔行以上的内容。这几行仅供阅读，
   但它们属于前段，同样受哈希保护。
3. **import 行**：一行 `import <root_module>`，取自 Project 基座的 `root_module`。
4. **环境上下文**：依次是全部 `set_option` 行、`open` 行、`universe` 行、`variable` 行，每组内部保持环境里记录的顺序。
   这个顺序必须与 LeanGround 构造检查前言时的顺序一致（见「未覆盖」）。
5. **已登记定义**：结论陈述和各前提占位陈述直接或间接用到的已登记定义，按依赖顺序排列。每个定义前有一行
   `-- definition <名字> (<定义 ID 前 8 位>)`，后接 LeanGround 定义记录里的源码原文。
6. **尝试笔记**：拉取时这个目标最近 20 条笔记的快照，新的在前，每条最多 500 个字符，全部写成 `--` 行注释，所以不需要转义。
   笔记之后会更新，文件里的这份不会随之更新；要看最新的笔记用 `mdc show GOAL`。
7. **分隔行**。

前段中第 3–5 项，与 LeanGround 检查时放进前言的内容在语义上相同。所以本地读到的环境，就是服务端检查时的环境。

### 4. 正文（可编辑）

#### 4.1 拉取时的初始内容

```lean
-- Available premises (existing goals). Unreferenced ones are dropped on submit.
theorem two_mul_eq (n : Nat) : 2 * n = n + n := sorry

-- Goal. Do not change its statement.
theorem double_eq (n : Nat) : double n = 2 * n := by
  sorry
```

- **可用前提**：每行一个占位，格式与现有 `placeholder()` 相同：`theorem 名字 binders : 类型 := sorry`，写在一行内
  [实测：`lean-source.ts:268`]。默认包含的前提：目标绑定了文档节点时，取该节点在依赖图上的直接前提；否则为空。
  `mdc pull GOAL --with GOAL2,GOAL3` 可以加入更多已有目标作为可用前提。
- **结论定理**：
  - 目标绑定了文档节点时，名字和签名取自该节点；
  - 目标是草图拆出来的时，取自引入它的那份草图里的占位声明；
  - 其他情况，名字取展示名，签名写成 `theorem 名字 : <∀ 形式的陈述>`。

  名字与前段的定义、其他占位重复，或者含有 `'` 时，`mdc` 在名字后加 `_goal`，必要时再加数字，直到合法且不重复。
- 目标还没有陈述时（新子目标在 `resolve` 之前只有 GoalKey），`mdc pull` 拒绝（`goal_unresolved`）。

#### 4.2 正文规则

正文中每条顶层命令，必须是下面三类之一：

| 类别 | 形态 | 提交时的身份 |
|---|---|---|
| 结论 | 名字等于结论名的 `theorem` 或 `lemma`，恰好一条 | 证明目标的那条声明 |
| 前提占位 | 证明体恰好是 `sorry` 或 `by sorry` 的其他 `theorem` / `lemma` | 每条成为一个前提。GoalKey 与已有目标相同时自动共用，否则成为新的子目标 |
| 辅助声明 | 已完整证明的 `theorem` / `lemma`；或 `def`、`abbrev`、`noncomputable def`、`structure`、`inductive` | 成为这条认证源码的一部分，不单独产生目标 |

具体规则（括号内是违反时 `mdc` 报的原因码；与服务端相同的情形沿用服务端的原因码）：

1. 正文不得含 `import`、`open`、`set_option`、`universe`、`variable` 行（`context_in_body`）。需要额外的上下文时，应当在 Project
   环境里统一修改，因为上下文是 GoalKey 的一部分。
2. 正文不得含上表之外的顶层命令，包括 `example`、`instance`、`class`、`namespace`、`section`、`#check` 等 `#` 命令、属性
   `@[…]`、`private` 等修饰词（`unsupported_declaration`）。
3. 声明的续行必须缩进，因为行首非空白的行会被当作新命令（见「背景」约束表）。
4. 全文（含前段）的声明名必须互不相同（`duplicate_name`），且不得含 `'`（`invalid_name`）。
5. 结论必须恰好一条（`root_missing` / `root_duplicated`）。它的签名（binders 与类型，空白压缩后比较）必须与拉取时相同
   （`root_statement_changed`）。想证一个更一般的版本时，不要改结论，而是把一般版本写成辅助引理或前提占位，再由它推出结论。
6. 提交时结论的证明体不得是 `sorry`（`root_is_sorry`）；`mdc check` 允许这种情况，以便逐步填写证明。
7. 前提占位的证明体必须恰好是 `sorry` 或 `by sorry`。证明体里**其他位置**出现 `sorry` 的声明（例如证明写了一半）是不完整的
   辅助声明，服务端会拒绝；草图模式下的原因码是 `sorry_outside_subgoals`。
8. 前提占位的陈述应当足够简单、具体；陈述与结论相同的占位没有意义，`mdc` 发现两者签名文本相同时拒绝（`premise_equals_root`）。
   签名文本不同、但 GoalKey 相同的情况，由协调层拒绝（见「未覆盖」）。
9. 注释（`--`、`/- -/`）可以出现在任何位置。文档注释 `/-- -/` 能否通过 LeanGround 的源码形态检查尚未确认 [未验证]，
   在确认之前应当避免使用。

### 5. 元数据记录

每个工作文件在 `.mdc/files/<文件名>.json` 有一条记录。它是 `mdc` 判断「这个文件对应哪个目标」的**唯一依据**；
文件里的说明注释只供阅读。

```json
{
  "format": "mdc-goal-file-record/1",
  "file": "3f9a1c2e-double_eq.lean",
  "project": "myproj",
  "goal": "3f9a1c2e…（完整 64 位）",
  "environment_id": "…",
  "root": "double_eq",
  "root_signature": "(n : Nat) : double n = 2 * n",
  "definitions": ["5c1e09aa…"],
  "premises": [{ "name": "two_mul_eq", "goal": "9d02b7c1…" }],
  "prefix_sha256": "…",
  "pulled_revision": 42,
  "lease": { "attempt": "…", "epoch": 3, "expires": "2026-10-01T08:30:00Z" },
  "submissions": [
    {
      "key": "submit-<32 位十六进制>-r42",
      "revision": 42,
      "request_sha256": "…",
      "intent": "split",
      "status": "sending | queued | certified | rejected",
      "job": "…",
      "certificate": "…",
      "reason": "…"
    }
  ]
}
```

| 字段 | 含义 |
|---|---|
| `goal`、`environment_id` | 拉取时的目标与环境。环境变化后，`mdc` 拒绝提交（`environment_changed`），需要重新拉取 |
| `root`、`root_signature` | 规则 5 的比较依据 |
| `definitions` | 前段中已登记定义的 ID，按依赖顺序排列；提交时原样作为请求的 `definitions` |
| `premises` | 拉取时写入的可用前提，用于 §6 第 4 步 |
| `prefix_sha256` | 前段（含分隔行）的 SHA-256 |
| `lease` | 当前租约；没有租约时为 `null`。`mdc` 在租约有效期内后台续租 |
| `submissions` | 每次提交的重放记录，见 §7 |

### 6. 从文件到提交请求

`mdc prove FILE`、`mdc split FILE`、`mdc check FILE` 共用以下步骤，`--dry-run` 只打印结果、不发送：

1. 读取文件，按 §2 规范化换行。
2. 找到唯一的分隔行（`separator_missing` / `separator_duplicated`），核对前段哈希等于 `prefix_sha256`（`prefix_modified`）。
3. 取分隔行之后的全部文本作为正文，用与服务端**同一份**扫描代码（`coordinator/src/lean-source.ts` 的 `scan`）扫描，
   再检查 §4.2 的规则。
4. **删去未引用的可用前提**：`premises` 里的占位，如果它的名字在正文其他部分（去掉注释和该占位自身之后）不作为标识符出现，
   就从提交源码中删去。只删拉取时写入的占位；Agent 自己新增的占位即使没有被引用也保留，交由服务端以 `subgoal_unused` 拒绝，
   因为那通常说明证明写错了。
5. **判断模式**：删减后没有前提占位，就是 `leaf` 模式、组件 `lean-worker`；否则是 `sketch` 模式、组件 `lean-worker-sketch`。
   - `mdc prove` 要求是 `leaf`，否则报错并列出剩余的占位名（`has_premises`）；
   - `mdc split` 要求是 `sketch`（`no_premises`）；
   - `mdc check` 两种都接受。
6. **找出新定义**：正文中的 `def` 等定义，如果它的名字作为标识符出现在某个前提占位的陈述里，就列入 `new_definitions`；
   其余是证明内部定义，留在源码里。结论的陈述在拉取时已经固定，只会用到前段的定义，所以不必检查。
7. **组成请求**：

   ```json
   {
     "type": "submit",
     "goal": "<记录中的 goal>",
     "source": "<删减后的正文>",
     "expected_root": "<记录中的 root>",
     "component": "lean-worker 或 lean-worker-sketch",
     "mode": "leaf 或 sketch",
     "definitions": ["<记录中的 definitions>"],
     "new_definitions": ["<第 6 步的结果>"]
   }
   ```

   提交的源码只是正文，前段不发送。这一点与 LeanGround「源码不含 import 与上下文、定义按 ID 引用」的要求一致。

所以，Agent 看到的文件与实际提交的源码之间，只有三处确定的差别：去掉前段、去掉未引用的可用前提、规范化换行。
`--dry-run` 打印出实际要提交的源码。

### 7. 重放与结果

1. 发送之前，先把幂等键、看板修订号和请求哈希写入 `submissions`，状态记为 `sending`。幂等键的形式为
   `submit-<请求 SHA-256 前 32 位>-r<修订号>`。
2. 网络结果不确定时（超时、连接中断），用**完全相同**的键、修订号和请求体重发。服务端按「先查幂等键、再查修订号」的顺序处理
   [实测：`docs/src/content/docs/development/architecture.md`「Collaboration state」]，所以第一次如果已经生效，重发只会取回第一次的结果。
3. 收到 `revision_conflict`，说明之前的发送没有生效：重新读取看板，用新的修订号新增一条记录。
4. 同一份正文在已有一条 `queued` 或 `certified` 记录时，`mdc` 直接报告已有结果，不再发送；`--again` 可以强制重发。
5. 使用 `--wait` 时，`mdc` 等后台作业结束，更新记录，并输出：认证 ID、模式，以及每个前提的名字、GoalKey 前缀、是否为新目标、
   自动 `resolve` 是否成功。

### 8. 完整例子

拉取得到的正文见 §4.1，前段如下（GoalKey 和 ID 为示意）：

```lean
-- mdc-goal-file/1
-- project: myproj
-- goal: 3f9a1c2e7b4d…
-- root: double_eq
-- Generated by mdc. Do not edit above the "edit below" line; mdc refuses to submit if it changed.
import Mathlib
set_option autoImplicit false
open Nat

-- definition double (5c1e09aa)
def double (n : Nat) : Nat := n + n

-- notes (snapshot at pull time, newest first)
-- [2026-09-30 alice/codex-1] Induction on n; the succ case needs double (n + 1) = double n + 2.
-- mdc: edit below this line
```

**情形一：完整证明。** 正文改为：

```lean
theorem two_mul_eq (n : Nat) : 2 * n = n + n := sorry

theorem double_eq (n : Nat) : double n = 2 * n := by
  unfold double
  omega
```

`two_mul_eq` 没有被引用，第 4 步删去它；剩下的正文没有占位，所以是 `leaf` 模式，用 `mdc prove` 提交。

**情形二：拆法。** 正文改为：

```lean
theorem two_mul_eq (n : Nat) : 2 * n = n + n := sorry

theorem double_succ (n : Nat) : double (n + 1) = double n + 2 := sorry

theorem double_eq (n : Nat) : double n = 2 * n := by
  induction n with
  | zero => rfl
  | succ k ih => rw [double_succ, ih]; omega
```

`double_succ` 是 Agent 新增的占位，会成为新的子目标；`two_mul_eq` 没有被引用，被删去。剩下一个占位，所以是 `sketch` 模式，
用 `mdc split` 提交。检查通过后，`double_succ` 的陈述被自动 `resolve`，其他人就可以 `mdc pull` 它。如果正文改为引用
`two_mul_eq`，它就会作为前提保留，并与已有目标共用同一个 GoalKey。

## 结论

1. 工作文件是一份完整的 Lean 文件，由分隔行分成两段：只读的前段（`import`、环境上下文、已登记定义、笔记快照），
   以及可编辑的正文（前提占位、结论定理、辅助声明）。
2. 前段由 `mdc` 生成并用哈希保护；正文规则与 LeanGround 的源码形态、MathDoc 的扫描器一一对应。所以 `mdc` 在本地拒绝的文件，
   服务端同样会拒绝，而且原因码一致。
3. 文件与目标的对应关系只记在 `.mdc/` 的记录里，不依赖文件注释，也不保存令牌。
4. 文件到请求的变换只有三步，都是确定的：去掉前段、去掉未引用的可用前提、规范化换行。模式（`leaf` / `sketch`）和新定义
   由文件内容推出，不需要 Agent 另外声明。
5. 重放安全来自三点：发送前先落盘，不确定时原样重发，服务端先查幂等键再查修订号。

## 已决定

维护者于 2026-10-01 确认以下四项，正文已按此书写：

| 编号 | 问题 | 决定 |
|---|---|---|
| G1 | 未引用的可用前提，由 `mdc` 自动删去，还是要求 Agent 手动删除？ | 自动删去：只删拉取时写入的占位，`--dry-run` 可以看到结果（§6 第 4 步） |
| G2 | 尝试笔记放进前段，还是只通过 `mdc show` 查看？ | 放进前段：Agent 打开文件就能看到前人的失败经验（§3 第 6 项） |
| G3 | 生成的注释用英文还是中文？ | 英文：文件会在不同语言的参与者和工具之间流转 |
| G4 | 一个文件是否允许同时证多个目标？ | v1 不允许，一个文件只对应一个目标 |

## 未覆盖

- 没有实现，也没有用真实 LeanGround 运行过 §8 的例子。
- LeanGround 构造检查前言时，`set_option`、`open`、`universe`、`variable` 的先后顺序没有核实。若与 §3 第 4 项不同，
  本地读到的环境与服务端会有细微差别，需要以 LeanGround 的顺序为准。
- 文档注释 `/-- -/` 能否通过 LeanGround 的源码形态检查，没有核实。
- §6 第 4 步和第 6 步按「标识符是否出现」做文本判断，没有经过 elaboration，可能误判（例如同名的局部变量）。
  误判的后果都会被服务端拦住：多留了占位会得到 `subgoal_unused`，漏报了新定义会得到 `definition_not_registered`；
  不会产生错误的认证。
- 签名文本不同、但 GoalKey 与结论相同的前提占位（「T ⇐ {T}」这种无意义的拆法），需要协调层在记录认证时拒绝；
  这条规则不属于文件格式，还没有设计。
- `mdc check` 需要的服务端检查接口还没有确定，见 `docs/coordination-project-model.md` 待决定 E。
- Rocq 不在本规范范围内。
