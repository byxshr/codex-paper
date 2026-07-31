# P0-A2 Code Review Handoff

## Review 目标

验证 Viewer 在论文包和模型输出完全不可信时，不会通过 Markdown、Ask、Notebook、HTML 或 SVG 执行主动内容；同时确认 P0-A1 的认证、路径和回收站能力未回归。

## 主要变更

- 新增统一服务端安全模块 `activeContentSecurity.mjs`，精确锁定 `sanitize-html@2.17.5`。
- detail/file/Ask/index API 输出安全派生字段，Notebook 改为结构化 view model。
- HTML 改成默认源码、显式静态安全预览；移除脚本 sandbox token、blob 与新标签执行入口。
- SVG 从 image 分离，改为源码与 attachment 下载。
- Viewer 改为 SPA，应用 shell 的 Nuxt bootstrap 外部化，以满足 `script-src 'self'` 且不依赖 nonce/unsafe-inline。
- 新增全局 CSP/安全头和静态 `v-html` 门禁。

## 建议重点检查

1. sanitizer allowlist、Markdown 图片路径变换和 data URI 文件签名校验是否存在绕过。
2. HTML preview 是否能保留第二份 CSP、导航、资源加载、CSS 或 sandbox allow token。
3. Notebook MIME 优先级和 blocked 节点是否可能回流到 `v-html`。
4. 外部化 SPA bootstrap 是否只暴露 public/app runtime config，且严格 CSP 下 hydration 正常。
5. SVG raw header、PDF iframe 与 P0-A1 session/CSRF/no-follow 行为是否兼容。
6. 新增 `v-html` 是否全部属于服务端净化字段或 highlight.js 输出。

## 测试证据

- Repository Contract：通过，145 个 tracked 文件。
- repository/security：Review 修订后 52/52；study：23/23。
- parser benchmark：5/5；reasoning：12/12；package：10/10。
- production build、真实 HTTP security integration、smoke test：通过。
- Browser 临时恶意库：严格 CSP 下 SPA hydration、配对和刷新正常；Markdown/Ask history/Notebook/HTML/SVG 不设置父页面变量、不弹窗、不改变 URL；静态 HTML iframe 为空 sandbox、no-referrer，内部主动节点为 0；canary 请求数为 0；tags mutation 正常。
- P0-A1 回归：session/CSRF/path/trash/restore 的单元与真实 HTTP 流程通过。
- 官方 plugin validator：通过；marketplace 重装路径为 `plugins/codex-paper/`，版本 `2.0.0+codex.20260712051635`。

`npm audit` 仍报告现有 Nuxt 依赖树的 34 项告警（4 low、12 moderate、14 high、4 critical）；数量与本轮加入 sanitizer 前一致，未执行破坏性 `audit fix --force`。依赖治理按既定范围留给 P1-3，Review 可单独判断是否存在与当前本地威胁模型直接相关的阻塞项。

## 独立 Review 结论与处置

`docs/P0-A2_CODE_REVIEW_RESULT.md` 结论为通过、可合并、无阻断项。

- L1 已采纳：删除无消费者的 `ACTIVE_CONTENT_SAFE_V_HTML` 导出，保留测试侧独立的允许集合，避免测试策略被生产代码同源修改而自动放行。
- L2 已采纳：依据 pinned KaTeX CSS 补全有限布局类集合，并新增复杂矩阵、重音、伸缩结构及 raw HTML class 不生效的回归测试。
- I1 不修改：BMP 的直接文件展示与 Markdown 更窄的 raster allowlist 是有意的保守差异。
- I2 不修改：highlight.js 的转义输出属于现有批准路径，其版本风险继续由 P1-3 依赖治理跟踪。

第二轮 Review（`docs/P0-A2_CODE_REVIEW_RESULT_ROUND2.md`）再次给出“通过、可合并、无阻断项”，动态确认有限 KaTeX 类枚举、raw HTML 转义和 `\htmlClass` 禁用边界均有效。新增信息级 O1 已采纳为维护约束：KaTeX 版本升级必须同步审计类白名单和复杂公式回归，不需要在本轮修改运行时代码。

## 已知非目标

- 不执行生成型 JavaScript，也不提供带 `allow-scripts` 的 iframe。
- 不实现 P0-A3 的生成代码 sandbox。
- 不改变 `index.html` 作为自包含交互式导出产物的生成契约。
