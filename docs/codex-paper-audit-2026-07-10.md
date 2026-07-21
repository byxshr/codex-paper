# Codex Paper 项目全面审计与优先级建议

- 审计日期：2026-07-10
- 审计基线：`byxshr/codex-paper` 的 `main@9371b93`
- 方案修订：2026-07-10，开发分支 `codex/audit-optimizations-2026-07-10`
- 样本产物：`attention-is-all-you-need.zip`（本文提到的“样本”或“样本产物”，均指本地目录 `/Users/bianyuxin/codex-papers/papers/attention-is-all-you-need` 中的文件）
- 审计范围：产品定位、`$paper-study` 工作流、PDF 解析、证据/推理数据、质量门禁、CI/benchmark、本地 Web UI、安全边界、存储生命周期、可维护性、发布与可复现性

## 1. 总体判断

Codex Paper 的**产品方向是成立的**：它不是简单摘要器，而是在构建“论文证据 → 推理结构 → 学习材料 → 交互阅读/追问”的本地学习环境。上传样本的用户可见内容整体质量较高，说明工作流设计、提示契约和学习材料的信息架构已经有明显价值。

当前最主要的问题不是功能不足，而是：

> **系统对外给出的“PASS / semantic validation / evidence grounded”信号，强于当前代码真正能保证的质量。**

样本中可见学习材料较好，但底层 `facts.json`、`analysis.json` 已出现明显语义错误，最终 `validation-report.json` 仍然是零警告 PASS。当前 skill 虽然把这两份文件定义为低层提示、把 `reasoning-analysis.json` 定义为最终推理权威，但验证报告没有清楚声明验证边界，错误提示仍可能影响后续生成、回退问答和未来自动化消费。这是“最终材料可能正确，但中间数据与质量徽章含义不清”的结构性风险。

建议先暂停扩展更多学习文档或 UI 功能，把下一阶段主线定为：

1. **先收紧安全边界，阻断主动内容、危险删除、任意代码执行和不受限下载解析**；
2. **让 PASS 值得信任，并明确它覆盖哪些工件、哪些问题属于 warning、哪些必须 fail**；
3. **让生成过程防覆盖、可回归、可恢复、可复现**；
4. 然后再做高级解析、体验和生态扩张。

## 2. 样本学习包审计

### 2.1 做得好的部分

1. **用户可见材料完整且有学习路径**：README、综述、方法、洞见、心智模型、反思、主动回忆问答、视觉索引、交互页和代码 demo 形成闭环。
2. **证据边界意识较强**：可见材料明确区分论文主张、分析推断和研究猜想，并多次使用页码/Table/Figure 自然定位。
3. **发现并保留了论文内部不一致**：材料指出 EN-FR 结果在摘要/Table 2 为 41.8、局部 prose 为 41.0，而不是强行抹平。
4. **代码 demo 可独立运行**：`code/multi_head_attention_probe.py` 在本次审查中正常执行，且没有外部依赖或联网行为。
5. **交互页为单文件、自包含**：上传包的 `index.html` 没有外链脚本或运行时 fetch，便于离线使用。
6. **视觉材料克制**：正文只使用两张高价值论文图，其余原始抽取图用于追溯。

### 2.2 样本暴露的关键缺陷

#### A. `facts.json` 把年份误当实验结果

样本中三个 `keyResults` 分别为：

- 28.4：正确的 EN-DE BLEU；
- 2014：来自 “WMT 2014”，实际应抽取同句中的 41.8；
- 2017：来自会议年份，不是实验结果。

这说明当前规则本质上是“候选句包含结果词或数字，就取第一个数字”，而不是理解 `task / dataset / metric / value / unit / model / comparator`。

#### B. 前置页噪声污染了 claim 和 analysis

- 核心 claim 尾部混入 `∗Equal contribution.`；
- `analysis.json` 的贡献项混入版权许可文本；
- benchmark 被错误回退为论文标题；
- `coreIdea` 退化为 prior-work 描述；
- `analysis.json` 使用 `claim:0`、`result:1` 这类间接引用，而非统一证据 ID。

#### C. 质量门禁没有发现上述错误

`.codex-paper/validation-report.json` 返回：

```json
{
  "status": "pass",
  "errors": [],
  "warnings": [],
  "stats": {
    "paperClaims": 24,
    "inferences": 10,
    "speculations": 2,
    "evidenceCoverage": 1
  }
}
```

这里的 `evidenceCoverage=1` 只证明引用 ID 存在，并不能证明引用内容与 claim 语义匹配，更不能证明抽取到的数值就是指标值。

#### D. 解析质量标记过度乐观

`paper-data.json` 的 public section 投影只有 `abstract/introduction/conclusion`，首页 abstract 曾混入脚注、会议信息和版本信息，但 `warnings=[]`、`qualityFlags=[]`。`evidence-ledger.json` 又将 reading order 和 section coverage 标为 high。三个 public section 本身不能证明 coverage 不足；真正的问题是 high/low 判断没有由 benchmark 校准，且已经观察到的污染没有降级质量标记。

#### E. 低层提示与最终推理权威已经发生分叉

用户可见材料正确写出了 41.8、识别了版权噪声和 baseline 控制问题；低层 `facts.json/analysis.json` 却仍错误。当前 skill 明确规定 `analysis.json` 只是低层提示，`reasoning-analysis.json` 才是最终推理权威；当前 Web evidence audit 读取 reasoning，Ask Codex 也优先使用用户可见材料和 reasoning，只有证据不足时才回退到底层提示。因此，“当前 Web 一定展示错误 facts”或“Ask 优先读取错误中间产物”并不准确。

真实风险是：

- Codex 在撰写 reasoning 和可见材料时仍会读取这些低层提示，必须依赖再次阅读原文来纠错；
- Ask Codex 在高优先级材料不足时仍可能回退到错误提示；
- facts/analysis 仍通过 API 或本地文件存在，未来自动评分、检索、跨论文比较可能直接消费它们；
- PASS 没有明确说明是否覆盖低层提示、reasoning、可见材料及跨工件一致性，容易被用户理解为“整个学习包均已验证”。

必须做出明确契约选择：要么把 facts/analysis 纳入门禁并保证其可靠性，要么正式将其降级、默认不暴露，并把 PASS 的验证范围限定清楚。

### 2.3 包体与可复现性

- 解压后 25 个文件，总计约 3.45 MB；PDF 约 2.22 MB，图片约 604 KB，JSON 约 584 KB。
- `evidence-ledger.json` 单文件约 486 KB；原始文本约 39.5k 字符，但 pages、evidence text、quote 三层文本合计约为原文的 2.87 倍，存在明显重复。
- ZIP 含 `__MACOSX/.../._paper.pdf`，导出流程未做平台元数据清理。
- `meta.json.generatedWith` 只有 plugin/parser 版本，缺少仓库 commit、skill hash、模型/运行时、生成参数、源文件 SHA、验证器版本、产物 hash 和人工修改状态。

## 3. 修订后的优先级总表

本表把“产品风险优先级”和“实施前置条件”分开：`S0` 不是产品风险等级，而是开始大规模开发前必须完成的仓库基线；P0 按安全、可信链和数据生命周期三条主线组织。表中每一行都是可独立进入开发、Review 和交付状态的工作包。

| 顺序 | 编号 | 优先级 | 改进项 | 主要风险/收益 | 预计工作量 |
|---:|---|---|---|---|---|
| 0 | `S0-1` | 前置 | 确立唯一 active tree 与契约基线 | 防止修复落入错误实现，建立后续 schema/fixture 边界 | 小 |
| 1 | `P0-A1` | P0 | 本地服务、危险写操作与路径边界 | 阻断未认证递归删除、非 loopback 暴露和 symlink 越界 | 中到大 |
| 2 | `P0-A2` | P0 | Web 主动内容隔离 | 阻断 Markdown、Ask、Notebook、SVG、HTML 的 XSS/同源执行链 | 中到大 |
| 3 | `P0-A3` | P0 | 生成代码执行策略与 sandbox | 防止论文或模型诱导的任意本地代码执行 | 中到大 |
| 4 | `P0-A4` | P0 | 下载器与 PDF parser 隔离/限额 | 防 SSRF、临时文件竞争、超大输入和解析资源耗尽 | 中到大 |
| 5 | `P0-B1` | P0 | 不可跳过的确定性回归与验收契约 | 以强制执行的可再分发 synthetic fixture 固定失败样本，防止真实 parser 缺陷绕过 CI | 中 |
| 6 | `P0-B2` | P0 | Typed ResultClaim、噪声过滤与直接证据引用 | 落地已冻结的 2.1 writer/reader 兼容契约，修复年份、脚注、版权和 benchmark 误抽 | 中到大 |
| 7 | `P0-B3` | P0 | 跨工件一致性门禁与三态健康状态 | 落地 Validation Report 1.0，让错误和不确定性可见、可定位、可失败 | 中到大 |
| 8 | `P0-C1` | P0 | 防碰撞 identity、幂等与禁止静默覆盖 | 防同名论文/版本覆盖和重跑清空用户数据 | 中 |
| 9 | `P0-C2` | P0 | 事务发布、共享锁、原子索引与最小 manifest | 防半成品、索引竞争和不可追溯产物进入正式库 | 大 |
| 10 | `P1-1` | P1 | 深层版面解析与 benchmark 校准 | 提升双栏、重复页眉页脚、脚注和表格结构准确率 | 大 |
| 11 | `P1-2` | P1 | 兼容实现、迁移与恢复工具 | 在 S0 已冻结政策上实现 migration、doctor、reindex、backup/restore 和回滚 | 大 |
| 12 | `P1-3` | P1 | 依赖治理、测试与仓库工程化 | 先完成供应链风险归因和运行时固定，再统一 workspace、CI 矩阵与 strict gates | 中到大 |
| 13 | `P1-4` | P1 | 统一完整 provenance | 把现有 source、execution、validation 和环境记录汇入唯一权威 manifest | 中到大 |
| 14 | `P1-5` | P1 | Web/API 流式 I/O、队列与可观测性 | 控制大文件内存、并发问答、取消/重启和错误契约 | 中到大 |
| 15 | `P1-6` | P1 | 分享策略、导出 allowlist 与版权元数据 | 避免无意分享原 PDF、原图、内部证据或私有上下文 | 中 |
| 16 | `P1-7` | P1 | 基础可访问性与隐私/生命周期控制 | 补齐键盘/ARIA、consent，以及 trash、quarantine、chat 和 report 的统一保留/删除策略 | 中到大 |
| 17 | `P2-1` | P2 | Evidence ledger v3 去重与索引 | 降低存储、token 和问答检索成本，同时保持引用兼容 | 大 |
| 18 | `P2-2` | P2 | 持久化学习进度与渐进式体验 | 在已有学习路线基础上增加书签、进度和复习状态 | 大 |
| 19 | `P2-3` | P2 | 校准后的高级质量 dashboard | 用可解释指标、趋势和 drill-down 替代新的不透明总分 | 大 |
| 20 | `P2-4` | P2 | 完整国际化与跨平台 UI 完善 | 扩展多语言、reduced-motion 和多平台交互一致性 | 大 |
| 21 | `P2-5` | P2 | Deterministic export、Release 与兼容矩阵 | 形成可校验、可安装、可升级的正式发布体系 | 大 |

