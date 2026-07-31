# P0-C2a Code Review 结论（第 2 轮）

- **审查日期**: 2026-07-21
- **审查范围**: 工作区未提交改动（`git diff HEAD`，40 个文件，+938/-558）及全部新增文件（`storage-transaction.mjs` 459 行、`generation-workspace.mjs` 321 行、`workspace-writer.mjs` 102 行、`workspace-cli.js`、`storage-transaction.test.mjs` 等）——即第 1 轮 review 建议修复之后的当前状态
- **审查依据**: `docs/P0-C2A_CODE_REVIEW_FINDINGS.md`（第 1 轮结论）与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（第 1 轮处置记录）；重点为 (a) 逐项复核第 1 轮已接受修复是否正确、完整，(b) 修复本身是否引入新缺陷，(c) diff 其余部分的新问题
- **方法**: 与第 1 轮相同的 8 个独立查找角度并行扫描（逐行 / 删除行为审计 / 跨文件追踪 / 复用 / 简化 / 效率 / 实现深度 / 约定），产生约 31 条去重候选；再按文件分组由 8 个独立验证批次逐条给出 CONFIRMED / PLAUSIBLE / REFUTED 判定

## 总体评估

第 1 轮的核心修复**大部分是成立的**：锁的部分获取回滚与逆序全量释放（缺陷 #2、#3）修复正确；死锁回收的互斥性核心（per-lock claim + rename 前后复核 token）成立；`atomicRemoveFile` 强制 SHA 前置条件成立；abandoned 只读门禁在 tags/resume/update 各入口生效；workspace 状态转换表、共享记录校验、sandbox 对 managed-generation 显式路径的接纳均已落地。

但第 2 轮发现 **15 个可确认的正确性缺陷**，其中相当一部分是修复本身引入或暴露的：

- **回收协议引入了两种新的失败模式**：`.reclaim` 守卫目录在崩溃后永久残留使该键的死锁回收永久失效（#5）；回收路径中并发竞争产生的 `STORAGE_LOCK_INITIALIZING` 未被捕获，把一次本可重试的瞬态竞争变成整个多锁获取的致命 409（#6）。
- **ask 锁收窄引入了两种新的失败模式**：追加聊天笔记用 0 超时单次尝试，任何瞬时锁竞争都会把耗时最长 180 秒算完的答案整体丢弃为 409（#2）；并发提问不再互斥，直接竞争 codexWorker 未加同步的 per-paper 线程 map，单个失败还会杀掉共享 worker 进程（#3）。
- **sandbox 报告协议在修复过程中引入三处缺陷**：报告目录用含冒号的原始 generationId 命名（NTFS 非法，且与存储层 `gen-sha256-` 命名不一致，#10）；explicit_path 包 plan 发放 approval 但 execute 必然失败、每轮烧掉一个 token（#4）；overlay 目录缺失时 404 被误标为"路径不安全"且同样烧 token（#7）。
- **最严重的新缺陷在 workspace 创建的失败保全路径**：populate 之后任何 rename/fsync 失败，catch 中用 `expectAbsent: true` 重写已存在的 workspace.json 必然失败并被吞掉，"保留失败现场"沦为死代码，做完的工作 60 分钟后被清理例程静默删除（#1）。

此外，**路由 slug 唯一性随 index 写入一起被删除了**（同名论文两次 prepare 得到相同 slug，冲突被推迟到 C2b 才爆发，#9）；migrate-package 的锁键与其他组件用的键不一致导致迁移与 Web 删除完全不互斥（#8），且迁移会无条件覆盖用户已填写的 reasoning-review.md（#11）。

结论：**边界目标（不触碰正式存储）仍然成立**（mandatory fixture 的行为级断言仍是有效防线），但建议在提交 C2a 之前修复 #1–#4，在 C2b 之前修复其余各项。

---

## 一、已确认的正确性缺陷（按严重程度排序）

### 1. workspace 创建失败后的"保留现场"路径是死代码，失败工作被静默删除 — CONFIRMED

`plugins/codex-paper/src/shared/generation-workspace.mjs:230`

