# P0-C2a Code Review 结论

- **审查日期**: 2026-07-21
- **审查范围**: 工作区未提交改动（`git diff HEAD`，40 个文件，+805/-515）及全部新增文件（`storage-transaction.mjs`、`generation-workspace.mjs`、`workspace-writer.mjs`、`workspace-cli.js`、`storage-transaction.test.mjs` 等，约 1100 行）
- **审查依据**: `docs/P0-C2A_CODE_REVIEW_SUMMARY.md` 列出的 6 项审查重点
- **方法**: 8 个独立查找角度（逐行扫描 / 删除行为审计 / 跨文件追踪 / 复用 / 简化 / 效率 / 实现深度 / 约定）并行扫描，产生约 30 条去重后的候选；每条经独立验证后给出 CONFIRMED / PLAUSIBLE / REFUTED 判定。

## 总体评估

P0-C2a 的核心目标——"写入权限边界迁移到私有 workspace，任何 prepare/author/render/validate 路径不得触碰正式 `paper.json` / `current.json` / `index.json`"——在主干路径上实现是**成立的**：workspace 创建满足同文件系统、私有权限（0700）、原子 rename、精确 resume；托管文件替换统一经过锁 + absent-or-SHA CAS；mandatory fixture 也确实在 workspace 内跑完整链路并断言无提前发布。测试覆盖（56 guard + 135 组合 + 9 storage transaction）与验证记录一致。

但审查发现**锁子系统存在 4 个可确认的正确性缺陷**（互斥性破坏、锁泄漏、锁目录永久损坏），**边界守卫本身存在 1 个使其无效的缺陷**（grep 的标识符从未在被守卫文件中出现过），以及若干边界一致性缺口（abandoned workspace 仍可被改写、内部写通道绕过 allowlist 与状态跟踪）。这些问题大多不影响本阶段的单人单机使用，但会在 P0-C2b 引入发布协议时直接放大，建议在 C2b 之前修复。

---

## 一、已确认的正确性缺陷（按严重程度排序）

### 1. 死锁回收存在 TOCTOU 竞争，可导致双持有者，破坏互斥 — CONFIRMED

`plugins/codex-paper/src/shared/storage-transaction.mjs:146-155`（`reclaimDeadOwner`）

回收时直接 `renameSync(lockDir, stale)`，未在 rename 前/后复核 owner token。场景：持有者死亡后进程 A、B 同时读到 dead owner；B 先完成回收并重新获取（写入自己的存活 owner.json）；A 随后执行自己的 rename——移走的却是 **B 的新锁目录**——然后递归重新获取。结果 A、B 同时认为自己持有 `paper:K`，并发 CAS 写托管文件，互斥性与"存活持有者的锁永不回收"不变量同时被破坏。

**建议**: rename 到 stale 目录后重读其中 owner.json 并比对 token/pid；不匹配则 rename 回原位并放弃回收。

### 2. 获取锁途中抛异常时不回滚已获取的锁（部分获取回滚失效）— CONFIRMED

`storage-transaction.mjs:265-267`（async 版）与 `:291-293`（sync 版）

`finally` 块仅在 `conflictKey` 非空（正常冲突）时释放已获取的锁。若 `tryAcquireOne` 对后续 key **抛异常**（如遇到 corrupt owner.json 的 `STORAGE_LOCK_CORRUPT`、symlink 的 `STORAGE_LOCK_UNSAFE`、或 ENOSPC），`conflictKey` 仍为 null，已获取的锁全部泄漏且无 handle 可释放。锁目录归属存活 pid，`reclaimDeadOwner` 不会回收——同进程重试也拿不到，形成自死锁，直到进程退出。这直接违反审查重点第 3 条"partial-acquisition rollback"。

**建议**: `finally` 改为"未成功返回 handle 即回滚"（如 `let succeeded = false`，成功后置 true，finally 中 `if (!succeeded)` 释放）。

### 3. `release()` 中单个锁释放抛异常会中断循环并永久泄漏其余锁 — CONFIRMED

