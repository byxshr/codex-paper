# P0-C2a Code Review 结论（第 3 轮）

- **审查日期**: 2026-07-22
- **审查范围**: 工作区未提交改动（`git diff HEAD`，42 个文件，+1076/-566）及全部新增文件（`storage-transaction.mjs` 521 行、`generation-workspace.mjs` 325 行、`workspace-writer.mjs` 92 行、`workspace-cli.js`、`codexWorker.ts` 等）——即第 2 轮 review 建议修复之后的当前状态
- **审查依据**: `docs/P0-C2A_CODE_REVIEW_FINDINGS.md`（第 1 轮）、`docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND2.md`（第 2 轮）与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（"First review disposition" + "Second review disposition"）；重点为 (a) 逐项复核第 2 轮已接受修复是否正确、完整，(b) 修复本身是否引入新缺陷，(c) 第 1/2 轮均标记但未修复的项是否已处理
- **方法**: 与前两轮相同的 8 角度并行扫描，产生约 22 条去重候选；按主题分组由 8 个独立验证批次逐条判定（其中 1 项经严谨反证判定为 REFUTED）

## 总体评估

第 2 轮的多数修复**方向正确且互相独立验证成立**：`setWorkspaceTags` 的函数式更新消除了 stale-merge 竞争；`transitionWorkspaceToAuthoringLocked` / `updateWorkspaceRecordLocked` 把降级与更新逻辑收敛到单一入口，`workspace-writer.mjs` 与 `generation-workspace.mjs` 两个通道现在共享同一函数；`acquireReclaimGuard` 用带own-token的守卫成功解决了第 2 轮 `.reclaim` 目录崩溃永久残留的问题；sandbox 报告目录已改用 `generationDirectoryName` 的 `gen-sha256-` 命名；`atomicRemoveFile` 与写路径共享 `WRITE_PRECONDITION_FAILED`；migrate-package 在直接子目录场景下确实改用 `legacy:<slug>` 锁。

但第 3 轮发现 **7 个可确认（CONFIRMED）的正确性缺陷**、**3 个可信（PLAUSIBLE）缺陷**，其中多数同样是修复本身的副作用：

- **最严重的是失败保全路径的"二次失败"未被处理**：第 2 轮修复让 workspace 创建失败时 CAS 更新已存在的 workspace.json 并重试 rename，但如果这次重试**也**失败，残留目录永久保持 `.init-` 前缀——不但不再被 60 分钟清理，反而因为已含 `workspace.json` 而被 `cleanupInitDirectories` **永久跳过**，彻底不可发现、不可回收。
- **同一根因的第二个后果**：`failed` 状态的 workspace 不算 abandoned，会被 `createGenerationWorkspace` 的去重检查当作"活跃"占用，导致对完全相同论文的任何后续重试都收到含糊的 `WORKSPACE_EXISTS 409`，且 CLI 只打印通用错误信息，不提示该去 abandon 哪个 workspace。
- **ask 的并发修复只堵住了同论文竞争，没堵住共享 worker 进程的失败连带**：`resetAfterFailure` 仍然在任一失败时 kill 唯一的共享 Codex 子进程并 reject 全局 `pendingRequests`——两个不同论文同时提问时，一个失败会把另一个正在进行的、原本会成功的请求也拒绝掉。队列键本身还用错了字段（`generationLockKey` 而非 `paperLockKey`），与处置记录里"per-paper"的表述不符。
- **migrate-package.js 的库根解析用了 `process.env.HOME` 而非 `os.homedir()`**——这与仓库里其余所有组件的默认解析方式不一致，在 `HOME` 未设置的环境（包括本仓库的实际开发主机 Windows）下会静默地让第 2 轮"迁移与 Web 删除互斥"的修复完全失效。
- **sandbox 的 abandoned workspace 按路径解析仍会抛未捕获异常**，绕过其余只读模式共享的结构化 `nonconformant` 响应，导致退出码与消息形态不一致，违反审查重点第 5 条"sandbox 行为保持可用"。
- **三个自第 1 轮起就被标记的死代码**（`generationReadOnly` 字段、`reconciled` 死分支、回收逻辑里的死 if/else）**连续第 3 轮未修复**；死 if/else 这次甚至被扩大了条件范围而不是被合并简化，说明该处代码在多轮迭代中始终未被真正读到。

