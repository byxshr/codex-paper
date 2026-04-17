# Codex Paper P0 计划与实施说明

## 文档目的

这份文档用于记录 `Codex Paper` 在 P0 阶段的计划、实际实施内容、验证结果、当前边界和后续迭代建议，方便后续继续演进时快速接手。

本文档描述的是当前活跃实现路径：

- `plugins/codex-paper/`
- `scripts/`
- `benchmarks/`

仓库中的旧副本 `plugin/` 仅保留作参考，本轮 P0 未对其继续演进。

---

## P0 目标

P0 的目标不是把产品一次做满，而是优先把“准确性基础设施”搭起来，让后续的学习内容、摘要内容和网页展示都有一个更稳定、可验证、可回归的底座。

本轮目标固定为：

1. 建立固定 benchmark 集和 gold 标注，避免 parser 反复回退。
2. 把 PDF 解析收敛成稳定 JSON 输出，而不是让 warning 污染结果。
3. 引入单一的 paper preparation 入口，统一生成 `paper-data.json`、`facts.json`、`meta.json` 和 `index.json`。
4. 让 `study` / `summary` 明确依赖结构化事实源，而不是完全自由生成。
5. 在 Web UI 中把 evidence / quality 信息露出来。
6. 提供 CLI benchmark 命令，形成最小回归闭环。

---

## P0 范围

### 已纳入范围

- 解析准确性
- benchmark 基础层
- paper preparation 管线
- skill 约束
- Web UI 的最小 facts/quality 支撑
- 本地 CLI 验证入口

### 未纳入范围

- 更深层的结构化分析文件，例如 `analysis.json`
- 复杂图表或语义化结果表
- 大规模性能优化
- 多人协作、远程存储、服务化部署
- 旧路径 `plugin/` 的同步重构

---

## 基准集

P0 固定使用本地目录 `~/codex-papers/paper-examples` 中的 5 篇论文作为 parser benchmark：

1. `Group Sequence Policy Optimization_dual_Gemini.pdf`
2. `How to Allocate, How to Learn? Dynamic Rollout Allocation and Advantage Modulation for Policy Optimization.pdf`
3. `Qwen3_Technical_Report.pdf`
4. `WebSailor.pdf`
5. `olmo-paper.pdf`

仓库内只提交 benchmark manifest、gold 标注和评测脚本，不提交 PDF 本体。

相关文件：

- `benchmarks/manifest.json`
- `benchmarks/gold/*.json`
- `benchmarks/run-benchmark.mjs`
- `benchmarks/benchmark-report.mjs`

---

## 本轮实施内容

## 1. Benchmark 基础层

新增 benchmark 目录与配套资产：

- `benchmarks/manifest.json`
- `benchmarks/gold/*.json`
- `benchmarks/README.md`
- `benchmarks/run-benchmark.mjs`
- `benchmarks/benchmark-report.mjs`

benchmark 执行逻辑：

- 逐篇读取 benchmark PDF
- 调用 `parse-pdf.js`
- 与对应 gold 文件比对
- 统计 `title`、`authors`、`abstract`、`pageCount`、`links`、`forbiddenTitlePatterns`、`jsonShape`
- 输出终端摘要，并写入 `/tmp/codex-paper-benchmark.json`

默认 benchmark 目录：

- `~/codex-papers/paper-examples`

支持覆盖的环境变量：

- `BENCHMARK_DIR`
- `CODEX_PAPER_BENCHMARK_DIR`

---

## 2. PDF 解析器重构

`plugins/codex-paper/skills/study/scripts/parse-pdf.js` 已重构为稳定 JSON parser。

关键变化：

- CLI `stdout` 只输出 JSON
- warning 和内部库噪音不再污染 `stdout`
- 优先使用 `PyMuPDF`
- `pdf-parse` 作为回退路径
- 解析输出 schema 固定，便于 skill、benchmark、UI 复用

当前输出字段：

- `title`
- `authors[]`
- `abstract`
- `pageCount`
- `year`
- `githubLinks[]`
- `codeLinks[]`
- `sections.abstract`
- `sections.introduction`
- `sections.conclusion`
- `warnings[]`
- `qualityFlags[]`
- `parserVersion`

解析策略要点：

- 先读取 metadata 和第一页 blocks
- 标题抽取时过滤日期、`arXiv:`、分类标签、纯编号行、机构行、URL/邮箱行
- 作者从标题后的作者窗口提取，并排除机构、邮箱、section heading
- 摘要优先从第一页的 `Abstract` block 提取，再回退到全文 heading 切段
- 页数直接取 parser 页数，不再依赖文本猜测
- 链接统一抽取并区分 `githubLinks` 与 `codeLinks`