`storage-transaction.mjs:212-217`（`createLockHandle.release`）

`released = true` 在迭代前设置，`releaseOne` 抛出（`STORAGE_LOCK_OWNERSHIP_LOST` / `STORAGE_LOCK_CORRUPT`）会中断 for 循环；再次调用 `release()` 因 `released` 已翻转成为 no-op。剩余锁被存活进程永久持有，该 paper 的所有后续操作超时。

**建议**: 逐项 try/catch，收集错误最后统一抛出；保证每个 item 都尝试释放。

### 4. 崩溃残留的无 owner.json 锁目录永久毒化该锁键，无恢复路径 — CONFIRMED

`storage-transaction.mjs:127-133`（`readOwnerRecord` ENOENT 分支）、`:179-181`（`tryAcquireOne`）

进程在 `mkdirSync(lockDir)` 之后、owner.json rename 落盘之前被 kill -9 / 断电，锁目录残留且无 owner.json。1 秒 `STORAGE_LOCK_INITIALIZING` 宽限期过后，`readOwnerRecord` 永远抛 `STORAGE_LOCK_CORRUPT`（422，不可重试），`tryAcquireOne` 直接上抛；`reclaimDeadOwner` 因需要合法 owner record 而永远不可达。该键（如共享的 `index`）上的所有操作跨重启持续失败，只能手工 `rm -rf` 锁目录。P0-C2a 明确排除了 recovery 命令，但"corrupt 锁永不回收"与"崩溃可自愈"之间需要一个折中。

**建议**: 对"无 owner.json 且 lockDir mtime 超过某上限（如 MAX_LOCK_TIMEOUT_MS 的数倍）"的目录允许安全回收（rename-out + 复核 + 删除），或至少提供一个显式的 `locks-doctor` 命令；同时将错误信息中附上锁目录路径以便人工处置。

### 5. 权限边界哨兵 grep 的标识符在被守卫文件中从未出现过，守卫无效 — CONFIRMED

`scripts/check-repository.mjs:548`

守卫用 `/writeLibraryIndex|writeCurrentRecord|writePaperRecord/` 检查 `prepare-paper.js` 不得发布正式存储，但改动前的 prepare-paper.js 实际使用的是 `writeJsonAtomicNoFollow`（HEAD 4 处）、`writeIndexPreserveShape`（HEAD 3 处）和裸 `fs.writeFileSync`（HEAD 2 处）——三个被 grep 的名字 **0 处匹配**。将被删除的发布代码原样恢复，该守卫依然绿灯。这个 CI 守卫恰恰是本里程碑要防的回归的最后防线。

**建议**: 改为 grep 实际存在过的写入原语（`writeJsonAtomicNoFollow` / `writeIndexPreserveShape` / `fs.writeFileSync` + `index.json|current.json|paper.json` 字面量），或更进一步：在行为层守卫（mandatory fixture 已断言无正式存储产生，把 sentinel 检查与 fixture 断言对齐，弱化字符串匹配的权重）。

### 6. workspaces-v1 下任何杂散文件（如 macOS `.DS_Store`）会让 prepare 全线失败 — CONFIRMED

`plugins/codex-paper/src/shared/generation-workspace.mjs:130-132`（`listGenerationWorkspaces`）

非 `.init-` 前缀、非目录或不匹配 ID 模式的条目直接抛 `WORKSPACE_REGISTRY_INVALID`（403）。开发平台是 macOS：用户在 Finder 中打开该目录即会产生 `.DS_Store`，此后 `prepare-paper.js`（`createGenerationWorkspace` 在锁内调用 list 做去重检查）与 `workspace-cli.js list` 全部硬失败，直到手工删除文件。

**建议**: 已知无害文件（`.DS_Store` 等隐藏文件）跳过即可；对确属可疑的条目再 fail-closed。

### 7. `setWorkspaceTags` / `updateWorkspaceRecord` 缺少 abandoned 只读门禁 — CONFIRMED

`generation-workspace.mjs:297-304`、`:231-253`