happy path 在 222 行以 `expectAbsent: true` 写入 workspace.json 后执行 `renameSync(initDir, finalDir)`（223 行）。此后任何失败（rename 抛 EPERM/EACCES/EBUSY——Windows 杀软/索引器持有句柄时真实可达；或 224-225 行的目录 fsync 失败）进入 catch，而 catch 在 230 行对**同一路径**再次以 `expectAbsent: true` 写 failed 记录——文件已存在，必然抛 `WRITE_PRECONDITION_FAILED`，被裸 `catch {}` 吞掉，231 行的 rename 永不执行。残留物保持 `.init-*` 命名、状态停留 `authoring`、无任何诊断，下一次 prepare 的 `cleanupInitDirectories` 在 60 分钟后 `rm -rf` 整个已 populate 的包。这直接违反审查重点第 2 条"保留失败现场"。

**建议**: catch 中改用"读取当前 sha 后 CAS 覆盖"（或先 `rm` 再 `expectAbsent`），并对 rename 失败单独处理（此时 workspace.json 已写好，只需重写 state 字段）。

### 2. ask 聊天笔记追加用 0 超时单次获取锁，瞬态竞争丢弃整个已算完的答案 — CONFIRMED

`plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts:144,161`；`operationLocks.mjs:28`

`withOperationLocks` 硬编码 `timeoutMs: 0`（单次尝试、无重试）。外部 Codex 调用（最长 180 秒）成功后，若追加笔记瞬间恰有 CLI 侧持有 `paper:<paperKey>`（build/render/tags/prepare 的亚秒级持锁均可触发），`acquireStorageLocks` 抛 `STORAGE_LOCK_CONFLICT` 409，ask 的 catch 因 `e.statusCode` 存在而原样上抛，客户端（papers/[slug].vue submitAsk）只展示错误、不重试——答案既未保存也未返回，全部丢弃。锁真正保护的只是一次亚秒级文件追加。

**建议**: 对追加笔记使用小超时（如 2–5s）；或获取失败时仍返回答案并附"未保存"标记。

### 3. 并发 ask 不再互斥，竞争 codexWorker 无同步的线程 map，单个失败杀掉共享 worker — CONFIRMED

`ask.post.ts:120`；`codexWorker.ts:148-186,389-392`

改动前整个 ask 流程被锁包裹，同一论文的第二个并发请求在调用 Codex 前快速失败 409。现在两个请求并发执行 `askCodexWorker`：`CodexMcpWorker.ask` 对共享 `paperThreads` map 做无同步的 get-await-set——两个首问各建一个 thread，`set` 后写覆盖前写（一个 thread 的上下文被孤儿化）；已有 thread 时两者并发对同一 threadId 发 `codex-reply`，对话轮次交错。且 `resetAfterFailure` 在任一失败时 kill 共享子进程并 `rejectAll`，连带拒绝另一个在途请求。

**建议**: 在 worker 内对同一 paperKey 的 ask 做进程内串行化（per-key Promise 链即可），与跨进程文件锁职责分离。

### 4. explicit_path 包 plan 发放 approval，execute 必然失败且每轮烧掉一个 token — CONFIRMED

`plugins/codex-paper/skills/study/scripts/sandbox-code.js:599,729`

`buildExecutionPlan` 唯一的门是 `descriptor.readOnly && !publishedGeneration`（355 行），而 explicit_path 描述符 `readOnly: false`——plan 返回 ready 并发放一次性 approval。`executeApprovedPlan` 在 729 行先 `claimApproval`（rename+rm，token 销毁），739 行 `prepareReport` → `reportTarget` 对 explicit_path 模式直接抛"Execution reports require a generation workspace or managed published generation"。HEAD 上 explicit external 包可正常执行并把报告写进 `<dir>/.codex-paper/execution-reports`。现在该模式永远无法执行，且每次尝试都消耗一个新 approval。

**建议**: 在 plan 阶段就按 `reportTarget` 的模式集拒绝（capability 返回 nonconformant 并给出正确诊断），不发放注定失败的 approval；或恢复 explicit_path 的包内报告路径。

