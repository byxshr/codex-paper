# P0-A2 Code Review 结论

Review 日期：2026-07-12
Review 范围：`docs/P0-A2_CODE_REVIEW_SUMMARY.md` 声明的主动内容隔离实施，覆盖服务端净化模块、API 契约、Viewer SPA、响应头与测试证据。
Reviewer：Claude（人工辅助静态审阅 + 局部动态验证）

## 总体结论

**通过（可合并），无阻断项。** 该实施在“论文包与模型输出完全不可信”的威胁模型下达成了设计目标：所有进入 `v-html` 的内容都来自服务端 `sanitize-html` 净化字段或 highlight.js 转义输出；HTML/SVG/Notebook rich output/JavaScript 均被降级为源码或结构化视图；应用侧 CSP 为 `script-src 'self'`，不依赖 nonce/unsafe-inline。8 项单元测试与真实 HTTP 集成测试均通过。

发现的问题均为 **低/信息级**，不构成安全绕过，不阻塞合并。

## 验证过的关键防线（确认有效）

1. **Markdown 净化** — `renderSafeMarkdown` 先用自定义 renderer 把原始 HTML 转义进 `<pre><code>`，再经 `sanitize-html` 白名单过滤。`javascript:`/`vbscript:`/外链图片/伪 PNG data URI/`<script>`/`onerror` 全部被剥离或转义（`activeContentSecurity.mjs:124`、集成测试 `viewer-security.integration.mjs:132-139`）。
2. **图片路径变换** — `safePaperImageUrl` 拒绝绝对 URL、协议相对 URL、scheme 前缀，并对拼接后的相对路径复用 `normalizeRelativePath` + `isPublicRelativePath` + 扩展名白名单，回落到受控的 `/raw` 端点（`activeContentSecurity.mjs:56`）。
3. **data URI 图片签名校验** — `safeDataImage`/`safeRasterOutput` 解码后核验 PNG/JPEG/GIF/WEBP 魔数，阻断把 SVG 伪装成 `image/png` 的注入；测试覆盖 `PHN2ZyBvbmxvYWQ...`（`activeContentSecurity.mjs:12,20,179`；测试 line 127-133）。
4. **静态 HTML 预览** — `createStaticHtmlPreview` 丢弃 `style/script/textarea/noscript/template`，把 `<a>` 降级为 `<span>`，只保留通过签名校验的 data 图片，并在 iframe `srcdoc` 内嵌第二层 `default-src 'none'` CSP。Viewer 侧 iframe 用 `sandbox=""`（无 token）+ `referrerpolicy="no-referrer"`（`[slug].vue:166-173`）。双层防御到位。
5. **Notebook** — MIME 优先级把 `text/html`、`image/svg+xml`、`application/javascript`、`text/javascript` 一律标为 `blocked` 并作为纯文本展示；仅 raster 图与纯文本可渲染；`blocked` 节点不进入 `v-html`（`activeContentSecurity.mjs:193`，`[slug].vue:186-200`）。
6. **SVG** — 从 image 类型分离，`file` API 只返回源码 + `downloadUrl`；`raw` 端点对 SVG 强制 `Content-Type: application/octet-stream`、`Content-Disposition: attachment`、`default-src 'none'; sandbox` CSP，杜绝内联执行（`raw.get.ts:19-23`）。
7. **外部化 SPA bootstrap** — 内联 `window.__NUXT__` 脚本被替换为 `/__codex-paper-spa-bootstrap.js` 外链，仅暴露 `runtimeConfig.public` 与 `app`，并对 `<`、U+2028/2029 做转义，满足严格 CSP 且不泄漏私有 runtime config（`externalize-spa-bootstrap.ts`、`routes/__codex-paper-spa-bootstrap.js.get.ts`）。
8. **全局安全头** — `00-headers.ts` 为非 API 路由设置应用 CSP、`X-Frame-Options: DENY`、`COOP`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、限制性 `Permissions-Policy`；API 路由设 `Cache-Control: no-store`。集成测试断言这些头（line 91-96）。
9. **v-html 门禁** — 单元测试遍历所有 `.vue`，断言 `v-html` 表达式只属于 5 个白名单字段，并断言删除了旧的 `PaperContent.vue`（测试 line 135-156）。同时断言无 `allow-scripts`/`createObjectURL`/`window.open`/`marked.parse` 逃逸口（line 158-165）。
10. **依赖锁定** — `sanitize-html` 精确锁定 `2.17.5`（`package.json:21`、`package-lock.json:16`），符合“精确锁定”声明。
11. **P0-A1 回归** — 集成测试完整覆盖 session pairing/CSRF/Origin 校验/路径穿越/符号链接/回收站删除与恢复，均未回归（line 104-192）。