## 4. Sprint 0 与 P0：必须优先完成

### S0-1：确立唯一 active tree 与契约基线

当前 marketplace 和开发脚本指向 `plugins/codex-paper/`，顶层 `plugin/` 是 legacy/reference tree；两棵树在 skill、脚本、Web UI 和 manifest 上已经明显分叉。继续保留两个可运行实现，会让安全和质量修复落入错误目录。

审计时“active tree 仍跟踪 `node_modules/`”这一事实已经过时：当前 `git ls-files` 中没有 tracked `node_modules`。因此不再创建“清理 tracked node_modules”开发项，只保留 CI 防回归规则。

#### 建议动作

1. 明确 `plugins/codex-paper/` 是唯一源码和发布输入。
2. 删除、归档或彻底去可执行化 `plugin/`；如短期必须保留，CI 应禁止其参与构建、测试和安装。
3. 所有根脚本、README、marketplace、测试和 fixture 只引用 active tree。
4. 定义本轮会修改的 schema 版本、兼容策略、fixture 许可边界和验证报告语义。
5. CI 禁止重新提交 `node_modules`、`.DS_Store`、`__pycache__`、`.output`、`.nuxt` 等构建/平台产物。

**退出条件**：仓库只有一个可安装、可构建、可测试的实现；所有命令和文档指向同一 tree；后续 P0 不存在“双写两份实现”的要求。

### P0-A：先收紧不可信输入与本地服务安全边界

论文、模型生成内容、代码 demo、Notebook、HTML/SVG 和远程 URL 都必须按不可信输入处理。P0-A 是最先启动的产品安全主线。

#### P0-A1：本地服务、危险写操作与路径边界

当前本地服务没有显式设置 `HOST/NITRO_HOST`；删除接口未统一使用 slug/path 校验，随后直接递归删除目录；file/raw API 只做 lexical containment，无法阻止目录内 symlink 指向外部路径。

建议：

- 服务显式绑定 `127.0.0.1`，不依赖框架或 Node 默认 host；
- 每次启动生成本地 bearer/session token，所有 library API 都要求认证；写操作再额外校验 Host、Origin 和 CSRF token；
- token 通过 same-origin bootstrap 或 `HttpOnly + SameSite=Strict` session 交给浏览器，不得进入 URL、history、referrer 或普通访问日志；
- delete、tags、Ask、file、raw、详情等 route 使用共享的操作级安全 resolver；
- 对既有目标使用 `lstat/no-follow` 和 realpath containment；对新目标校验最近存在父目录，并在持锁后完成 rename/delete，降低 symlink TOCTOU；
- hidden file、嵌套机器文件、路径编码和大小策略采用同一规则；
- 删除操作改为 trash/tombstone 或可恢复隔离区，并要求确认 token；禁止直接对拼接路径执行无保护的递归删除；
- 为 `..`、编码路径、symlink、跨目录引用、伪造 Origin、并发删除和恢复建立 route regression。

**验收条件**：任意路由参数都不能读写 `~/codex-papers` 允许范围外的文件；未认证请求不能读取 library，跨 Origin 请求不能执行写操作；误删可以恢复。

#### P0-A2：Web 主动内容隔离

当前 Ask 答案、Markdown 和 Notebook 最终进入 `v-html`；Notebook `text/html` 与 SVG 未净化；HTML iframe 同时允许 scripts 与 same-origin；新标签会执行由生成 HTML 构造的 blob。

建议：

- Markdown/Ask 默认禁用 raw HTML，或统一经过严格 sanitizer；
- Notebook Markdown、`text/html` 和 SVG 使用明确 allowlist，默认降级为转义文本；
- 默认关闭 HTML/Notebook 主动预览，直到隔离策略生效；
- iframe 去掉 `allow-same-origin`、`allow-forms`、`allow-popups`，使用 opaque 或独立随机 origin，并通过 preview CSP 禁止出站网络；
- 不直接在新标签执行未经审计的 blob；新窗口必须 `noopener,noreferrer`；
- 增加严格 CSP、`X-Content-Type-Options: nosniff`、frame 与 referrer 策略；
- fixture 覆盖事件处理器、`javascript:` URL、恶意 SVG、Notebook rich output、Ask 输出和 HTML 页面。

**验收条件**：Markdown、Ask、Notebook 和 SVG 中的不可信主动内容不能执行；如交互式 HTML 允许脚本，只能在 opaque/offline sandbox 内运行，不能访问 opener、父页面、应用 origin、本地 API、凭据或外部网络。

#### P0-A3：生成代码执行策略与 sandbox

验证器参数默认不执行代码，但标准 `$paper-study` 流程明确调用 `--run-code`，所以实际用户工作流仍会直接把生成的 `.py/.js` 交给本机 Python/Node，仅有 timeout 和输出 buffer。

建议：

- 标准流程默认只做静态检查，不再自动传 `--run-code`；
- 执行必须由用户明确同意，且每次展示文件、命令和权限边界；
- 增加 sandbox capability gate：平台没有通过 conformance tests 的受支持 sandbox 时，用户包执行功能保持不可用，而不是退回裸机执行；
- 使用容器或 OS sandbox：无网络、只读源目录、临时 HOME、空凭据环境、CPU/内存/进程/文件大小限制；
- 白名单解释器、扩展和参数，禁止 shell 透传；
- 记录代码 hash、实际命令、资源使用、输出截断、退出和超时原因；
- CI 只执行仓库内可信 fixture，和用户包执行策略分离。

**验收条件**：默认工作流不会执行生成代码；没有合格 sandbox 时明确拒绝执行；支持显式执行的平台无法联网、读取凭据或写入沙箱外目录。

#### P0-A4：下载器与 PDF parser 隔离/限额

当前 downloader 接受任意 HTTP/HTTPS 主机、跟随重定向、只检查 Content-Type，使用共享可预测临时路径且没有大小上限；parser 子进程缺少 wall time、CPU、内存和页数限制。

建议：

- 默认仅 HTTPS；初始请求和每次 redirect 都解析并验证目标地址，覆盖 IPv4、IPv6 ULA、IPv4-mapped IPv6、loopback、link-local、RFC1918、metadata 及保留地址；
- 连接固定到已验证 IP，同时保留原始 Host/SNI 并校验实际 peer address，防止 DNS rebinding；
- 流式强制 Content-Length 与实际接收字节上限；
- `%PDF-` magic 和受限 parser 成功是硬条件；扩展名、MIME 和合理页数作为附加策略信号，不能拒绝合法的无 `.pdf` 签名 URL；
- `mkdtemp` + 随机文件名 + `0600` + exclusive create，共享 staging 在成功/失败后都清理；
- parser 进程增加 wall time、CPU、内存、输出和页数限制；
- 对异常、加密、超大、解压炸弹式和 malformed PDF 使用私有 quarantine，定义权限、配额、保留周期和清理策略。

**验收条件**：SSRF redirect、无限流、伪 PDF、超大/加密/异常 PDF 都能在受控资源内失败，不留下共享临时垃圾。

### P0-B：建立可信、可回归的质量链

#### P0-B1：先建立不可跳过的确定性回归与验收契约

当前 CI 中真实 parser benchmark PDF 可以全部缺失并记为 skipped，最终仍以 exit 0 结束；reasoning/package benchmark 仍会运行，所以更准确的描述是“真实 parser 语料可全部跳过”，不是“整个 CI 什么都不跑”。

建议测试边界：

1. PR fixture 固定放在 `benchmarks/fixtures/pdf/`，只允许原创 synthetic 或有明确再分发许可的 PDF；每个 fixture 必须附 S0 约定的 SPDX/copyright/SHA-256/generator/`redistributable` manifest。Attention 本地样本继续只读且不得提交。
2. 将基础可信链拆成少量职责单一的 fixture，例如前置页噪声、结果表与数值冲突；不要为了 P0 制作一个同时承担高级双栏和 table-grid 质量断言的“大而全”PDF，这些 layout 断言留给 P1-1。
3. fixture 必须通过 P0-A4 的受限 parser supervisor 执行，再进入确定性的 `PDF → prepare → 固定 golden authoring boundary → validators`；不得为 benchmark 恢复无资源边界的 parser 快捷路径。
4. 先写失败 golden assertions，再修改提取实现；至少固定 Attention 样本暴露的年份、脚注、版权和 41.8/41.0 冲突，并预留 2.1 `resultClaims` 与 Validation Report 1.0 的期望边界。
5. 仓库内 mandatory parser suite 若实际执行数为 0，CI 必须失败；外部或 nightly corpus 可以 skip，但必须单独报告，不能替代 mandatory suite。
6. 真实 model-in-loop 生成可选放入 nightly 或人工评测，因为当前 reasoning 和可见材料由 Codex 撰写，不能伪装成完全确定性的 PR E2E；它不作为 P0-B1 的阻塞退出条件。
7. 安全恶意 fixture 已由 P0-A 覆盖；Node/Python 矩阵、lint/typecheck/coverage 归 P1-3。

**验收条件**：mandatory parser fixture 没有被执行时 CI 必红；Attention 风格缺陷在修复前可以稳定复现，修复后可以稳定防回归。

#### P0-B2：Typed ResultClaim、噪声过滤与直接证据引用

用结构化 ResultClaim 取代 `{label,value,context}`：

```json
{
  "task": "machine translation",
  "dataset": "WMT 2014",
  "split": "newstest2014",
  "languagePair": "EN-FR",
  "metric": "BLEU",
  "value": 41.8,
  "unit": "score",
  "model": "Transformer big",
  "comparator": "single-model state of the art",
  "direction": "higher_is_better",
  "location": {"page": 8, "table": 2},
  "evidenceRefs": ["ev-p008-tab-..."],
  "confidence": "high"
}
```

规则：

- 候选数字必须与 metric、表头或明确结果谓词绑定；
- 年份、页码、引用编号、版本号、GPU 数、训练天数默认不得成为主指标值；
- copyright、conference header、arXiv version、author footnote、running header/footer、reference 默认不得成为 claim/result/contribution；
- facts/analysis 使用统一 `ev-*` 证据 ID，不再把 `claim:0/result:1` 作为最终引用；
- P0 只实现样本所需的确定性噪声过滤和数值绑定；高级双栏、表格网格和 GROBID 放 P1-1；
- 不再重新设计版本策略，直接实现 S0 已冻结的 2.1 契约：writer 新增 `resultClaims` 和直接 `ev-*` refs，保留 `keyResults` 兼容 projection 至 3.0；reader 继续支持旧 `claim:n/result:n` refs，读取旧包不得隐式写回。

**样本验收标准**：结果包含 28.4 和 41.8，不包含 2014/2017；版权、会议头和 equal-contribution 脚注不进入核心事实。

#### P0-B3：跨工件一致性门禁与三态健康状态

按 S0 已冻结的 Validation Report 1.0 目标接口实施，不再定义第二套状态或报告。如果 facts/analysis 继续存在并可能被 Codex、Ask 或未来 API 消费，就必须纳入验证；如果维持不可信 hint 定位，则默认不得暴露，报告的 `scope.included/excluded` 必须明确排除范围。