### 5. 崩溃残留的 `.reclaim` 守卫目录永久禁用该键的死锁回收 — CONFIRMED

`plugins/codex-paper/src/shared/storage-transaction.mjs:149-150,175`

第 1 轮修复引入的 per-lock reclaim claim 依赖 `mkdirSync(reclaimGuard)`（149 行）与 finally 中的 `rmdirSync`（175 行）。进程在两者之间被 kill -9/断电，`<lockDir>.reclaim` 永久残留；此后所有回收尝试在 150 行 EEXIST → return false，`tryAcquireOne` 永远返回 null，该键上所有操作跨重启持续 `STORAGE_LOCK_TIMEOUT`。全仓库无任何清理 `.reclaim`（或泄漏的 `.stale-*`）残留的代码，也无 mtime 兜底。这是修复引入的新的永久毒化模式，与刻意递延的"无主/corrupt 锁目录不回收"是不同的路径。

**建议**: 对 EEXIST 的守卫目录检查 mtime，超过上限（如数倍 MAX_LOCK_TIMEOUT_MS）允许移除后重试；同时在回收成功/失败路径上清理 `.stale-*`。

### 6. 回收路径中 `STORAGE_LOCK_INITIALIZING` 逃逸为致命 409，瞬态竞争不再重试 — CONFIRMED

`storage-transaction.mjs:157,165,205`

`reclaimDeadOwner` 内 156 行的复核 `readOwnerRecord(lockDir)` 只捕获裸 `ENOENT`（157 行）。并发回收者刚完成回收并在其递归 `tryAcquireOne` 中 `mkdirSync(lockDir)`（192 行）、owner.json 尚未 rename 就位时，本进程的复核恰好抛 `STORAGE_LOCK_INITIALIZING`（409）——未被捕获，经 205 行无守卫的调用点逃出（201-203 行的 catch 只包住**第一次** readOwnerRecord），在 `acquireStorageLocks` 中被 `rollbackAfterError` 回滚后**原样抛给调用方**：超时预算还有余量却直接失败。另外 165 行 `readOwnerRecord(stale)` 若抛出（非 token 不匹配），既不恢复也不 `rmSync`，`.stale-*` 目录泄漏并上抛致命错误。

**建议**: 205 行的回收调用与 156/165 行的复核统一按"回收失败 → return false / INITIALIZING → 视为冲突重试"处理。

### 7. overlay 目录缺失时报告写入 404 被误标为"路径不安全"，approval 同样被烧掉 — CONFIRMED

`sandbox-code.js:643-652,651`；`paper-library.mjs:268,401`

`descriptorForRecord`（`existsSync(overlayDir) ? … : overlayDir`）与 `resolveExplicitPackage` 的 managed_generation 分支（无存在性检查）都容忍 overlay 目录不存在，而全仓库没有任何代码在报告写入前 mkdir overlay 根；`atomicWriteFile` 的 `assertSafeDirectory(root)` 对缺失根直接抛 `STORAGE_DIRECTORY_MISSING`（404），`prepareReport` 的 catch 只透传 `STORAGE_LOCK_*`，把其余一律改写为"Execution report path is unsafe"——诊断误导，且 token 已在 729 行被消耗。

**建议**: 报告路径写入前确保 overlay 根存在（在 descriptor/writer 层 mkdir），catch 只重写真正的路径安全类错误。

### 8. migrate-package 锁键与所有其他组件不一致，迁移与 Web 删除完全不互斥 — CONFIRMED

`migrate-package.js:106`；`paper-library.mjs:319,385`；`delete.delete.ts`

migrate 锁 `legacy:migration:<sha256(realpath)>`，而 delete 路由经 `descriptor.paperLockKey` 锁 `legacy:<slug>`（外加 `index`）。两者走同一套 storage-transaction 文件锁，键相同即可互斥——但永远不同。`movePaperToTrash` 无守卫地 `renameSync(paperRoot, payloadDir)`：迁移中途包根被移入 trash，migrate 的 `atomicWriteFile` 要么 `STORAGE_DIRECTORY_MISSING` 半途失败（包处于半迁移态），要么经已解析的 realpath 把 meta/evidence 写进本应冻结的 trash payload。这正是 C2a "每次托管替换必须持锁" 规则要防的交错。