`writeWorkspaceAuthoring` 与 `resolveExplicitPackage` 都对 abandoned workspace fail-closed（409），但 `workspace-cli.js tags` → `setWorkspaceTags` → `updateWorkspaceRecord` 无状态检查，可改写 abandoned workspace 的 `publishIntent.tags` / `updatedAt`，甚至任何库内调用者传 `{state:'authoring'}` 可将其复活为可写。"abandoned 只读"的不变量被旁路。

**建议**: 在 `updateWorkspaceRecord` 中拒绝 `current.state === 'abandoned'` 的更新（`abandonGenerationWorkspace` 自身入口豁免），或最小改动在 `setWorkspaceTags` 加门禁。

### 8. 内部写通道 `replaceWorkspaceFile/Json` 绕过 allowlist 且不联动 workspace 状态 — CONFIRMED（双子项）

`plugins/codex-paper/src/shared/workspace-writer.mjs:43-57`

- **(a) 状态联动缺口**: `writeWorkspaceAuthoring`（外部通道）每次写入都将状态降回 `authoring` 并刷新 `updatedAt`；而 build-analysis / render-from-analysis / scaffold 使用的 `replaceWorkspaceFile/Json` 从不触碰 workspace.json。对 `validated` 状态的 workspace 重跑 render 会改写 README/summary/analysis 而状态仍是 `validated`——未来 C2b 的发布门禁将放行从未复验的内容。
- **(b) allowlist 缺口**: `replaceWorkspaceFile` 接受包内任意相对路径（现有例证：validation-report.js 写 `.codex-paper/validation-report.json`，不在 `AUTHORING_CODEX_FILES` 内），allowlist 只对外部通道生效，约束靠调用方自觉。

**建议**: 把状态降级逻辑下沉进 writer（或最低限度：render/build 完成后显式降级状态）；allowlist 改为 writer 层的参数化策略（authoring 路径集 + 各脚本声明的产物路径集），而非只挂在一个入口上。

### 9. 已发布 generation 的显式路径在 sandbox 中被误诊为 "Legacy flat-layout" — CONFIRMED

`plugins/codex-paper/skills/study/scripts/sandbox-code.js:354-355`、`:596-599`；`paper-library.mjs:375-377`

`resolveExplicitPackage` 对已发布 generation 路径返回 `managed_generation_v1, readOnly=true`；sandbox 仅按 `readOnly` 分支，给出错误诊断 "Legacy flat-layout packages are read-only until explicitly migrated"（对托管存储包完全不适用）且永不发放 approval。同一论文用 slug 调用则正常执行、报告写入 overlay/。改动前 explicit_path 流程可以执行。路径调用与 slug 调用行为不一致 + 误导性诊断。

**建议**: `managed_generation_v1` 应与 `managed_v1` 同样走 overlay 报告路径（或至少给出正确的诊断与"请用 slug 调用"的指引）。

### 10. Web ask 路由跨进程持有 `paper:` 锁贯穿整个外部 Codex 调用（最长 3 分钟），阻塞 CLI 侧全部写入 — CONFIRMED

`plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts:119-121`；`operationLocks.mjs:26`

`withOperationLocks` 从进程内 Set 换成跨进程文件系统锁后，聊天期间该 paper 的 `paper:<paperKey>` 被 Web 进程持有至外部调用返回（`ASK_TIMEOUT_MS = 180_000`）；CLI 授权路径（workspace 写入、build、validate）以 10s 超时获取同一键，全部 `STORAGE_LOCK_TIMEOUT` 退出。锁真正需要覆盖的只有 `appendChatNote` 那一次写入。

**建议**: 将锁的获取收窄到 `appendChatNote` 前后，而不是包裹整个外部调用。

### 11. 其余已确认问题（中低严重度）

