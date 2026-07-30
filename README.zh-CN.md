<div align="center">

# Codex Paper

**将研究论文转化为综合学习环境**

[English](README.md) | [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Codex Plugin](https://img.shields.io/badge/Codex-Plugin-blue)](https://openai.com)

Codex Paper 是一个 Codex 插件，可以把研究论文转化为可复用的论文学习包。它会先构建只来自论文本身的证据记录和结构化研究推理分析，再让 Codex 基于这些证据撰写学习笔记、方法解释、代码演示、图表导读、交互式页面和后续问答上下文，而不是把原始解析结果直接模板化成学习材料。

<table>
  <tr>
    <td align="center">
      <img src="assets/library.png" alt="Codex Paper 论文库，包含搜索、标签筛选和收藏索引" width="100%"/>
      <br/>
      <sub>论文库 - 搜索、筛选并打开已保存的论文学习包</sub>
    </td>
    <td align="center">
      <img src="assets/paper.png" alt="单篇论文学习页，展示学习笔记、研究推理和证据审计" width="100%"/>
      <br/>
      <sub>论文学习页 - 阅读证据驱动的笔记、研究推理、证据审计和追问上下文</sub>
    </td>
  </tr>
</table>

</div>

## 功能特性

- **自动 PDF 解析** - 使用分层解析器提取标题、作者、摘要、章节和代码链接
- **有界 PDF 摄取** - HTTPS-only 下载、逐跳 SSRF 校验、DNS pin、128 MiB 流式上限、隔离解析、页数/资源预算和私有有界 quarantine
- **长论文处理** - 解析大型论文时记录质量标记，并在抽取不完整时保守降级
- **代码仓库检测** - 自动发现 GitHub、arXiv、CodeOcean 链接
- **Evidence-first 论文准备** - 先生成内部证据文件 `paper-data.json`、`facts.json`、`analysis.json`
- **类型化定量结果** - Package 2.1 将指标数值绑定到任务、数据集、位置和直接论文证据，同时保留 `keyResults` 兼容投影
- **证据账本** - 写出 `evidence-ledger.json`，包含稳定 evidence ID、逐页文本、章节树、证据单元、自然位置和解析质量降级标记
- **研究推理分析** - 新增 `reasoning-analysis.json`，记录中心主张、研究问题、作者推理路径、验证、最弱假设、最小复现、最强反例、后续研究和不确定区域
- **语义验证** - 检查 schema、证据引用、source type、数字 grounding、推理图环路、批判性分析覆盖和模板残留
- **Context modes** - 默认离线 `paper-only`；`canonical` 和 `literature` 将外部证据单独写入 `.codex-paper/external-evidence.json`，不混入论文证据账本
- **确定性解析门禁** - 每个 PR 必跑两个可再分发 synthetic PDF；独立的 5 篇外部论文语料在 CI 中保持可选
- **Reasoning/package benchmark** - 新增确定性 fixtures，回归检查研究推理质量和可见学习包质量
- **Codex 写作学习包** - 基于论文正文和证据生成 `README.md`、`summary.md`、`insights.md`、`method.md`、`mental-model.md`、`reflection.md`、`qa.md`
- **克制的图表学习路径** - 生成 `visual-assets.md`，只在合适位置插入有来源、有解释、能帮助理解的高价值图表和确定性图解
- **代码演示** - 至少生成一个可独立运行、与论文核心概念相关的代码示例
- **安全配对的本地网页查看器** - 仅监听 loopback，提供 session/CSRF 防护、安全文件边界、可恢复回收站，并隐藏内部 JSON
- **Ask Codex 追问** - 可以在单篇论文页向 Codex 提问，并把回答保存到 `chat-notes.md`
- **智能评估** - 难度级别和论文类型检测，实现自适应内容生成

---

## Codex 插件结构

这个仓库仅保留一份权威 Codex 插件实现，位于 `plugins/codex-paper/`：

- Codex 插件根目录：`plugins/codex-paper/`
- Codex manifest：`plugins/codex-paper/.codex-plugin/plugin.json`
- 仓库内 marketplace 条目：`.agents/plugins/marketplace.json`
- 根安装、构建和测试自动化入口：`scripts/codex-paper.sh`

安装必须使用指向 `plugins/codex-paper/` 的仓库 marketplace 条目。原顶层 legacy tree 已删除，仅保留在 Git 历史中。如果本地脚本硬编码了旧的 singular tree 路径，请从仓库 marketplace 重新安装，并把脚本改为使用 `plugins/codex-paper/`。

对外使用时，插件名和 skill 名是分开的：

- 插件名：`codex-paper`
- 深度阅读 skill：`$paper-study`
- 快速摘要 skill：`$paper-summary`
- 网页查看器 skill：`$paper-webui`
- 追问问答 skill：`$paper-chat`

---

## 快速开始

### 安装

将这个仓库注册为 Codex marketplace：

```bash
git clone https://github.com/byxshr/codex-paper.git ~/codex-paper
```

在 `~/.codex/config.toml` 中添加 marketplace 并启用插件：

```toml
[marketplaces.codex-paper]
source_type = "local"
source = "/Users/YOUR_USER/codex-paper"

[plugins."codex-paper@codex-paper"]
enabled = true
```

把 `/Users/YOUR_USER/codex-paper` 替换成你 clone 后的绝对路径，然后重启 Codex。打开 `/plugins`，搜索 `codex-paper`，如果插件浏览器提示安装或启用，按提示操作即可。

如果你已经安装过旧版 Codex Paper，拉取本仓库更新后需要在 `/plugins` 里更新或重装插件。优先选择指向当前 checkout 的本地 marketplace 条目。如果旧的 `codex-paper@codex-paper` 和本地 `codex-paper@codex-paper-local` 同时启用，请禁用过期条目，避免 Codex 加载旧版本。

重启后可以这样使用：

```text
请使用 $paper-study 阅读 ~/Downloads/attention-is-all-you-need.pdf 这篇论文，并用中文生成完整学习包。
```

如果只需要快速摘要：

```text
请使用 $paper-summary 快速总结 https://arxiv.org/abs/1706.03762
```

仓库安装命令会：
- 校验 Node.js/npm，并创建私有、hash 锁定的 Python runtime
- 在禁止依赖生命周期脚本的前提下安装两套 Node.js 依赖
- 在 `~/codex-papers/` 创建论文目录
- 初始化搜索索引
- 安装网页查看器依赖项

### 系统要求

- **Node.js**: 固定为 22.23.1
- **npm**: 固定为 10.9.8
- **CPython**: 固定为 3.11.15，仅用于创建受管 venv
- **Codex**: 支持插件的最新版本
- **原生运行时检查工具**:
  - **macOS**: 安装 Xcode Command Line Tools（`xcode-select --install`），提供 `otool`、`install_name_tool` 和 `codesign`
  - **Linux**: 安装提供 `readelf` 的 `binutils`；bootstrap 必须已经使用可重定位或系统原生库引用
- **poppler-utils**: 用于 PDF 图像提取（通过系统包管理器安装）
  - **macOS**: `brew install poppler`
  - **Ubuntu/Debian**: `sudo apt-get install poppler-utils`
  - **Arch Linux**: `sudo pacman -S poppler`

---

## 使用方法

### 学习研究论文

直接与 Codex 对话来学习论文：

```
请使用 $paper-study 阅读 ~/Downloads/attention-is-all-you-need.pdf 这篇论文，并用中文生成完整学习包。
```

您也可以使用 URL：

```
# 直接 PDF 链接
请使用 $paper-study 阅读 https://arxiv.org/pdf/1706.03762.pdf 这篇论文

# arXiv 摘要链接（自动转换为 PDF）
请使用 $paper-study 阅读 https://arxiv.org/abs/1706.03762 这篇论文
```

远程论文输入必须使用 HTTPS。初始请求和每次重定向都会拒绝 private、loopback、link-local、metadata、reserved、ULA 和 IPv4-mapped 地址，并固定连接到已验证 IP。系统以 `%PDF-` 签名和受限 parser 成功为硬条件；`.pdf` 后缀和 `Content-Type` 只作为辅助信号。

如果只需要快速摘要：

```
请使用 $paper-summary 快速总结 https://arxiv.org/abs/1706.03762
```

如果想追问已经生成的学习包：

```
请使用 $paper-chat 回答 ~/codex-papers/papers/attention-is-all-you-need 这篇论文的问题：
self-attention 和循环式序列建模的关键差异是什么？
```

Codex 将自动触发学习工作流程并：
1. 解析 PDF，准备元数据、正文、facts、analysis 和证据账本
2. 推断论文 profile，脚手架生成 `reasoning-analysis.json`，并阅读对应 profile 契约
3. 从论文证据中填写研究推理，然后在写作可见材料前运行严格语义验证
4. 基于证据写作完整学习材料，而不是直接渲染机器 JSON
5. 生成自包含的 `index.html` 交互式探索器
6. 创建至少一个可独立运行的代码演示
7. 复制原始 `paper.pdf`，筛选关键视觉资产，避免把低价值碎图堆进阅读流
8. 创建隐藏的问答证据导航包，方便后续 grounded 追问
9. 更新全局搜索索引
10. 刷新论文库索引，方便网页查看器展示；需要查看时可用 `$paper-webui` 启动

### 启动网页查看器

```text
请使用 $paper-webui 启动 Codex Paper 网页查看器。
```

启动终端会打印一个新的配对令牌。打开 **http://127.0.0.1:5815**，在配对门禁中粘贴该令牌，并妥善保管。令牌只通过请求 body 换取 HttpOnly session，不应放入 URL。

进入 Viewer 后，您可以：
- 浏览所有已学习的论文
- 查看生成的 Markdown、HTML、PDF、图片和代码材料
- 查看 HTML 源码，并由用户显式开启不执行脚本的“静态安全预览”；Viewer 永不执行生成型 JavaScript
- 以结构化单元格阅读 Notebook；HTML、SVG 与 JavaScript rich output 会降级为可见的阻断文本
- 查看 SVG 源码或安全下载文件，而不是内联渲染
- 访问代码演示
- 在单篇论文页向 Codex 追问，并把回答保存到 `chat-notes.md`
- 搜索论文库
- 把论文移入可恢复回收站，并在 Trash 面板中恢复

服务只绑定 IPv4 loopback。每次重启都会使旧 Viewer session 失效并生成新配对令牌。SPA 使用仅允许同源脚本的严格 CSP；Markdown 与模型回答统一在服务端渲染和净化。API/文件系统边界见 [`docs/local-viewer-security.md`](docs/local-viewer-security.md)，渲染边界见 [`docs/web-active-content-security.md`](docs/web-active-content-security.md)。

Ask Codex 会在网页首次提问时懒启动一个长期运行的 `codex mcp-server` worker。网页查看器会为每篇论文保留独立的 Codex thread 和请求队列，因此同一论文的后续追问可以复用对话上下文，不再每次启动新的 `codex exec` 进程。一次 reply 抛错或返回空内容，只会使当前论文缓存的 thread 失效；下一次请求可创建新 thread，不会重置其他论文或共享 worker。答案一旦生成，即使聊天笔记持久化、锁释放或富 Markdown 渲染失败也会返回；渲染失败时使用转义后的安全纯文本，并携带明确的已保存/未保存状态与警告。轻量的进程内 paper lease 会让进行中的 Ask 与 Web 删除产生可重试冲突，注册和外部调用均不获取或长期持有跨进程锁。回答仍然运行在只读 sandbox 中，并优先使用 `.codex-paper/answering-pack.md`；旧学习包没有该文件时，会回退到用户可见 Markdown 材料和本地证据文件。

---

## 论文存储结构

新学习包使用 Paper Library Layout 1.0。路由 slug 只是 index alias；所有 CLI 与 Viewer 请求都解析权威 `current.json`，不再自行拼接 `papers/{slug}`：

```
~/codex-papers/
├── .codex-paper/workspaces-v1/{workspaceId}/ # 私有 authoring/validation 或发布 journal
│   ├── workspace.json                        # 有界状态与 publish intent
│   ├── publication.json                      # sealing 后的有界幂等恢复 journal
│   └── package/                              # 发布原子移动前存在
├── .codex-paper/locks-v1/                    # 跨进程锁 owner records
├── .codex-paper/store-v1/papers/{paperKey}/
│   ├── paper.json                       # paper identity alias 与 reconciliation 审计
│   ├── current.json                     # 当前 source/generation 的唯一权威指针
│   ├── overlay/                         # 位于 generation 外的可变状态
│   │   ├── state.json                   # tags、进度和注释
│   │   ├── chat-notes.md                # 追问笔记
│   │   └── files/                       # 用户文件（Viewer 中映射到 user/）
│   └── sources/{sourceRevision}/generations/{generation}/package/
│       ├── README.md、summary.md、insights.md、method.md 等
│       ├── paper.pdf、images/、code/、index.html
│       ├── paper-data.json、evidence-ledger.json、facts.json、analysis.json
│       ├── reasoning-analysis.json、meta.json
│       └── .codex-paper/                 # identity、validation、answering 与 sealed generation manifest
├── papers/{legacy-slug}/                 # 既有 flat 2.0/2.1 包；显式迁移前只读
├── index.json                            # 搜索/兼容投影，不是 identity 权威
└── .trash/{trashId}/{tombstone,payload}  # 可恢复生命周期 envelope
```

### 验证和迁移

运行完整确定性套件：

```bash
bash scripts/codex-paper.sh install
bash scripts/codex-paper.sh runtime-status
bash scripts/codex-paper.sh dependency-audit
bash scripts/codex-paper.sh secret-scan
bash scripts/codex-paper.sh supply-chain-test
bash scripts/codex-paper.sh test
bash scripts/codex-paper.sh identity-test
bash scripts/codex-paper.sh layout-test
bash scripts/codex-paper.sh storage-test
bash scripts/codex-paper.sh publication-test
bash scripts/codex-paper.sh benchmark-mandatory
bash scripts/codex-paper.sh benchmark-all
bash scripts/codex-paper.sh smoke-test
bash scripts/codex-paper.sh build
```

prepare 阶段的新生成内容只进入私有 generation workspace；不会创建或修改 `paper.json`、`current.json`、正式 store 或 `index.json`，也不会提前出现在 Viewer。后续操作必须显式使用 prepare 返回的 workspace ID 或路径，不会自动选择“最新 workspace”。workspace authoring 通过共享 writer 与 CAS 完成：

```bash
bash scripts/codex-paper.sh workspace-list --json
bash scripts/codex-paper.sh workspace-inspect <workspace-id-or-path> --json
bash scripts/codex-paper.sh workspace-write <workspace> README.md --stdin --expect-absent
bash scripts/codex-paper.sh workspace-tags <workspace> --tag <领域> --tag <方法>
bash scripts/codex-paper.sh workspace-abandon <workspace> --json
bash scripts/codex-paper.sh publish-workspace <validated-workspace> --json
bash scripts/codex-paper.sh publication-recover --json
bash scripts/codex-paper.sh reindex --json
```

只有 `phase=complete`、intrinsic `publishable=true` 且标准策略为 `allow_publish` 的 Validation Report 才能发布。`current.json` 是 Viewer 可见性的提交点，`index.json` 只是可重建投影；正式 generation 每次权威解析都会核验 manifest，既有无 manifest 的 managed generation 继续按兼容模式只读。

验证一个已完成的学习包：

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js {paper-route-slug}
node plugins/codex-paper/skills/study/scripts/validate-study-package.js {paper-route-slug}
```

reasoning 命令生成 draft 阶段的 `allow_authoring` 门禁；最终标准门禁允许 `pass_with_warnings` 发布，只有在明确要求 warning 也阻断时才添加 `--strict`。两个命令都原位更新唯一的 `.codex-paper/validation-report.json`。学习包校验只做静态检查，绝不执行生成代码。可选执行使用单独准备的 Docker sandbox，并且每次都要求绑定当前代码哈希的新授权：

```bash
# 显式准备：构建 digest 固定的镜像并运行一致性测试
bash scripts/codex-paper.sh sandbox-setup

# 查看文件、哈希、命令、权限边界和资源限制
bash scripts/codex-paper.sh sandbox-plan {paper-route-slug}

# 仅在用户明确同意该计划后执行
bash scripts/codex-paper.sh sandbox-run {paper-route-slug} --approval-token <one-time-token>
```

该令牌绑定精确计划并阻止重放，但不认证人类身份。Agent 流程必须在展示计划后暂停，等待用户新的明确同意后才能执行。

没有通过一致性测试的 Docker 时，runner 会返回 `unavailable` 或 `nonconformant`，绝不会退回宿主机 Python、Node 或 shell。容器无网络，只读挂载 `code/`，不继承宿主凭据，并且只能写入受限临时目录。

将旧学习包迁移为草稿证据/推理文件，不编造高层研究分析：

```bash
bash scripts/codex-paper.sh migrate ~/codex-papers/papers/{paper-slug}
```

库外 package 目录需要显式迁移：

```bash
bash scripts/codex-paper.sh migrate /path/to/package --external-path
```

迁移只接受库内规范化的一层 legacy package，或显式指定的真正库外 package。即使传入 `--external-path`，managed workspace/store 路径、符号链接和库内嵌套路径仍会被拒绝。

填写草稿推理分析前，可以先做一次迁移结果 sanity check：

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js {paper-route-slug} --allow-draft
```

详细契约见 [Paper Library Layout 1.0](docs/paper-library-layout-1.0.md)、[证据账本](docs/evidence-ledger.md)、[研究推理分析](docs/reasoning-analysis.md)、[学习包契约](docs/package-v2.md)和[迁移指南](docs/migration-v1-to-v2.md)。

---

## 架构

### 插件结构

```
codex-paper/
├── .agents/
│   └── plugins/
│       └── marketplace.json          # 权威 marketplace 目录
├── plugins/
│   └── codex-paper/
│       ├── .codex-plugin/
│       │   └── plugin.json              # 插件清单
│       ├── skills/
│       │   ├── study/
│       │   │   ├── SKILL.md             # 学习工作流定义
│       │   │   └── scripts/
│       │   │       ├── parse-pdf.js     # 稳定 JSON 解析器
│       │   │       ├── prepare-paper.js # 标准化论文准备入口
│       │   │       └── extract-images.py
│       │   ├── summary/
│       │   │   └── SKILL.md             # 带证据约束的快速摘要
│       │   ├── chat/
│       │   │   └── SKILL.md             # 基于证据的追问问答
│       │   └── webui/
│       │       └── SKILL.md             # 本地网页查看器启动
│       ├── hooks/
│       │   ├── hooks.json               # 会话生命周期钩子
│       │   └── check-install.sh
│       ├── src/
│       │   └── web/                     # Nuxt.js 网页查看器
│       └── package.json
├── scripts/
│   ├── codex-paper.sh                # 根安装、构建和测试入口
│   └── check-repository.mjs          # 仓库契约门禁
├── benchmarks/
│   ├── fixtures/pdf/                    # 可再分发的确定性 PDF fixtures
│   ├── mandatory/                       # 不可跳过的断言与预期缺陷
│   ├── manifest.json                    # 可选外部 parser corpus
│   ├── gold/                            # 外部论文的人工期望
│   ├── reasoning/                       # reasoning validator fixtures
│   ├── packages/                        # 可见学习包质量 fixtures
│   ├── run-mandatory-benchmark.mjs      # 受限 PDF-to-validator 门禁
│   ├── run-benchmark.mjs                # 可选外部 benchmark 执行器
│   ├── run-reasoning-benchmark.mjs      # reasoning benchmark 入口
│   ├── run-package-benchmark.mjs        # package benchmark 入口
│   └── benchmark-report.mjs             # 可读报告格式化脚本
└── README.md
```

### 核心组件

1. **学习技能** - Codex 论文阅读和写作 agent，负责生成完整学习包
2. **PDF 解析器** - 使用 `PyMuPDF` 优先、`pdf-parse` 回退的分层解析器，并稳定输出 JSON
3. **图像提取器** - PDF 图表提取的 Python 脚本
4. **准备链路** - 在私有 generation workspace 中生成 `paper-data.json`、`facts.json`、`analysis.json`、`meta.json` 和 `evidence-ledger.json`；只有完成标准 Validation gate 并显式发布后才更新 current/index
5. **研究推理验证** - 使用 `reasoning-analysis.json`、论文 profile 和 `validate-reasoning.js` 约束证据引用、source type、数字 grounding、推理 DAG 和批判性分析
6. **网页查看器** - 带 Nitro API 的 Nuxt.js 应用，默认展示用户材料，隐藏机器 JSON，并展示证据审计和作者推理视图
7. **Ask Codex API** - 复用长期运行的 Codex MCP worker 处理基于证据的追问，并将回答追加到 `chat-notes.md`
8. **Runtime 与供应链策略** - 显式 runtime setup、依赖审计、secret scan 和不可变供应链复核

---

## 开发

### 单一入口脚本

本地安装和测试统一通过一个根目录脚本完成：

```bash
bash scripts/codex-paper.sh install
bash scripts/codex-paper.sh build
bash scripts/codex-paper.sh start
bash scripts/codex-paper.sh stop
bash scripts/codex-paper.sh status
bash scripts/codex-paper.sh runtime-setup
bash scripts/codex-paper.sh runtime-status
bash scripts/codex-paper.sh dependency-audit
bash scripts/codex-paper.sh secret-scan
bash scripts/codex-paper.sh supply-chain-test
bash scripts/codex-paper.sh repo-test
bash scripts/codex-paper.sh smoke-test
bash scripts/codex-paper.sh benchmark-mandatory
bash scripts/codex-paper.sh benchmark
bash scripts/codex-paper.sh benchmark-all
bash scripts/codex-paper.sh benchmark-report
```

这样用户只需要记一个入口，`scripts/common.sh` 继续只做内部复用。

### 运行测试

```bash
# 无需受管 Python，单独运行静态 Repository Guard mutation tests
bash scripts/codex-paper.sh repo-test

# 测试 PDF 解析
node plugins/codex-paper/skills/study/scripts/parse-pdf.js /path/to/paper.pdf

# 测试 HTTPS downloader、parser 预算和私有 quarantine
bash scripts/codex-paper.sh pdf-security-test

# 先准备论文数据、facts.json 和 evidence-ledger.json
node plugins/codex-paper/skills/study/scripts/prepare-paper.js /path/to/paper.pdf --workflow study --language zh

# 测试 identity、fingerprint、只读复用和 flat-layout 碰撞保护
bash scripts/codex-paper.sh identity-test

# 校验研究推理
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js paper-slug

# 校验已生成的学习包
node plugins/codex-paper/skills/study/scripts/validate-study-package.js paper-slug --lang zh

# 运行 Validation Report 1.0 契约测试
bash scripts/codex-paper.sh validation-test

# 查看可选生成代码 sandbox 能力（不会执行代码）
bash scripts/codex-paper.sh sandbox-status

# 运行不可跳过的 synthetic PDF-to-validator 回归
bash scripts/codex-paper.sh benchmark-mandatory

# 运行 mandatory PDF、可选外部 parser、reasoning 和 package benchmark
bash scripts/codex-paper.sh benchmark-all

# 测试网页查看器
bash scripts/codex-paper.sh start
```

### 生产构建

```bash
# 构建网页查看器
bash scripts/codex-paper.sh build

# 构建的查看器将在 plugins/codex-paper/src/web/.output/ 目录中
```

---

## 配置

### 环境变量

无需配置！插件使用合理的默认值：

- **论文目录**: `~/codex-papers/`
- **Benchmark 目录**: `~/codex-papers/paper-examples`
- **网页查看器端口**: `5815`
- **长论文行为**: 抽取质量标记和保守降级信息会记录在生成的学习包中

### 高级自定义

您可以通过编辑这些文件来修改行为：

- `plugins/codex-paper/skills/study/SKILL.md`
- `plugins/codex-paper/skills/summary/SKILL.md`
- `benchmarks/gold/*.json`

---

## 贡献

欢迎贡献！请：

1. Fork 仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 进行更改
4. 如适用，添加测试
5. 提交更改 (`git commit -m 'add amazing feature'`)
6. 推送到分支 (`git push origin feature/amazing-feature`)
7. 打开 Pull Request

---

## 许可证

本项目采用 **MIT 许可证** - 详见 [LICENSE](LICENSE) 文件。

---

## 致谢

- 面向 Codex 构建
- PDF 解析由 [PyMuPDF](https://pymupdf.readthedocs.io/) 提供主路径，并以 [pdf-parse](https://www.npmjs.com/package/pdf-parse) 作为回退
- 网页查看器由 [Nuxt.js](https://nuxt.com) 构建
- 数学渲染由 [KaTeX](https://katex.org) 提供支持
- 感谢 [alaliqing/claude-paper](https://github.com/alaliqing/claude-paper/) 和 [FeijiangHan/PaperForge](https://github.com/FeijiangHan/PaperForge) 带来的设计启发