**建议**: migrate 改用 `legacy:<slug>`（必要时加 `index`），与 descriptor 的锁键构造共享同一来源。

### 9. 路由 slug 唯一性随 index 写入一起被删除，同名论文静默共享同一 slug — CONFIRMED

`prepare-paper.js:305-322`；`generation-workspace.mjs:196`

`allocateRouteSlug` 的已用集只来自 managed records 的 routeAliases、index.json 条目与 legacy 目录名。HEAD 上 prepare 会把论文写入 index.json，使第二篇同名论文获得 `<slug>-<sha12>` 后缀；现在 C2a 不再发布，且**没有任何代码查询既有 workspace 的 routeSlug**（createGenerationWorkspace 只按 generationId 去重）。两篇不同论文（不同字节 → 不同 paperKey/generationId）同名 prepare 后，两个 workspace 的 workspace.json 与 `publishIntent.paperRecord.routeAliases` 携带同一个裸 slug，全程无检查，冲突被推迟到尚未编写的 C2b 发布期爆发。

**建议**: `allocateRouteSlug` 的已用集并入 `listGenerationWorkspaces` 的非 abandoned workspace slug。

### 10. sandbox 报告目录用含冒号的原始 generationId 命名，Windows 上不可用且与存储命名不一致 — CONFIRMED

`sandbox-code.js:606`；`paper-library.mjs:88`

`reportTarget` 拼 `execution-reports/${descriptor.generationId}`，即 `gen:sha256:<hex>`（含两个冒号），而存储层自己的 `generationDirectoryName` 是 `replaceAll(':', '-')` 后的 `gen-sha256-<hex>`。`atomicWriteFile` 的 segment 校验不拦冒号并原样 mkdir：NTFS 上 mkdir 失败（冒号保留字符），已发布 generation 的执行报告永远无法提交；POSIX 上则静默创建与存储约定不一致的冒号目录。同一行代码对紧邻的 timestamp 做了去冒号处理，唯独漏了这一段。

**建议**: 复用 `generationDirectoryName`（或等价 sanitize）。

### 11. 迁移无条件覆盖用户已填写的 reasoning-review.md — CONFIRMED

`migrate-package.js:314,317`

新代码在 `!fs.existsSync(reasoningPath)`（只检查 reasoning-analysis.json）分支内经 `writeMigrationFile` 无条件写入 `REVIEW_TEMPLATE`；`writeMigrationFile` 只有 CAS 前置条件、没有"已存在即跳过"守卫。HEAD 上该写入经 `scaffold-reasoning-analysis.js` 的 `if (!fs.existsSync(reviewPath) || options.force)` 保护。结果：包里有已填写的 reasoning-review.md 但没有 reasoning-analysis.json 时，不带 `--force` 运行迁移即把用户的审阅内容覆盖为空白模板。

**建议**: 恢复"review 文件缺失或 --force 才写"的守卫。

### 12. 其余已确认/可信的问题（中低严重度）

