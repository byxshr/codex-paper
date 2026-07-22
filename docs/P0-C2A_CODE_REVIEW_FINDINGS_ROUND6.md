# P0-C2a Code Review 结论（第 6 轮）

- **审查日期**: 2026-07-22
- **审查范围**: 工作区未提交改动（`git diff HEAD`，45 个文件，+1478/-642）及全部新增文件（`storage-transaction.mjs`、`generation-workspace.mjs`、`workspace-writer.mjs`、`workspace-cli.js`、`askLeases.mjs`、**新增 `codexThreadState.mjs`** 等）——即第 5 轮 review 建议修复之后的当前状态
- **审查依据**: 前五轮结论文档与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（"First"–"Fifth review disposition"）；重点为 (a) 逐项复核第 5 轮已接受修复（按论文粒度的线程失效、validator 失败补偿、ask 租约去锁化、`librarySecurity.mjs` 共享 CAS、CLI 退出码共享函数、Guard 全量消费者覆盖）是否正确、完整，(b) 修复本身是否引入新缺陷
- **方法**: 与前五轮相同的 8 角度并行扫描，产生约 10 条去重候选；按主题分组由 4 个独立验证批次逐条判定，**1 项经充分交叉验证后判定为 REFUTED**

## 总体评估

**收敛趋势在本轮延续**：第 5 轮修复的核心机制基本站得住——`workspace-cli.js`/`prepare-paper.js` 的 CLI 退出码映射确认已改为共享函数 `storageCliExitCode`；`librarySecurity.mjs` 的 `writeFileAtomic` 确认已改用共享的 `fileWritePrecondition`；ask 租约注册确认已去除文件锁（不再包在 `withOperationLocks` 里）；Repository Guard 现在对全部 9 个声明的消费脚本都有 mutation test 覆盖。一个被怀疑的新缺口（ask 租约纯进程内、CLI 工具对其不可见）经核实**不成立**——ask 只能作用于 `managed_v1` 描述符，而 `migrate-package.js`/`workspace-cli.js` 要么明确拒绝这个模式、要么只操作物理上完全独立的 workspace 目录树，不存在真实的文件碰撞面。

但本轮确认了 **2 个正确性缺陷**，两者的共同点是：**第 5 轮的修复只覆盖了它们各自被设计要解决的那一种触发方式，没有覆盖同一失败类别下的另一种触发方式**：

- **按论文粒度的线程失效逻辑只在 `codex-reply` 抛异常时生效**：第 5 轮把"任一失败清空所有论文线程"收窄为"只清空这一个论文的线程"，但清理动作被放在 `codexThreadState.mjs` 内部包裹 `callTool('codex-reply', ...)` 的 try/catch 里——如果这次调用在 RPC 层面**成功返回**（不抛异常）却带回空内容（`answer` 为空字符串），`askSerialized` 在这个 try/catch 之外才判定"空回答"并抛错，此时已损坏的 threadId 从未被从缓存里删除。后续对同一论文的每次提问都会复用这个已经产生空回答的线程，重复失败，直到整个 worker 进程因无关原因重启——这正是第 5 轮想要彻底关闭的"该论文永久失效"问题，只是换了一个不抛异常的触发方式。
- **validator 失败补偿只覆盖"写报告"这一步，没覆盖紧随其后的"置最终状态"这一步**：第 5 轮加的 try/catch 只包住 `replaceWorkspaceJson`（写验证报告）这一次调用；负责把状态从 `validating` 切换到 `failed`/`validated`/`authoring` 的第二次 `updateWorkspaceRecordLocked` 调用在 try/catch **之外**执行。如果报告写入成功、但这第二次调用本身失败（如诊断数组增长触及 `STORAGE_FILE_TOO_LARGE`），workspace 会停留在 `validating`，且**完全没有任何诊断信息**——比第 5 轮专门处理的"报告写入失败"场景还要糟，因为那个场景好歹会留下一条诊断。

