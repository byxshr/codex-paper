# P0-C2a Code Review 结论（第 5 轮）

- **审查日期**: 2026-07-22
- **审查范围**: 工作区未提交改动（`git diff HEAD`，45 个文件，+1367/-641）及全部新增文件（`storage-transaction.mjs`、`generation-workspace.mjs`、`workspace-writer.mjs`、`workspace-cli.js`、**新增 `askLeases.mjs`** 等）——即第 4 轮 review 建议修复之后的当前状态
- **审查依据**: 前四轮结论文档与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（"First/Second/Third/Fourth review disposition"）；重点为 (a) 逐项复核第 4 轮已接受修复（含最严重的 `migrate-package.js` 边界绕过、ask 答案保全、workspace 崩溃残留分类、validator 单锁化、Repository Guard 双脚本要求）是否正确、完整，(b) 修复本身是否引入新缺陷
- **方法**: 与前四轮相同的 8 角度并行扫描，产生约 15 条去重候选；按主题分组由 5 个独立验证批次逐条判定

## 总体评估

**这一轮呈现出明显的收敛趋势**：第 4 轮的修复总体上经得起检验。其中一个查找角度对 `askLeases.mjs` 调用方、`migrate-package.js` 的 descriptor.mode 穷尽性、validator 单锁事务、Repository Guard 双脚本要求、共享锁键/CAS 前置条件消费、`delete.delete.ts` 校验顺序这 6 个专项做了详尽的跨文件追踪，**未发现任何新的正确性缺陷**——第 4 轮最严重的 `migrate-package.js` 边界绕过（可复现的、直接写入活跃 workspace 的问题）已经通过改为调用共享的 `resolveExplicitPackage`/`resolveLibraryPaper` 描述符彻底关闭，且能穷尽处理所有 `descriptor.mode` 取值；ask 的答案保全逻辑已经从"错误码白名单"改为"用闭包捕获 `completedNote`"，能覆盖任意失败原因（包括锁释放阶段才抛出的 `OWNERSHIP_LOST`）；`.init-*` 崩溃残留现在被正确分类为只读、非活跃、不可 resume，且不阻塞新的 prepare 重试；validator 的三步状态转换已经收敛到单次加锁；Repository Guard 现在同时要求 `prepare-paper.js` 与 `migrate-package.js` 导入共享解析器，并有配套的 mutation test。

本轮确认了 **2 个正确性缺陷**（均为中等严重度，非阻塞性）：

- **ask 的一次失败的 `codex-reply` 会永久破坏该论文的后续提问**：第 4 轮为了不再让单次请求失败牵连所有论文而删除了 `resetAfterFailure()`，但删除时没有同步补上"清除这一个论文损坏的 threadId"的逻辑——现在任何 `codex-reply` 失败都不会清理 `paperThreads` 里的缓存，导致该论文后续每次提问都对着同一个已失效的 threadId 重试，持续失败，直到整个 worker 进程因无关原因重启（这会清空所有论文的线程，代价过大）。
- **validator 的单锁化修复没有失败补偿**：`persistWorkspaceValidationReport` 把"置 validating → 写报告 → 置最终状态"收进了同一次加锁，修复了第 4 轮发现的跨锁竞争，但如果写报告这一步本身失败（超限、磁盘错误），第三步不会执行，workspace 停留在 `validating` 状态且无诊断信息——不过验证发现这个状态可以被后续的正常 authoring 写入或重新运行验证自动修复，不是不可逆的卡死，严重度中等。

其余候选大多是代码质量/效率类的既有模式在本轮新代码里重演：`librarySecurity.mjs` 的 `writeFileAtomic`（承载 `index.json`/overlay/trash 三类核心写入）仍未使用本轮刚整合出的共享 `fileWritePrecondition`，是第 4 个独立手写的 CAS 前置条件实现；`workspace-cli.js` 与 `prepare-paper.js` 的错误码退出映射"对齐"是靠复制粘贴而非共享函数实现的；Repository Guard 新增的"必须共享解析器"规则覆盖 9 个消费脚本，但配套的 mutation test 只验证了其中 2 个；`acquirePaperAskLease`（一次纯内存 Map 操作）被包在一次真正的跨进程文件锁获取里，给每次 ask 请求都增加了两次同步 fsync 的开销。两个候选被驳回：删除确认令牌 120 秒 TTL 短于 ask 最长 180 秒的担心不成立（前端每次删除请求都会重新获取令牌）；`resolveExplicitPackage` 与 `generation-workspace.mjs` 的 `descriptor()` 各自独立实现同一份 workspace 描述符字段集，经比对是完全等价的重复代码，不产生行为分歧。