| # | 位置 | 问题 | 判定 |
|---|------|------|------|
| 11a | `prepare-paper.js:448-465` | `--resume-workspace` 对 abandoned workspace 返回 `workspace_resumed` 成功（exit 0），后续所有步骤才失败；应在 resume 时 fail-closed | CONFIRMED |
| 11b | `sandbox-code.js:641-653` | `prepareReport` 的 catch-all 将 `STORAGE_LOCK_TIMEOUT/CONFLICT`（409, retryable）改写为 "Execution report path is unsafe" 的策略错误，丢弃 code/statusCode/retryable | CONFIRMED |
| 11c | `scripts/check-repository.mjs:572-573` | authoring-boundary.mjs 缺失时 `readFileSync` 直接抛 ENOENT，中止整个契约检查并吞掉已收集的错误清单（CLI 有兜底 catch，程序化调用者无） | CONFIRMED（含措辞修正） |
| 11d | `prepare-paper.js:338-342, 473` | `--reconcile-identity` 不再复用已发布 generation，改为创建目标路径与已发布包相同的新 workspace；`action === 'reconciled'` 分支成为死代码；发布期 CAS 冲突如何消解被推迟到未编写的 C2b | PLAUSIBLE（死代码属实；"必然不可发布"是对未写代码的预测） |

### 12. 被驳回的候选（记录备查）

- **`ensureWorkspaceRoot` 非递归 mkdir 导致 ENOENT** — REFUTED：`prepare-paper.js:420` 在唯一调用链上已先执行 `mkdirSync(libraryRoot, { recursive: true, mode: 0o700 })`。

---

## 二、设计/实现深度问题（建议 C2b 前处理）

1. **`resolveExplicitPackage` 手写了一套平行的 workspace 解析**（`paper-library.mjs:326-340`）：只校验 schemaVersion/workspaceId/state，跳过 `validateWorkspaceRecord` 的 generationId / targetPackageRelativePath / publishIntent 校验，并从**未校验**的字段拼锁键。corrupt record 在一条路径被 422 拒绝、在另一条路径却能通过并锁错键。存在 import 环约束（generation-workspace 依赖 paper-library），但可通过提取共享校验/描述符构造模块解决。— CONFIRMED
2. **workspace 状态机没有转换表**：`validateWorkspaceRecord` 接受任意合法 state 值；validate-reasoning.js 用三次独立加锁调用拼出 `validating → validated/failed` 转换，崩溃可将 workspace 滞留在 `validating` 且无人察觉。状态字段的语义靠每个脚本自觉维护。
3. **sandbox-code.js `reportTarget` 在调用点内联每种 mode 的存储策略**（写根、报告目录、锁键集），新增 descriptor mode 时这里是最容易漏改的地方；`commitReport` 为此手写了一套四字段漂移比对。策略应归属 descriptor/writer 层。

## 三、复用/重复代码（同一安全谓词多副本，漂移风险）

| 项 | 副本位置 | 说明 |
|---|---|---|
| `isContained` | storage-transaction.mjs:32、paper-library.mjs:92（已导出）、librarySecurity.mjs:73 | 路径逃逸检查是核心安全谓词，3 份拷贝；加固只落到一份时边界强度不一致 |
| workspace ID 正则 | generation-workspace.mjs:19、workspace-writer.mjs:10、paper-library.mjs:326、schema JSON | 4 处；ID 格式变更时漏改任意一处即产生"同一 workspace 按 ID 与按路径解析结果不同" |
| `WORKSPACES_RELATIVE_PATH` | generation-workspace.mjs:16、paper-library.mjs:8 | 两个同名导出常量 |
| `assertSafeDirectory` vs `requireSafeDirectory` | storage-transaction.mjs:37 vs paper-library.mjs:104 | 同一"安全目录"定义两套实现，仅错误类不同 |
| `preconditionFor` vs librarySecurity `writeFileAtomic` 前置块 | workspace-writer.mjs:31 vs librarySecurity.mjs:255-261 | **已经开始漂移**：前者把 404/STORAGE_DIRECTORY_MISSING 也视为 absent，后者只认 ENOENT |
| `readWorkspaceRecord` 手写安全读 | generation-workspace.mjs:85-96 | paper-library 已有 `readJsonNoFollow`；手写版把 symlink 拒绝坍缩成 422"记录无效"而非 403 安全拒绝 |
| `atomicRemoveFile` 路径校验 | storage-transaction.mjs:399-410 | 与 `atomicWriteFile`(337-360) 的校验逐行重复，应提取 `resolveSafeTarget(root, relativePath)` |
| `acquireStorageLocks` / `acquireStorageLocksSync` | storage-transaction.mjs:248-274 / 276-301 | 逐行复制，仅等待原语不同；上文缺陷 #2 需要修两处正是这种复制的代价。`updateWorkspaceRecord/Sync`（generation-workspace.mjs:231-253）同理 |