## 发现的问题

### 低 — L1：`ACTIVE_CONTENT_SAFE_V_HTML` 导出无消费者
`activeContentSecurity.mjs:255` 导出了冻结的白名单数组，但全仓库无任何导入（已 grep 确认）。真正生效的 v-html 白名单硬编码在测试 `viewer-active-content.test.mjs:148` 中，两处存在漂移风险：若未来新增合法 v-html 字段，需同时手改测试与该导出，容易忘记同步。
- 建议：让测试从该导出 import 白名单（单一事实源），或删除未使用的导出以免误导读者。非阻断。

### 低 — L2：KaTeX allowedClasses 白名单不完整，部分数学结构会降级渲染
`sanitizeRenderedMarkdown` 的 `allowedClasses` 正则覆盖了常见 KaTeX 类（已动态验证 `\frac`、上下标、`\sqrt`、`\sum`、`\int`、`pmatrix`、`\left(...\right)` 均无类被剥离）。但正则未包含若干 KaTeX 布局类，例如 `mtable`/`col-align-*`/`arraycolsep`（复杂矩阵对齐）、`accent-body`、`sout`/`cancel-*`、`stretchy`/`hide-tail`/`halfarrow-*`/`brace-*`（可伸缩箭头与花括号）、`x-arrow`、`delimcenter`。命中这些类的公式会被剥离样式类，导致**视觉降级**（错位/重叠），不影响安全。
- 建议：如需完整数学渲染保真，补全这些类到白名单；否则记录为已知渲染限制。纯功能问题，非安全、非阻断。

### 信息 — I1：`file.get.ts` 的 `getFileType` 把 `.bmp` 归为 image，但 raw 层无 bmp 处理一致性
`file.get.ts:5` 的 `RASTER_EXTENSIONS` 含 `.bmp`，`raw.get.ts:6` 的 `MIME_TYPES` 也含 `.bmp`。但 `activeContentSecurity.mjs:7` 的 `RASTER_EXTENSIONS`（用于 Markdown 内联图片路径）**不含** `.bmp`，故 Markdown 里引用 `.bmp` 图片会被降级为 `blocked-image`。这属于设计上的保守取舍（bmp 无签名校验路径），行为一致且安全，仅记录以免误认为 bug。

### 信息 — I2：`highlightedHtmlCode`/`highlightedCode` 依赖 highlight.js 转义正确性
HTML 源码视图与代码视图经 highlight.js `highlight()` 输出后直接 `v-html`（`[slug].vue:174,184`）。这是 highlight.js 的既定安全契约（其对 token 文本做 HTML 转义），当前用法未开启 `ignoreIllegals` 之外的危险选项，属可接受。仅提示：此防线依赖上游库正确性，应随 highlight.js 版本升级关注其安全公告。

## 测试与证据核验

- 本地执行 `node --test scripts/tests/viewer-active-content.test.mjs`：**8/8 通过**（已实跑确认）。
- 动态验证 `safeDataImage` 魔数校验、KaTeX 类剥离情况、SPA bootstrap 序列化转义，均与代码声明一致。
- 集成测试 `viewer-security.integration.mjs` 断言链完整（需先产出 `.output` 生产构建；本次未重跑生产构建，采信 Summary 声明的通过结果 + 静态核对断言逻辑无误）。
- `npm audit` 34 项告警属既有 Nuxt 依赖树，与本轮引入 sanitizer 无关，按既定范围留给 P1-3，未见与当前本地威胁模型直接相关的阻断项。此判断合理。

## 建议后续动作（非阻断）

1. 收敛 v-html 白名单为单一事实源（L1）。
2. 视数学渲染需求决定是否补全 KaTeX 类白名单（L2）。
3. 依赖治理（Nuxt 树告警）按计划在 P1-3 处理。

## 复核签署

在声明的威胁模型内，P0-A2 的主动内容隔离目标达成，P0-A1 能力未回归，无安全阻断项。**同意合并**，上述低/信息级项可作为后续清理项跟进。
