# P0-C2a Code Review 结论（第 4 轮）

- **审查日期**: 2026-07-22
- **审查范围**: 工作区未提交改动（`git diff HEAD`，43 个文件，+1192/-612）及全部新增文件（`storage-transaction.mjs` 518 行、`generation-workspace.mjs` 381 行、`workspace-writer.mjs` 92 行、`codexWorker.ts` 406 行、`workspace-cli.js` 等）——即第 3 轮 review 建议修复之后的当前状态
- **审查依据**: 前三轮结论文档（`FINDINGS.md`/`FINDINGS_ROUND2.md`/`FINDINGS_ROUND3.md`）与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（"First/Second/Third review disposition"）；重点为 (a) 逐项复核第 3 轮已接受修复是否正确、完整，(b) 修复本身是否引入新缺陷，(c) diff 其余部分（含此前未覆盖到的文件，如 `validate-reasoning.js`/`validate-study-package.js`/`migrate-package.js` 与新管理树的交叉）
- **方法**: 与前三轮相同的 8 角度并行扫描，产生约 25 条去重候选；按主题分组由 5 个独立验证批次逐条判定，**其中一项由查找角度直接构造复现脚本验证**（见一.1）

## 总体评估

第 3 轮的修复**大部分方向正确且独立验证成立**：`.init-*` 残留在含合法 `workspace.json` 时可被发现，`failed` 状态被正确排除在活跃占用之外并在错误信息中提示 workspace ID；ask 的 codexWorker 重构成功把"任一请求失败即 kill 共享进程"收窄为"仅真正的 worker 进程崩溃才全局 reject"（`resetAfterFailure` 已被移除，`rejectAll` 现在只在 `child.on('close')` 触发）；`ask.post.ts` 的队列键已改为 `paperLockKey`；`migrate-package.js`、`prepare-paper.js` 的库根解析已统一改为 `os.homedir()`；`generationReadOnly` 死字段与 `reconciled` 死分支确认已被删除。

但本轮发现一个**通过实际复现脚本验证的严重边界绕过**，以及 **7 个其他 CONFIRMED 的正确性缺陷**：

- **最严重**：`migrate-package.js` 完全不认识本次改动引入的 `.codex-paper/workspaces-v1`（generation workspace）管理树——它硬编码了自己的一套 `LIBRARY_ROOT`/`PAPERS_ROOT`，从未调用其余所有工具共用的 `getLibraryLayout()`/`getWorkspaceLayout()`。配合 `--external-path` 标志（该标志同时会跳过第 3 轮新增的"嵌套路径拒绝"检查），可以把迁移工具直接指向一个**活跃**的 generation workspace 包目录，成功写入 `meta.json`、`evidence-ledger.json`、`reasoning-analysis.json`、`.codex-paper/reasoning-review.md`——完全绕开该 workspace 自己的锁、状态机与 `writeWorkspaceAuthoring`/`replaceWorkspaceFile` 的写入白名单，且 `workspace.json` 的状态字段完全不会被触碰，产生"记录说未变、内容已被改写"的静默不一致。这直接违反了本系列审查从第 1 轮起就在保护的核心边界。
- **ask 的答案保全修复范围过窄**：第 3 轮把追加聊天笔记冲突时的"丢弃答案"改为返回 `saved:false`，但白名单只覆盖 `STORAGE_LOCK_CONFLICT`/`STORAGE_LOCK_TIMEOUT` 两个错误码；`chatNotes.ts` 自身的符号链接安全检查（`boundaryError(403,...)`）与 `storage-transaction.mjs` 的 `STORAGE_LOCK_CORRUPT`/`OWNERSHIP_LOST`/`UNSAFE`/`REQUIRED` 均不在白名单内，命中时仍走外层 catch 丢弃答案——其中 `OWNERSHIP_LOST` 甚至可能在 `appendChatNote` 已经成功写入之后、锁释放阶段才抛出，意味着一次**真正保存成功**的回答仍可能被上报为丢失。
- **ask 的锁收窄留下一个此前三轮都未点名的新豁口**：`askCodexWorker` 现在在没有持有任何锁的情况下运行外部 Codex 调用（可长达 180 秒），而 Web 删除路由持有的正是同一个 `paperLockKey`——第 2 轮已经为 migrate 与 Web 删除之间结构完全相同的竞争（`movePaperToTrash` 的无守卫 `renameSync`）打过补丁，但从未把该分析推广到 ask 上。
- **workspace 创建失败保全的"最后一道防线"仍有缺口**：如果进程在 `workspace.json` 写入成功、`renameSync` 执行之前被 kill（SIGKILL/OOM/断电），第 3 轮新增的 catch 块根本不会被调用——这个残留目录现在因为"可被发现"而被判定为活跃 `authoring` workspace，永久阻塞对同一论文的重试，且 `cleanupInitDirectories` 因其含 `workspace.json` 而永久跳过它。这是崩溃时机的问题，不是异常处理逻辑能覆盖的。
- **`validate-reasoning.js`/`validate-study-package.js` 首次被本系列审查覆盖，发现同样的非原子多步状态转换问题**：`persistWorkspaceReport` 把"置为 validating → 写报告 → 置为最终状态"拆成三次独立的加锁/解锁，中间窗口内并发的 authoring 写入或 abandon 可以让最后一次状态转换因不满足转换表而抛异常（此时报告已经落盘），或者在目标状态恰好合法时静默覆盖并发方刚设置的状态。
- **Repository Guard 意外弱化**：第 3 轮为 prepare 守卫新增异步 `writeFile(` 检测的同一次改动里，"prepare-paper.js 必须使用共享的 `paper-library.mjs` 解析器"这条既有检查被整体移除，且未在新的 workspace-writer 守卫组里补上，测试套件也从未覆盖过这条检查的错误文案，因此无测试会因这次弱化而失败。

