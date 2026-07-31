# P0-C2a Code Review 结论（第 7 轮）

- **审查日期**: 2026-07-22
- **审查范围**: 工作区未提交改动（`git diff HEAD`，45 个文件，+1573/-643）及全部新增文件（`storage-transaction.mjs`、`generation-workspace.mjs`、`workspace-writer.mjs`、`workspace-cli.js`、`askLeases.mjs`、`codexThreadState.mjs` 等）——即第 6 轮 review 建议修复之后的当前状态
- **审查依据**: 前六轮结论文档与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（"First"–"Sixth review disposition"）；重点为 (a) 逐项复核第 6 轮已接受修复（空回答分支的线程失效、validator 补偿覆盖第二步、共享诊断 sanitizer、`MAX_LOCK_TIMEOUT_MS` 导出）是否正确且完整，(b) 修复本身是否引入新缺陷
- **方法**: 与前六轮相同的多角度并行扫描（工作区/存储正确性 + CLI/Web 路由两个独立批次），产生候选后逐条交叉验证。**1 项经核实判定为 REFUTED，1 项经核实其触发前提不成立而降级为 PLAUSIBLE（低可达性）**

## 总体评估

**边界目标继续成立，且第 6 轮的两个正确性修复已确认到位且带回归测试**：

- `codexThreadState.mjs` 的 `finalizeCodexPaperToolResult` 现在对"空 `answer`"和"缺失 `threadId`"两种情形都会在 `existingThreadId` 存在时调用 `invalidateCodexPaperThread`；`callCodexPaperTool` 的 catch 分支单独处理 `codex-reply` 抛异常的情形；`codexWorker.ts:182` 只在 finalize 成功后才写回 `paperThreads`，因此空回答不会留下陈旧线程。`scripts/tests/viewer-security.test.mjs:79` 有专门的行为回归（"an empty successful reply invalidates only the matching cached paper thread"）。
- `validation-report.js` 的 `persistWorkspaceValidationReport` 现在把 `compensate(...)` 同时用于"写报告"（288 行）和"置最终状态"（298 行）两步；补偿写入自身失败时通过 `preservationError` 暴露次生错误而非静默丢弃。`tests/validation-report.test.mjs:394` 与 `:423` 覆盖了两步补偿及次生错误保留。
- 第 6 轮的代码质量建议也已落实：补偿分支改用共享的 `createWorkspaceDiagnostic`（不再手写第三份 sanitizer）；`workspace-cli.js` 与 `prepare-paper.js` 均已导入并使用 `MAX_LOCK_TIMEOUT_MS`，不再硬编码 `30_000`。

本轮**未发现任何针对已加固机制（dead-owner reclaim、部分获取回滚、CAS 前置条件、锁序、状态转移表）的新突破口**。经充分交叉验证后，两个批次各自给出的高置信候选分别被降级或驳回：

- **workspace 删除路由与 ask 租约的可见性、prepare 只写 workspace、ask 不在外部调用期间持跨进程锁、任何保存/锁失败都不丢答案** —— 全部复核成立。
- 唯一确认的**新正确性缺陷**是一处**回答投递（而非保存）路径**的答案丢失：answer 已成功写入聊天记录之后，构造响应体时对其做 `renderSafeMarkdown`，若该渲染抛异常会落入外层 catch 返回 502，把已保存的 answer 从 HTTP 响应里丢掉——这正是第 3–5 轮反复加固的"绝不丢失已生成答案"不变量，只是换到了此前未覆盖的渲染分支上。

结论：**边界目标本轮继续成立**。建议修复下述 1 个正确性缺陷（渲染失败导致的答案投递丢失），并可顺带处理 1 个低可达性的锁序整洁性问题；其余为延续性的代码质量观察。

---

## 一、已确认的正确性缺陷

### 1. answer 保存成功后，构造响应时的 `renderSafeMarkdown` 若抛异常，会把已保存的答案从 HTTP 响应中丢弃 — CONFIRMED（中）

`plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts:166-173`（渲染点 168 行）

`ask.post.ts` 的内层 try/catch（149-164 行）已经正确覆盖了"保存/锁失败仍返回 answer + `saveWarning`"这一第 3–5 轮加固的语义。但紧随其后的 `return { answer, answerHtml: renderSafeMarkdown(answer, ...), ... }`（166-173 行）在**内层 try/catch 之外**执行渲染：`renderSafeMarkdown`（`activeContentSecurity.mjs:151`）内部调用 `marked.parse(...)` 与 `sanitizeRenderedMarkdown(...)`。`markedKatex` 的 `throwOnError:false` 只约束 KaTeX 的**渲染阶段**，不约束 marked 的解析扩展在**解析阶段**抛出的错误。若 answer 含有某种触发解析/清洗抛错的病理内容，异常会落到外层 catch（174 行）；此时 `e.statusCode` 为 undefined，函数返回 502 fallback。结果：**answer 已经写入 `chat-notes.md`（可从历史恢复），但从本次 HTTP 响应里彻底消失**，客户端（`[slug].vue:588` 读取 `response.answer`）拿到的是 502 而非答案。这与内层 try/catch 精心保证的"生成成功即返回答案"目标相矛盾，只是发生在渲染分支而非保存分支。