一个候选在本轮被**严谨驳回**：怀疑的死锁回收 TOCTOU 竞争经证明不成立——`writeOwnerRecord` 最终落盘用的是文件级 rename（而非目录级），无论目录是否被并发换过，新持有者的 owner.json 写入总是最后生效；且本仓库实际开发主机 Windows 上 `renameSync` 对已存在目录会直接抛异常而非静默替换，回收路径设想的"静默覆盖"场景不成立。

结论：**边界目标仍然成立**，但建议在 C2a 合入前修复失败保全路径的二次失败与 ask 的跨论文失败连带（#1、#2、#3），并在合入前后分别验证 `migrate-package.js` 在实际部署环境（尤其 Windows/服务/计划任务）下的锁键是否真正与 Web 侧相交（#4）。

---

## 一、已确认的正确性缺陷（按严重程度排序）

### 1. workspace 创建失败保全的重试 rename 若再次失败，残留目录永久不可发现、不可回收 — CONFIRMED

`plugins/codex-paper/src/shared/generation-workspace.mjs:248`

第 2 轮修复让失败保全路径 CAS 更新已存在的 `workspace.json`（247 行）并在 `preservationDir === initDir` 时重试 `renameSync(initDir, finalDir)`（248 行）。但如果这次重试**也**失败（如 Windows 杀软/索引器持续持有句柄），异常被外层 `catch (caught) { preservationError = caught }`（251-253 行）吞掉附加到原始错误上后原样上抛，目录**永久**保持 `.init-<workspaceId>-<rand>` 命名：`listGenerationWorkspaces`（135 行）无条件跳过所有 `.init-` 前缀条目；`resolveGenerationWorkspace` 无论按 ID 还是按路径都要求 basename 匹配 `WORKSPACE_ID_PATTERN`，`.init-` 目录永远无法通过；`cleanupInitDirectories`（179 行）现在会跳过任何**已含 `workspace.json`** 的 `.init-` 目录，且不检查年龄——而失败保全恰恰就是在这个目录里写入了 `workspace.json`。三重防线叠加的结果不是"60 分钟后清理"，而是**永久不可发现、永久不可回收**的残留，且其中往往包含已完整 populate 的论文包内容。

**建议**: 重试 rename 失败时应有独立的告警/发现路径（如把失败信息也写进一个可被 `listGenerationWorkspaces` 之外的诊断命令发现的位置），或至少允许 `cleanupInitDirectories` 对含 `workspace.json` 的 `.init-` 目录也按年龄清理（但需先确认其内容已被上层记录）。

### 2. `failed` 状态的 workspace 被当作活跃占用，导致对同一论文的任何重试永久收到含糊的 409 — CONFIRMED

`plugins/codex-paper/src/shared/generation-workspace.mjs:199-201`；`prepare-paper.js:668-671`

`createGenerationWorkspace` 的去重检查（199-201 行）只排除 `abandoned` 状态，`failed` 仍算活跃并阻塞对同一 `generationId` 的新建。`generationId` 是内容的确定性哈希（`paper-identity.js:254`，排除 `createdAt`/随机值），因此对**完全相同**的论文+参数重试会得到相同的 `generationId`——即，populate 阶段任何瞬态失败（ENOSPC/EBUSY 等）被正确保全为 `failed` 记录后，用户直接重跑 prepare 会永远撞上 `WORKSPACE_EXISTS 409`。`prepare-paper.js` 的 CLI 处理（668-671 行）只打印通用的 `error.message`，从不透出 `error.details.workspaceId`，用户无法知道该去 `abandon` 哪个 workspace。（存在一个旁路：已知 workspace ID 时可用 `--resume-workspace <id>` 续作，但这不是"重试"路径，且要求用户已经知道该 ID。）

**建议**: 在错误信息中附上冲突 workspace 的 ID 与建议命令；或允许对 `failed` 状态的 workspace 直接重新 populate（而非要求先手工 abandon）。

### 3. ask 的跨论文失败连带未修复：任一论文失败会 kill 共享 Codex 进程并拒绝所有其他论文的在途请求 — CONFIRMED

`plugins/codex-paper/src/web/server/utils/codexWorker.ts:151-159,392-403`