结论：**边界目标在 migrate-package.js 这一条路径上已经不成立**，建议作为阻塞项立即修复（一.1-1.3）；ask 的答案保全与并发删除竞争（一.4-1.5）、workspace 崩溃残留（一.6）、validate 的非原子转换（一.7）与 Guard 弱化（一.8）建议在 C2a 合入前一并处理。

---

## 一、已确认的正确性缺陷（按严重程度排序）

### 1. migrate-package.js 完全不识别 generation workspace 管理树，可绕过其锁与状态机直接改写活跃 workspace 内容 — CONFIRMED（已复现）

`plugins/codex-paper/skills/study/scripts/migrate-package.js:76`

`resolvePaperDir` 的托管布局排斥检查只测试 `.codex-paper/store-v1`（已发布 generation 树），对本次改动新增的 `.codex-paper/workspaces-v1`（generation workspace 树）一无所知——因为该文件顶部硬编码了自己的 `LIBRARY_ROOT`/`PAPERS_ROOT`，从未调用其余所有工具（`sandbox-code.js`、`validate-reasoning.js`、`workspace-writer.mjs`）经由 `resolveExplicitPackage`/`requireWritableWorkspace` 共用的 `getLibraryLayout()`/`getWorkspaceLayout()`。

查找角度用如下步骤**实际复现**：创建一个 `authoring` 状态的活跃 generation workspace，执行 `node migrate-package.js <该 workspace 的 packageDir> --external-path`——命令成功，直接把 `evidence-ledger.json`、`meta.json`、`reasoning-analysis.json`、`.codex-paper/reasoning-review.md` 写入了这个活跃 workspace 的包目录，使用的是 migrate 自己的 `legacy:migration:<hash>` 锁（不是该 workspace 的 `workspace:<id>` 锁），完全绕开 `writeWorkspaceAuthoring`/`replaceWorkspaceFile` 的 CAS 与写入白名单校验。`workspace.json` 的 `state`/`updatedAt`/`lastSuccessfulStep` 全程未被触碰——记录状态与实际内容产生静默不一致，且与 `workspace-cli.js write` 或 study skill 的并发写入完全不互斥。

**建议**: `migrate-package.js` 改为调用共享的 `getLibraryLayout()`/`getWorkspaceLayout()`，并在 `resolvePaperDir` 中同时排斥 `.codex-paper/store-v1` 与 `.codex-paper/workspaces-v1` 两棵管理树。