此外发现若干代码质量/效率类观察，多是延续性的重复模式在本轮新代码里再次出现：诊断信息的"代码消毒 + 路径脱敏"逻辑现在有三份独立实现（`600` 字符上限的 `boundedText` 未导出，导致新的补偿写入分支又手写了一份，长度上限还漂移成了 `500`）；补偿写入自身失败时错误被静默丢弃，不像 `generation-workspace.mjs` 的同类模式那样会把次生错误挂到 `preservationError` 上；三个 CLI 脚本各自硬编码了一遍 `30_000` 的锁超时上限检查，没有导入已经导出的 `MAX_LOCK_TIMEOUT_MS`；补偿写入路径下第二次 `updateWorkspaceRecordLocked` 在同一把已持有的锁内又重新解析/读取/哈希了一遍其实没有变化过的 `workspace.json`；Repository Guard 对 9 个消费脚本的覆盖仍然依赖人工维护的数组，未来第 10 个消费脚本若被遗漏，默认状态是不受保护而非受保护。

结论：**边界目标本轮继续成立**。建议修复上述两个正确性问题（线程失效的空回答分支、validator 补偿的第二步覆盖），其余代码质量类观察可与既往几轮的同类项一并处理。

---

## 一、已确认的正确性缺陷

### 1. 线程失效逻辑只在 `codex-reply` 抛异常时触发，RPC 成功但返回空内容的情形不会清理缓存 — CONFIRMED

`plugins/codex-paper/src/web/server/utils/codexThreadState.mjs:22`

`callCodexPaperTool` 只在包裹 `await callTool('codex-reply', ...)` 的 catch 块（21-24 行）里执行 `paperThreads.delete(slug)`。若这次调用在 RPC 层面正常返回（`result?.isError` 为假，`codexWorker.ts` 的 `callTool` 因此不抛异常），但提取出的内容为空/空白，`callCodexPaperTool` 会正常返回 `{existingThreadId, result}`——不触碰 Map。`askSerialized` 随后才在这个 try/catch **之外**判定 `if (!answer) throw new Error('Codex returned an empty answer')`（178 行）；此时已经产生空回答的 `existingThreadId` 从未被移除或替换。下一次对同一论文的 `ask()` 调用会经 `existingThread?.paperDir === paperDir` 命中同一个条目，复用同一个已经证明会产生空回答的线程，重复相同的失败——直到整个 worker 进程因无关原因重启（会清空所有论文的线程，代价过大）。这正是第 5 轮修复想要彻底关闭的"单个论文永久失效"问题，只是这次是经由不抛异常的触发路径重现。

**建议**: 把清理逻辑从"仅捕获异常"扩展为"任何导致 `askSerialized` 判定失败的结果都清理对应 threadId"，例如让 `callCodexPaperTool` 的调用方在判定空回答/缺失 threadId 后也显式调用一次清理，或把空内容判定挪进 `callCodexPaperTool` 内部一并处理。

### 2. validator 失败补偿只包住"写报告"步骤，紧随其后的"置最终状态"步骤失败时不留任何诊断 — CONFIRMED

`plugins/codex-paper/skills/study/scripts/validation-report.js:267-289`

`persistWorkspaceValidationReport` 的 try 块只跨越 267-287 行，只包住 `replaceWorkspaceJson`（写 `.codex-paper/validation-report.json`）这一次调用及其补偿逻辑。负责把状态从 `validating` 切到最终状态（`failed`/`validated`/`authoring`）的第二次 `updateWorkspaceRecordLocked` 调用在 289 行——**在 try/catch 之外**。若报告写入成功，但这第二次调用本身抛出（如诊断数组累积触发 `STORAGE_FILE_TOO_LARGE`、CAS 冲突、真实磁盘错误），异常直接从函数中传出，`workspace.json` 停留在 266 行设置的 `state:'validating'`，且**没有留下任何诊断**——比第 5 轮专门处理的"报告写入本身失败"分支更糟，那个分支好歹会写入一条 `validation_report_write_failed` 诊断。

**建议**: 把 try 块的范围扩大到覆盖第二次 `updateWorkspaceRecordLocked` 调用，对其失败同样走一次补偿写入（或至少记录诊断）。

