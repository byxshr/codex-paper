# P0-A2 Code Review 结论（第二轮）

Review 日期：2026-07-12
Review 范围：针对第一轮结论（`docs/P0-A2_CODE_REVIEW_RESULT.md`）L1/L2 的整改，以及更新后的 `docs/P0-A2_CODE_REVIEW_SUMMARY.md` 处置声明进行复核。
Reviewer：Claude（静态审阅 + 动态验证）

## 总体结论

**通过（可合并），无阻断项。** 第一轮的两项低级发现（L1、L2）已按声明整改完毕，整改本身经动态验证未引入新的安全弱化或渲染回归。第一轮的 I1/I2 明确“不修改”的处置合理。

## 逐项复核

### L1（已采纳，验证通过）— 删除无消费者的 `ACTIVE_CONTENT_SAFE_V_HTML` 导出
- 代码确认：`activeContentSecurity.mjs` 文件末尾（原 line 255）的导出已删除；全仓库 grep 无残留引用。
- 测试侧 `viewer-active-content.test.mjs:164` 保留独立硬编码的 `allowed` 集合。
- **处置评价：正确。** 生产代码与测试策略解耦后，测试作为独立守门人，不会被生产代码的同源修改自动放行——这比第一轮建议的“单一事实源 import”在安全语义上更强。Summary 对此的理由陈述准确。

### L2（已采纳，验证通过）— 补全 KaTeX 布局类白名单 + 回归测试
- 代码确认：新增 `KATEX_ALLOWED_CLASSES` 冻结常量（`activeContentSecurity.mjs:15-36`），含约 120 个显式类名 + `reset-size1..11` / `size1..11`，并保留原有的 `mord/mop/.../mfrac` 锚定正则（line 118）。有注释说明这些类只能来自 pinned KaTeX renderer。
- 新增回归测试 `viewer-active-content.test.mjs:64-78`：断言 `pmatrix`、`\widehat`、`\overrightarrow` 产出的 `mtable/col-align-c/arraycolsep/accent/delimcenter/hide-tail/svg-align` 均保留，且带 `onclick` 的 raw `<span class="tag cancel-pad col-align-c">` 被转义为文本、onclick 被剥离。

**动态安全验证（本轮实跑）：**
1. **allowlist 不会弱化过滤** — 验证 sanitize-html 对字符串类是精确匹配：`tag` 通过、`tag-evil` 与 `evilclass` 被剥离。扩充白名单只放行枚举内的确切类名，不引入前缀/子串放行。
2. **raw HTML 注入这些类仍被阻断** — 因为原始 HTML 在 KaTeX 之前已被 renderer 转义进 `<pre><code>`，攻击者无法用 `<span class="katex ...">` 走私（测试 line 76-77 已覆盖，实跑确认）。
3. **`\htmlClass{evil}{x}` 注入无效** — marked-katex 默认 strict 模式禁用 HTML 扩展，`\htmlClass` 被当作文本，`evil-injected` 仅作为转义文本出现在 annotation 中，不落入任何 class 属性。
4. **覆盖完整性** — 对 `\sum \int \sqrt \frac \widehat \overrightarrow pmatrix array \cancel \boxed` 的复合表达式渲染，无任何合法 KaTeX 类被误剥离（stripped = 空）。

**处置评价：正确且安全。** 类名收敛为显式枚举而非放开 `class` 通配，符合“对齐 pinned CSS 而非放行任意用户类名”的注释意图。

### I1（不修改，合理）— BMP 在直接文件展示 vs Markdown 内联 raster allowlist 的差异
`file.get.ts`/`raw.get.ts` 支持 `.bmp` 直接展示，而 `activeContentSecurity.mjs:7` 的 Markdown 内联 `RASTER_EXTENSIONS` 不含 `.bmp`（无 BMP 签名校验路径）。这是有意的保守差异，安全侧偏严，接受“不修改”。

### I2（不修改，合理）— highlight.js 转义输出属既有批准路径
其上游版本风险由 P1-3 依赖治理跟踪，接受“不修改”。

## 测试与证据核验

- 本轮实跑 `viewer-active-content.test.mjs`：**9/9 通过**（第一轮为 8，新增 KaTeX 回归测试，与 Summary “52/52”口径一致——即 +1 项）。
- 实跑 `viewer-security.test.mjs`：**12/12 通过**，路径穿越/符号链接类防线无回归。
- Summary 中 production build / 真实 HTTP integration / browser canary / plugin validator（版本 `2.0.0+codex.20260712051635`）采信声明；本轮未重跑生产构建，静态核对断言逻辑无误。
- `npm audit` 34 项告警仍属既有 Nuxt 依赖树，与本轮无关，留 P1-3。

## 遗留观察（非阻断，无需本轮处理）

- **O1（信息级）**：`KATEX_ALLOWED_CLASSES` 是手工维护的、对齐当前 pinned KaTeX `0.16.x` CSS 的快照。若未来升级 KaTeX 版本，新引入的布局类可能未在白名单内而导致公式视觉降级（非安全问题）。建议在依赖升级 checklist 中附一句“核对 KaTeX 类白名单”。当前 `sanitize-html` 与 KaTeX 均已 pin，风险已被冻结。

## 复核签署

第一轮 L1/L2 整改到位且经动态验证无副作用，I1/I2 处置合理。P0-A2 在声明的威胁模型内目标达成，P0-A1 无回归，无安全阻断项。**第二轮同意合并。**