**触发条件**: answer 为 Codex 正常返回的非空文本，但包含使 `marked.parse`/`sanitizeHtml` 抛异常的内容。marked/sanitize-html 对任意文本相当健壮，实际触发概率低，但结构上确实存在：渲染点在答案保存之后、且其异常汇入会丢弃答案的 catch。

**建议**: 将 `renderSafeMarkdown` 的调用移入一层防御式包裹（try/catch），失败时回退为已保存的纯文本 answer（例如 `answerHtml` 置空或用转义后的 answer），保证只要 answer 已生成就一定随响应返回；或把渲染提前到保存之前、与保存共享同一"答案已生成则不丢"的保护范围。

## 二、低可达性的锁序整洁性问题（PLAUSIBLE）

### 2. `cleanupInitDirectories` 在 registry 锁之外执行破坏性 `rmSync`，理论上可删除另一进程正在创建的 `.init-*` 目录 — PLAUSIBLE（低可达性）

`plugins/codex-paper/src/shared/generation-workspace.mjs`：调用点 259 行、删除点 247 行、窗口 274-297 行

`createGenerationWorkspace` 在进入 `withStorageLocks([...'registry'...])`（266 行）**之前**就调用了 `cleanupInitDirectories(layout)`（259 行），因此该清理**不受 registry 锁串行化保护**。清理逻辑对一个 `.init-*` 目录只在"存在 `workspace.json`"（246 行）或"mtime ≤ 1 小时"（247 行）时跳过；成功路径下 `workspace.json` 要到 297 行才写入，此前 init 目录一直无记录，且 `populate` 只写 `initDir/package/**`（不刷新 `initDir` 自身 mtime）。理论上若某个持锁的 create 其 `populate` 耗时超过 1 小时，另一进程未加锁的 cleanup 可能把它的 `.init-*` 目录 `rmSync` 掉，导致持锁进程后续的 `atomicWriteJson`/`renameSync` 作用在被销毁的树上，工作丢失。

**为何降级为低可达性（对提交批次的修正）**: 提出该候选的批次假设"完整 Codex 生成的包，`populate` 耗时可能超过 60 分钟"——**此前提不成立**。`populate`（`prepare-paper.js:596-611`）只做同步的 `atomicWriteFile`/`atomicWriteJson`，写入的是**已经在 `createGenerationWorkspace` 之前算好的** PDF 字节与 JSON 工件；PDF 解析、分析、身份计算全部发生在建 workspace **之前**。因此一个存活中的 create 其 `populate` 在毫秒级完成，根本无法把 init 目录的 mtime 拖过 1 小时窗口。真正会被清掉的只有"崩溃/被杀且无记录、且已存在超过 1 小时"的残留——这正是第 3 轮 disposition 明确保留的既定 1 小时清理策略。故该项不是可达的数据丢失缺陷，而是一处"把破坏性步骤放在锁外"的整洁性/纵深防御瑕疵。

**建议（非阻断）**: 将 `cleanupInitDirectories` 移入 `withStorageLocks` 块内（此处已持 registry 锁），或让其跳过对应 generation/workspace 锁当前被持有的 `.init-*` 目录，以消除锁外破坏性操作这一结构隐患。

## 三、被驳回的候选（记录备查）

- **`migrate-package.js:279,321` —— `--force` 会用骨架重建 `reasoning-analysis.json`，销毁已完成的 reasoning** — REFUTED：这是**既定且已文档化**的行为。第 2 轮 disposition 明确记录"legacy migration ... preserves an existing reasoning review unless `--force` is explicit"，第 3 轮亦重申"guaranteeing documented legacy packages"。`306/315/321/325` 行的 `!fs.existsSync(...) || options.force` 正是该契约的实现：默认保留现有 reasoning/ledger/review，仅在调用方显式传入 `--force` 时才覆盖。要求显式 `--force` 且作用于非常规 flat 布局，符合已接受的破坏性操作确认原则，不构成新缺陷。

## 四、复用/重复与诊断质量（延续性代码质量，非阻断）

| 项 | 位置 | 说明 |
|---|---|---|
| 诊断"消毒+脱敏"仍存在两份实现（本轮补偿分支已收敛到共享实现，但两处上限常量仍不同） | `validation-report.js:84`（`boundedMessage`，上限 `MAX_MESSAGE_LENGTH=500`，用于 finding 文本）vs `generation-workspace.mjs:77`（`boundedText`，默认上限 600，用于 workspace 诊断） | 第 6 轮已让补偿写入改用共享的 `createWorkspaceDiagnostic`（消除了第三份手写实现）。剩余的两份服务于不同 schema（validation-report finding vs workspace diagnostic），长度上限差异是各自 schema 约束使然，属可接受的分治；若要进一步统一可在 P1-3 处理 |
| Repository Guard 的消费脚本覆盖仍是人工维护的硬编码数组 | `check-repository.mjs:468-474`（resolver 消费者）、`480-483`（writer 消费者）vs `check-repository.test.mjs` 的独立列表 | 与第 6 轮同一观察：Guard 强制范围仅限数组中列出的脚本，未来新增第 N 个导入 `paper-library.mjs`/`workspace-writer.mjs` 的脚本默认不受保护。第 6 轮 disposition 已论证"import 扫描无法推断写权限、且无法发现绕过共享模块的新旁路"，故维持显式清单 + 全量 mutation 覆盖；属已知取舍，非新问题 |