| # | 位置 | 问题 | 判定 |
|---|------|------|------|
| 12a | `generation-workspace.mjs:136` | `.DS_Store` 修复只硬编码单个文件名：Thumbs.db / desktop.ini（Windows）、`._*` AppleDouble、`.localized`、编辑器交换文件等任何杂散常规文件仍使 prepare 与 list 全线 403——第 1 轮 #6 的故障类只关掉了一个实例 | CONFIRMED |
| 12b | `workspace-writer.mjs:16` | 波浪号展开用 `process.env.HOME \|\| ''` 而 `resolveGenerationWorkspace` 用 `os.homedir()`：HOME 未设置时（Windows 服务/cron/本仓库 dev 主机即 win32）`~/...` 在 writer 通道坍缩为 `/codex-papers/...` 错误地 fail-closed，同一引用经 workspace-cli 却正常 | CONFIRMED |
| 12c | `paper-library.mjs:351,353` | abandoned workspace 按路径解析抛 `WORKSPACE_ABANDONED`（描述符 `readOnly` 硬编码 false），按 ID 解析经 writer 变成 `PUBLISHED_GENERATION_READ_ONLY`、错误信息指向 legacy 迁移——同一状态两套错误码与误导性诊断，根因是 `resolveExplicitPackage` 手工构造第二份 descriptor | CONFIRMED |
| 12d | `generation-workspace.mjs:313-314` | `setWorkspaceTags` 在锁外快照 publishIntent、锁内整体覆盖写回：快照与写入之间并发的 publishIntent 变更被静默回滚。今天唯一并发写者是 tags 自身（last-writer-wins 尚可容忍），但任何未来 publishIntent 写者（如 reconciliation 刷新）都会触发丢失更新 | PLAUSIBLE（潜伏） |
| 12e | `check-repository.mjs:548` | 哨兵静态层仍有洞：不检查 `atomicWriteJson({root: libraryRoot, relativePath: 'index.json'})` 这条受祝福通道的写入目标，`import { writeFileSync } from 'node:fs'` 也可绕过 `\bfs\.writeFileSync\b`。但 `run-fixture.mjs:99-102` 的 `unpublishedBeforeC2b` 行为级断言会捕获此类回归——洞只在静态层 | PLAUSIBLE |
| 12f | `generation-workspace.mjs:282-303` | `writeWorkspaceAuthoring` 两处直接 CAS 写 `state:'authoring'` 均不调用 `assertWorkspaceTransition`，而 workspace-writer 的平行降级（36 行）调用——转换表没有唯一检查点，两份降级副本已经漂移（assert 有无、lastSuccessfulStep 序列不同）。今天因 abandoned 前置检查而无行为差异；C2b 新增禁止转回 authoring 的状态时，外部写通道将静默绕过 | CONFIRMED（当前良性） |
| 12g | `storage-transaction.mjs:452-453` vs `408-411` | 同一"目标已变化"CAS 冲突两个错误码：写路径 `WRITE_PRECONDITION_FAILED`、删除路径 `STORAGE_CAS_CONFLICT`；测试只断言前者，重试/冲突处理按码匹配会漏掉删除侧 | CONFIRMED |

### 13. 被驳回的候选（记录备查）

- **validate-reasoning 诊断未消毒可致 workspace 滞留 validating** — REFUTED：所有进入 `report.errors` 的 finding 都经 `makeFinding`（validation-report.js:108）做 `toUpperCase().replace(/[^A-Z0-9_]/g,'_')` 消毒且 message 截断 500；legacy `addFinding` 条目因缺 id/severity 必经 `adaptLegacyFinding` → `makeFinding`。诊断永远满足 `/^[A-Z0-9_]+$/`，最终写入不会因此抛 `WORKSPACE_RECORD_INVALID`。（消息中的本地绝对路径未做 boundedText 式脱敏，仅属卫生问题。）

---

## 二、第 1 轮已接受修复逐项复核

| 第 1 轮修复 | 第 2 轮结论 |
|---|---|
| 1. 死锁回收 claim + rename 前后复核 token | **互斥性核心成立**；但引入 #5（守卫目录崩溃残留永久禁用回收）与 #6（INITIALIZING 逃逸为致命 409、stale 目录泄漏） |
| 2. 异常路径回滚全部已获取锁；release 逆序全量尝试 | **成立**。`rollbackAfterError` + `releaseAcquired`（逐项 try/catch、聚合抛出）实现正确，async/sync 两版一致 |
| 3. prepare 哨兵改 grep 历史写入原语；缺失边界文件收集为错误 | **静态层部分成立**，存在 12e 所述盲区；行为级防线（mandatory fixture）完整，边界实际由 fixture 维持 |
| 4. `.DS_Store` 跳过；abandoned 不可 resume/tags/update/复活 | **abandoned 门禁成立**（所有入口 409，转换表 abandoned 行终态）；`.DS_Store` 为单名补丁（12a），且按路径/按 ID 的错误码分裂（12c） |
| 5. 状态转换表 + 命名输出策略 + 写入降级 validated→authoring | **机制存在且内部写通道生效**；但无唯一检查点（12f），降级逻辑两份副本已漂移，双 allowlist（WRITE_POLICIES vs AUTHORING_*）无交叉校验、覆盖集合互不重合 |
| 6. 共享 record 校验 + 路径规范化 | **基本成立**；`resolveExplicitPackage` 仍手工构造 descriptor（readOnly 硬编码 false），是 12c 的根因 |
| 7. sandbox 接受 managed-generation 显式路径；锁错误保留元数据 | **锁错误透传成立**；但引入 #10（冒号目录名）、暴露 #4（explicit_path token 烧毁回归）与 #7（overlay 缺失误诊 + token 烧毁） |
| 8. ask 锁收窄到 appendChatNote | **收窄本身成立**；但引入 #2（0 超时丢弃答案）与 #3（并发 ask 竞争 worker 线程态） |
| 9. `atomicRemoveFile` 强制 SHA 前置 | **成立**；错误码与写路径漂移（12g） |