第 2 轮加入的 `paperQueues` 只对**同一 slug**（见缺陷 #4，实际是同一 generationLockKey）的请求做 Promise 链式串行化。`askSerialized` 的 catch（193-196 行）仍调用 `resetAfterFailure()`，其 `stop()` 杀掉唯一共享的 `this.child` 进程并清空 `paperThreads`，`rejectAll()`（392-398 行）遍历**全局单一的** `pendingRequests` Map 并拒绝其中每一项——不区分 slug。两个不同论文并发提问（各自走独立的 `paperQueues` 队列，但共享同一子进程）时，若论文 A 的请求失败（MCP 错误、空回答等），A 的 `resetAfterFailure` 会把论文 B 正在进行中的、原本会成功的请求也一并拒绝。这正是第 2 轮缺陷 #3 的同类问题，只是攻击面从"同论文并发"收窄为"共享进程的任意论文"。

**建议**: 让 `resetAfterFailure` 只拒绝失败请求自身的 pending entry，不 kill 共享子进程；或改为按 slug 拆分独立子进程/连接。

### 4. ask 的"per-paper"队列实际按 generationLockKey 而非 paperLockKey 分组 — CONFIRMED

`plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts:120-121`

`askCodexWorker({ slug: descriptor.generationLockKey, ... })` 传入的是 `generationLockKey`（`generation:<paperKey>:<generationId>`），不是 `paperLockKey`（`paper:<paperKey>`）。第 2 轮处置记录声称"Ask serializes Codex calls per paper"，但实际是**按 generation** 分组：同一论文的两个不同 generation（如已发布的 generation 与一个活跃 workspace generation）之间的并发提问不会互相排队。由于缺陷 #3 的共享进程连带仍未修复，这个分组错误在实践中影响有限（两者反正都会被同一次 `resetAfterFailure` 拖累），但与文档表述不符，且一旦 #3 被修复，此处仍需一并修正为 `paperLockKey`。

**建议**: 改用 `descriptor.paperLockKey` 作为队列键。

### 5. migrate-package.js 的库根解析用 `process.env.HOME` 而非 `os.homedir()`，在 HOME 未设置的环境下静默让锁键修复失效 — CONFIRMED

`plugins/codex-paper/skills/study/scripts/migrate-package.js:16`

```js
const LIBRARY_ROOT = path.resolve(process.env.PAPERS_DIR || path.join(process.env.HOME || '', 'codex-papers'));
```

而 `paper-library.mjs` 的 `getLibraryLayout`（及其余所有组件——`generation-workspace.mjs`、`workspace-writer.mjs`、`librarySecurity.mjs`、`storage-transaction.mjs` 等）一致使用 `os.homedir()`。Node 的 `os.homedir()` 在 Windows 上解析 `USERPROFILE`（或 `HOMEDRIVE`+`HOMEPATH`），**不读取 `HOME`**；而本文件直接读 `process.env.HOME`。在 `HOME` 未设置但 `USERPROFILE` 已设置的环境——包括**本仓库自己的开发主机（win32）**，以及任何服务/计划任务/CI 上下文——`LIBRARY_ROOT` 会坍缩为 `path.resolve('codex-papers')`（相对 CWD），与其余组件解析出的真实库根完全不同。`scripts/codex-paper.sh` 的 `cmd_migrate` 也没有可靠地为其注入 `PAPERS_DIR`。后果：`migrationLockKey` 的 `path.relative(PAPERS_ROOT, canonicalPaperDir)` 相对于错误的 `PAPERS_ROOT` 恒为 `..` 开头，`isDirectLegacyPackage` 恒为 false，锁键退化为不与任何其他组件相交的 `legacy:migration:<hash>`——**静默地让第 2 轮修复的迁移/Web删除互斥失效**，复现第 2 轮缺陷 #8。

**建议**: 改为 `os.homedir()`，与仓库其余部分保持一致。

### 6. sandbox 对 abandoned workspace 按路径解析仍抛未捕获异常，绕过结构化只读响应 — CONFIRMED

`plugins/codex-paper/src/shared/paper-library.mjs:351`；`sandbox-code.js` `resolvePaperDir`/`buildExecutionPlan`