结论：**边界目标本轮继续成立，且未发现新的边界绕过**。建议修复上述两个正确性问题（ask 线程失效、validator 补偿缺失），其余代码质量与效率类观察可与此前几轮的既定同类项一并处理。

---

## 一、已确认的正确性缺陷

### 1. `codex-reply` 失败后缓存的 threadId 从未被清理，导致该论文后续提问永久失败 — CONFIRMED

`plugins/codex-paper/src/web/server/utils/codexWorker.ts:164`

第 4 轮删除了 `resetAfterFailure()`（原本任一请求失败就杀掉共享子进程并清空所有论文的 `paperThreads`，修复了"一个论文失败连累所有论文"的问题），但删除时没有引入替代的、按论文粒度清理失效线程的逻辑。`askSerialized` 里对 `callTool('codex-reply', {threadId: existingThreadId, ...})` 的调用没有任何 try/catch：若 MCP 服务端认为该 threadId 已失效或调用超时而抛出异常，异常直接沿 Promise 链上抛，`this.paperThreads.set(...)` 永远不会执行——即损坏的 `existingThreadId` 继续留在 `paperThreads` 里。全仓库现在只有 `stop()` 与子进程 `close` 事件会清空 `paperThreads`，且都是清空**全部**论文的映射，不是按论文清理。结果：该论文后续每一次提问都复用同一个已损坏的 threadId、重复相同的失败，直到整个 worker 进程因无关原因重启。

**建议**: 在 `codex-reply` 调用失败时删除该 slug 在 `paperThreads` 里的条目（而非杀掉整个子进程），让下一次提问自动退回到新建 `codex` 会话。

### 2. validator 单锁化修复缺少失败补偿，报告写入失败会让 workspace 卡在 validating（可自愈）— CONFIRMED（中等严重度）

`plugins/codex-paper/skills/study/scripts/validation-report.js:264-276`（`persistWorkspaceValidationReport`）

第 4 轮把"置 `validating` → 写报告 → 置最终状态"三步收进同一次 `withWorkspaceMutationSync` 加锁，修复了跨锁窗口的竞争问题。但函数内没有任何 try/catch：若写报告这一步（`replaceWorkspaceJson` → `atomicWriteJson` → `atomicWriteFile`）因 `STORAGE_FILE_TOO_LARGE` 或真实磁盘 I/O 错误（ENOSPC/EACCES/EIO）失败，第三步（置最终状态）不会执行，`workspace.json` 停留在 `state:'validating'`、`lastSuccessfulStep:'validation_started'`，且不带任何诊断信息。验证确认：`WORKSPACE_TRANSITIONS.validating` 允许 `validating→authoring`，任何后续的普通 authoring 写入（未设置 `preserveValidationState`）会经 `transitionWorkspaceToAuthoringLocked` 自动把状态修复回 `authoring`；重新运行一次验证也因为 `validating→validating` 合法而能成功——不是不可逆卡死，但期间没有留下任何失败诊断。

**建议**: 在写报告步骤外包一层 try/catch，失败时把状态改写为 `failed` 并记录诊断（复用 `createGenerationWorkspace` 失败保全路径的模式）。

## 二、被驳回的候选（记录备查）

- **删除确认令牌 120 秒 TTL 短于 ask 最长 180 秒，可能让"ask 结束后重试删除"的约定失效** — REFUTED：前端 `usePapers.ts` 的 `removePaper()` 在每次调用 `DELETE` 之前都会先调用 `POST /delete/prepare` 重新获取一枚全新的确认令牌，从不复用旧令牌；用户手动重试删除时天然会拿到新令牌，TTL 与 ask 最长时长的数值关系不构成实际约定失效。
- **`resolveExplicitPackage` 与 `generation-workspace.mjs` 的 `descriptor()` 独立实现同一份 workspace 描述符字段集，可能产生行为分歧** — REFUTED（作为行为缺陷）：逐字段比对确认两者对 `initializationResidue`（均基于目录名 `.init-` 前缀判定）与 `readOnly`（均为 `state==='abandoned' || initializationResidue`）的计算完全等价，同一个 `.init-*` 残留经两条路径解析得到的对象在这些字段上一致。作为纯重复代码（非行为缺陷）保留在下节记录。