两项刻意不实现的决定（无主/corrupt 锁不自动回收、发布/恢复协议递延 C2b）与代码一致，本轮不重复标记。

## 三、设计/实现深度（C2b 前建议处理）

1. **`reportTarget` 的每模式存储策略仍内联在调用点**（sandbox-code.js:597-625）：第 1 轮 二.3 未处理，managed_generation_v1 是靠让 else 分支兼职吸收的；新增模式（sealed/archive 等）会落进 else，root 为 null 时 path.join 崩溃或在错误的锁键下写报告。策略应归 descriptor/writer 层——#4、#7、#10 三个缺陷都根植于此。
2. **abandoned 终态语义散布在 5 处**（updateWorkspaceRecord ×2、writeWorkspaceAuthoring ×2、resolveExplicitPackage），`resolveGenerationWorkspace` 仍向任意调用者交出带全套锁键与可写 packageDir 的 descriptor、只附被动 readOnly 标志。转换表 `abandoned: ['abandoned']` 行实为死行。建议以转换表为唯一权威、把散布的前置检查收敛为一处映射。
3. **降级 validated→authoring 的两份副本**（workspace-writer.mjs:35-54 与 generation-workspace.mjs:279-303）应提取为单一 helper，由两个通道共同调用（12f 的修法）。

## 四、复用/重复（新增或恶化项）

| 项 | 位置 | 说明 |
|---|---|---|
| 双 allowlist | workspace-writer.mjs:8-13 vs generation-workspace.mjs:39-43 | WRITE_POLICIES 与 AUTHORING_* 两套独立维护、已互不重合（analysis.json / validation-report.json 只在前者；visual-assets.md 等 7 个只在后者），无任何交叉校验 |
| 降级逻辑 ×2 | workspace-writer.mjs:35 vs generation-workspace.mjs:279 | 已漂移：assert 有无、lastSuccessfulStep 序列不同（12f） |
| CAS 谓词 ×2 | storage-transaction.mjs:408-411 vs 452-453 | 同一冲突两个错误码（12g） |
| 波浪号展开 ×2 | workspace-writer.mjs:16 vs generation-workspace.mjs:153 | HOME vs os.homedir() 已产生行为分裂（12b） |
| descriptor 构造 ×2 | paper-library.mjs:341-360 vs generation-workspace.mjs:104-127 | readOnly 语义已分裂（12c） |
| `updateWorkspaceRecord` / `Sync` | generation-workspace.mjs:238-250 / 252-264 | 逐行复制，第 1 轮修复在两份中同步生长；锁内主体全同步，可提取共享 |

第 1 轮 三 节所列其余重复项（isContained ×3、workspace ID 正则 ×4 等）维持原状，递延决定不变。

## 五、效率（非阻塞）