`resolvePaperDir`（sandbox-code.js）只调用 `resolveExplicitPackage`（按路径解析），从不调用 `resolveGenerationWorkspace`（按 ID 解析）。`resolveExplicitPackage` 对 abandoned workspace 路径直接抛 `WORKSPACE_ABANDONED`（`paper-library.mjs:351`），而 `resolveGenerationWorkspace` 对 abandoned 从不抛出，只返回 `readOnly:true` 的描述符（`generation-workspace.mjs:108`）。`resolvePaperDir` 把该异常重新包装成通用 `SandboxError`（默认 `exitCode=EXIT.POLICY(2)`，只透传 `error.message`），在 `buildExecutionPlan` 内部无 try/catch 的情况下继续上抛，**在到达其余只读模式（`legacy_flat`、`managed_generation_v1`）共用的、产生结构化 `{capability:{status:'nonconformant',reason}}` JSON 响应的逻辑之前就终止**。最终只被顶层 `main().catch` 捕获，打印纯文本 stderr 且退出码为 2（其余只读模式走正常 `plan` 输出，退出码为 3）。这直接违反审查重点第 5 条"overlay/trash/sandbox 行为保持可用"——对 abandoned workspace 的只读访问，行为与消息形态都与其余只读模式不一致。

**建议**: `resolvePaperDir` 捕获 `WORKSPACE_ABANDONED` 并转换为与其余只读模式一致的 nonconformant 描述符，而不是任其穿透为异常。

### 7. 三项自第 1 轮起被标记的死代码，连续第 3 轮未修复（其中一项被扩大而非简化）— CONFIRMED

| 位置 | 状态 |
|---|---|
| `paper-library.mjs:272,354,398` `generationReadOnly` 字段 | 三处写、零处读，第 1、2、3 轮均标记，未删除 |
| `prepare-paper.js:482` `preparation.action === 'reconciled'` | `resolvePreparationAction` 只返回 `'workspace'`/`'reused'`，`'reconciled'` 永远不是返回值，第 1、2、3 轮均标记，未删除 |
| `storage-transaction.mjs:206-209` `reclaimDeadOwner` 内 `readOwnerRecord` 的 catch | `if (code==='ENOENT' \|\| code==='STORAGE_LOCK_INITIALIZING') return false; return false`——两分支同值，第 2 轮标记为死代码建议合并为 `catch { return false }`；第 3 轮实际把条件从仅 ENOENT **扩大**到 ENOENT/INITIALIZING，死代码范围变大而非消失 |

**建议**: 三处均为纯删除/化简操作，风险极低，建议本轮一并处理，避免第 4 轮重复标记。

## 二、可信（PLAUSIBLE）的正确性问题

### 8. ask 追加锁的 3 秒超时仍可被合法的多文件作者化写入耗尽 — PLAUSIBLE

`ask.post.ts:144-152`；`render-from-analysis.js:511-538`

`withWorkspaceMutationSync` 持有 `paperLockKey` 期间，`render-from-analysis.js` 顺序执行 4 次 `replaceWorkspaceFile`（README.md、quick-summary.md、summary.md、insights.md），每次 `atomicWriteFile` 内部 2 次 `fsyncSync`（文件 + 目录），一次 render 通道下持锁期间共 8 次同步 fsync。在较慢磁盘（网络卷、被限流的云盘、被杀软扫描的 Windows 文件系统）上，8 次顺序 fsync 超过 3 秒是合理场景，并非病态输入。第 2 轮修复缩小了窗口但未消除；`ask.post.ts` 的 catch（160-166 行）在冲突时仍直接上抛，不做答案保留。

**建议**: 若追加锁超时，把已生成的答案随错误一起返回（客户端可提示"已生成但未保存"），而非直接丢弃。

### 9. check-repository.mjs 的 prepare 守卫正则仍窄于同文件内的 authoring-boundary 守卫 — PLAUSIBLE（范围小于最初怀疑）

`scripts/check-repository.mjs:548` vs `:577`