## 二、被驳回的候选（记录备查）

- **ask 租约纯进程内、CLI 工具（`migrate-package.js`/`workspace-cli.js`）对其不可见，可能与 ask 未加锁的 180 秒 Codex 读取产生跨进程竞争** — REFUTED：`ask.post.ts` 经 `requireWritablePaperAccess` 解析出的描述符只能是 `managed_v1` 或 `legacy_flat` 模式；`migrate-package.js` 的 `migrationTargetForDescriptor` 明确拒绝 `managed_v1`/`generation_workspace_v1`/`managed_generation_v1` 三种模式；`workspace-cli.js` 的写入只作用于 `workspaces-v1` 树下的 workspace 包目录，与 ask 可能触达的 `store-v1` 托管包目录物理上完全独立。不存在真实的文件路径碰撞面，租约的可见性范围因此不构成问题。且第 4/5 轮的处置记录本就只声明该租约用于解决"Web 删除路由"这一个场景，从未声称覆盖 CLI 工具协调。

## 三、复用/重复与诊断质量（代码质量）

| 项 | 位置 | 说明 |
|---|---|---|
| 诊断信息的"代码消毒 + 路径脱敏"逻辑三份独立实现，长度上限已经漂移 | `validation-report.js:109`（`makeFinding`）、`generation-workspace.mjs:77-82`（私有未导出的 `boundedText`，上限 600）、`validation-report.js:270-275`（本轮新增的补偿写入分支，上限 500） | `validation-report.js` 已经从 `generation-workspace.mjs` 导入了 `updateWorkspaceRecordLocked`，但因为 `boundedText` 从未被导出，新的补偿分支只能手写第三份逻辑，长度上限与已有实现不一致 |
| 补偿写入自身失败时次生错误被静默丢弃，不同于 `generation-workspace.mjs` 的对应模式 | `validation-report.js:282-285`（空 catch，仅注释） vs `generation-workspace.mjs:306-308,317`（`preservationError` 被捕获并挂到 `failure.preservationError` 后再抛出） | 若报告写入失败**且**补偿写入也失败，operators/日志只能看到原始存储错误，看不到 workspace 已经处于未诊断的 `validating` 状态且补偿本身也失败了这一事实 |
| 锁超时上限检查三处硬编码 `30_000`，未导入已导出的 `MAX_LOCK_TIMEOUT_MS` | `workspace-cli.js:26`、`prepare-paper.js:148`、`prepare-paper.js:425` vs `storage-transaction.mjs:8` 导出的 `MAX_LOCK_TIMEOUT_MS` | 两个 CLI 文件都只导入了 `storageCliExitCode` 等其他共享函数，唯独锁超时上限仍是字面量；未来若该上限调整，三处都需要手动同步 |
| Repository Guard 的 9 消费脚本覆盖依赖人工维护的数组，非文件系统扫描派生 | `check-repository.mjs:468-474,480-483` vs `check-repository.test.mjs` 的 `resolverConsumers`/`writerConsumers` | `check-repository.mjs` 不导出任何数组，测试文件独立手写了一份几乎相同的列表；9 个消费脚本目前都有 mutation test 覆盖，但 Guard 的实际强制力仅限于 `check-repository.mjs` 自己数组里列出的脚本——未来第 10 个导入 `paper-library.mjs`/`workspace-writer.mjs` 的脚本，默认状态是**不受保护**，需要人工记得把它加进数组，这与第 5 轮修复的正是同一类"静默弱化无测试覆盖"风险，只是从"测试覆盖"层面下沉到了"Guard 本身的强制范围"层面 |

## 四、效率