## 四、效率问题（非阻塞，量化后按需处理）

1. **CAS 双读双哈希**：`preconditionFor` 读全文件+哈希，`atomicWriteFile` 内部再读一次+再哈希（workspace-writer.mjs:31 / storage-transaction.mjs:367-375）。持有排他锁时这纯属重复；librarySecurity `writeFileAtomic` 同样模式。chat-notes 路径上一次请求同一文件被同步读 3 次。
2. **`expectAbsent` 写也全量读旧文件**（storage-transaction.mjs:363-370）：仅需存在性时把最大 128MB 的旧文件读进内存与 null 比较；lstat 已足够。
3. **Web 热路径上的同步 fsync 锁协议**（operationLocks.mjs:24-27）：每个请求 2-3 个锁键 × 每键 mkdir+写 owner.json+双 fsync+读回+unlink+rmdir，全部同步阻塞 Nitro 事件循环；原实现是纳秒级内存 Set。跨进程锁的正确性收益是真实的，但至少可改用异步 fs 并评估 advisory 短锁是否需要双 fsync。
4. **`writeWorkspaceAuthoring` 每文件 3 次 resolve + 每文件重写 record**（generation-workspace.mjs:261-295）：写满一个包（约 11 个文件）产生 ~30 次 workspace.json 读取/解析与 11 次带双 fsync 的 record 重写；`atomicWriteJson` 返回的 sha256 可直接用作下一次的 expectedSha256。
5. **`createGenerationWorkspace` 在持锁状态下全量扫描并校验所有 workspace**（generation-workspace.mjs:189）做去重；目录名已含 paper/generation 前缀，可按前缀过滤后只读匹配项。abandoned/failed workspace 会累积，扫描成本随库增长。

## 五、简化建议（低优先级）

- `generationReadOnly` 字段在 paper-library.mjs 三处 descriptor 中赋值，**全仓库 0 处读取**——删除或在使用点派生。
- `writeWorkspaceAuthoring` 在非 authoring 状态下同一锁内两次完整 CAS 写 workspace.json（预降级 + 写后记录）。若预降级是刻意的崩溃安全设计（内容写失败时状态已不是 validated），建议加注释说明；否则合并为一次。
- `getWorkspaceLayout` 现在可完全由 `getLibraryLayout`（本次 diff 已为其新增 workspacesRoot）替代。

## 六、审查重点逐项结论

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立**（fixture 与测试佐证）；但 CI 哨兵守卫本身无效（缺陷 #5），边界目前主要靠测试而非守卫维持 |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **基本成立**；resume 对 abandoned 不 fail-closed（11a），杂散文件可致创建失败（#6） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **锁顺序成立**（rank+字典序全局一致）；**回滚不成立**（#2、#3）；**回收侧有 TOCTOU**（#1）与**corrupt 永久毒化**（#4） |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **对 atomicWriteFile 成立**；`atomicRemoveFile` 的 `expectedSha256` 可为 null（无条件删除），与"每次替换必须 CAS"的表述存在缺口 |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **写保护成立**；sandbox 对已发布 generation 的路径调用被误诊且不可用（#9） |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立** |

---