第 548 行 PREPARE_SCRIPT 守卫：`/writeLibraryIndex|writeCurrentRecord|writePaperRecord|writeJsonAtomicNoFollow|writeIndexPreserveShape|\bwriteFileSync\b|['"](?:index|current|paper)\.json['"]/`；第 577 行 authoring-boundary 守卫：`/writeFileSync|writeFile\(/`——后者额外能匹配异步 `fs.writeFile(...)`/`fs.promises.writeFile(...)` 调用形式，前者没有对应分支。但验证发现前者已有字面量文件名分支（`['"](?:index|current|paper)\.json['"]`），能拦住 `writeFile(path.join(libraryRoot, 'index.json'), data)` 这类最直接的规避写法——真正能绕过的场景需要**同时**避开字面量文件名（如拼接构造），更为刁钻。`prepare-paper.js` 当前不含任何 `writeFile`/`writeFileSync` 调用，纯属假设性缺口；且 mandatory fixture 的 `unpublishedBeforeC2b` 断言检查执行后的实际磁盘状态，与写入所用的 API 形式无关，构成独立于静态守卫的行为级防线。

**建议**: 为 PREPARE_SCRIPT 守卫补上 `writeFile\(` 分支，使其与 authoring-boundary 守卫对称，成本很低。

### 10. migrate-package.js 的锁键对嵌套路径仍回退到不相交的键 — PLAUSIBLE（仅非常规调用可达）

`migrate-package.js:107`

`isDirectLegacyPackage` 要求 `canonicalPaperDir` 恰好比 `PAPERS_ROOT` 深一级；更深层路径回退到 `legacy:migration:<hash>`。追踪 `resolvePaperDir` 的可达输出：按 slug 解析（经 `resolveLibraryPaper`/`descriptorForLegacy`）受 `ROUTE_PATTERN`（不含路径分隔符）约束，只能产生一级 `papers/<slug>`；按路径解析时，输入包根目录同样落在一级；只有当用户显式传入包内**更深层**的子目录/文件路径（而非包根或 slug）时才会触发嵌套回退——这不属于文档化的 `<paper-dir-or-slug>` 标准用法，但 `resolvePaperDir` 并未阻止这种输入，也不需要 `--external-path`。

**建议**: 对嵌套输入路径先归一化到包根（如向上查找最近的合法包目录），再计算锁键。

## 三、被驳回的候选（记录备查）

- **`reclaimDeadOwner` 恢复路径的 TOCTOU 可能用死锁目录覆盖新持有者的空锁目录** — REFUTED：`writeOwnerRecord` 最终落盘用的是**文件级** `renameSync(temporary, target)`（`target = path.join(lockDir, 'owner.json')`），无论 `lockDir` 是否被并发换过，新持有者自己的 `writeOwnerRecord` 调用最终总会把 `owner.json` 写成自己的记录，不会因目录被恢复而丢失或与死持有者数据混淆。此外触达该分支要求 `moved !== owner`，而紧邻的 210 行刚复核过 `current === owner`；且本仓库实际开发主机为 Windows，`renameSync` 对已存在目录（无论空否）直接抛异常而非静默替换，恢复分支的 `catch {}` 会吞掉该异常而非执行设想中的"静默覆盖"。

## 四、复用/重复（第 2 轮修复引入或加剧的项，代码质量）

| 项 | 位置 | 说明 |
|---|---|---|
| CAS 前置条件计算 ×2 | `generation-workspace.mjs:240-246` vs `workspace-writer.mjs:51-61`（`preconditionFor`） | 逻辑重复；分歧点（`STORAGE_DIRECTORY_MISSING`/404 分支）经验证是死代码——`readFileNoFollowBounded` 在此调用链中从不抛出该错误码，故当前非活跃缺陷，但仍是维护负担 |
| 死锁回收的"重命名-复核-恢复或删除"算法 ×3 | `storage-transaction.mjs` `acquireReclaimGuard`（159-197）与 `reclaimDeadOwner`（199-228，其中该模式自身又内部重复一次） | 第 2 轮为修复 `.reclaim` 守卫崩溃残留新增的代码，把同一 token 校验+ rename-恢复模式手写了三份；未来对其中一份的修正（如 TOCTOU 加固）不会自动应用到另外两份 |
| 路由 slug 冲突判定谓词 ×2 | `prepare-paper.js:311`（`allocateRouteSlug`）vs `generation-workspace.mjs:199-202`（`createGenerationWorkspace` 锁内复核） | 两处独立表达"什么算冲突的活跃 workspace"；当前字段与逻辑完全一致（均为 `state !== 'abandoned'` + paperKey 不同），非活跃缺陷，但未来排除规则变化时两处必须同步修改 |
| sandbox 描述符模式枚举独立维护 | `sandbox-code.js:604`（`reportPolicyForDescriptor`） | 硬编码 `'generation_workspace_v1'`/`'managed_v1'`/`'managed_generation_v1'` 字符串，与 `paper-library.mjs`/`generation-workspace.mjs` 里实际定义模式值的位置无共享常量或交叉校验；未识别的新模式会 fail-closed（返回 null → nonconformant），非安全缺陷，但 C2b 新增模式时容易漏配 |
| abandoned 终态错误 ×4 | `workspace-writer.mjs:21-26`、`generation-workspace.mjs:263/302`、`paper-library.mjs:351` | 第 2 轮统一了错误码（均为 `WORKSPACE_ABANDONED`/409），但仍是 4 处独立类型（`Error`/`GenerationWorkspaceError`/`LibraryLayoutError`）与独立文案，无共享断言函数；缺陷 #6 正是这 4 份副本行为不一致的直接后果 |