1. **`resolveExplicitPackage` 的 records 分支 O(N) 全库扫描**（paper-library.mjs:393）：`listManagedRecords`（读解析每个 paper.json + 建别名表）+ `.find()` 内逐条 `realpathSync`；paperKey 本可从路径首段直接得出。`canWriteValidationReport`（validation-report.js:264）为返回一个布尔触发同样的全量解析。sandbox 一次执行解析 2-3 遍 → 200 篇库上数百次 JSON 读取。
2. **prepare 的 PDF 拷贝退化**（prepare-paper.js:590）：`readFileNoFollowBounded`(≤128MB) 全量入堆 + `atomicWriteFile` 内部再算一次被丢弃的 SHA-256（源哈希 433 行已算过），且全程持 4 把锁；HEAD 为内核态 `copyFileSync`。
3. **报告协议 2-3 轮跨进程锁 + 全量重解析**（sandbox-code.js:641/704/766）：commitReport 从头重跑 resolve 链去比对 reservation 里已有的字段；`atomicRemoveFile` 重读全文件重算 reservation 已持有的 sha（其中重解析/重哈希兼作 TOCTOU 复核，收敛时需保留等价校验）。
4. **`updateWorkspaceRecord` 单字段更新读 workspace.json 5 次**（3 次完整 resolve + 2 次原始读，4 次在锁内）；`withWorkspaceMutationSync` 每次调用 `requireWritableWorkspace` 最多 3 次。可让 resolve 返回 bytes+sha 供 CAS 复用、写后用已验证的 next 记录构造返回值。

## 六、简化（低优先级）

- `generationReadOnly` 仍是三写零读的死字段（paper-library.mjs:272/354/398）——第 1 轮 五 节建议未执行，删除即可。
- `preparation.action === 'reconciled'` 死分支仍在（prepare-paper.js:476，`resolvePreparationAction` 只返回 workspace/reused 两种）——第 1 轮 11d 未执行。
- `reclaimDeadOwner` 的 rename catch（storage-transaction.mjs:161-164）`if (ENOENT) return false; return false` 两路同值，ENOENT 判断为死代码；按意图直接 `catch { return false }` 并留一行注释，避免后人"修复"为 throw。

## 七、审查重点逐项结论（第 2 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立**（fixture 行为断言完整）；静态哨兵存在 12e 盲区 |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **保留失败现场不成立**（#1：post-record 失败路径死代码 + 60 分钟清理）；其余成立 |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **回滚与释放已修复成立**；回收侧引入 #5（守卫残留永久禁用回收）与 #6（瞬态竞争致命化） |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **成立**（含 atomicRemoveFile）；migrate 的锁键不与任何共享方相交（#8），互斥名存实亡 |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **写保护成立**；sandbox 报告在 Windows（#10）、overlay 缺失（#7）、explicit_path（#4）三种情形不可用或烧 token |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立** |

---