门禁要求：

- 核心数字在 facts、analysis、reasoning 和用户可见材料之间引用同一证据；如果 S0 决定正式降级并默认不暴露 analysis，则报告必须明确排除范围；
- 可见材料不得新增底层未验证的数字；
- 同一指标出现冲突时必须记录 uncertainty/warning，不能静默选择；
- parser 污染必须进入报告；section coverage 和 reading-order 只有经过 benchmark 判定不足或不确定时才降级，不能仅凭 public section 字段数量推断；
- 将 `evidenceCoverage` 重命名或解释为 `referenceCoverage`，避免暗示语义正确；
- 现有 `.codex-paper/validation-report.json` 原位演进到 1.0 目标接口，包含 `phase`、`publishable`、scope、gate、validator、`generatedAt`、结构化 findings 和 `referenceCoverage`；不得创建并行报告；
- Web UI 直接读取 validation report 展示 warnings 并跳到 PDF location；validator 不得回写已验证材料；
- P0-B3 负责生成 intrinsic findings、`publishable`、gate outcome 和稳定 report hash；P0-C2 负责把该 hash 纳入 generation manifest，并以 gate outcome 决定是否进入正式库，避免 B3 依赖尚不存在的 manifest。

状态语义：

- `fail`：核心主张无证据、引用不存在、未披露的关键数值冲突、跨工件核心事实矛盾，或存在未隔离的主动内容；
- `pass_with_warnings`：最终材料正确且关键风险已隔离，但存在解析降级、论文内部冲突、低置信提示或非关键覆盖不足；
- `pass`：验证范围内没有未处理错误或 warning。

**样本验收标准**：41.8 vs 41.0 产生明确 warning；abstract 污染产生 parser warning；section coverage 仅在 benchmark 证明不足时降级。这些已确认问题存在时绝不能返回零 warning 的 `pass`。

### P0-C：先保证数据不丢失，再扩展完整版本历史

P0-C1 与 P0-C2 作为一个连续 epic 交付：C1 先冻结 identity、幂等、统一 resolver 和 immutable/overlay 数据模型，C2 紧接着实现跨进程事务发布和统一 writer；不得只完成 ID 计算却继续沿用 title slug 覆盖写入。为控制 Review 面和故障注入范围，两个父项各拆成两个内部子阶段，但仍按 22 个顶层工作包统计，父项状态按最保守子阶段汇总。

#### P0-C1：防碰撞 identity、幂等与禁止静默覆盖

当前目录只由 title slug 决定，`sourceSha256` 虽已计算却不参与 identity；重跑还可能把既有 tags 重置为空。

**P0-C1a：identity、fingerprint 与冲突策略**

- `paperId` 优先使用经过规范化且达到高置信阈值的 DOI/arXiv base ID；没有可信 canonical ID 时退化为稳定 source identity。canonical ID 只负责论文分组，永远不能绕过 source hash 隔离或触发覆盖；
- `sourceRevisionId = sourceSha256`，表示原始 PDF 字节版本；同一 `paperId` 下的不同 source hash 必须并存为不同 revision，并在 canonical-ID 冲突时给出明确诊断；
- `generationId = hash(sourceSha + generation contract/version + content-affecting inputs)`。content-affecting inputs 至少包括插件/skill 或代码摘要、parser policy、context/profile/language 与生成参数；时间、临时绝对路径等动态值不得进入 fingerprint；
- 明确区分 generation fingerprint 和 provenance：影响生成语义的输入参与 identity，OS patch、执行时间等仅记录在 provenance，除非契约证明它们会改变输出；
- slug 只负责展示和路由别名，不承担唯一性；同名冲突使用 identity 映射解决，不使用静默覆盖或 symlink alias；
- 不同 source hash 绝不能写入同一 source revision；同一 source 在生成契约、版本或参数变化时创建新的 generation；
- “相同输入幂等”限定为相同 source + 相同 generation fingerprint，不得覆盖不可变 generation；

**P0-C1b：物理布局、统一 resolver 与 overlay**

- 目标布局明确区分 paper identity、source revision、immutable generation、mutable overlay 和 authoritative `current` record；所有消费者通过共享 resolver 解析 slug/paperId/current generation，不自行拼接 `papers/<slug>`；
- 兼容读取现有 flat-layout 2.0/2.1 包，但默认只读且不得隐式搬迁或写回；旧包迁移必须走 P1-2 显式、可回滚流程；
- 禁止用目录 symlink 维持旧 slug 路径；Viewer、validator、sandbox、trash/restore、Ask 和根脚本必须使用同一个 no-follow resolver；
- 数据分层为 immutable generated revision（PDF、机器数据、生成材料、validation、generation manifest）与 mutable paper overlay（tags、chat notes、学习进度、用户注释）；
- 用户修改 manifest 管理的生成文件时标记 dirty 或 clone-on-write，不原地悄悄改写 manifest；
- tags 不再通过重新生成 `meta.json` 清空；Ask notes、学习进度和用户注释不得混入 immutable generation 或在不重验的情况下改变其 validation 语义；
- `meta.json`、index 和旧 slug 继续作为兼容 projection/alias，但不成为身份或生成事实权威；
- 默认保留 overlay、用户文件和未由 generation manifest 管理的文件；
- `--resume`、`--new-revision`、`--replace` 必须有明确且不可静默的行为。

**验收条件**：同标题不同 PDF 不覆盖；相同 source + generation fingerprint 重跑不产生随机重复包；同一 PDF 在生成版本变化后可以安全产生新 generation；旧 flat-layout 包可只读访问且 hash/mtime 不变；所有消费者经共享 resolver 工作；tags、Ask notes、用户 overlay 和手工文件不丢失。测试必须包含同标题不同 PDF、同 source 幂等、fingerprint 变化、canonical-ID 冲突、legacy 零写回和 overlay 保留 fixtures。

#### P0-C2：事务发布、共享锁、原子索引与最小 manifest

**P0-C2a：generation workspace、跨进程锁与共享 writer**

- staging 位于 `PAPERS_ROOT` 同一文件系统；prepare、reasoning authoring、render、validation 和最终发布整个多步流程都在 generation workspace 内完成，prepare 不得提前把半成品暴露为正式论文；
- prepare、render、validation、tags、Ask/chat、trash/restore、sandbox 和 index writer 共用一套存储库、per-paper/source/generation lock 和 index lock；P0-A1 的进程内互斥和部分原子 JSON 写入只是迁移基础，必须升级为可恢复的跨进程锁与共享 writer，不能作为 C2 已完成的证据；
- 明确锁顺序、超时、stale-lock 恢复和冲突语义；delete 与 prepare/chat 竞争时允许一方返回可重试 conflict，而不是要求所有操作同时成功；
- staging、锁、失败诊断和临时文件均遵守 no-follow、同文件系统、权限和有界清理策略；服务重启或进程崩溃后能够区分可恢复 workspace 与不可发布残留。

**P0-C2b：原子发布、authoritative manifest、index 与恢复**

- 写入不可变 generation 目录，完整 Validation Report 1.0 gate 允许后原子 rename，并以 authoritative current record/manifest 作为唯一 commit point；不要承诺 current 与 index 两个文件跨文件原子提交；
- index 在独立锁下使用 temp + fsync + rename，并作为可重建缓存；若 generation 已提交但尚未入 index，由 reindex 恢复；
- 失败包保留受控诊断信息，但不得进入正式 index；
- P0 最小 authoritative `generation-manifest.json` 只记录 paper/source/generation ID、source SHA、generation fingerprint、系统管理文件及 hash、transaction state、validation status/report hash；
- `meta.json` 和 index 保留现有消费者需要的兼容 projection，并记录 manifest ID/hash；生成事实以 manifest 为权威，projection 可重建。
- 只有 P0-B3 report 的 gate outcome 允许发布时才切换 authoritative current record；`fail` 或未完成验证的 generation 只能保留为受控诊断状态，不得进入正式 index。

**验收条件**：对每个 prepare/author/render/validate/publish 边界进行故障注入时均不污染正式库；并发 writer 遵循固定锁和可观察 conflict 语义，不静默丢更新；任一正式工件都能追到输入 hash、generation fingerprint 和 B3 report hash；overlay mutation 不改变 immutable generation hash，或明确产生 dirty/clone-on-write 状态；index 删除、损坏或落后时可由 authoritative records 最小重建。

完整 revision 浏览、复杂 resume、环境/model/人工编辑/migration history 放到 P1-2/P1-4。P0-C2 的工作量应按“大”估算，而不是“中”。

## 5. P1：可信基线之后的工程化与产品化

### P1-1：深层版面解析与 benchmark 校准

P0 已处理样本所需的数值绑定和前置噪声，P1-1 只保留真正的 layout 工作：

- 用 block/bbox/font 和跨页重复统计去除 header/footer、脚注、版权和会议信息；
- abstract 边界综合空间位置、字体和 section heading；
- 双栏阅读顺序使用坐标聚类，不直接信任 `page.get_text("text")`；
- 表格保留 row/column/header/grid 关系；
- year 使用有优先级的元数据、首页和正文来源；
- `readingOrder`、`sectionCoverage`、table quality 由 benchmark 校准，不能由 parser 名称或“找到三个 section”直接给 high；
- 可选接入 GROBID 等增强解析器，并保留离线 fallback。

P1-1 复用 P0-B1 的 deterministic fixture/golden 机制和 P0-B3 的稳定 finding code、location 与 report 语义；新增 layout fixture 时扩展同一条失败优先回归链，不另建无法对账的评分体系。

### P1-2：兼容实现、迁移与恢复工具

S0 已冻结 2.0 → 2.1 的兼容方向和 unknown-version 只读策略，P0-B2 已提供 2.1 writer/reader，并保留一个受限、显式的 v1 → 2.x migration 入口。本项不重复这条最低迁移路径；在 P0-C2 物理布局和 P1-4 manifest schema 稳定后，负责把 identity/layout/manifest 演进及未来 ledger v3 兼容承诺落实为可运维工具：

- evidence ID alias、引用迁移和旧包只读策略；
- 面向 identity/layout/manifest 的可重复、可回滚 migration，禁止隐式迁移或读取时写回；
- `doctor`、`reindex`、backup/restore 和 index/package drift 修复；
- migration 前后 hash、验证报告与失败恢复测试。

本项实现实际 package schema compatibility 与迁移能力；P2-5 只负责把已经通过验证的兼容范围公开为 release policy，不重复实现迁移逻辑。

### P1-3：依赖治理、测试与仓库工程化

S0 已解决唯一 active tree。P0-A 增加了 Web、Docker sandbox、Python parser launcher 和安全测试，production install 也已暴露需要归因的 npm audit 告警，因此本项拆成两个连续子阶段：

**P1-3a：前置依赖与运行时治理**

P1-3a 是 M2 期间允许启动的有界并行通道，不阻塞 P0-C1 identity/resolver 设计；但 Node/Python/Docker runtime 基线、依赖可达性结论和 content-affecting runtime 输入必须在 P0-C2 冻结 generation fingerprint 与 authoritative manifest 前反馈到主线。父项在实际启动前仍保持 `未开始`。