**补偿写入路径下第二次 `updateWorkspaceRecordLocked` 在同一把已持有的锁内又完整重新解析/读取/哈希了一遍并未变化过的 `workspace.json`**（`validation-report.js:289`，调用 `generation-workspace.mjs:323-337` 的 `updateWorkspaceRecordLocked`）：266 行的第一次调用已经返回了一个"锁内最新"的 `current` 描述符；两次调用之间只执行了 `replaceWorkspaceJson`（写的是另一个文件 `validation-report.json`），`workspace.json` 期间不可能变化。但 `updateWorkspaceRecordLocked` 内部无条件地又做了一次 `resolveGenerationWorkspace`（含 existsSync/lstat 安全校验与完整读取+解析+校验）、一次 `readFileNoFollowBounded`+SHA-256 哈希、以及返回值前的第三次解析——纯粹浪费的 I/O，可复用 266 行已经持有的新鲜状态。

## 五、第 5 轮已接受修复逐项复核

| 第 5 轮修复 | 第 6 轮结论 |
|---|---|
| 一次失败的 `codex-reply` 只让匹配的论文/线程/路径条目失效；行为回归测试证明下一次请求会用全新的 `codex` 调用，另一篇论文缓存的线程不受影响 | **对"抛异常"这一种失败形态成立**；但同一函数对"RPC 成功但内容为空"这一形态没有覆盖，仍会导致该论文永久失效（缺陷 #1） |
| validation-report 替换失败时，在同一把锁内尝试把 workspace 转为 `failed` 并附带 `validation_report_write_failed` 与一条有界、路径脱敏的诊断，然后重新抛出原始持久化错误；若该存储故障同时阻止了记录补偿，原始错误依然可见，后续 authoring/validation 可以恢复 | **对"写报告"这一步的失败覆盖成立**；但紧随其后的"置最终状态"这一步本身失败时完全没有覆盖（缺陷 #2），且"若补偿本身也失败，原始错误依然可见"这一表述只对报告写入失败分支成立，实际实现中补偿失败被静默丢弃（三节） |
| 进程内 ask 租约注册不再执行文件系统加锁；`librarySecurity.mjs` 使用共享的 CAS 前置条件辅助函数；prepare/workspace CLI 退出码映射使用同一个共享函数 | **三项均已验证成立** |
| Guard mutation 覆盖现在覆盖每一个声明过的 paper-library/workspace-writer 消费者 | **对当前 9 个已声明的消费者成立**；但覆盖机制本身仍是人工维护的硬编码数组，而非从磁盘扫描派生，未来新增消费者默认不受保护（三节） |

## 六、审查重点逐项结论（第 6 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立** |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **成立**（本轮未发现新问题） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **成立** |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **成立** |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **成立** |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立** |

---

## 附录：本轮 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/src/web/server/utils/codexThreadState.mjs", "line": 22, "summary": "线程失效清理只在 codex-reply 抛异常时触发；RPC 成功但返回空内容时不会清理缓存的 threadId，导致该论文后续提问永久复用同一个已产生空回答的线程", "failure_scenario": "codex-reply 正常返回（result.isError 为假）但内容为空，askSerialized 在 callCodexPaperTool 的 try/catch 之外判定空回答并抛错，此时 existingThreadId 从未被移除；后续每次对该论文提问都复用同一线程重复失败，直到整个 worker 进程因无关原因重启"},
  {"file": "plugins/codex-paper/skills/study/scripts/validation-report.js", "line": 289, "summary": "validator 失败补偿的 try/catch 只包住写报告这一步，紧随其后置最终状态的第二次 updateWorkspaceRecordLocked 调用在其外部，该调用本身失败时 workspace 停留在 validating 且无任何诊断", "failure_scenario": "报告写入成功后，置最终状态的调用因诊断数组增长触发 STORAGE_FILE_TOO_LARGE 或磁盘错误而失败，异常直接传出，workspace.json 停留在 validating/validation_started 且诊断字段为空，比报告写入失败本身的分支缺少诊断信息"}
]
```

*本文件由第 6 轮 code review 流程生成；候选来源为 8 角度并行扫描（约 10 条去重候选），全部结论经按主题分组的 4 个独立验证批次逐条判定（2 项 CONFIRMED 正确性缺陷、1 项 REFUTED、其余为经核实的代码质量/效率类 CONFIRMED 观察）。*
