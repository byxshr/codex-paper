# P0-C1b：物理布局、统一 Resolver 与 Mutable Overlay

## 目标

P0-C1b 将 P0-C1a 冻结的 paper/source/generation identity 落到不会因标题碰撞而覆盖的物理布局，并让 Viewer、validator、sandbox、trash/restore、Ask 与 study CLI 通过同一个 no-follow resolver 访问当前 generation。旧 flat-layout 2.0/2.1 包保持只读兼容，迁移留给 P1-2。

## 权威布局

```text
<library>/.codex-paper/store-v1/papers/<paperKey>/
  paper.json
  current.json
  overlay/
    state.json
    chat-notes.md
    files/
  sources/<sourceRevisionId>/generations/<generationId>/package/
```

- `paperKey` 是首次创建时 `paperId` 的 SHA-256 派生稳定键；canonical reconciliation 不移动目录。
- `paper.json` 保存首次钉住的 primary paper ID、显式 identity aliases 和 route aliases。
- `current.json` 是当前 source/generation/package 的唯一权威指针。
- generation package 是按 generation identity 隔离的逻辑生成层；tags、chat notes、progress、annotations 与用户 overlay 文件不得写入其中。现有多步 authoring 在 P0-C2 引入 workspace/publish commit point 前仍会写入该 generation，manifest sealing、发布后不可变和 dirty/clone-on-write 强制执行属于 C2。
- `index.json`、`meta.json` 和 route slug 只是兼容投影，不承担 identity/current 权威。

## 行为契约

- 默认 prepare：精确 generation 只读复用；同 source 的新 fingerprint 创建新 generation；同 paper 的新 source 创建新 revision；同标题不同论文使用稳定后缀 route slug 共存。
- `--resume`：只允许复用精确 generation，不存在即失败且零写。
- `--new-revision`：要求已存在同 paper 分组且 source revision 为新值；不满足即失败。
- `--replace`：C1b 明确拒绝。覆盖/替换发布属于 P0-C2。
- `--reconcile-identity <existing-route>`：仅在 source hash 与 generation fingerprint 完全相同的情况下，显式添加另一个 paper ID alias 并记录审计项；可信 canonical ID 可显式提升为 paper-level primary，但不移动 `paperKey`，也不改写 generation identity 或文件内容。
- current 切换只发生在成功创建新 generation/revision 时；复用旧 generation 不会悄悄回退 current。

## 安全与兼容

- resolver 对 store、paper record、current、source、generation、package 与 overlay 的每个路径段执行 `lstat`、realpath containment 和 no-follow 检查。
- alias 只存在于受校验的记录/index 中，不使用目录 symlink。
- resolver 返回稳定 `paperLockKey` 和 `generationLockKey`；不同 alias 不能绕过互斥或复用错误 Ask thread。
- legacy flat 包返回 `legacy_flat/readOnly=true` descriptor；读取不创建 store/current/overlay，也不改变 hash 或 mtime。
- legacy tags/Ask/sandbox execution 等需要写入的操作 fail closed；trash/restore 只移动 payload，tombstone 存放在独立 trash envelope。

## C2 边界

C1b 只建立布局、解析、overlay 隔离和单进程写入语义。generation workspace、跨进程锁、统一 writer、manifest sealing、发布后不可变、manifest-managed dirty/clone-on-write、gate 驱动的原子发布和崩溃恢复属于 P0-C2a/C2b。

## 验收

- 同标题不同 PDF 共存且不覆盖。
- 相同 source + fingerprint 重跑零写复用。
- fingerprint 或 source 变化创建新 generation/revision，旧 generation 与 overlay 保持不变。
- local-first/canonical-later 及反向顺序只有显式 reconciliation 才合并 alias。
- Viewer、validator、sandbox、trash/restore、Ask 和 study CLI 通过共享 resolver。
- legacy 2.0/2.1 可读、默认不可写且读取前后 hash/mtime 不变。
- 完整 repository/security/study/benchmark/build/smoke 回归通过。

## 实施结果

- 已新增 Library Layout 1.0 的 `paper.json`、`current.json` 与 overlay schemas、共享 no-follow resolver、正式契约文档和 ADR。
- prepare 已支持 exact-generation 零写复用、多 generation/revision、同标题共存、`--resume`、`--new-revision`、拒绝 `--replace`，以及显式且有审计记录的双向 identity reconciliation。
- Viewer、validation、render/scaffold、sandbox、migration、trash/restore、Ask/tags 和根脚本已迁移到共享 resolver；legacy flat 包读取兼容但所有写操作 fail closed。
- Library Layout 7/7、Paper Identity/prepare 17/17、repository/security 124/124、study/unit 76/76、Validation 21/21、PDF security 12/12、mandatory 2/2、external parser 5/5、reasoning/package 各 12/12、production build、HTTP security、smoke 与 Browser QA 全部通过。
- 官方 plugin validator 通过；canonical marketplace 重装 active path 为 `plugins/codex-paper/`，版本为 `2.0.0+codex.20260721114227`。
- 第二轮独立 Code Review 已逐项确认 B1/H1 修复并无条件 Approve；当前状态为 `Review 完成 / 未推送`。M2 保持开启，阶段提交和远端 CI 通过后进入 P0-C2a。

## 回滚

本阶段不迁移现有 flat 包。回滚代码后，旧包仍按原路径存在；新 managed store 不会被旧版本识别，但也不会被删除或覆盖。恢复支持需要保留整个 `.codex-paper/store-v1` 与 `index.json`。