当前固定的 `qualityFlags`：

- `title_from_fallback`
- `authors_low_confidence`
- `abstract_missing`
- `sections_partial`
- `links_missing`

---

## 3. 单一 paper preparation 入口

新增：

- `plugins/codex-paper/skills/study/scripts/prepare-paper.js`

职责：

1. 接受本地 PDF 路径或 URL
2. 如为 URL，先下载 PDF
3. 调用 `parse-pdf.js`
4. 生成标准化数据文件
5. 复制 PDF 到 paper 目录
6. 更新 `meta.json`
7. 更新 `~/codex-papers/index.json`

当前输出文件：

- `paper.pdf`
- `paper-data.json`
- `facts.json`
- `meta.json`

`paper-data.json` 是当前单篇论文的标准事实源，主要包含：

- 论文基本元数据
- `sections`
- `warnings`
- `qualityFlags`
- `parserVersion`
- `rawText`

`facts.json` 是 evidence-first 的轻量事实层，当前字段为：

- `paperSlug`
- `parserVersion`
- `coreClaims[]`
- `keyResults[]`
- `limitations[]`

每条 facts 都包含 evidence 信息：

- `evidence.section`
- `evidence.quote`

当前 `facts.json` 采用启发式抽取，优先覆盖：

- `abstract`
- `introduction`
- `conclusion`

---

## 4. meta.json 与 index.json 写入收敛

本轮统一为 `meta.json` 和 `index.json` 增加这些字段：

- `sourceFilename`
- `parserVersion`
- `qualityFlags`
- `year`

`index.json` 写入策略保持兼容：

- 如果原文件根结构是数组，则继续写数组
- 如果原文件根结构是 `{ papers: [] }`，则继续保留对象结构

这样可以避免因 P0 改造破坏已有本地索引格式。

---

## 5. Skill 约束更新

已更新：

- `plugins/codex-paper/skills/study/SKILL.md`
- `plugins/codex-paper/skills/summary/SKILL.md`

核心约束变化：

1. 先运行 `prepare-paper.js`
2. 再读取 `paper-data.json` 和 `facts.json`
3. 再生成 `summary.md`、`insights.md`、`qa.md` 或 `quick-summary.md`

新增的生成约束：

- 只能使用 `paper-data.json` 或 `facts.json` 中已经存在的事实
- 不允许凭空新增指标值
- 定量结果必须带 `Source:`，并引用 `facts.json` 中的 section 名称

这一步的意义是把“生成内容”从完全自由写作，收束到“基于结构化事实再表达”。

---

## 6. Web UI 最小准确性支撑

新增 API：

- `plugins/codex-paper/src/web/server/api/papers/[slug]/facts.get.ts`

详情页现在会读取 `facts.json`，在文件浏览区上方显示 Facts 面板：

- `Core Claims`
- `Key Results`
- `Limitations`
- `Parser Quality`

首页卡片现在也会展示 `qualityFlags`。

涉及的主要文件：

- `plugins/codex-paper/src/web/components/PaperCard.vue`
- `plugins/codex-paper/src/web/composables/usePapers.ts`
- `plugins/codex-paper/src/web/pages/papers/[slug].vue`

本轮只做“证据可见、问题可见”，没有引入复杂可视化或重做现有文件树浏览逻辑。

---

## 7. CLI 与本地验证入口

根脚本：

- `scripts/codex-paper.sh`

共享变量与基础检测：

- `scripts/common.sh`

新增或更新的命令：

```bash
bash scripts/codex-paper.sh install
bash scripts/codex-paper.sh build
bash scripts/codex-paper.sh start
bash scripts/codex-paper.sh stop
bash scripts/codex-paper.sh status
bash scripts/codex-paper.sh smoke-test
bash scripts/codex-paper.sh benchmark
bash scripts/codex-paper.sh benchmark-report
```

本轮同时补充了：

- benchmark 目录环境变量
- `PyMuPDF` 可用性检查
- 自动安装 `PyMuPDF`

---

## 实施结果

## 1. Benchmark 结果

当前 parser benchmark 已通过：

- `Passed: 5/5`

说明：

- 5/5 样本 `stdout` 可解析为合法 JSON
- 5/5 样本返回了 `title`、`pageCount`、`parserVersion`
- 5/5 命中了 gold 中的 `expectedTitle`
- 5/5 满足 `forbiddenTitlePatterns`
- 5/5 命中至少一个主要作者
- 5/5 满足 abstract phrase 约束
- 5/5 页数精确匹配

