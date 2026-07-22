# P0-C2a Code Review 结论（第 8 轮）

- **审查日期**: 2026-07-22
- **审查范围**: 工作区未提交改动（`git diff HEAD`）及全部新增文件（`storage-transaction.mjs`、`generation-workspace.mjs`、`workspace-writer.mjs`、`workspace-cli.js`、`askLeases.mjs`、`codexThreadState.mjs`、`activeContentSecurity.mjs` 等）——即第 7 轮 review 建议修复之后的当前状态
- **审查依据**: 前七轮结论文档与 `docs/P0-C2A_CODE_REVIEW_SUMMARY.md`（"First"–"Seventh review disposition"）；重点为 (a) 逐项复核第 7 轮已接受修复（Ask 投递的渲染失败降级、`cleanupInitDirectories` 移入 registry 锁内）是否正确、完整、且未引入新缺陷，(b) 在七轮加固之后是否仍存在此前遗漏的正确性/清洗突破口
- **方法**: 与前七轮相同的多角度并行扫描（工作区/存储正确性 + CLI/Web 路由与内容清洗两个独立批次），逐条交叉验证。**本轮为 clean 结果：未发现新的、可端到端追踪的正确性缺陷**

## 总体评估

**边界目标继续成立，第 7 轮的两个修复经复核确认到位、正确、且带真实回归测试**：

- **Ask 投递的渲染失败降级（第 7 轮唯一 CONFIRMED 的修复）**：`ask.post.ts:166` 现调用 `renderSafeMarkdownForDelivery(answer, ...)`；该函数（`activeContentSecurity.mjs:170-176`）只对富文本渲染器 `renderer(...)` 加 try/catch，失败时回退到 `renderSafePlainText`（`escapeHtml` 包进 `<pre class="raw-html"><code>…</code></pre>`，`degraded:true`）并追加"富文本渲染失败，已使用安全纯文本显示"的警告。三点关键验证均通过：
  - **(a) 降级路径的转义安全**：`escapeHtml`（69-76 行）转义 `& < > " '` 五个字符，降级 HTML 无法重新引入活动标记或属性逃逸——无 XSS。行为回归 `viewer-active-content.test.mjs:81` 用 `<script>globalThis.pwned=true</script>` 注入并断言其被转义为 `&lt;script&gt;…`、且 `doesNotMatch(/<script>/)`。
  - **(b) 降级路径本身是否可能再抛异常**：`answer` 由 `finalizeCodexPaperToolResult` 保证为经 `trim()` 的非空**字符串**（否则更早抛出），而 `escapeHtml`/`String(x??'')`/`.replace` 对字符串不会抛异常，故 fallback 不会抛。此处仅存在"若未来有非字符串进入则 fallback 抛错会汇入外层 catch 丢答案"的**潜在脆弱性**，但当前类型契约下不可达。
  - **(c) 非空答案分支必返回 answer**：返回前仅有空答案（128 行）与 forbidden-residue（137 行）两处合法拒绝；保存失败被 149-164 吞掉并置 `saved:false`+警告，渲染失败优雅降级，172-179 行始终返回 `answer`。答案投递无丢失路径。
- **`cleanupInitDirectories` 移入锁内（第 7 轮低可达性整洁性修复）**：确认现位于 `withStorageLocks(keys, ...)` 块内（`generation-workspace.mjs:266`，锁自 265 行开始）；`registry` 锁（rank 10）在 `keys`（264 行）中，且被每个并发 create 共同要求，因此清理执行时不可能存在另一 creator 存活中的 `.init-*` 目录；本次操作自己的 `initDir` 在其后（274 行）才创建。Repository Guard 新增 mutation（`check-repository.mjs:594-598`）断言 `cleanupInitDirectories(layout)` 必须位于 `return withStorageLocks(keys` 之后，防止未来漂移出锁外。

**两个独立审查批次在七轮加固之后均给出 clean 结论**：

- **存储/工作区批次**：锁序/回滚（所有获取点均经 `normalizeLockKeys` rank 排序，部分获取经 `releaseAcquired` 回滚）、dead-owner reclaim 仍拒绝异主/存活 pid、corrupt 记录抛 `STORAGE_LOCK_CORRUPT` 而不回收、每处托管替换都强制 absent-or-SHA CAS（写与删除）、锁内重解析消解 TOCTOU、正式记录（paper.json/current.json/index.json）在这些文件中无任何写入路径——全部端到端追踪成立。
- **CLI/Web 与内容清洗批次**：prepare 只写临时 workspace、migrate/sandbox 的 managed/workspace 拒绝与报告目标 gating、Ask 每论文串行、180 秒外部调用期间不持跨进程锁（3 秒 `withOperationLocks` 只包 `appendChatNote`）、按论文线程失效对"抛异常"与"RPC 成功但空内容"两种触发都成立——全部成立。

结论：**边界目标本轮继续成立，且无新增待修正确性缺陷**。第 7 轮修复正确收口了此前唯一的 CONFIRMED 项，未引入回归。

---

## 一、已确认的正确性缺陷

**无。** 本轮两个独立审查批次均未发现新的、可端到端追踪的正确性缺陷。

## 二、非阻断的稳健性观察（记录备查，非本轮缺陷）