### 2. migrate-package.js 的嵌套路径拒绝检查用未 realpath 的路径，而锁键计算用 realpath 后的路径，符号链接可致二者失配 — CONFIRMED

`migrate-package.js:84`（嵌套拒绝）vs `:110-113`（`migrationLockKey`）

嵌套拒绝检查用 `path.relative(PAPERS_ROOT, paperDir)`，其中 `paperDir` 只是 `path.resolve(expanded)`，从未 `lstat`/`realpath`；`migrationLockKey` 却用 `fs.realpathSync(paperDir)` 计算等价关系。`resolvePaperDir` 的直接路径分支全程没有调用 `realpathSync`/`lstatSync` 拒绝符号链接（不同于 `paper-library.mjs` 的 `requireSafeDirectory` 会显式拒绝符号链接）。若 `PAPERS_ROOT` 下的一级目录本身是指向别处的符号链接，嵌套拒绝检查看到单段路径而放行，但 `migrationLockKey` 基于 realpath 计算出不同的相对路径，退化为不与其他组件相交的 `legacy:migration:<hash>` 键。

**建议**: 嵌套拒绝检查改用与 `migrationLockKey` 相同的 `fs.realpathSync` 结果，二者共享同一次路径规范化。

### 3. `--external-path` 会连带跳过嵌套路径拒绝检查，可对库内嵌套路径重新打开缺陷 #2 类型的锁不相交问题 — CONFIRMED

`migrate-package.js:80-83`

嵌套拒绝检查（第 3 轮为修复"锁键回退"新增）与"库外路径需要 `--external-path`"检查都被同一个 `!options.externalPath` 条件门控。用户对一个**实际位于库内**、但嵌套超过一级的路径传入 `--external-path`（如 `papers/foo/bar`），两个检查同时被跳过，函数直接返回该嵌套路径；`migrationLockKey` 随即因 `legacyRelative` 含路径分隔符而退化为 `legacy:migration:<hash>`，不再与 `legacy:foo` 上的 Web 删除/trash 操作互斥——纯粹通过 CLI 参数选择即可触达，无需符号链接等特殊条件。

**建议**: 让嵌套拒绝检查独立于 `externalPath`，只在确认路径已经在库外时才豁免。

### 4. ask 的答案保全白名单过窄，且 `OWNERSHIP_LOST` 可能在保存成功后才抛出，导致"已保存"的回答仍被上报为丢失 — CONFIRMED

`plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts:157`

第 3 轮把冲突时的处理改为 `if (saveError?.code !== 'STORAGE_LOCK_CONFLICT' && saveError?.code !== 'STORAGE_LOCK_TIMEOUT') throw saveError`，只把这两个码之外的一切都视为需要向用户丢弃答案的严重错误。但这条路径上现实可达的错误远不止这两种：`chatNotes.ts` 自身的 `boundaryError(403, ...)`（`overlayDir`/`chat-notes.md` 是符号链接等，无 `.code` 字段，天然不在白名单内）、`storage-transaction.mjs` 的 `STORAGE_LOCK_CORRUPT`、`STORAGE_LOCK_UNSAFE`、`STORAGE_LOCK_REQUIRED`，尤其是 **`STORAGE_LOCK_OWNERSHIP_LOST`**——它可能在 `withStorageLocks` 的 `finally` 块里、`appendChatNote` 已经成功执行**之后**的 `handle.release()` 阶段才抛出（token 在释放前被判定不匹配）。这意味着聊天记录**已经真实写入磁盘**，却因为释放阶段的异常被上报为"未保存"。这些错误均不在白名单内，触发外层 catch 后：带 `.statusCode` 的错误被原样 `throw e`（不经 `createFallbackError` 包装，响应里连 `fallbackPrompt` 字段都没有）；不带的走 502 `createFallbackError`。两种情况下 `answer` 变量都不会出现在响应里，前端 `[slug].vue` 的 `submitAsk` catch 也只读取 `e.data?.data?.fallbackPrompt`，从不检查任何携带答案的字段——已生成的回答端到端丢失，这正是第 3 轮修复想要关闭的同一类问题的另一种触发方式。