## 附录：Top-10 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 230, "summary": "createGenerationWorkspace 失败保全路径对已存在的 workspace.json 用 expectAbsent:true 重写，必然失败且被吞，失败现场以 .init-* 残留并在 60 分钟后被清理例程删除", "failure_scenario": "populate 与 workspace.json 写入成功后 renameSync/fsync 失败（Windows 杀软/索引器持句柄）→ catch 内写 failed 记录抛 WRITE_PRECONDITION_FAILED 被 catch{} 吞 → 无诊断、状态停 authoring、下次 prepare 的 cleanupInitDirectories rm -rf 整个已完成的包"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 144, "summary": "聊天笔记追加经 withOperationLocks 硬编码 timeoutMs:0 单次获取锁，无任何重试，瞬态竞争把已算完的答案整体变成 409 丢弃", "failure_scenario": "外部 Codex 调用 180 秒成功返回；追加瞬间 CLI 侧 build/tags 亚秒级持有 paper:<key> → STORAGE_LOCK_CONFLICT 409 原样上抛，客户端仅展示错误，答案未保存也未返回"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 120, "summary": "askCodexWorker 移出锁外后并发 ask 不再互斥，竞争 codexWorker 无同步的 paperThreads map，且单个失败 resetAfterFailure 杀掉共享 worker 进程连带拒绝另一在途请求", "failure_scenario": "同一论文两个并发提问：两个首问各建 thread、set 后写覆盖前写孤儿化一个上下文；已有 thread 时并发 codex-reply 同一 threadId 交错对话；任一失败 kill 子进程 rejectAll 另一请求"},
  {"file": "plugins/codex-paper/skills/study/scripts/sandbox-code.js", "line": 599, "summary": "explicit_path 包 plan 仍返回 ready 并发放一次性 approval，但 reportTarget 拒绝该模式，executeApprovedPlan 先 claimApproval 后必然失败，每轮烧掉一个 token 且永远无法执行", "failure_scenario": "库外研究包 plan→ready+token；execute 在 claimApproval（token 销毁）后 prepareReport 抛 'Execution reports require a generation workspace...'；HEAD 上该流程可正常执行并写包内报告"},
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 149, "summary": "崩溃残留的 <lockDir>.reclaim 守卫目录使该键死锁回收永久失效，全仓库无任何清理路径或 mtime 兜底", "failure_scenario": "回收中被 kill -9 → .reclaim 残留 → 此后所有 reclaimDeadOwner EEXIST return false → 死锁键跨重启持续 STORAGE_LOCK_TIMEOUT 直至手工 rm -rf"},
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 205, "summary": "回收复核只捕获裸 ENOENT，并发回收者初始化窗口产生的 STORAGE_LOCK_INITIALIZING 经无守卫的 reclaimDeadOwner 调用点逃逸，整个多锁获取带余量超时预算直接致命 409", "failure_scenario": "A/B 同见 dead owner，B 完成回收并 mkdir 新锁目录、owner.json 未就位；A 复核抛 INITIALIZING → 未捕获 → rollbackAfterError 上抛 409，prepare/workspace-cli 直接退出而非在剩余 10s 预算内重试"},
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 106, "summary": "migrate 锁 legacy:migration:<sha256(realpath)> 而其余组件全部锁 legacy:<slug>，两键永不相交，迁移与 Web 删除/trash 完全不互斥", "failure_scenario": "migrate 进行中用户在 viewer 删除同一论文：movePaperToTrash 无守卫 rename 包根入 trash → migrate 的 atomicWriteFile 或 STORAGE_DIRECTORY_MISSING 半途失败留下半迁移包，或经 stale realpath 把文件写进本应冻结的 trash payload"},
  {"file": "plugins/codex-paper/skills/study/scripts/prepare-paper.js", "line": 305, "summary": "index 写入删除后 allocateRouteSlug 的已用集不含既有 workspace 的 slug，createGenerationWorkspace 只按 generationId 去重，两篇同名不同内容论文静默获得同一 routeSlug", "failure_scenario": "prepare 同名论文 v1.pdf 与 v2.pdf（不同 paperKey）：两个 workspace 的 publishIntent.paperRecord.routeAliases 携带同一裸 slug，无任何检查，冲突推迟到 C2b 发布期爆发"},
  {"file": "plugins/codex-paper/skills/study/scripts/sandbox-code.js", "line": 606, "summary": "reportTarget 用含冒号的原始 generationId（gen:sha256:<hex>）作 overlay 报告子目录名，NTFS 上 mkdir 失败，且与存储层 generationDirectoryName 的 gen-sha256- 命名不一致", "failure_scenario": "Windows 上已发布 generation 的执行报告提交必然 EINVAL/ENOENT 失败（token 已烧）；POSIX 上静默创建与存储约定不一致的冒号目录"},
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 317, "summary": "迁移在 reasoning-analysis.json 缺失分支无条件写 REVIEW_TEMPLATE，丢失了 HEAD 上 scaffold 的存在性守卫，用户已填写的 reasoning-review.md 被覆盖为空白模板", "failure_scenario": "包内有已填写的 .codex-paper/reasoning-review.md 但无 reasoning-analysis.json：不带 --force 运行 migrate-package，writeMigrationFile 以 CAS 覆盖写掉用户审阅内容"}
]
```

*本文件由第 2 轮 code review 流程生成；候选来源为 8 角度并行扫描（约 31 条去重候选），全部结论经按文件分组的独立验证批次逐条判定（15 项 CONFIRMED 正确性缺陷、2 项 PLAUSIBLE、1 项 REFUTED）或直接代码核实。*
