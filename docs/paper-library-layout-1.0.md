# Paper Library Layout 1.0

Paper Library Layout 1.0 定义 Codex Paper 的物理存储、current resolution 与 mutable overlay 边界。Paper Identity 1.0 说明“对象是谁”；本契约说明“对象放在哪里、当前读取哪一代、哪些内容允许改变”。

## 权威关系

1. `paper.json` 钉住 paper record 的 primary `paperId`，并记录经显式 reconciliation 添加的 identity/route aliases。
2. `current.json` 唯一决定默认读取的 source revision 和 generation。
3. generation package 内的 PDF、机器数据、学习材料和 validation report 属于按 generation identity 隔离的生成层；P0-C2 的 publish/manifest sealing 完成前，现有 authoring 命令仍会写入该层，不能把 C1b 描述为已经强制“创建即不可变”。
4. `overlay/state.json`、`overlay/chat-notes.md` 和 `overlay/files/` 属于用户可变层。
5. `index.json`、`meta.json` 与 slug 都是兼容 projection；不得据此覆盖、重分组或选择“最新” generation。

损坏、缺失、跨 paper 的 current 指针必须 fail closed，resolver 不得回退到目录排序或最新 mtime。

## Alias 与 reconciliation

首次成功生成钉住 initial primary `paperId` 和 `paperKey`。后续输入若得到不同 paper ID，即使 source/generation 完全相同，也只能返回 `PAPER_IDENTITY_RECONCILIATION_REQUIRED`。用户显式执行 reconciliation 后，新增 ID 成为 alias 并写入有界审计记录；如果它是更强的可信 DOI/arXiv identity，可以显式提升 paper-level primary。`paperKey`、既有 generation identity 和文件内容始终保持不变，因此 local-first 与 canonical-first 最终可得到相同的 canonical primary/alias 语义。

同一个 alias 只能属于一个 paper record。重复、歧义或指向不存在 record 的 alias 均为 registry corruption，并 fail closed。

## Overlay 合并

允许的权威 mutable 字段为 `tags`、`progress` 和 `annotations`；Chat notes 和用户文件单独存放。Overlay 不能遮蔽 `paper.pdf`、`meta.json`、`facts.json`、`analysis.json`、`reasoning-analysis.json`、validation report 或其他 generation 文件。Viewer 仅把 `chat-notes.md` 和 `overlay/files/` 作为受控逻辑视图合入公共文件树。

## Legacy

没有 managed record、但存在 `papers/<slug>` 的 2.0/2.1 flat package，以 `legacy_flat` 模式解析。该 descriptor 永远 `readOnly=true`；读取不得创建或更新 store、current、overlay、index 或 validation report。显式迁移属于 P1-2。

## 安全边界

所有层级拒绝 symlink、越界 realpath、非普通关键文件和不符合 schema 的记录。所有进程内 paper 锁和 Ask thread key 使用 resolver 返回的稳定 paper/generation key，而不是用户提供的 alias。

## 与 P0-C2 的边界

C1b 保证 overlay mutation 不进入 generation package，并冻结 current resolution 与物理分层；它不提供 generation workspace、manifest sealing、发布 commit point 或发布后的 dirty/clone-on-write 检测。只有 P0-C2 完成 gate 驱动的原子发布后，正式 generation 才具备可强制验证的不可变语义。