**建议**: 把"是否已保存"与"是否需要向用户丢弃答案"解耦——无论保存阶段抛出什么错误，只要 `answer` 已生成就应随响应返回（附带 `saved:false` 与具体错误提示）。

### 5. ask 的外部 Codex 调用现在完全不持锁运行，与并发删除的竞争此前三轮均未被点名分析 — CONFIRMED

`ask.post.ts:120`

`askCodexWorker` 调用（可能耗时长达 180 秒，`cwd` 设为 `descriptor.packageDir`）现在完全在锁外运行——第一次 `withOperationLocks` 调用直到 147 行（仅包裹 `appendChatNote`）才出现。Web 删除路由对同一个 `descriptor.paperLockKey` 通过 `withOperationLocks` 加锁（`operationLocks.mjs` 现在是真正的跨进程文件锁，不再是进程内 Set），随后 `movePaperToTrash` 执行无守卫的 `fs.renameSync(descriptor.paperRoot, payloadDir)`——正是 Codex 子进程正在读取的目录。第 2 轮的 findings 文档曾明确点名并修复过结构完全相同的竞争（migrate 的无守卫 `renameSync` 与 Web 删除竞争，通过让 migrate 采用共享的 `legacy:<slug>` 锁解决），但从未把这个分析推广到 ask 上——这是本轮新发现的信息，而非第 2 轮"移除 ask 全程持锁"这一决定本身已经知情接受的后果（该决定的论证只涉及"不再阻塞 CLI 写入"，未涉及"删除期间读取"）。

**建议**: 参照 migrate 的解法，让 ask 在调用 Codex 前后对 `paperLockKey` 做一次轻量存在性检查，或让删除路由检测到进行中的 ask 时延后/拒绝。

### 6. workspace 创建在 rename 之前被杀掉进程，残留因"可被发现"而永久卡在 authoring 状态，阻塞所有后续重试 — CONFIRMED

`plugins/codex-paper/src/shared/generation-workspace.mjs:275-276`

`createGenerationWorkspace` 的正常路径：`atomicWriteJson` 把 `state:'authoring'` 的 `workspace.json` 写入 `.init-<id>-<rand>`（275 行），随后单独一条语句 `fs.renameSync(initDir, finalDir)`（276 行）。若进程在这两行之间被 kill -9/OOM/断电，第 3 轮新增的 catch 块（280 行起，本应把记录 CAS 更新为 `failed`）**根本不会被调用**——这是纯粹的 JS 异常处理，无法覆盖进程终止。而第 3 轮的另一个修复让 `listGenerationWorkspaces`/`initializationWorkspaceById` 把任何含合法 `workspace.json` 的 `.init-` 目录当作正常可发现的 workspace；该残留状态为 `authoring`，被 `isActiveWorkspaceState` 判定为活跃，`createGenerationWorkspace` 的去重检查因此对同一 `generationId` 的后续重试永远抛 `WORKSPACE_EXISTS`——而 `cleanupInitDirectories` 又因为它含 `workspace.json` 而永久跳过清理。全仓库没有任何针对此场景的恢复逻辑，现有测试也只模拟同步的 rename 异常（会正确触发 catch），从未模拟真正的进程终止，这个缺口完全未被测试覆盖。

**建议**: 需要一种能区分"正常在 authoring 状态被使用"与"崩溃于 `.init-` 前缀下"的信号（后者本质上不应该出现，因为正常 authoring 只发生在 rename 之后的 `ws-...` 目录）；对 `.init-` 前缀下发现的 `authoring` 状态残留，可视为崩溃标志，允许其像 `failed` 一样被排除出活跃占用检查，或提供显式恢复命令。

### 7. `validate-reasoning.js`/`validate-study-package.js` 的状态转换非原子，跨三次独立加锁，可在报告已落盘后崩溃或静默覆盖并发状态变更 — CONFIRMED

`plugins/codex-paper/skills/study/scripts/validate-reasoning.js:514-526`；`validate-study-package.js:980-990`