| 项 | 位置 | 说明与不可达性论证 |
|---|---|---|
| 降级渲染路径对非字符串输入的潜在脆弱性 | `activeContentSecurity.mjs:170-176`（`renderSafeMarkdownForDelivery` 的 catch 分支中 `renderSafePlainText(markdown)` 未再包 try/catch） | 若有非字符串进入，`renderSafePlainText` 理论上可能抛错并逃出内层 try/catch、汇入 `ask.post.ts:180` 外层 catch 而丢弃已保存答案。**当前不可达**：`answer` 由 `finalizeCodexPaperToolResult` 保证为 `output.content?.trim()` 的非空字符串（否则更早抛 `empty answer`），`escapeHtml`/`String`/`.replace` 对字符串不会抛异常。属"防御纵深可再加固"而非可达缺陷；若要收口，可让 `renderSafeMarkdownForDelivery` 的 catch 对 `String(markdown ?? '')` 再取一次，或整体再包一层兜底 |
| `atomicWriteFile` 中间目录创建的 `existsSync`→`mkdirSync` 未捕获竞态 `EEXIST` | `storage-transaction.mjs:451` | 并发下两写者之间理论上存在 `existsSync` 判否后另一方抢先 `mkdirSync` 的窗口。**不可达且不违反不变量**：给定 package 的写者由 workspace 锁串行化，不会有两个并发写者作用于同一 package 的同一中间目录；即便 `EEXIST` 抛出也只是让本次写失败，不会破坏任何 CAS/边界不变量。预存在的 robustness 备注，非本轮引入、非新缺陷 |

## 三、被驳回/未采纳的候选

本轮两个批次均主动声明"未发现新的可靠正确性缺陷（clean）"，无需驳回的高置信误报。上述二节两项均由提出批次自行标注为"非缺陷、仅为完整性记录"。

## 四、复用/重复与效率

本轮未发现新的复用/效率缺陷。第 6/7 轮记录的两项延续性观察维持既定取舍：

- 诊断"消毒+脱敏"的两份实现（`validation-report.js` 的 `boundedMessage` 上限 500 服务 finding schema、`generation-workspace.mjs` 的 `boundedText` 默认上限 600 服务 workspace diagnostic schema）受各自 schema 约束，属可接受的分治；第 6 轮已消除补偿分支的第三份手写实现。
- Repository Guard 的消费脚本清单仍为人工维护的显式数组 + 全量 mutation 覆盖；第 6 轮 disposition 已论证 import 扫描无法推断写权限、且无法发现绕过共享模块的旁路，故维持显式清单。

均为 P1-3 工程项，非 C2a 正确性变更。

## 五、第 7 轮已接受修复逐项复核

| 第 7 轮修复 | 第 8 轮结论 |
|---|---|
| Ask 投递用 `renderSafeMarkdownForDelivery` 包裹富文本渲染，渲染失败时回退到 HTML 转义的纯文本 `<pre>`，保留原始 answer 与保存元数据并追加可见警告；行为测试注入渲染失败并证明活动标记仍被转义 | **成立**：`ask.post.ts:166-179` 实现符合描述；`activeContentSecurity.mjs:170-176` 的降级路径经 `escapeHtml` 保证转义；`viewer-active-content.test.mjs:81` 为真实行为回归（注入 `<script>` 并断言转义 + `doesNotMatch(/<script>/)`）。非空答案在所有分支均随响应返回，无丢失路径 |
| 低可达 cleanup 观察作为廉价纵深防御被采纳：对老旧无记录 `.init-*` 残留的有界删除移入 registry 锁内，并加 Repository Guard mutation 防止其漂移出锁外 | **成立**：`cleanupInitDirectories(layout)` 现位于 `generation-workspace.mjs:266`（锁内）；`check-repository.mjs:594-598` 断言其必须在 `return withStorageLocks(keys` 之后 |
| `--force` migration 候选维持驳回（显式替换是已文档化的破坏性覆盖）；finding/workspace 诊断上限分离与显式 Guard 消费者清单为既定契约边界 | **成立**：与第 2/3/6 轮 disposition 一致，无变化 |

## 六、审查重点逐项结论（第 8 轮）

| 审查重点 | 结论 |
|---|---|
| 1. 无路径创建/更改正式 paper.json / current.json / index.json | **成立**（这些文件在四个核心 shared 模块中无任何写入路径；workspace 写入经 `WRITE_POLICIES`/`isAuthoringPath` 限定在 `packageDir` 内的白名单相对路径） |
| 2. workspace 创建同文件系统、私有、原子、精确 resume、保留失败现场 | **成立**（第 7 轮的锁外 cleanup 结构隐患已消除，移入 registry 锁内并有 Guard 保护） |
| 3. 锁顺序与部分获取回滚跨进程成立；不安全/corrupt/异主/存活锁不回收 | **成立** |
| 4. 托管文件替换都要求锁 + absent-or-SHA CAS | **成立** |
| 5. 已发布/legacy 内容不可作者化，overlay/trash/sandbox 保持可用 | **成立** |
| 6. mandatory fixture 在 workspace 内跑完整链路并断言无提前发布 | **成立**（本地缺 PyMuPDF/`fitz` 时依赖真实 PDF 解析的 storage 测试在解析阶段环境性失败，非代码回归；`viewer-active-content`/`viewer-security` 等不依赖解析的测试全绿：26/26；Repository Contract 通过） |

---

## 附录：本轮 findings（JSON）

```json
[]
```

*本文件由第 8 轮 code review 流程生成；候选来源为多角度并行扫描（工作区/存储正确性 + CLI/Web 路由与内容清洗两个独立批次）。两个批次均端到端追踪后主动给出 clean 结论：无新的可靠正确性缺陷。第 7 轮的两个修复（Ask 渲染失败降级、cleanup 移入 registry 锁内）经复核确认到位、正确、带真实行为回归，且未引入回归。二节两项为提出批次自行标注的非缺陷稳健性备注。*