最近一次 benchmark 报告输出位置：

- `/tmp/codex-paper-benchmark.json`

---

## 2. End-to-end 准备链路结果

已经成功通过 `prepare-paper.js` 准备至少两篇论文：

- `Qwen3_Technical_Report.pdf`
- `WebSailor.pdf`

已验证生成：

- `paper.pdf`
- `paper-data.json`
- `facts.json`
- `meta.json`

并成功更新：

- `~/codex-papers/index.json`

---

## 3. Web 构建与运行结果

已完成验证：

- web build 成功
- `/api/papers` 可返回论文列表
- `/api/papers/{slug}/facts` 可返回 facts 数据
- 首页与单篇页都能正常加载

说明：

在当前工具环境里，viewer 的长期后台驻留会受运行环境限制影响，因此测试使用了临时启动 + 健康检查的方式进行验证。该限制属于当前执行环境边界，不是项目逻辑错误。

---

## 当前数据契约

## 1. parser 公共输出

`parse-pdf.js` 当前公共输出契约：

```json
{
  "title": "string",
  "authors": ["string"],
  "abstract": "string",
  "pageCount": 0,
  "year": 2026,
  "githubLinks": ["string"],
  "codeLinks": ["string"],
  "sections": {
    "abstract": "string",
    "introduction": "string",
    "conclusion": "string"
  },
  "warnings": ["string"],
  "qualityFlags": ["string"],
  "parserVersion": "string"
}
```

---

## 2. facts.json 契约

当前 `facts.json` 结构：

```json
{
  "paperSlug": "string",
  "parserVersion": "string",
  "coreClaims": [
    {
      "text": "string",
      "evidence": {
        "section": "abstract",
        "quote": "string"
      }
    }
  ],
  "keyResults": [
    {
      "label": "string",
      "value": "string",
      "context": "string",
      "evidence": {
        "section": "abstract",
        "quote": "string"
      }
    }
  ],
  "limitations": [
    {
      "text": "string",
      "evidence": {
        "section": "conclusion",
        "quote": "string"
      }
    }
  ]
}
```

---

## 已知边界

P0 虽然已经建立了准确性基础，但它仍然是第一版底座，还存在这些边界：

1. 作者抽取仍是启发式规则，对极其拥挤的作者区、团队署名和机构混排情况还不够完美。
2. `facts.json` 目前主要来自摘要、引言、结论，还没有系统抽取实验表、图表标题、数据集和方法细粒度结构。
3. benchmark 目前只有 5 篇，能做回归，但覆盖面还不够广。
4. Web UI 现在是“文件浏览器 + facts 面板”，还不是完整的语义化研究阅读界面。
5. `paper-data.json` 当前保留了 `rawText`，对大论文来说文件会偏大；后续可能需要做缓存和裁剪策略。

---

## 后续迭代建议

## P1：解读质量与结构化分析

建议下一轮优先做：

1. 新增 `analysis.json`
2. 把 `quick-summary.md`、`summary.md` 改成“先结构化分析，再渲染 markdown”
3. 增加 `problem`、`coreIdea`、`contributions`、`resultsTable`、`limitations` 等固定字段
4. 让更多内容显式绑定 evidence，而不是只绑定 section 名称

---

## P2：语义化可视化与效率

建议再下一轮做：

1. 首页改为更轻量的索引加载
2. 单篇页改为语义化阅读界面，而不只是文件树浏览
3. 引入 parser / preparation 缓存，基于 `pdf hash + parserVersion` 判断是否需要重建
4. 扩展 benchmark 集，覆盖更多版式、更多论文类型和更多异常 PDF

---

## 推荐的继续推进顺序

如果要继续迭代，推荐顺序如下：

1. 先扩充 benchmark 集
2. 再增强 `facts.json` 的覆盖范围
3. 再落地 `analysis.json`
4. 最后再重构页面为语义化阅读页

这样做的原因是：

- benchmark 先稳，后续改 parser 才不会反复回退
- facts 先稳，summary / study 才有真正可靠的输入
- 结构化分析层先出现，前端可视化才有稳定数据源

---

## 快速回顾

P0 已经完成的事情可以概括为一句话：

`Codex Paper` 已经从“基于 prompt 的论文处理原型”，推进到了“带 benchmark、稳定 parser、单一 preparation 入口、evidence-first facts 层和最小 UI 支撑的可回归基础版本”。

这意味着后续迭代不再需要从零开始讨论“先做什么”，而是可以直接沿着 benchmark、facts、analysis、UI 这条链路继续推进。