`persistWorkspaceReport` 依次执行：`updateWorkspaceRecordSync(..., {state:'validating'})`（独立加锁/解锁）→ `writeValidationReportAtomic`（自己的独立加锁）→ `updateWorkspaceRecordSync(..., {state: 最终状态})`（再次独立加锁/解锁）。三步之间锁并未连续持有。若并发的 authoring 写入（`transitionWorkspaceToAuthoringLocked`）或 abandon 落在第一步与第三步之间的窗口，`WORKSPACE_TRANSITIONS.authoring` 不含 `validated`（也不含从 `abandoned` 出发的任何转换），最后一次 `updateWorkspaceRecordSync` 会抛 `WORKSPACE_STATE_TRANSITION_INVALID`——**此时验证报告已经写入磁盘**，只有顶层 `runCli` 的 catch 捕获并 `process.exit(2)`，留下"报告文件宣称验证完成、workspace 记录却仍是 authoring"的不一致；若目标状态恰好是 `failed`（`authoring→failed` 合法），则调用反而静默成功，覆盖掉并发方刚刚设置的 `authoring` 状态。这需要两个真正并发的进程/请求触发，在这套多智能体协作的工作流中是现实场景（如一次 authoring 写入正巧与一次验证运行同时发生）。`validate-study-package.js` 存在完全相同的三步模式与相同风险。

**建议**: 让整个"validating → 写报告 → 最终状态"序列在单次锁获取内完成（复用已持有的 `lockHandle` 而非每一步都重新 `resolveGenerationWorkspace`/加锁）。

### 8. Repository Guard 静默移除了"prepare-paper.js 必须使用共享 paper-library.mjs 解析器"的检查，且无测试覆盖 — CONFIRMED

`scripts/check-repository.mjs:465-473`

`git diff HEAD` 显示，原本要求 `PREPARE_SCRIPT` 必须包含 `paper-library.mjs`（"must use the shared paper library resolver"）的消费者循环，把 `PREPARE_SCRIPT` 整体移出了这个列表，也没有并入本轮新增的 `workspace-writer.mjs` 守卫组（该组只覆盖 `build-analysis.js`/`render-from-analysis.js`/`scaffold-reasoning-analysis.js`）。`PREPARE_SCRIPT` 现存的专属检查（543-552 行）只做纯文本 `source.includes('createGenerationWorkspace')` 等字符串匹配，不要求真正经由共享解析器路由。`scripts/tests/check-repository.test.mjs` 里完全没有任何测试覆盖过"must use the shared paper library resolver"这条错误文案（对任何消费者都没有），因此这次弱化、以及未来任何进一步弱化，都不会被测试套件捕获。

**建议**: 把 `PREPARE_SCRIPT` 重新加回该消费者循环（或在新守卫组中显式覆盖），并为该错误文案补充至少一个回归测试。

## 二、复用/重复（代码质量，按影响排序）

| 项 | 位置 | 说明 |
|---|---|---|
| CAS 前置条件计算重复 3 次，其中 2 处的分歧分支是死代码 | `workspace-writer.mjs:51-61`（含 `STORAGE_DIRECTORY_MISSING`/404 分支）vs `generation-workspace.mjs:287-293`（仅 ENOENT）vs `migrate-package.js:119-133`（ENOENT + statusCode 404） | `readFileNoFollowBounded` 在这些调用点从不抛出 `STORAGE_DIRECTORY_MISSING`/404，故额外分支当前均为死代码，但仍是需要在 3 处同步维护的重复逻辑 |
| 锁键字符串模板独立手写 6 次 | `paper-library.mjs` 5 处（284-285、318-319、360-363、387-388、405-407）+ `generation-workspace.mjs:144-147`（`descriptor()`） | 无任何共享的键构造函数；这正是第 3 轮缺陷 #4（队列键用错字段）的同类根因，风险等级应相应提高 |
| `.init-` 残留发现/安全校验逻辑独立实现 3 次，安全检查集合不完全重合 | `initializationWorkspaceById`（112-125）、`listGenerationWorkspaces` 的 init 分支（159-168）、`cleanupInitDirectories`（216-228） | 前两者做完整的 symlink/目录/`WORKSPACE_ID_PATTERN`/重复 ID 校验并解析记录；`cleanupInitDirectories` 只做 symlink/目录检查与 `workspace.json` 存在性判断，未来任一处的加固不会自动应用到其余两处 |
| `allocateRouteSlug` 用内联字面量数组重新实现 `isActiveWorkspaceState`，未导入已导出的同名函数 | `prepare-paper.js:312` vs `generation-workspace.mjs:104-106` | `generation-workspace.mjs` 同文件的 `createGenerationWorkspace`（245 行）本身就在调用这个导出函数；`prepare-paper.js` 的 import 列表未包含它，转而手写 `['authoring','validating','validated'].includes(...)`——与第 3 轮缺陷 #4（分配器与锁内复核用两份独立谓词）性质相同，本应在本轮一并解决却又以新形式重演 |
| abandoned 终态错误第 5 次独立措辞；`workspace-cli.js` 与 `prepare-paper.js` 的 CLI 退出码映射已确认分叉 | `prepare-paper.js:458`（"...and cannot be resumed."）vs `generation-workspace.mjs:319/358`（"Abandoned workspaces are read-only."）vs `workspace-writer.mjs:22` | 本轮新增的 `--resume-workspace` 路径又添加了第 5 种措辞；`workspace-cli.js` 把 `_INVALID` 后缀码或 400/403/413 状态码统一映射为退出码 2，`prepare-paper.js` 缺少这两条规则，同一错误族（如 `WORKSPACE_WRITE_PATH_FORBIDDEN`）在两个 CLI 下退出码不同（2 vs 3） |