- 对 npm audit 告警逐项确认 production/dev 可达性，记录升级、替换、接受或暂缓理由；不以无边界的 `npm audit fix --force` 代替评估；
- 固定 Python 依赖清单、版本范围和隔离环境；
- 固定并校验当前声明支持的 Node/Python/Docker 版本，CI 和本地脚本使用同一运行时基线；
- 增加最小依赖审计、secret scan 和供应链变更审查门禁。

**P1-3b：仓库工程化**

- root npm workspace、统一 lockfile、本地 `npm install` 与 CI `npm ci`；
- package 增加 `engines`、`files`、`test`、`lint`、`typecheck`，TypeScript strict；
- CI 覆盖声明支持的 Node/Python 版本，逐步增加第二 OS；
- coverage、CodeQL 和 Dependabot/Renovate；
- CI 持续禁止 tracked `node_modules` 和其他生成物回归；
- 修正 README 中“hook 自动安装依赖”的过时描述，或实现真实、可控的依赖检查。

当前 tracked `node_modules` 已为 0，不再把删除它们列为待开发工作。

本项的 runtime/OS matrix 是实际 CI gate；P2-5 的兼容矩阵是基于这些结果对外发布和承诺的支持范围。

### P1-4：统一完整 provenance

本项不是从零新增记录，而是在 P0 最小 authoritative manifest 上统一已经存在的 source hash/parser policy、P0-A3 execution report、P0-B3 validation report，以及后续环境和人工编辑信息：

- 原始 URL、DOI/arXiv 版本、source SHA、获取时间；
- repo commit、plugin/skill/schema/validator 版本与完整生成参数；
- model/Codex/runtime、Node/Python/OS、parser backend；
- language、context mode、paper profile 和完整生成参数；
- 工件依赖图、现有 execution report、validation report 及其 hash；
- 人工编辑状态、最后编辑时间、migration history；
- manifest schema 和签名/校验策略。

只保留一个 authoritative manifest；`meta.json`、README 和 index 是兼容或展示 projection，并携带 manifest ID/hash，不复制另一套权威生成事实。

M3 中应先冻结 P1-4 manifest schema，再实施 P1-2 的 layout/manifest migration，避免迁移工具追逐仍在变化的目标结构；P0-C2 只交付可发布所需的最小 authoritative manifest。

### P1-5：Web/API 流式 I/O、队列与可观测性

P0-A1 已完成安全 path containment、进程内互斥、部分原子 JSON 写入以及公共文件的基础大小/深度/节点预算；这些不等于 P0-C2 的跨进程共享写入和事务发布。本项只处理仍缺失的可靠性与性能能力：

- PDF/图片使用 stream 和 range，不同步 `readFileSync` 整个文件；
- 补齐尚未覆盖的 JSON 深度、数组数量、Notebook cell/output 等结构预算，不重复实现已有单文件大小边界；
- 在现有统一 HTTP 错误码基础上增加 API schema validation 和 request ID；
- Ask 使用全局有界队列，支持超时、取消、服务重启和 thread 生命周期可观测；
- chat/index 写入复用 P0-C2 的锁与原子写库；
- 为 route latency、RSS、最大 PDF/pages/ledger/Notebook、Ask token budget 建立可测预算。

### P1-6：分享策略、导出 allowlist 与版权元数据

P1 必须把策略落实为可执行的最小安全分享能力：

- `local-full`：包含 PDF、内部 JSON、代码；
- `shareable`：默认排除原 PDF、原始抽图、内部 evidence 和 `.codex-paper` 私有上下文；
- `audit`：包含证据、manifest 和 validation report；
- 每种模式使用明确 allowlist，而不是“打包目录中剩余文件”；
- 实现 planner/filter、dry-run 文件清单、确认步骤和最小 shareable 目录输出；
- 输出前列出文件、许可和敏感内容，要求用户确认；
- 保留来源链接、作者、许可与引用信息。

Deterministic ZIP、签名和正式 release artifact 放 P2-5。

### P1-7：基础可访问性与隐私/生命周期控制

P0-A2 已移除 Google Fonts 并使用本地/system font stack，P0-A1/A3/A4 也分别引入 trash、execution report 和 quarantine 生命周期数据；其中 quarantine 已具备 7 天、32 项、512 MiB 的自动保留上限。本项不重复该自动清理实现，只保留公开使用前仍未完成的基础门槛：

- tab/button 增加 `aria-selected/pressed`、焦点状态和键盘导航；
- drawer 使用 dialog semantics、focus trap 和 Escape 关闭；
- iframe title、图片 alt、按钮显式 `type="button"`；
- Playwright + axe 建立基础可访问性回归；
- 在现有分散的 Viewer、主动内容、sandbox 和 PDF ingestion 安全文档上增加统一 SECURITY.md、隐私说明、信任边界和数据流；
- 实现 Ask consent gate，以及 thread/chat、trash、execution report 等其余数据的可见 retention/deletion enforcement 和控制入口；quarantine 重点补用户可见说明、查看/清理入口和策略配置，不重做既有自动上限；
- manifest 中的 privacy/terms 链接指向真实文档，不再指向仓库首页。

## 6. P2：性能、进阶体验与正式发布

### P2-1：Evidence ledger v3 去重与索引

样本 ledger 的 pages/evidence/quote 存在约 2.87 倍文本重复，但当前 schema、验证器、Web 和 reasoning refs 都依赖这些字段，不能直接机械去重。

建议：

- 先通过 P1-2 建立 schema compatibility 和 evidence alias；
- 文本只存一次，evidence 保存 offset/range、normalized hash 和短 preview；
- 稳定 ID 纳入 source SHA 和 normalized location；
- 大包使用 SQLite/JSONL + 索引，避免每次读取整个 JSON；
- 为 Ask 预构建检索索引和 token budget；
- 先测 size、latency、RSS，再决定迁移收益。

此项工作量应按“大”估算。

### P2-2：持久化学习进度与渐进式体验

Attention 样本已经具备阅读路线、时间建议、文件地图、隐藏答案和基础 PDF 页跳转，因此本项不是从零建设。剩余重点：

- 15 分钟、45 分钟、2 小时 route preset；
- 跨会话阅读进度、书签、已答问题和薄弱点；
- bbox 级 PDF deep-link，而不仅是页码；
- quiz 随机抽题、间隔复习和复习队列；
- 基于用户水平改写解释，但不修改底层事实；
- 持久化必须复用 P0/P1 的安全写入、隐私和迁移机制。

### P2-3：校准后的高级质量 dashboard

P0-B3 已提供明确三态和 warning。高级 dashboard 只有在 M2 的 identity/current-generation/manifest 语义稳定、并积累足够且可按 parser/contract 版本分组的 Validation Report 1.0 样本后才建设：

- parsing、grounding、consistency、execution、security、provenance 子指标；
- 历史趋势、版本对比和 warning drill-down；
- 从指标直接跳到工件、测试或 PDF evidence；
- 不用单一不透明总分掩盖关键失败；
- 校准误报/漏报并记录阈值版本。

### P2-4：完整国际化与跨平台 UI 完善

- 完整 locale 资源和语言切换；
- `prefers-reduced-motion`、高对比度和移动端完善；
- macOS/Linux/Windows 的路径、字体、键盘和浏览器差异测试；
- 屏幕阅读器人工 QA；
- 基础 ARIA、键盘可用性和离线字体基线必须由 P0/P1 保持，不得在本阶段回退。

### P2-5：Deterministic export、Release 与兼容矩阵

- ZIP 排序、固定时间戳、清除 `__MACOSX/.DS_Store`、生成 checksum；
- GitHub Release、可校验或签名 artifact；
- Node/Python/Codex/macOS/Linux/Windows 支持矩阵；
- SBOM、release notes、migration/release policy；
- issue template、bug reproduction bundle 和 benchmark contribution guide；
- 只有 P0/P1 release gate 通过后才发布正式版本。

这里的兼容矩阵和 release policy 是对 P1-2/P1-3 实际验证结果的公开声明，不替代底层 schema migration 或 CI gate。

## 7. 建议直接创建的 Issues

1. `[S0-1][repo] Establish plugins/codex-paper as the single active source tree`
2. `[P0-A1][security] Harden local server, destructive routes and realpath containment`
3. `[P0-A2][security] Sanitize Markdown, Ask, Notebook and SVG; isolate HTML preview`
4. `[P0-A3][security] Disable generated-code execution by default and add sandbox policy`
5. `[P0-A4][security] Harden downloader and PDF parser against SSRF and resource exhaustion`
6. `[P0-B1][ci] Add non-skippable deterministic Attention-style PDF regression`
7. `[P0-B2][quality] Replace heuristic keyResults with typed ResultClaim extraction`
8. `[P0-B3][quality] Add Validation Report 1.0 cross-artifact gate with pass/pass_with_warnings/fail`
9. `[P0-C1a][storage] Freeze collision-safe paper/source/generation identity and fingerprint semantics`
10. `[P0-C1b][storage] Add unified current-generation resolver and preserve mutable overlays`
11. `[P0-C2a][storage] Add same-filesystem generation workspace, cross-process locks and shared writers`
12. `[P0-C2b][storage] Add Validation-gated atomic publication, manifest, index rebuild and crash recovery`
13. `[P1-1][parser] Add calibrated layout-aware column, footnote and table parsing`
14. `[P1-2][schema] Implement package migrations and evidence aliases from the frozen compatibility policy`
15. `[P1-2][recovery] Add doctor, reindex, backup and restore workflows`
16. `[P1-3a][deps] Triage dependency advisories and pin Node/Python/Docker runtime baselines`
17. `[P1-3b][repo] Add workspace, strict types, CI matrix and long-term dependency automation`
18. `[P1-4][provenance] Consolidate existing source/execution/validation provenance into the authoritative manifest`
19. `[P1-5][web] Add streaming, bounded queues, cancellation and API observability`
20. `[P1-6][export] Define local-full/shareable/audit allowlists and license metadata`
21. `[P1-7][a11y] Add keyboard, ARIA and axe baseline`
22. `[P1-7][privacy] Implement consent and unified retention/deletion controls; document trust model and data flow`
23. `[P2-1][ledger] Design ledger v3 compaction, aliases and retrieval index`
24. `[P2-2][ux] Add persistent learning progress, bbox deep-links and review queues`
25. `[P2-3][quality] Add calibrated health trends and drill-down dashboard`
26. `[P2-4][i18n] Complete locale and cross-platform UI support`
27. `[P2-5][release] Add deterministic artifacts, checksums and compatibility matrix`

## 8. 重基线后的里程碑实施顺序

原 30/60/90 天估算保留为历史排期背景；当前以后续里程碑及退出条件为准，不再用日历区间推断完成状态。

### M0：关闭安全基线并完成 Sprint 0 退出条件