## 附录：Top-10 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 149, "summary": "reclaimDeadOwner 回收死锁时不复核 owner token，两进程并发回收可各自认为持有同一锁，破坏互斥", "failure_scenario": "持有者死亡后 A/B 同时读到 dead owner；B 完成回收并重新持锁，A 随后 rename 移走 B 的存活锁目录并重新获取——双持有者并发 CAS 写托管文件"},
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 266, "summary": "获取多把锁途中 tryAcquireOne 抛异常时 finally 仅按 conflictKey 回滚，异常路径泄漏全部已获取锁（sync 版 292 行同病）", "failure_scenario": "acquire(['registry','paper:K',...]) 前三把成功、第四把遇 corrupt owner.json 抛 422 → 前三把归属存活 pid 永不释放，该 paper 自死锁至进程退出"},
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 214, "summary": "release() 先置 released=true 再迭代，单个 releaseOne 抛异常中断循环且二次调用为 no-op，其余锁永久泄漏", "failure_scenario": "workspace 锁 owner 被外部改动 → 首个 releaseOne 抛 OWNERSHIP_LOST → paper/generation 锁保持被存活 pid 持有，后续操作全部超时"},
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 133, "summary": "mkdir 后、owner.json 落盘前崩溃残留的锁目录在 1s 宽限期后永远抛 STORAGE_LOCK_CORRUPT，reclaimDeadOwner 不可达，无恢复路径", "failure_scenario": "prepare 被 kill -9 于 tryAcquireOne 中途 → 该锁键跨重启持续 422，需手工 rm -rf 锁目录"},
  {"file": "scripts/check-repository.mjs", "line": 548, "summary": "权限边界哨兵 grep 的标识符（writeLibraryIndex 等）在 prepare-paper.js 历史上从未出现（实际是 writeJsonAtomicNoFollow/writeIndexPreserveShape/fs.writeFileSync），守卫无效", "failure_scenario": "把被删除的正式存储发布代码原样恢复，CI 哨兵仍绿灯，本里程碑要防的回归静默入库"},
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 130, "summary": "listGenerationWorkspaces 对 workspaces-v1 下任何杂散条目（如 macOS .DS_Store）抛 403，连带 createGenerationWorkspace 使 prepare 全线失败", "failure_scenario": "用户用 Finder 打开该目录产生 .DS_Store → 此后所有 prepare 与 workspace-cli list 硬失败直至手工删除"},
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 303, "summary": "setWorkspaceTags/updateWorkspaceRecord 无 abandoned 门禁，abandoned workspace 仍可被改写甚至复活为可写", "failure_scenario": "workspace-cli abandon 后再 tags --tag x 成功改写 publishIntent；任何调用者传 {state:'authoring'} 可解除只读"},
  {"file": "plugins/codex-paper/src/shared/workspace-writer.mjs", "line": 43, "summary": "replaceWorkspaceFile/Json（render/build/scaffold 所用内部通道）不经 isAuthoringPath allowlist、写入后不降级 validated 状态", "failure_scenario": "validated workspace 重跑 render → 内容改写而状态仍 validated，未来发布门禁放行未复验内容；任意脚本可写 meta.json 等身份文件"},
  {"file": "plugins/codex-paper/skills/study/scripts/sandbox-code.js", "line": 354, "summary": "已发布 generation 的显式路径被 sandbox 误诊为 'Legacy flat-layout' 且永不发放 approval，同一论文按 slug 调用则正常", "failure_scenario": "prepare 返回 reused 的 paperDir 路径 → sandbox plan 报 nonconformant 且诊断指向不适用的 legacy 迁移，路径调用流程不可用"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 119, "summary": "ask 路由将跨进程 paper: 锁持有至外部 Codex 调用结束（最长 180s），仅 appendChatNote 需要锁", "failure_scenario": "用户在 viewer 提问期间，CLI 侧同一 paper 的 workspace 写入/校验以 10s 超时获取同键 → STORAGE_LOCK_TIMEOUT，作者化在聊天期间不可用"}
]
```

*本文件由 code review 流程生成；候选来源为 8 角度并行扫描，全部结论经独立验证或直接代码核实。*