## 五、效率（第 2 轮修复引入的新增开销）

1. **prepare 现在对 workspace 注册表做两次 O(N) 全量扫描**：`prepare-paper.js:332`（第 3 轮为修复第 2 轮缺陷 #9 新增的锁外预扫描，喂给 `allocateRouteSlug`）与 `generation-workspace.mjs:199`（`createGenerationWorkspace` 锁内复核扫描）各自完整读取+解析+校验注册表内每个 `workspace.json`。对于最终落到 `'workspace'`（新建）分支的 prepare 调用，这是真实的 2×N 读取；对于 `'reused'`/`'reconciled'` 分支，锁外扫描的结果被完全丢弃（`createGenerationWorkspace` 从不调用）。
2. **sandbox 报告写入对 overlay 目录做无条件 `ensureStorageDirectory`**（`sandbox-code.js:664`）：即使该目录已在之前的执行中创建过，仍每次执行 2 次 `lstat`+`realpath`、一次 `mkdirSync`（EEXIST 被吞但系统调用照常发生）与一次对父目录描述符的无条件 `fsync`。同一 generation 上的多次沙箱执行会重复付出这份磁盘落盘成本，缺少 `existsSync` 快速路径。

## 六、第 2 轮已接受修复逐项复核

| 第 2 轮修复 | 第 3 轮结论 |
|---|---|
| workspace 初始化失败 CAS 更新已存在 workspace.json + 重试 rename + 不再按年龄删除含记录的残留 | **首次失败路径成立**；但重试 rename **再次**失败时残留永久不可发现（#1），且 `failed` 状态被去重检查当作活跃占用阻塞重试（#2） |
| ask 按论文在进程内串行化 Codex 调用 + 3 秒等待追加锁 | **同 slug 串行化机制本身成立**；但队列键实为 generationLockKey 非 paperLockKey（#4），且跨 slug 的共享进程失败连带完全未处理（#3）；3 秒仍可被合法长写入耗尽（#8，PLAUSIBLE） |
| 回收 claim 拥有自己的 owner token，可恢复死亡的同主机回收 owner；初始化/复核竞争可重试；恢复失败的所有者复核改为 fail-closed 恢复而非泄漏或删除 | **核心机制成立**（TOCTOU 猜想被驳回，见三节）；但恢复算法在两个独立函数间手写三份重复（复用表） |
| sandbox 报告存储改为按描述符模式显式选择策略；不支持的 explicit_path 不发放 approval；managed overlay 经共享加锁存储边界创建；generation 报告目录复用可移植的 `gen-sha256-*` 命名 | **explicit_path 与 overlay 创建的核心修复成立**；但 abandoned workspace 按路径解析仍抛穿透异常，绕过该策略统一提供的结构化响应（#6） |
| legacy 迁移在完整迁移期间持有与 Viewer 生命周期操作相同的 `legacy:<slug>` 锁；保留既有 reasoning review 除非显式 `--force` | **直接子目录场景下机制成立**；但库根解析用 `process.env.HOME` 而非 `os.homedir()`，在 HOME 未设置环境下静默退化为不相交的键（#5，含本仓库实际开发主机）；嵌套路径输入下同样回退（#10，PLAUSIBLE，仅非常规调用可达） |
| 活跃、非 abandoned 的 workspace 参与路由分配；workspace 创建在持有注册表锁期间复核路由预留 | **机制成立**（未发现新的冲突场景）；但分配器与锁内复核用两份独立谓词表达同一排除规则（复用表），当前一致、无活跃缺陷 |
| workspace 记录变更现在在获取锁后才评估函数式更新；状态降级集中化；abandoned 的 ID/路径错误一致；`~` 展开统一用 `os.homedir()`；写/删除 CAS 冲突共享 `WRITE_PRECONDITION_FAILED` | **函数式更新本身成立**（`setWorkspaceTags` stale-merge 问题已消除）；"abandoned 错误一致"仅在错误码层面成立，消息与异常类型仍是 4 份独立副本（复用表）；`~` 展开在 `generation-workspace.mjs`/`workspace-writer.mjs` 内部已统一，但 `migrate-package.js` 是另一个未纳入这次统一的独立文件，其根路径解析问题（#5）是同一类"环境变量而非 os.homedir()"错误的第三次出现 |
| Repository Guard 拒绝具名 writeFileSync 导入、正式记录/索引文件名字面量、迁移锁漂移、既有 review 守卫被移除 | **基本成立**；PREPARE_SCRIPT 守卫仍窄于同文件内 authoring-boundary 守卫的异步写入分支，但字面量文件名分支已能拦住大多数直接规避（#9，PLAUSIBLE，范围小于最初怀疑） |