## 三、效率

1. **`listGenerationWorkspaces` 为每个累积的失败 `.init-` 残留构建完整描述符**（159-168 行），即使调用方（`createGenerationWorkspace`）几秒后就用 `isActiveWorkspaceState` 把非活跃的丢弃。由于第 3 轮修复让含 `workspace.json` 的残留永不被 `cleanupInitDirectories` 清理，其数量只增不减；配合第 3 轮已指出的"prepare 双重全量扫描"，残留数量增长会同比放大每次 prepare 的浪费。
2. **`initializationWorkspaceById` 对每个残留都完整读取+解析+校验 `workspace.json`** 才比较 `workspaceId`（112-125 行），尽管目标 ID 已经编码在目录名 `.init-<workspaceId>-<rand>` 里，一次廉价的文件名前缀匹配即可过滤掉绝大多数无关条目。该路径受 `cleanupInitDirectories` 的 32 条/次上限与 60 分钟清理保护（仅对无 `workspace.json` 的残留有效），实际影响随场景 1 的残留积累而放大。

## 四、第 3 轮已接受修复逐项复核

| 第 3 轮修复 | 第 4 轮结论 |
|---|---|
| 双 rename 失败时 workspace 仍可通过含合法记录的 `.init-*` 残留被发现；精确 ID/路径解析与列表识别；无记录残留保留 1 小时清理策略 | **发现机制本身成立**；但该机制的一个副作用是让"进程在 rename 前被杀"的场景从"60 分钟后清理"变成"永久卡在 authoring、阻塞重试"（缺陷 #6），是本轮新暴露的边界情形，非机制本身错误 |
| `failed` 保留用于诊断但不计入生成/路由预留的活跃占用；活跃冲突与初始化错误包含精确 workspace ID 与恢复指引 | **成立**；`allocateRouteSlug` 与 `createGenerationWorkspace` 两处判定逻辑当前一致但仍是独立表达（复用表），且崩溃于 rename 前的残留（`authoring` 而非 `failed`）不在此修复覆盖范围内（缺陷 #6） |
| ask 的队列与线程按共享 paper 锁分组，线程复用同时校验包路径；仅真正的 worker 进程失败才是全局 reject 事件 | **队列键与线程复用校验均成立**（已独立验证 `resetAfterFailure` 被移除，跨论文连带确认关闭）；但外部调用完全不持锁运行留下了与并发删除竞争的新缺口（缺陷 #5） |
| 3 秒聊天笔记锁冲突不再丢弃已生成的答案；API 返回 `saved:false`、可空的记录标识与有界警告；Viewer 展示答案及其未保存状态 | **对两个白名单错误码本身成立**；但白名单过窄，覆盖不到的错误（含释放阶段才抛出的 `OWNERSHIP_LOST`）仍会丢弃答案，包括已经真正保存成功的情形（缺陷 #4） |
| prepare 与 legacy 迁移的默认库根统一改用 `os.homedir()`；迁移同时拒绝库内嵌套输入，确保文档化的 legacy 包使用与 Viewer 生命周期操作相同的 `legacy:<slug>` 锁 | **`os.homedir()` 统一成立**；但迁移工具对新的 workspace 管理树完全无感知，构成本轮最严重的边界绕过（缺陷 #1）；嵌套拒绝检查本身存在路径规范化不一致（缺陷 #2）与被 `--external-path` 整体绕过的问题（缺陷 #3） |
| abandoned workspace 路径解析为只读描述符，sandbox 规划返回结构化 `nonconformant` 结果而非抛出不一致的策略错误 | **成立**（本轮未发现新问题） |
| 移除未使用的 `generationReadOnly` 投影、不可达的 `reconciled` 准备分支、多余的 reclaim catch 分支；Repository Guard 新增对 prepare 中异步直接 `writeFile(...)` 的检测 | **三项死代码清理均确认完成**；但同一次 Guard 改动里，"prepare 必须使用共享 paper-library.mjs 解析器"这条既有检查被静默移除且无测试覆盖（缺陷 #8） |