## 三、复用/重复（代码质量，本轮延续的既有模式）

| 项 | 位置 | 说明 |
|---|---|---|
| `writeFileAtomic` 是第 4 个独立手写的 CAS 前置条件实现，承载核心库写入 | `librarySecurity.mjs:256-262` vs 本轮新整合的 `storage-transaction.mjs` 导出函数 `fileWritePrecondition` | 两者逻辑完全等价却各自独立实现；`writeFileAtomic` backs `writeLibraryIndex`（index.json）、overlay `state.json`、以及经 `trashManager.mjs` 的 trash 墓碑写入与恢复——即库内几乎所有核心 CAS 写入路径都在用这份未纳入本轮整合的重复逻辑 |
| `workspace-cli.js` 与 `prepare-paper.js` 的错误码退出映射靠复制粘贴对齐，非共享函数 | `workspace-cli.js:101-103` vs `prepare-paper.js:676-678` | 两处退出码判定表达式逐字节相同但各自独立书写；未来任一处修改退出码规则都不会自动同步到另一处，重演第 4 轮已标记过的同类漂移风险 |
| `resolveExplicitPackage` 内联重写 workspace 描述符字段集，与 `generation-workspace.mjs` 的 `descriptor()` 重复 | `paper-library.mjs:361-372` vs `generation-workspace.mjs:137-162` | 已验证当前行为完全等价（见二节），纯属未共享的重复代码 |
| `migrate-package.js` 的 legacy 锁键回退模板 | `migrate-package.js:82`（`descriptor.paperLockKey \|\| \`legacy:${legacyRelative}\`\`） | 与 `legacyStorageLockKey` 格式一致但独立书写；**注意**：经核实这不是意外遗留——`scripts/check-repository.mjs:762` 的架构守卫要求该字面量字符串必须保留在文件中，是刻意的纵深防御而非遗漏，优先级应降低 |
| `writeValidationReportAtomic` 生产环境零调用方 | `validation-report.js:257` | 经核实这是刻意设计：`check-repository.mjs:752` 的守卫明确禁止 validator 脚本调用它，强制其只能通过 `persistWorkspaceValidationReport` 完成原子事务；函数仍被导出、仍被测试直接调用，属于按设计保留的"防触发"函数，非维护疏漏 |
| `migrate-package.js` 两个分支各自计算一次 `fs.realpathSync(descriptor.packageDir)` | `migrate-package.js:76,90` | 可在两个分支前统一计算一次，代价是被拒绝的 managed/workspace 路径会多付出一次可忽略的 realpath 调用 |

## 四、效率

1. **`acquirePaperAskLease`（纯内存 Map 操作）被包在一次真正的跨进程文件锁获取里**（`ask.post.ts:122-126`，`withOperationLocks(..., {timeoutMs:0})`）：即使完全无竞争，`tryAcquireOne`/`writeOwnerRecord` 仍会执行真实的 `mkdirSync` + 临时文件写入 + **两次同步 `fsync`**（文件一次、目录一次）+ rename，只为了保护一个 Node 单线程下本就原子的 `Map.set`。给每一次 ask 请求的开头都增加了不必要的磁盘 I/O 延迟，且在任何锁冲突（如并发 migrate/delete 持有同一把 `paperLockKey`）下会让 ask 请求本身超时失败——这是一个此前从不接触磁盘的操作。

**建议**: 用一个不依赖跨进程锁的机制注册租约（Node 单线程下 `Map.set`/`Map.delete` 本身线程安全，无需额外加锁），仅在需要跨进程可见性时才引入锁。

## 五、第 4 轮已接受修复逐项复核

| 第 4 轮修复 | 第 5 轮结论 |
|---|---|
| 迁移工具改为通过共享 library descriptor 解析，拒绝托管 workspace/已发布 generation，独立于 `--external-path` 拒绝符号链接与嵌套库内输入，锁键来自同一个用于边界判定的规范化描述符 | **完整成立**（专项跨文件追踪未发现新缺口；`descriptor.mode` 的 5 种取值均有穷尽、安全的分支处理） |
| ask 生成答案后，任何聊天记录持久化或释放锁失败都会返回该答案并附带有界的保存诊断；引用计数的进程内 paper 租约让 Web 删除在 ask 进行中返回可重试的冲突，而不必在外部调用期间持有跨进程锁 | **答案保全与删除协调机制均成立**；但 ask 层面暴露了一个新问题：单次 `codex-reply` 失败会永久损坏该论文的线程缓存（缺陷 #1），且租约注册本身产生了不必要的跨进程锁开销（四节） |
| 含合法 workspace 记录的 `.init-*` 目录被归类为初始化崩溃残留：精确 inspect/abandon 仍可用，但只读、非活跃、不可 resume，且不阻塞新的 prepare 重试 | **成立**（本轮未发现新问题） |
| Reasoning 与完整包 validator 现在把"validating → 报告替换 → 最终状态"收进同一把 workspace 锁；Repository Guard 阻止两个 CLI 退回拆分的状态/报告写入 | **单锁化本身成立**；但缺少失败补偿，报告写入失败会让状态卡在 validating（缺陷 #2，可自愈） |
| prepare 与迁移都被 Repository Guard 要求保留共享的 paper-library 解析器，并为此前缺失的哨兵补充了 mutation test | **对 prepare/migrate 两个脚本成立**；但该 Guard 规则实际覆盖 9 个消费脚本（另加 3 个 workspace-writer 消费脚本），mutation test 只验证了其中 2 个，其余 7 个若被静默弱化不会被测试捕获——与第 4 轮修复的正是同一类"静默弱化无测试覆盖"风险，只是换了未覆盖的脚本 |
| CAS 前置条件发现已共享；存储锁键使用公共构造函数；prepare 使用共享的活跃 workspace 谓词；精确 init 查找先按编码 ID 过滤再解析；prepare/workspace CLI 错误映射已对齐 | **对第 4 轮点名的具体调用点均成立**；但整合并不完全：`librarySecurity.mjs` 的 `writeFileAtomic` 仍是第 4 个独立的 CAS 前置条件实现（三节）；`workspace-cli.js`/`prepare-paper.js` 的错误映射"对齐"是复制粘贴而非共享函数（三节） |

## 六、审查重点逐项结论（第 5 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立** |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **成立**（第 4 轮的崩溃残留分类修复本轮验证通过，未发现新问题） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **成立** |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **成立**（第 4 轮发现的 migrate-package.js 边界绕过已彻底关闭） |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **成立** |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立** |

---

## 附录：本轮 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/src/web/server/utils/codexWorker.ts", "line": 164, "summary": "codex-reply 调用失败时缓存的 threadId 从未被清理，第4轮删除 resetAfterFailure 后没有补上按论文粒度的失效线程清理，导致该论文后续提问永久复用同一个已损坏的 threadId 持续失败", "failure_scenario": "论文 P 已有会话线程；一次 codex-reply 调用因 MCP 服务端判定线程失效而抛出异常，paperThreads 中 P 的 threadId 条目未被移除；此后每次对 P 提问都复用同一损坏的 threadId 重复失败，直到整个 worker 进程因无关原因重启（会清空所有论文的线程，代价过大）"},
  {"file": "plugins/codex-paper/skills/study/scripts/validation-report.js", "line": 264, "summary": "persistWorkspaceValidationReport 的单锁化修复没有失败补偿，报告写入失败会让 workspace 停留在 validating 状态且无诊断信息（可经后续正常写入或重跑验证自愈）", "failure_scenario": "验证运行时报告写入因 STORAGE_FILE_TOO_LARGE 或磁盘 I/O 错误失败，置最终状态的第三步不会执行，workspace.json 停留在 validating/validation_started 且无诊断；下一次正常 authoring 写入或重新运行验证可将其修复，期间用户看不到失败原因"},
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 122, "summary": "acquirePaperAskLease 这一纯内存 Map 操作被包在一次真正的跨进程文件锁获取里，每次 ask 请求开头都产生两次同步 fsync 的不必要磁盘 I/O，且在锁冲突时会让 ask 本身超时失败", "failure_scenario": "并发的 migrate/delete 操作短暂持有同一把 paperLockKey 时，ask 请求在注册租约阶段（原本纯内存操作）就可能因跨进程锁获取失败而提前失败，退化为一个此前从不接触磁盘的操作现在依赖磁盘锁的可用性"}
]
```

*本文件由第 5 轮 code review 流程生成；候选来源为 8 角度并行扫描（约 15 条去重候选，其中一个角度对 6 个专项做了详尽跨文件追踪且未发现新问题），全部结论经按主题分组的 5 个独立验证批次逐条判定（2 项 CONFIRMED 正确性缺陷、2 项 REFUTED、其余为经核实的代码质量/效率类 CONFIRMED/PLAUSIBLE 观察）。*