## 五、效率

本轮未发现新的效率缺陷。第 6 轮指出的"补偿路径第二次 `updateWorkspaceRecordLocked` 在同一把锁内重新解析/哈希 `workspace.json`"仍存在（`generation-workspace.mjs:332-346` 内部的 `resolveGenerationWorkspace` + `readFileNoFollowBounded`+SHA-256），但第 6 轮 disposition 已明确这是"锁内 CAS/no-follow 纵深防御，而非性能捷径"的刻意设计，维持不变。

## 六、第 6 轮已接受修复逐项复核

| 第 6 轮修复 | 第 7 轮结论 |
|---|---|
| 按论文粒度的线程失效现在覆盖"`codex-reply` 抛异常"与"RPC 成功但答案为空"两种触发方式，带行为回归且保留其他论文线程 | **成立**：`finalizeCodexPaperToolResult` 对空 answer / 缺失 threadId 均在 `existingThreadId` 存在时失效缓存；`viewer-security.test.mjs:79` 专门覆盖空回答分支且断言另一论文线程不受影响 |
| validator 失败补偿同时覆盖"写报告"与"置最终状态"两步；能写入时记 `validation_state_update_failed`，补偿再失败时保留原始错误并把次生错误挂到 `preservationError` | **成立**：`persistWorkspaceValidationReport` 的 `compensate(...)` 对 288 与 298 两处调用统一处理；`validation-report.test.mjs:394`/`:423` 覆盖两步补偿与次生错误保留 |
| 采用共享 workspace 诊断 sanitizer；导出并使用 `MAX_LOCK_TIMEOUT_MS` | **成立**：补偿分支改用 `createWorkspaceDiagnostic`；`workspace-cli.js:11`/`prepare-paper.js:39` 导入 `MAX_LOCK_TIMEOUT_MS` 并在 25/149/426 行使用 |

## 七、审查重点逐项结论（第 7 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立**（prepare 只 `readIndexPreserveShape` 读取、从不写；所有写入经 `populate` 进入 `.init-*`→`workspaces-v1`；`reconcilePaperRecord` 仅进 `publishIntent`，不落正式 store） |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **成立**（本轮新发现的锁外 cleanup 为低可达性整洁性问题，见二节，不构成可达的现场丢失） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **成立** |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **成立** |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **成立** |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立**（本地 PDF 解析依赖 PyMuPDF/`fitz`，未安装时 5 个依赖真实解析的 storage 测试在解析阶段即环境性失败，非代码回归；其余 11 项通过，Repository Contract 通过） |

---

## 附录：本轮 findings（JSON）

```json
[
  {"file": "plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts", "line": 168, "summary": "answer 保存成功后，构造响应体时对其执行 renderSafeMarkdown，若解析/清洗抛异常会落入外层 catch 返回 502，把已写入聊天记录的答案从 HTTP 响应中丢弃", "verdict": "CONFIRMED", "failure_scenario": "Codex 正常返回非空 answer 并成功写入 chat-notes；构造返回对象时 renderSafeMarkdown(answer) 内部 marked.parse/sanitizeHtml 因病理内容抛异常（throwOnError:false 只管 KaTeX 渲染、不管解析扩展抛错），异常汇入 174 行外层 catch，e.statusCode 为 undefined，返回 502 fallback；答案虽已持久化，但本次响应丢失，客户端拿到错误而非答案"},
  {"file": "plugins/codex-paper/src/shared/generation-workspace.mjs", "line": 259, "summary": "cleanupInitDirectories 在 registry 锁之外执行破坏性 rmSync，理论上可删除另一进程持锁 create 尚无 workspace.json 的 .init-* 目录；但 populate 为同步写已算好的工件、毫秒级完成，无法拖过 1 小时窗口，故实际不可达", "verdict": "PLAUSIBLE", "failure_scenario": "进程 A 持全部锁执行 create，其 populate 需超过 60 分钟（实际不成立：populate 只做同步 atomicWriteFile，PDF 解析/分析都在建 workspace 之前完成）；此窗口内进程 B 在锁外的 cleanup 见到 A 的无记录且 mtime 陈旧的 .init-* 目录并 rmSync；A 随后的 workspace.json 写入/rename 作用在被销毁的树上而失败。建议将 cleanup 移入 registry 锁内以消除锁外破坏性操作的结构隐患"}
]
```

*本文件由第 7 轮 code review 流程生成；候选来源为多角度并行扫描（工作区/存储正确性 + CLI/Web 路由两个独立批次），全部结论经逐条交叉验证（1 项 CONFIRMED 正确性缺陷、1 项经修正触发前提后降级为 PLAUSIBLE、1 项 REFUTED，其余为延续性代码质量/效率观察）。第 6 轮的两个正确性修复经复核确认到位且带回归测试。*