## 七、审查重点逐项结论（第 3 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立**（fixture 行为断言完整）；静态哨兵在 prepare-paper.js 内部存在与同文件内其他守卫不对称的窄口（#9，影响范围有限） |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **首次失败保全成立，但二次失败的保全本身会永久失败且不可发现**（#1）；`failed` 状态阻塞同一论文的合法重试（#2） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **成立**（本轮怀疑的新 TOCTOU 竞争被驳回）；回收算法本身在两处独立重复（复用表，非正确性问题） |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **成立**；migrate-package 在直接子目录场景下与 Web 侧共享锁（成立），但库根解析错误可在 HOME 未设置环境下使该保证整体失效（#5） |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **写保护成立**；abandoned workspace 按路径的 sandbox 只读访问仍不可用/行为不一致（#6） |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立**，且继续为 #9 的静态哨兵缺口提供独立的行为级保障 |

---

## 附录：Top-10 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 248, "summary": "workspace 创建失败保全的重试 rename 若再次失败，残留目录永久保持 .init- 前缀，被 listGenerationWorkspaces/resolveGenerationWorkspace/cleanupInitDirectories 三重跳过，永久不可发现不可回收", "failure_scenario": "populate 与 workspace.json CAS 写入成功后 renameSync(initDir, finalDir) 失败，重试同样失败（如 Windows 杀软持续持锁句柄）→ 残留目录改名为 .init-ws-...，从此对所有调用者不可见，cleanupInitDirectories 因其已含 workspace.json 而永远跳过，不再按年龄清理"},
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 199, "summary": "failed 状态的 workspace 未被排除在活跃占用检查之外，导致对同一论文的任何后续重试永久收到含糊的 WORKSPACE_EXISTS 409", "failure_scenario": "prepare 论文 X 因瞬态 ENOSPC 失败并被正确保全为 failed 记录；磁盘恢复后重跑相同 prepare X（generationId 因内容确定性哈希而相同）→ createGenerationWorkspace 的去重检查把 failed workspace 当作活跃占用抛 409，CLI 只打印通用错误信息，不提示需要 abandon 哪个 workspace"},
  {"file": "plugins/codex-paper/src/web/server/utils/codexWorker.ts", "line": 392, "summary": "resetAfterFailure 仍然在任一论文的 ask 失败时 kill 唯一共享的 Codex 子进程并 reject 全局 pendingRequests，第2轮的按论文串行化未覆盖这一跨论文连带", "failure_scenario": "论文 A、B 同时提问（各自独立的 paperQueues 队列但共享同一子进程）；A 的请求因 MCP 错误失败 → resetAfterFailure 杀掉共享子进程并 rejectAll 全局 pendingRequests → B 正在进行中、原本会成功的请求也被拒绝，B 收到与自己请求无关的失败信息"},
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 16, "summary": "LIBRARY_ROOT 用 process.env.HOME 而非 os.homedir() 解析，与仓库其余所有组件的默认根路径解析方式不一致，在 HOME 未设置的环境（含本仓库开发主机 Windows）下静默让第2轮的迁移锁键修复失效", "failure_scenario": "HOME 未设置、PAPERS_DIR 未显式传入时，LIBRARY_ROOT 坍缩为 CWD 相对路径，与 paper-library.mjs 用 os.homedir() 解析出的真实库根不同 → migrationLockKey 的 path.relative 恒为 .. 开头 → isDirectLegacyPackage 恒 false → 锁键退化为不与 Web 删除/trash 相交的 legacy:migration:<hash>，复现第2轮缺陷#8"},
  {"file": "plugins/codex-paper/src/shared/paper-library.mjs", "line": 351, "summary": "sandbox 对 abandoned workspace 按路径解析仍抛未捕获的 WORKSPACE_ABANDONED 异常，绕过其余只读模式共享的结构化 nonconformant 响应，退出码与消息形态不一致", "failure_scenario": "sandbox-code.js plan 指向一个 abandoned workspace 的包路径 → resolvePaperDir 经 resolveExplicitPackage 抛异常，在 buildExecutionPlan 的 capability 判定逻辑之前终止 → 只被顶层 main().catch 捕获为纯文本 stderr，退出码为2；而 legacy_flat/managed_generation_v1 等其余只读模式走正常 JSON plan 输出，退出码为3"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 121, "summary": "ask 的\"按论文\"串行化队列实际以 generationLockKey 而非 paperLockKey 为键，与处置记录中 per-paper 的表述不符，同一论文不同 generation 的并发提问不互相排队", "failure_scenario": "论文 P 同时有已发布 generation G1 与活跃 workspace generation G2；对 G1、G2 并发提问因队列键不同而不被串行化，直接并发调用共享 codexWorker，叠加缺陷#3的连带效应"},
  {"file": "plugins/codex-paper/src/shared/storage-transaction.mjs", "line": 206, "summary": "reclaimDeadOwner 内的死 if/else（两分支同返回 false）自第2轮起被标记建议合并，第3轮反而扩大了判断条件范围而非简化", "failure_scenario": "读者看到 if (ENOENT || INITIALIZING) return false 会误以为其余错误（如权限错误）会向上传播触发响应处理，实际所有 readOwnerRecord 失败都被同等吞掉；连续3轮审查在此重复消耗复核成本"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 152, "summary": "追加聊天笔记的锁超时从0提升到3秒后仍可被合法的多文件作者化写入（如 render-from-analysis 顺序写4个文件、8次同步fsync）耗尽，已算完的 Codex 答案在冲突时仍被直接丢弃", "failure_scenario": "较慢磁盘（网络卷/被限流云盘/被杀软扫描的 Windows 文件系统）上一次 render 通道的8次顺序 fsync 超过3秒即可触发；ask.post.ts 的 catch 直接上抛冲突错误，不做答案保留"},
  {"file": "scripts/check-repository.mjs", "line": 548, "summary": "PREPARE_SCRIPT 守卫正则仍缺少同文件内 authoring-boundary 守卫已有的异步 writeFile( 分支，但已有的字面量文件名分支能拦住大多数直接规避", "failure_scenario": "prepare-paper.js 若新增拼接构造文件名（避开字面量 'index.json' 等）的异步 fs.promises.writeFile 调用可静态逃逸该守卫，但 mandatory fixture 的行为级断言仍会捕获任何实际发生的正式存储写入，构成独立防线"},
  {"file": "plugins/codex-paper/skills/study/scripts/migrate-package.js", "line": 107, "summary": "migrationLockKey 只对 PAPERS_ROOT 的直接一级子目录使用共享锁键，嵌套输入路径回退到不与其他组件相交的键，仅在非常规的显式子路径调用下可达", "failure_scenario": "用户显式传入包内更深层子目录/文件路径（而非包根或 slug，非文档化用法）触发嵌套回退，锁键退化为 legacy:migration:<hash>，与并发 Web 删除不再互斥"}
]
```

*本文件由第 3 轮 code review 流程生成；候选来源为 8 角度并行扫描（约 22 条去重候选），全部结论经按主题分组的独立验证批次逐条判定（7 项 CONFIRMED、3 项 PLAUSIBLE、1 项 REFUTED）或直接代码核实。*