- 已完成：P0-A4 阶段 commit 已推送，并由 [CI run 29251157289](https://github.com/byxshr/codex-paper/actions/runs/29251157289) 复验 Repository Contract、PDF ingestion、sandbox、benchmarks、build、Viewer security 和 smoke gates；
- 已完成：P0-B1 阶段 commit `d36fb3b` 已推送，并由 [CI run 29313834426](https://github.com/byxshr/codex-paper/actions/runs/29313834426) 复验许可明确的 synthetic fixtures、失败优先 golden assertions、受限 parser supervisor 和不可跳过 mandatory gate；
- mandatory parser fixture 已通过受限 parser supervisor 实际运行，all-skip 或 executed=0 会失败；
- 真实 model-in-loop 继续作为 nightly/人工评测，不冒充 deterministic PR gate。

**退出条件**：P0-A1～A4 均已在远端通过必要 CI；唯一 active tree 和冻结契约继续受 Guard 保护；仓库内 mandatory parser suite 不可全 skip。

### M1：完成 P0-B 可信质量链

- **状态：已关闭。** P0-B3 阶段 commit `22253bc` 已推送，并由 [CI run 29749079490](https://github.com/byxshr/codex-paper/actions/runs/29749079490) 完整复验 Repository Contract、unit、PDF ingestion、Docker sandbox conformance、Validation Report 1.0、mandatory/external/reasoning/package benchmarks、production build、Viewer security 和 smoke gates；
- P0-B2 实现已冻结的 2.1 `resultClaims`、直接 `ev-*` refs、`keyResults` 兼容 projection 和旧引用 reader；
- 实施年份/页码/版权/脚注/会议头等确定性噪声规则，并用 B1 fixtures 固定 28.4、41.8 与 2014/2017 边界；
- P0-B3 将现有 validation report 升级到 1.0，完成 facts/analysis/reasoning/visible 对账与结构化 findings；
- Web 展示 `pass / pass_with_warnings / fail`、scope 和可定位 warning；B3 产出稳定 report hash 和 `publishable`，但不依赖 C2 manifest；
- P0-C1 identity/overlay 方案设计和 P1-3a 依赖告警归因可与 M1 并行，但不属于 M1 强制退出条件；关闭 M1 后按 M2 主线先进入 P0-C1。

**退出条件**：Attention 风格 fixtures 不再把 2014/2017 当结果；41.8/41.0 产生明确 warning；已确认污染不能得到零 warning 的 `pass`；旧 2.0 包仍可读且读取不写回。

### M2：完成 P0-C 数据生命周期

- 按 `P0-C1a → P0-C1b → P0-C2a → P0-C2b` 连续实施：先冻结 identity/fingerprint，再统一 resolver/layout/overlay，随后建立 generation workspace/shared writer，最后接入 gate 驱动的发布与恢复；
- 整个 prepare → reasoning → render → validation 流程留在同文件系统 generation workspace，prepare 不再提前发布半成品；
- 把 P0-A1 的进程内锁升级为跨进程共享锁和统一 writer，并迁移 prepare、render、validation、tags、Ask/chat、trash/restore、sandbox、index 等所有写入消费者；
- 写入 P0 最小 authoritative manifest，并纳入 B3 validation report hash；只有 gate 允许的 generation 才能切换 current record 和进入 index，index 只作为可重建缓存；
- 提供完成 C2 所必需的最小 reindex/drift recovery；完整 doctor、backup/restore 和 migration UX 留给 P1-2。
- P1-3a 可作为有界并行通道梳理依赖与 runtime baseline，但必须在 C2 冻结 fingerprint/manifest 前回馈结论，且不阻塞 C1 开工。

**退出条件**：崩溃或并发不污染正式库；同标题不同 PDF 不覆盖；旧 flat-layout 包可读但零写回；所有消费者使用共享 resolver；重跑不丢 overlay，overlay mutation 不改变 immutable generation/report hash 或会产生明确 dirty 状态；任一正式工件可追到 source hash、generation fingerprint 和 validation report；index 可从 authoritative records 重建。

### M3：必要 P1 工程与恢复能力

- P1-4 先把 source、execution、validation、环境与人工编辑 provenance 汇入唯一 authoritative manifest，并冻结迁移目标 schema；
- P1-2 随后完成 identity/layout/manifest migration、evidence alias、doctor、reindex、backup/restore 和回滚测试；
- 若 P1-3a 未在 M2 完成，先关闭其依赖/runtime 基线，再由 P1-3b 完成 root workspace、`npm ci`、lint/typecheck/coverage、依赖自动化和第二运行时/平台基线；
- P1-1 深化双栏、header/footer、脚注和表格 grid benchmark；
- P1-5 完成 stream/range、有界 Ask 队列、取消、request ID 和可观测预算；
- P1-7 完成基础 a11y、Ask consent，以及 trash/chat/report 的统一 retention/deletion 控制；quarantine 复用既有自动上限并补可见控制；
- P1-6 实现 shareable/audit allowlist、dry-run 和版权元数据。

**退出条件**：旧包可读、迁移可回滚；依赖风险和支持运行时有明确证据；形成可验证、可恢复、可安全分享的 release candidate。

### M4：选择性 P2 与正式发布

- 先为 ledger v3 建立 size/latency/RSS 基准和 alias 兼容设计，不在收益未证明前迁移；
- 从持久化学习进度、bbox deep-link 或复习队列中选择最小 MVP；
- dashboard 以 M2 稳定 identity/manifest 和足量 Validation Report 语料为前提；完整 i18n 和跨平台 UI 继续以后置校准数据和 P1 a11y 基线为前提；
- 只有 P0/P1 release gate 满足时才制作 deterministic export、checksums、SBOM 和正式 release。

**退出条件**：P2 功能不牺牲 P0/P1 验收；正式发布具备可校验 artifact、公开兼容矩阵和迁移/release policy。

### 资源与排期说明

安全边界和可信质量链已完成，后续主线是 P0-C 数据生命周期。2–3 名工程师可让 P0-C 主线与有界的 P1-3a 依赖/runtime 风险梳理并行，但 C1 identity/resolver 决策仍须先于 C2 publication/manifest 冻结；单人开发按 M2 → M3 → M4 顺序推进，不应同时启动 ledger v3、完整学习体验、完整 i18n 和正式发布体系。

## 9. 最值得保留的项目优势

整改时不要丢掉以下差异化能力：

1. **证据优先而非模板填充**；
2. **把作者推理、审稿人视角和不确定性放进学习包**；
3. **本地、可检查、可继续追问**；
4. **用户可见材料不暴露机器 JSON 噪声**；
5. **用代码和交互帮助理解，而不是只给长摘要**。

下一阶段的核心不是继续增加材料数量，而是让上述优势建立在可验证的底层事实和安全边界上。

## 10. 审计结论

这个项目已经跨过“概念 demo”阶段，具备形成有用研究工具的产品骨架；但还没有跨过“可信研究基础设施”的门槛。下一阶段不是升级模型或继续增加页面，而是依次建立安全边界、可信质量链和不会丢数据的生成生命周期。

> **PDF 原始证据 → 结构化事实 → 推理 → 可见材料 → 校验报告，任何一层发生冲突都必须可见、可定位、可失败。**

这条质量链必须运行在两个前提上：所有论文衍生内容默认不可信；任何未完成验证的包都不能覆盖正式数据或进入索引。完成 Sprint 0 和三条 P0 主线后，再做 parser 深化、ledger 优化和 UX，才会产生复利。

## 11. 开发进度与状态跟踪

本章是本轮审计优化项的统一进度视图。具体设计、代码差异和讨论仍以关联的 Issue、分支、commit 与 PR 为准；每次开始开发、完成自测、进入或完成 Review、推送、合并以及发生阻塞时，都应同步更新本章。

### 11.1 状态模型

为避免把“代码已写完”和“代码已交付”混为一谈，每个开发项分别记录**开发状态**与**交付状态**。

#### 开发状态

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `未开始` | 尚未为本轮优化开展实现工作 | 已明确范围，但没有进行中的代码或测试修改 |
| `开发中` | 正在设计、编码、补测试或修复 Review 意见 | 已有实际开发活动，但尚未满足自测和验收要求 |
| `开发完成` | 实现与必要测试已完成，等待或可以进入 Review | 验收标准已自检，并记录测试命令、结果或其他证据 |
| `Review 中` | 正在进行代码或方案审查 | 已指定审查对象，并关联 commit 或 PR |
| `Review 完成` | Review 已通过，所有阻塞性意见已处理 | 审查结论和必要的回归验证均有记录 |
| `阻塞` | 当前无法继续推进 | 必须记录阻塞原因、解除条件和下一责任方；解除后回到阻塞前状态 |
| `暂缓` | 已决定延后，当前不计入活跃开发 | 必须记录原因和重新评估时间或触发条件 |
| `取消` | 已明确不再实施 | 必须记录决策原因及替代方案（如有） |

常规流转为：`未开始 → 开发中 → 开发完成 → Review 中 → Review 完成`。Review 要求修改时回到 `开发中`；任何非终态均可进入 `阻塞` 或 `暂缓`。

#### 交付状态

| 状态 | 含义 |
|---|---|
| `未推送` | 修改只存在于本地，或尚无与该开发项对应的 commit |
| `已推送` | 对应 commit 已推送到远端分支，无论是否已创建 PR 或进入 Review |
| `已合并` | PR 或等价变更已进入目标分支 |

交付状态只表示代码所在位置，不替代质量结论。例如，`已推送` 不代表 `开发完成`，`已合并` 也不替代 `Review 完成` 的质量记录。

### 11.2 更新规则

1. **状态必须有证据**：从 `开发中` 开始记录工作分支或 Issue；到达 `开发完成` 时补充测试、benchmark、截图或 validation report；到达 `Review 完成` 时补充 PR、review 结论或等价审查记录。
2. **按最保守状态汇总**：一个开发项包含多个子项时，只要仍有阻塞验收的子项未完成，就不得把父项标为 `Review 完成`。
3. **开发与交付分别更新**：本地完成但未推送时可记录为 `开发完成 / 未推送`；Review 通过但尚未合并时可记录为 `Review 完成 / 已推送`。
4. **阻塞必须可解除**：记录具体原因、下一责任方和解除条件，不使用“待处理”之类无法行动的描述。
5. **保留变更历史**：更新总表的同时在变更记录中追加一行，不覆盖既有历史。
6. **日期使用绝对日期**：统一采用 `YYYY-MM-DD`；同日多次关键变更可使用 `YYYY-MM-DD HH:mm`。

### 11.3 当前进度总表

- 跟踪基线：2026-07-10
- 开发分支：`codex/audit-optimizations-2026-07-10`
- 当前阶段：`M2`“完成 P0-C 数据生命周期”；M0 已由 P0-B1 阶段 commit `d36fb3b` 和 [CI run 29313834426](https://github.com/byxshr/codex-paper/actions/runs/29313834426) 正式关闭；M1 已由 P0-B3 阶段 commit `22253bc` 和 [CI run 29749079490](https://github.com/byxshr/codex-paper/actions/runs/29749079490) 正式关闭；下一开发子阶段为 `P0-C1a`。
- 编号规则：与第 3 章优先级总表一致；一个工作包可拆成多个 Issue，但父项按最保守子项状态汇总。
- 子项映射：`P0-C1` 对应 C1a identity/fingerprint 与 C1b layout/resolver/overlay，`P0-C2` 对应 C2a workspace/locks/writers 与 C2b publish/manifest/index/recovery；`P1-2` 对应 migration/alias 与 recovery，`P1-3` 对应 dependency/runtime governance 与 repository engineering，`P1-7` 对应 a11y 与 privacy/lifecycle controls；更新父项时必须在“工作位置”列出全部关联 Issue。
- 初始化说明：下表的 `未开始` 表示“尚未在本台账登记本轮实现活动”，不表示仓库中完全没有相关基础能力。

| ID | 优先级 | 开发项 | 开发状态 | 交付状态 | 工作位置 | 验收证据 | 下一步 | 最后更新 |
|---|---|---|---|---|---|---|---|---|
| `S0-1` | 前置 | 唯一 active tree 与契约基线 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；`plugins/codex-paper/`；`docs/adr/0001-active-tree-and-contract-baseline.md` | repo guard 31/31、study 23/23、reasoning 12/12、package 10/10、parser 5/5、build/smoke/plugin validator 通过；active path 已确认；版本 `2.0.0+codex.20260710083739`；两轮外部 Review 均批准且无阻塞 | 开始 `P0-A1` 本地服务、危险写操作与路径边界 | 2026-07-13 |
| `P0-A1` | P0 | 本地服务、危险写操作与路径边界 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；`docs/P0-A1_IMPLEMENTATION_PLAN.md`；`docs/P0-A1_CODE_REVIEW_SUMMARY.md`；`docs/P0-A1_CODE_REVIEW_RESULT.md`；`docs/P0-A1_CODE_REVIEW_ROUND2.md`；`docs/local-viewer-security.md` | 两轮独立安全 Review 最终 Approve、无遗留 findings；guard/security 43/43、study 23/23、parser 5/5、reasoning 12/12、package 10/10、build/smoke/HTTP integration/Browser QA/plugin validator 通过；active path `plugins/codex-paper/`；版本 `2.0.0+codex.20260711152652` | 开始 `P0-A2` Web 主动内容隔离 | 2026-07-13 |
| `P0-A2` | P0 | Web 主动内容隔离 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；`docs/P0-A2_IMPLEMENTATION_PLAN.md`；`docs/P0-A2_CODE_REVIEW_SUMMARY.md`；`docs/P0-A2_CODE_REVIEW_RESULT.md`；`docs/P0-A2_CODE_REVIEW_RESULT_ROUND2.md`；`docs/web-active-content-security.md` | 两轮独立 Review 均通过、无阻断项；L1/L2 整改复核有效；repository/security 52/52、study 23/23、parser 5/5、reasoning 12/12、package 10/10、build/security/官方 validator 通过；active path `plugins/codex-paper/`；版本 `2.0.0+codex.20260712051635` | 开始 `P0-A3` 生成代码执行策略与 sandbox | 2026-07-13 |
| `P0-A3` | P0 | 生成代码执行策略与 sandbox | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；`docs/P0-A3_IMPLEMENTATION_PLAN.md`；`docs/P0-A3_CODE_REVIEW_SUMMARY.md`；`docs/P0-A3_CODE_REVIEW_FINDINGS.md`；`docs/P0-A3_CODE_REVIEW_FINDINGS_ROUND2.md`；`docs/generated-code-sandbox-security.md` | 两轮独立 Review 已通过；真实 Docker 诊断确认 minimal-only Python 缺少 entrypoint 所需标准库，且文件边界由 `SIGXFSZ` 或 64 MiB `/tmp` 的 `ENOSPC` 强制执行；已改用完整 `python3`、加入防回退 Guard，并修正 synthetic 探针清理与 signal/status 严格匹配；Guard 37/37、repository/security 75/75、study 23/23、parser 5/5、reasoning 12/12、package 11/11、官方 validator 与 [CI run 29244582383](https://github.com/byxshr/codex-paper/actions/runs/29244582383) 全部通过；active 版本 `2.0.0+codex.20260713105712` | 开始 `P0-A4` 下载器与 PDF parser 隔离/限额 | 2026-07-13 |
| `P0-A4` | P0 | 下载器与 PDF parser 隔离/限额 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；`docs/P0-A4_IMPLEMENTATION_PLAN.md`；`docs/P0-A4_CODE_REVIEW_SUMMARY.md`；`docs/P0-A4_CODE_REVIEW_RESULT.md`；`docs/P0-A4_CODE_REVIEW_RESULT_ROUND2.md`；`docs/pdf-ingestion-security.md` | 两轮独立 Review 均通过且无遗留 findings；首轮采纳 F1/F2，补齐 IPv4-compatible IPv6 拒绝和同步写盘失败清理，F3 总响应时限按 fail-closed 设计保留；第二轮复现 PDF security 12/12、Guard tests 40/40 和 repository contract；repository/security 90/90、study 23/23、parser 5/5、reasoning 12/12、package 11/11、build/HTTP security/smoke/官方 validator 通过；[CI run 29251157289](https://github.com/byxshr/codex-paper/actions/runs/29251157289) 远端全绿；active 版本 `2.0.0+codex.20260713121349` | 实施 `P0-B1` 不可跳过的确定性回归与验收契约 | 2026-07-13 |
| `P0-B1` | P0 | 不可跳过的确定性回归与验收契约 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；commit `d36fb3b`；`docs/P0-B1_IMPLEMENTATION_PLAN.md`；`docs/P0-B1_CODE_REVIEW_SUMMARY.md`；`docs/P0-B1_CODE_REVIEW_RESULT.md`；`docs/P0-B1_CODE_REVIEW_RESULT_ROUND2.md`；`docs/deterministic-regression-contract.md`；`benchmarks/mandatory/`；`benchmarks/fixtures/pdf/` | 两轮独立 Review 最终无条件 Approve、无新增缺陷；首轮唯一合并前建议已通过内容限定 detector 和双向元数据回归关闭；两个 MIT synthetic PDF 可逐字节复现；mandatory `declared/executed/completed/passed=2/2/2/2`、10 条预期缺陷全部稳定观测；repository/security 104/104、study 23/23、PDF security 12/12、external parser 5/5、reasoning 12/12、package 11/11、build/HTTP security/smoke/官方 plugin validator 通过；[CI run 29313834426](https://github.com/byxshr/codex-paper/actions/runs/29313834426) 全部通过；2.0 schema 与 active plugin 版本未改；manifest 双重校验漂移风险转入 P1-3b | 开始 `P0-B2` Typed ResultClaim、噪声过滤与直接证据引用 | 2026-07-14 |
| `P0-B2` | P0 | Typed ResultClaim、噪声过滤与直接证据引用 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；`docs/P0-B2_IMPLEMENTATION_PLAN.md`；`docs/P0-B2_CODE_REVIEW_SUMMARY.md`；`docs/P0-B2_CODE_REVIEW_FINDINGS.md`；`docs/P0-B2_CODE_REVIEW_FINDINGS_ROUND2.md`；`docs/P0-B2_CODE_REVIEW_FINDINGS_ROUND3.md`；`docs/P0-B2_CODE_REVIEW_FINDINGS_ROUND4.md`；`plugins/codex-paper/skills/study/schemas/facts-2.1.schema.json`；`plugins/codex-paper/skills/study/scripts/extract-facts.js`；`plugins/codex-paper/src/shared/package-compatibility.mjs`；`benchmarks/mandatory/gold/` | 新 writer 输出 package/facts `2.1.0`，evidence/reasoning 三份冻结 schema 仍为 `2.0.0`；typed ResultClaim、`keyResults` 投影、直接 `ev-*` refs、2.0/v1/unknown 只读兼容及 Viewer compatibility 已落地；四轮 Review findings 均已关闭，第四轮修订后的独立复核通过；migration 全 artifact/JSON 零写入预检、facts/analysis 损坏 meta 安全降级和准确混合版本诊断已确认；Viewer compatibility 是轻量版本视图，不替代 validator/P0-B3 完整性与发布门禁；mandatory `2/2` 通过并只保留 3 个 P0-B3 预期 finding；repository/security 108/108、study 44/44、PDF security 12/12、external parser 5/5、reasoning 12/12、package 12/12、production build、HTTP security、smoke 和官方 validator 通过；Attention 样本经临时库只读验收包含 28.4/41.8/41.0、无 2014/2017 年份结果，原目录 hash/mtime 不变；active 版本 `2.0.0+codex.20260716070151` | 实施 `P0-B3` 跨工件一致性门禁与三态健康状态；M1 在 B3 Review 和远端 CI 通过前不关闭 | 2026-07-20 |
| `P0-B3` | P0 | 跨工件一致性门禁与三态健康状态 | `Review 完成` | `已推送` | `codex/audit-optimizations-2026-07-10`；commit `22253bc`；`docs/P0-B3_IMPLEMENTATION_PLAN.md`；`docs/P0-B3_CODE_REVIEW_SUMMARY.md`；`docs/P0-B3_CODE_REVIEW_RESULT.md`；`docs/P0-B3_CODE_REVIEW_RESULT_ROUND2.md`；`docs/validation-report-1.0.md`；`plugins/codex-paper/skills/study/schemas/validation-report-1.0.schema.json`；`plugins/codex-paper/skills/study/scripts/validation-report.js`；Viewer Validation API/UI；`benchmarks/mandatory/` | Validation Report 1.0 引擎、统一 CLI、mandatory 正向契约、Viewer API/UI、Repository Guard 与 CI gate 已完成；首轮独立 Review 的 F1–F4 全部采纳：数值披露改为完整 token 精确比较，typed ResultClaim 规则仅用于 native 2.1，并新增合法 2.0 warning-only/publishable 回归；第二轮独立 Review 逐项复现修复有效、未发现新 soundness 缺陷并 Approve；千分位数值识别作为非阻塞已知限制记录，动态 metric 正则确认已安全转义；repository/security 114/114、study 58/58、Validation 20/20、PDF security 12/12、mandatory 2/2、external parser 5/5、reasoning 12/12、package 12/12、production build、HTTP security、smoke、Browser QA 和官方 validator 全部通过；[CI run 29749079490](https://github.com/byxshr/codex-paper/actions/runs/29749079490) 远端全绿，覆盖 Repository Contract、unit、PDF ingestion、Docker conformance、Validation、全部 benchmarks、build、Viewer security 与 smoke；Attention 样本原目录 hash/mtime 不变；active path `plugins/codex-paper/`，版本 `2.0.0+codex.20260720134033` | M1 已关闭；进入 `P0-C1a` identity/fingerprint 子阶段 | 2026-07-21 |
| `P0-C1` | P0 | 防碰撞 identity、幂等与禁止静默覆盖 | `未开始` | `未推送` | — | — | 先执行 C1a identity/fingerprint，再执行 C1b resolver/overlay；父项按最保守子阶段汇总 | 2026-07-21 |
| `P0-C2` | P0 | 事务发布、共享锁、原子索引与最小 manifest | `未开始` | `未推送` | — | — | C1 两阶段冻结后，执行 C2a workspace/locks，再执行 C2b publish/index/recovery | 2026-07-21 |
| `P1-1` | P1 | 深层版面解析与 benchmark 校准 | `未开始` | `未推送` | — | — | 复用 B1 fixture/golden 和 B3 finding 语义扩展双栏、header/footer、脚注和表格 grid benchmark | 2026-07-21 |
| `P1-2` | P1 | 兼容实现、迁移与恢复工具 | `未开始` | `未推送` | — | — | 等 P1-4 稳定 manifest schema 后实施 identity/layout/manifest migration、doctor/reindex、backup/restore 和 rollback | 2026-07-21 |
| `P1-3` | P1 | 依赖治理、测试与仓库工程化 | `未开始` | `未推送` | — | — | P1-3a 可有界并行 M2 并在 C2 manifest 冻结前反馈 runtime/fingerprint；P1-3b 留在 M3 | 2026-07-21 |
| `P1-4` | P1 | 统一完整 provenance | `未开始` | `未推送` | — | — | M3 先冻结唯一 manifest schema，再启动 P1-2 的布局/manifest migration | 2026-07-21 |
| `P1-5` | P1 | Web/API 流式 I/O、队列与可观测性 | `未开始` | `未推送` | — | — | 聚焦 stream/range、剩余结构预算、request ID、全局有界 Ask 队列和取消/可观测性 | 2026-07-13 |
| `P1-6` | P1 | 分享策略、导出 allowlist 与版权元数据 | `未开始` | `未推送` | — | — | 定义 local-full/shareable/audit allowlist 和确认流程 | 2026-07-10 |
| `P1-7` | P1 | 基础可访问性与隐私/生命周期控制 | `未开始` | `未推送` | — | — | 建立键盘/ARIA/axe、Ask consent 和其余数据生命周期控制；quarantine 复用既有自动保留上限 | 2026-07-21 |
| `P2-1` | P2 | Evidence ledger v3 去重与索引 | `未开始` | `未推送` | — | — | 先测 size/latency/RSS，并等待 P1 schema/alias contract | 2026-07-10 |
| `P2-2` | P2 | 持久化学习进度与渐进式体验 | `未开始` | `未推送` | — | — | 在已有路线/隐藏答案基础上选定进度、书签或复习 MVP | 2026-07-10 |
| `P2-3` | P2 | 校准后的高级质量 dashboard | `未开始` | `未推送` | — | — | 等 M2 identity/manifest 稳定并积累足量 Validation Report 语料后定义校准指标 | 2026-07-21 |
| `P2-4` | P2 | 完整国际化与跨平台 UI 完善 | `未开始` | `未推送` | — | — | 基于 P1 a11y 基线定义 locale 和跨平台测试矩阵 | 2026-07-10 |
| `P2-5` | P2 | Deterministic export、Release 与兼容矩阵 | `未开始` | `未推送` | — | — | 等 P0/P1 release gate 后设计 artifact/checksum/release 流程 | 2026-07-10 |

### 11.4 进度汇总

| 优先级 | 总数 | 未开始 | 开发中 | 开发完成 | Review 中 | Review 完成 | 阻塞/暂缓/取消 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 前置 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| P0 | 9 | 2 | 0 | 0 | 0 | 7 | 0 |
| P1 | 7 | 7 | 0 | 0 | 0 | 0 | 0 |
| P2 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| **合计** | **22** | **14** | **0** | **0** | **0** | **8** | **0** |

| 交付状态 | 未推送 | 已推送 | 已合并 | 合计 |
|---|---:|---:|---:|---:|
| 工作包数量 | 14 | 8 | 0 | 22 |

完成率按 `Review 完成` 的开发项计数；交付状态通过上表单独统计，不计入开发完成率。前置项单独统计，不混入 P0 产品风险完成率。

### 11.5 变更记录

| 时间 | 开发项 | 状态变化 | 证据或说明 | 更新人 |
|---|---|---|---|---|
| 2026-07-10 | 全部 | 初始化为 `未开始 / 未推送` | 建立第一版 14 项审计优化台账；后续更新不得删除本行或覆盖历史记录 | Codex |
| 2026-07-10 | 全部 | 14 项旧台账重构为 22 个工作包，状态保持 `未开始 / 未推送` | 按代码、CI 和 Attention 样本复核结果加入 Sprint 0，并拆分 P0-A 安全、P0-B 可信链、P0-C 数据生命周期 | Codex |
| 2026-07-10 | `S0-1` | `未开始 / 未推送` → `开发中 / 未推送` | 开始收敛唯一 active tree、冻结契约基线并接入 Repository Contract gate | Codex |
| 2026-07-10 16:42 | `S0-1` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成源码收敛、插件摄取修复、契约基线、CI gate 与全量自测；安装版本为 `2.0.0+codex.20260710083739` | Codex |
| 2026-07-10 16:48 | `S0-1` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 两轮独立对抗 Review 后封堵第二 manifest、dangling symlink 与 fixture 许可绕过；最终无阻塞项 | Codex |
| 2026-07-11 | `S0-1` | 状态保持 `Review 完成 / 未推送` | 复核外部 Code Review 结论；采纳 CLI 参数解析健壮性建议并补回归测试，guard 更新为 29/29；澄清 hooks 的已验证证据与新任务人工验证边界 | Codex |
| 2026-07-11 | `S0-1` | 状态保持 `Review 完成 / 未推送` | 复核第二轮 Code Review；排除生成型 lockfile 的 legacy 文本误报，并将三条默认提示固化为门禁，guard 更新为 31/31；补充原子暂存 checklist | Codex |
| 2026-07-11 | `P0-A1` | `未开始 / 未推送` → `开发中 / 未推送` | 开始实施 loopback、配对 session、Host/Origin/CSRF、统一 no-follow resolver 和可恢复回收站 | Codex |
| 2026-07-11 22:45 | `P0-A1` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成服务配对、共享路径边界、可恢复删除与恢复 UI；全量回归、真实 HTTP 集成、Browser QA、官方 validator 和 active plugin 重装通过，版本 `2.0.0+codex.20260711144506` | Codex |
| 2026-07-11 | `P0-A1` | 状态保持 `开发完成 / 未推送` | 采纳首轮 Review 的 N1–N4：修复 delete/restore 回滚链、原子临时文件 no-follow/exclusive、confirmation 上限和默认端口 Host；安全回归增至 12 项；重装版本 `2.0.0+codex.20260711152652` | Codex |
| 2026-07-12 | `P0-A1` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 第二轮独立安全 Review 最终 Approve，确认 N1–N4 修复正确且无新增 findings；进入阶段性提交 | Codex |
| 2026-07-12 | `P0-A2` | `未开始 / 未推送` → `开发中 / 未推送` | 开始实施 Viewer SPA 严格 CSP、服务端统一净化、HTML 静态安全预览和 Notebook/SVG 主动内容降级 | Codex |
| 2026-07-12 | `P0-A2` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成统一净化、SPA 严格 CSP、静态 HTML 预览、Notebook/SVG 降级与恶意 fixture；全量回归、HTTP integration、Browser canary、官方 validator 和 active plugin 重装通过，版本 `2.0.0+codex.20260712030120` | Codex |
| 2026-07-12 | `P0-A2` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 独立 Review 结论为通过且无阻断项；采纳 L1 删除无消费者白名单导出、采纳 L2 补全 pinned KaTeX 布局类并新增复杂公式回归；repository/security 52/52，重装版本 `2.0.0+codex.20260712051635` | Codex |
| 2026-07-12 | `P0-A2` | 状态保持 `Review 完成 / 未推送` | 第二轮独立 Review 再次同意合并且无阻断项，确认 L1/L2 整改无安全弱化；信息级 O1 固化为 KaTeX 升级时同步审计类白名单与复杂公式回归的维护约束 | Codex |
| 2026-07-13 | `P0-A3` | `未开始 / 未推送` → `开发中 / 未推送` | 开始移除 validator 裸机执行，实施 Docker-only capability/conformance gate、两步单次授权和结构化执行报告 | Codex |
| 2026-07-13 | `P0-A3` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成静态 validator、digest-pinned Docker runner、审批快照、资源边界、CI gate 与文档；本地全量回归和插件重装通过，版本 `2.0.0+codex.20260713082445`；真实 Docker conformance 等待后续 CI | Codex |
| 2026-07-13 | `P0-A3` | 状态保持 `开发完成 / 未推送` | 复核首轮安全 Review：明确 token 不认证人类身份的 workflow 信任边界并加入 Guard，清理过期授权文件，严格校验并标记非权威资源统计；repository/security 72/72，重装版本 `2.0.0+codex.20260713091303` | Codex |
| 2026-07-13 | `P0-A3` | `开发完成 / 未推送` → `Review 中 / 未推送` | 第二轮独立 Review 确认首轮 findings 全部关闭、无新增缺陷并批准合并；真实 Docker conformance 仍是完成 Review 的强制 CI gate，先创建阶段 commit | Codex |
| 2026-07-13 | `S0-1`、`P0-A1`、`P0-A2`、`P0-A3` | 交付状态 `未推送` → `已推送` | 分支 `codex/audit-optimizations-2026-07-10` 已推送至 `origin`；P0-A3 等待远端真实 Docker conformance | Codex |
| 2026-07-13 | `P0-A3` | 状态保持 `Review 中 / 已推送` | PR #3 首次真实 Docker CI 在 `conformance.js` 失败；新增有界容器诊断、显式 JS invariant 错误与回归测试，repository/security 增至 73/73，插件版本 `2.0.0+codex.20260713104741` | Codex |
| 2026-07-13 | `P0-A3` | 状态保持 `Review 中 / 已推送` | 诊断 CI 确认 `python3-minimal` 缺少可信 entrypoint 所需 `json` 标准库；镜像改装完整 `python3` 且新增防回退 Guard，repository/security 74/74，插件版本 `2.0.0+codex.20260713105027` | Codex |
| 2026-07-13 | `P0-A3` | 状态保持 `Review 中 / 已推送` | 后续真实 Docker CI 越过 entrypoint，并确认文件边界会以 Linux `SIGXFSZ` 或受限 `/tmp` 的 `ENOSPC` 生效；conformance 增加探针清理并严格匹配 signal exit/resource status，新增回归后 repository/security 75/75，插件版本 `2.0.0+codex.20260713105712` | Codex |
| 2026-07-13 | `P0-A3` | `Review 中 / 已推送` → `Review 完成 / 已推送` | [CI run 29244582383](https://github.com/byxshr/codex-paper/actions/runs/29244582383) 的真实 Docker conformance、benchmarks、production build、Viewer security integration 与 smoke test 全部通过，关闭最终强制验收条件；下一项为 `P0-A4` | Codex |
| 2026-07-13 | `P0-A4` | `未开始 / 未推送` → `开发中 / 未推送` | 冻结 HTTPS-only、逐跳 SSRF/DNS pin、128 MiB 下载、2000 页、受限 parser worker 与私有有界 quarantine 实施边界 | Codex |
| 2026-07-13 | `P0-A4` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成安全 downloader、私有 staging、受限 parser 进程组、quarantine、Repository Guard 与 CI gate；repository/security 88/88、PDF security 10/10、全量 benchmark/build/security/smoke 通过，重装版本 `2.0.0+codex.20260713111903` | Codex |
| 2026-07-13 | `P0-A4` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 独立 Review 结论可交付且无阻塞项；采纳 F1/F2，拒绝 IPv4-compatible IPv6 并让同步写盘异常进入受控清理；F3 总响应时限按防无限滴流的 fail-closed 策略保留；repository/security 90/90、PDF security 12/12，重装版本 `2.0.0+codex.20260713121349` | Codex |
| 2026-07-13 | `P0-A4` | 状态保持 `Review 完成 / 未推送` | 第二轮独立 Review 复现首轮两项修复和 Repository Guard，确认无新增阻塞或非阻塞 findings，建议直接交付且无遗留跟进项 | Codex |
| 2026-07-13 | 剩余计划 | 状态不变，实施顺序重基线 | 保留 P0-B1→B2→B3→C1→C2 主线；将当前阶段改为 M0～M4 退出条件，按 S0 冻结契约收敛 B2/B3，明确 B3/C2 发布边界，删除 P1-5/P1-7 已完成范围，并拆分 P1-3a 依赖治理与 P1-3b 仓库工程化 | Codex |
| 2026-07-13 | `P0-A4` | 交付状态 `未推送` → `已推送` | 阶段 commit `2f4376f` 与路线重基线 commit `9ccf213` 已推送；[CI run 29251157289](https://github.com/byxshr/codex-paper/actions/runs/29251157289) 的 Repository Contract、unit、PDF ingestion、Docker sandbox conformance、benchmarks、production build、Viewer security 和 smoke 全部通过 | Codex |
| 2026-07-13 | `P0-B1` | `未开始 / 未推送` → `开发中 / 未推送` | 开始实施可再分发 synthetic PDF、预期缺陷 golden、固定 authoring boundary 与不可跳过 CI gate | Codex |
| 2026-07-13 21:09 | `P0-B1` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成两个逐字节可复现的 MIT fixtures 与 mandatory PDF→prepare→authoring→validators 链路；2/2 实际执行并通过，10 条预期缺陷稳定观测；repository/security 103/103、study 23/23、PDF security 12/12、parser 5/5、reasoning 12/12、package 11/11、build/HTTP security/smoke/官方 validator 全部通过；等待独立 Review 和远端 CI | Codex |
| 2026-07-14 | `P0-B1` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 独立 Review 批准并复现全部验收；采纳唯一合并前建议，修复 `FRONT_MATTER_NOISE_IN_ANALYSIS` 被 parser cachebuster/`generatedAt` 元数据永久触发的问题，增加内容级正例和元数据-only 反例；mandatory 2/2、repository/security 104/104、study 23/23 通过；远端 CI 仍待推送后执行 | Codex |
| 2026-07-14 | `P0-B1` | 状态保持 `Review 完成 / 未推送` | 第二轮独立 Review 无条件 Approve，复现 metadata-only 反例、真实污染正例、mandatory 2/2、mandatory tests 9/9、Guard tests 45/45 与 repo-check；无新增缺陷，manifest 双重校验的低优先级漂移风险转入 P1-3b | Codex |
| 2026-07-14 | `P0-B1` | 交付状态 `未推送` → `已推送` | P0-B1 阶段实现、确定性 fixtures、mandatory CI gate、两轮 Review 记录与台账已提交并推送至 `codex/audit-optimizations-2026-07-10`；等待远端 CI 最终验收 | Codex |
| 2026-07-14 | `P0-B1` / `M0` | 状态保持 `Review 完成 / 已推送`；M0 正式关闭 | 阶段 commit `d36fb3b` 的 [CI run 29313834426](https://github.com/byxshr/codex-paper/actions/runs/29313834426) 全绿：Repository Contract、unit、PDF ingestion、Docker sandbox、mandatory/external/reasoning/package benchmarks、production build、Viewer security 和 smoke 全部通过；进入 M1/P0-B2 | Codex |
| 2026-07-14 | `P0-B2` | `未开始 / 未推送` → `开发中 / 未推送` | 开始实施 2.1 typed ResultClaim writer、ledger-backed 噪声过滤、直接 `ev-*` 引用和共享只读兼容层；冻结三份 2.0 schema 与 Node/plugin base version | Codex |
| 2026-07-14 | `P0-B2` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成 facts 2.1 schema/writer、兼容 projection、2.0/v1/unknown reader、Viewer compatibility 和 B1 golden 迁移；mandatory 2/2、repository/security 106/106、study 30/30、PDF security 12/12、parser 5/5、reasoning 12/12、package 11/11、build/HTTP security/smoke/官方 validator 全部通过；Attention 样本只读验收通过，重装 active 版本 `2.0.0+codex.20260714075810`；等待独立 Review，M1 尚未关闭 | Codex |
| 2026-07-14 | `P0-B2` | 状态保持 `开发完成 / 未推送` | 复核首轮独立 Review 并采纳全部 9 项 finding：修复 metric-name 数字误抽、confidence 升级、空上下文错误合并、percent projection、Table 0、非法/重复 evidence ID、2.0 writer 写入、未知 artifact 降级和 Viewer ledger 热路径；新增 Ajv writer gate 与受限显式 v1→v2 migration 例外，并按原契约丢弃 low-confidence 结果候选；repository/security 107/107、study 36/36、全量 benchmark/build/security/smoke/官方 validator 通过，重装版本 `2.0.0+codex.20260714085501`；等待独立复核 | Codex |
| 2026-07-14 | `P0-B2` | 状态保持 `开发完成 / 未推送` | 复核第二轮 8 项 finding：修复候选合并顺序依赖、无 meta 时三端兼容分类分裂、未知版本迁移先写后拒绝、analysis fallback 忽略 limit、直接引用缺少可选 ledger membership 以及错误风暴；明确 v1 仅 `--legacy-ok` 有限只读验证且 writer 继续 fail closed；repository/security 108/108、study 40/40、mandatory 2/2、PDF security 12/12、parser 5/5、reasoning 12/12、package 12/12、production build/HTTP security/smoke/官方 validator 全部通过，重装版本 `2.0.0+codex.20260714124915`；等待修订后独立复核 | Codex |
| 2026-07-16 | `P0-B2` | 状态保持 `开发完成 / 未推送` | 复核第三轮 7 项 finding：修复显式声明 1.x 的 migration/scaffold guard 分歧，避免部分写入；无 meta 且 ancillary JSON 损坏时保留安全核心读取并返回 `unknown_read_only + PACKAGE_ARTIFACT_INVALID`，validator 对损坏 meta 明确失败；确认 `--legacy-ok` 退出码变化和“缺 meta 不推断 native 2.1”均为刻意 fail-closed 契约；repository/security 108/108、study 42/42、mandatory 2/2、PDF security 12/12、parser 5/5、reasoning 12/12、package 12/12、production build/HTTP security/smoke/官方 validator 全部通过，重装版本 `2.0.0+codex.20260716062741`；等待修订后独立复核 | Codex |
| 2026-07-16 | `P0-B2` | 状态保持 `开发完成 / 未推送` | 复核第四轮 5 组 finding：migration 在任何写入前预检 meta/ledger/reasoning JSON 与 ancillary schema，默认/`--force` 均拒绝不支持版本；损坏 meta 不再阻断 facts/analysis，混合版本诊断准确指出实际 offender；确认 Viewer 权威 meta 快速分类与 CLI validator 穷尽校验属于不同信任边界，Viewer `readOnly` 不代表完整性或 publishable；repository/security 108/108、study 44/44、mandatory 2/2、PDF security 12/12、parser 5/5、reasoning 12/12、package 12/12、production build/HTTP security/smoke/官方 validator 全部通过，重装版本 `2.0.0+codex.20260716070151`；等待修订后独立复核 | Codex |
| 2026-07-20 | `P0-B2` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 第四轮修订后的独立 Code Review 通过，四轮 findings 全部关闭且无遗留 Review 阻塞项；P0-B2 Review gate 正式关闭，下一步创建阶段性 commit、执行远端 CI 验证并进入 P0-B3；M1 尚未关闭 | Codex |
| 2026-07-20 | `P0-B2` | 交付状态 `未推送` → `已推送` | P0-B2 阶段实现、四轮 Review 修订、总结文档和台账已纳入阶段性提交并推送至 `codex/audit-optimizations-2026-07-10`；远端 CI 作为本次交付验收 | Codex |
| 2026-07-20 | `P0-B3` | `未开始 / 未推送` → `开发中 / 未推送` | 开始将唯一 validation report 原位升级到 1.0，实施跨 evidence/facts/analysis/reasoning/可见材料的一致性门禁、三态质量、稳定 intrinsic hash、独立 Viewer Validation API 和 mandatory 正向契约；M1 在独立 Review 和远端 CI 通过前不关闭 | Codex |
| 2026-07-20 | `P0-B3` | `开发中 / 未推送` → `开发完成 / 未推送` | 完成 Validation Report 1.0、跨工件一致性与冲突披露门禁、独立 Viewer Validation API/UI、mandatory 正向契约及 CI/Guard 接入；repository/security 114/114、study 56/56、Validation 18/18、PDF security 12/12、mandatory 2/2、external parser 5/5、reasoning/package 各 12/12、build/HTTP security/smoke/Browser QA/官方 validator 全部通过；active 版本 `2.0.0+codex.20260720125242`，等待独立 Review，M1 尚未关闭 | Codex |
| 2026-07-20 | `P0-B3` | `开发完成 / 未推送` → `开发中 / 未推送` → `开发完成 / 未推送` | 复核首轮独立 Review 并采纳 F1–F4：修复 `41.8` 子串错误满足 `41.0` 披露的 fail-open，限制 typed ResultClaim projection/grounding/conflict 规则仅适用于 native 2.1，并新增合法 2.0 warning-only/publishable 回归；repository/security 114/114、study 58/58、Validation 20/20、mandatory 2/2、reasoning/package 各 12/12 通过，重装版本 `2.0.0+codex.20260720134033`；等待修订后独立复核，M1 尚未关闭 | Codex |
| 2026-07-20 | `P0-B3` | `开发完成 / 未推送` → `Review 完成 / 未推送` | 第二轮独立 Review 逐项验证首轮 F1–F4 修复，确认没有新 soundness 缺陷并 Approve；千分位数值识别记录为非阻塞契约限制，动态 metric 正则确认已正确转义且无需修改；P0-B3 Review gate 关闭，等待阶段提交、推送和远端 CI，M1 尚未关闭 | Codex |
| 2026-07-20 | `P0-B3` / `M1` | `Review 完成 / 未推送` → `Review 完成 / 已推送`；M1 正式关闭 | 阶段 commit `22253bc` 已推送；[CI run 29749079490](https://github.com/byxshr/codex-paper/actions/runs/29749079490) 全绿，Repository Contract、unit、PDF ingestion、Docker sandbox conformance、Validation Report 1.0、mandatory/external/reasoning/package benchmarks、production build、Viewer security 和 smoke 全部通过；进入 M2/P0-C1 | Codex |
| 2026-07-21 | 剩余计划 | 状态数量不变，M2/M3 实施边界重基线 | 将 P0-C1/C2 细分为 C1a identity/fingerprint、C1b resolver/overlay、C2a workspace/locks/writers、C2b publish/manifest/index/recovery；P1-3a 作为有界 M2 并行通道，M3 调整为先 P1-4 再 P1-2；Issue 建议扩展为 27 项，顶层工作包仍为 22 个 | Codex |