## 五、审查重点逐项结论（第 4 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立**（本轮未发现对正式存储三文件的新写入路径） |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **"保留失败现场"在 rename 前崩溃的窗口仍不成立**（缺陷 #6，且现已被判定为永久阻塞而非可清理） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **成立**（本轮未发现新的锁子系统缺陷） |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **对托管存储本身成立**；但 migrate-package.js 完全绕过 workspace 的锁与 CAS 直接改写其内容（缺陷 #1），是该条不变量在本轮最严重的破口 |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **对 sandbox 只读访问成立**（第 3 轮修复验证通过）；但"不可作者化"对活跃 workspace 而言被 migrate-package.js 绕过（缺陷 #1） |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立**（fixture 未覆盖 migrate-package.js 路径，故未能捕获缺陷 #1；建议评估是否需要把 migrate 场景纳入 fixture 或独立的边界测试） |

---

## 附录：Top-10 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 76, "summary": "migrate-package.js 完全不识别 .codex-paper/workspaces-v1 管理树，配合 --external-path 可直接对活跃 generation workspace 的包目录写入，绕过其锁与状态机（已用复现脚本验证）", "failure_scenario": "对一个 authoring 状态的活跃 workspace 执行 node migrate-package.js <packageDir> --external-path，命令成功写入 evidence-ledger.json/meta.json/reasoning-analysis.json/.codex-paper/reasoning-review.md，使用的是不相交的 legacy:migration:<hash> 锁，workspace.json 的 state/updatedAt 全程未变，记录与实际内容产生静默不一致"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 157, "summary": "答案保全的错误码白名单只覆盖 STORAGE_LOCK_CONFLICT/TIMEOUT，STORAGE_LOCK_OWNERSHIP_LOST 等错误可能在 appendChatNote 已成功写入后的锁释放阶段才抛出，导致已真正保存的回答仍被上报为丢失", "failure_scenario": "追加聊天笔记成功写入磁盘，但 withStorageLocks 的 finally 释放阶段因 token 不匹配抛出 STORAGE_LOCK_OWNERSHIP_LOST（不在白名单内）→ 外层 catch 原样上抛或包装为 502 → 响应不含 answer 字段，前端只能读取 fallbackPrompt，用户看到的是回答丢失而非已保存"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 120, "summary": "外部 Codex 调用（最长180秒）现在完全不持有 paperLockKey，与 Web 删除路由持有同一把跨进程锁执行的无守卫 renameSync 竞争，此竞争此前三轮均未被点名分析", "failure_scenario": "用户提问期间 Codex 子进程正读取 paperDir 下文件；另一用户同时确认删除该论文，movePaperToTrash 无守卫地把 paperRoot 整体 rename 进 .trash，Codex 的文件读取在目录消失后失败或读到不完整内容"},
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 276, "summary": "进程在 workspace.json 写入成功、renameSync 执行前被杀死，第3轮新增的失败保全 catch 块不会被调用，残留因可被发现而永久卡在 authoring 状态，阻塞同一论文的所有后续重试", "failure_scenario": "prepare 在 atomicWriteJson 成功后、fs.renameSync(initDir, finalDir) 之前被 kill -9；.init-<id> 残留状态为 authoring，被 isActiveWorkspaceState 判定为活跃，重试相同论文永远收到 WORKSPACE_EXISTS，cleanupInitDirectories 因其含 workspace.json 而永久跳过清理，无任何恢复路径"},
  {"file": "plugins/codex-paper/skills/study/scripts/validate-reasoning.js", "line": 514, "summary": "persistWorkspaceReport 把 validating→写报告→最终状态拆成三次独立加锁，中间窗口的并发状态变更可使最后一次转换在报告已落盘后抛异常，或静默覆盖并发方的状态", "failure_scenario": "验证运行到写报告阶段时，另一进程并发把 workspace 从 validating 转回 authoring；最终的 updateWorkspaceRecordSync({state:'validated'}) 因 authoring 不允许转到 validated 而抛 WORKSPACE_STATE_TRANSITION_INVALID，此时 validation-report.json 已经写入磁盘，形成报告与记录状态不一致"},
  {"file": "plugins/codex-paper/skills/study/scripts/validate-study-package.js", "line": 982, "summary": "与 validate-reasoning.js 完全相同的非原子三步状态转换模式，同样的崩溃后不一致或静默覆盖风险", "failure_scenario": "同上，validate-study-package.js 在写报告后调用 updateWorkspaceRecordSync 设置最终状态，若中间窗口有并发 authoring 写入或 abandon，行为与缺陷#7 相同"},
  {"file": "scripts/check-repository.mjs", "line": 465, "summary": "Repository Guard 静默移除了要求 prepare-paper.js 必须使用共享 paper-library.mjs 解析器的检查，未并入新的 workspace-writer 守卫组，且测试套件从未覆盖过这条检查的错误文案", "failure_scenario": "未来若 prepare-paper.js 不再经由共享解析器路由论文/slug 解析，重新引入身份边界绕过，CI 的 contract-test 不会捕获，因为该检查已被移除且无回归测试守护"},
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 84, "summary": "嵌套路径拒绝检查用未经 realpath 的原始路径，migrationLockKey 用 realpath 后的路径计算，符号链接可致二者对同一路径的判定分叉", "failure_scenario": "PAPERS_ROOT 下的一级目录本身是指向别处的符号链接，嵌套拒绝检查看到单段路径而放行，migrationLockKey 基于 realpath 计算出不同相对路径，退化为不与 Web 删除/trash 相交的 legacy:migration:<hash> 锁"},
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 80, "summary": "--external-path 标志会连带跳过第3轮新增的嵌套路径拒绝检查，可对库内嵌套路径重新打开与缺陷相同的锁不相交问题，纯粹通过 CLI 参数选择即可触达", "failure_scenario": "用户对库内嵌套路径（如 papers/foo/bar）传入 --external-path，嵌套拒绝检查因 externalPath 为真而跳过，migrationLockKey 退化为不与 legacy:foo 互斥的键，migrate 与 Web 侧对同一包 foo 的并发操作不再互斥"},
  {"file": "plugins/codex-paper/skills/study/scripts/prepare-paper.js", "line": 312, "summary": "allocateRouteSlug 用内联字面量数组重新实现同文件内已导入可用的 isActiveWorkspaceState 判定，与第3轮缺陷#4（分配器与锁内复核用独立谓词）同类问题以新形式重演", "failure_scenario": "未来新增 workspace 状态并更新 isActiveWorkspaceState 时，若 prepare-paper.js 的硬编码数组未同步更新，路由分配器与 createGenerationWorkspace 的去重检查会对同一组 workspace 的活跃性判定不一致，重现路由 slug 冲突或误报 409"}
]
```

*本文件由第 4 轮 code review 流程生成；候选来源为 8 角度并行扫描（约 25 条去重候选，其中一条经实际复现脚本验证），全部结论经按主题分组的 5 个独立验证批次逐条判定（15 项 CONFIRMED，无 PLAUSIBLE/REFUTED）。*
