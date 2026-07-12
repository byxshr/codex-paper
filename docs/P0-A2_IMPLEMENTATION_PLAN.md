# P0-A2：Web 主动内容隔离实施记录

## 目标

在不信任论文包和模型输出的前提下，阻止 Markdown、Ask、Notebook、HTML 与 SVG 在 Viewer 同源上下文中执行主动内容。Viewer 改为严格 CSP 下的纯客户端 SPA；生成型 `index.html` 只提供用户显式开启的静态安全预览。

## 实施范围

- 服务端统一解析并净化 Markdown、Ask 与 Notebook Markdown。
- HTML 移除脚本、样式、表单、嵌入、导航和外部资源后生成静态预览。
- Notebook rich output 结构化输出；HTML、SVG 与 JavaScript 降级为转义文本。
- SVG 仅提供源码与安全下载，禁止内联图片渲染。
- 应用、API 与 raw 响应设置 CSP 和防嗅探等安全头。
- 增加单元、静态门禁、真实 HTTP 集成与浏览器 canary 验收。

## 非目标

- 不执行论文包内任意 JavaScript。
- 不提供带脚本权限的 iframe sandbox。
- 不修改 study 产物的自包含交互式导出契约。
- 不实现 P0-A3 的生成代码执行 sandbox，也不实现跨进程锁。

## 阶段与状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| 方案与威胁边界 | 完成 | 审计建议与用户确认的静态安全预览方案 |
| 服务端净化与 API | 完成 | `activeContentSecurity.mjs`；detail/file/Ask/index/raw API 契约 |
| Viewer 与响应头 | 完成 | client-only SPA、外部 bootstrap、严格 CSP、结构化 Notebook、HTML/SVG 隔离 |
| 自动化与 Browser QA | 完成 | Review 修订后 52/52 repository/security、23/23 study、真实 HTTP、临时恶意库与零 canary 命中 |
| 插件验证与重装 | 完成 | 官方 validator 通过；`2.0.0+codex.20260712051635` 指向 `plugins/codex-paper/` |

## 验收命令

- Repository Contract：通过，145 个 tracked 文件。
- repository/security tests：52/52；study tests：23/23。
- parser：5/5；reasoning：12/12；package：10/10。
- production build、真实 HTTP `security-test` 与 smoke test：通过。
- Browser QA：严格 CSP 下 hydration 和 session refresh 正常；Markdown、Ask 历史、Notebook、HTML、SVG payload 均未执行；父 URL 不变、无弹窗、canary 0 命中；tags mutation 正常。
- 官方 plugin validator：通过；active path 为 `plugins/codex-paper/`，版本 `2.0.0+codex.20260712051635`。

## Code Review 处置

独立 Review 结论为通过、无阻断项。低优先级建议的处理如下：

- L1：采纳“删除未使用导出”的方案。`v-html` 允许集合继续由测试独立定义，避免生产代码自行扩大列表时测试自动放行。
- L2：采纳。按 pinned KaTeX CSS 补全有限布局类集合，并新增矩阵、重音和伸缩结构回归；raw HTML class 仍被转义为文本。
- I1：保留现状。BMP 只在直接文件查看路径作为 raster，Markdown 内联仍采用 PNG/JPEG/GIF/WebP 的更窄策略。
- I2：保留现状并纳入依赖升级关注项；highlight.js 输出仍受静态 `v-html` 门禁约束。

第二轮独立 Review 再次结论为通过、无阻断项，确认 L1/L2 整改没有引入安全弱化或渲染回归。新增信息级 O1 已记录为依赖升级约束：未来升级 KaTeX 时必须同步核对 `KATEX_ALLOWED_CLASSES` 与 bundled CSS，并运行复杂公式回归，禁止以任意 class 通配替代有限白名单。

## 回滚

本轮不 stage、commit 或 push。若实施失败，可按工作树差异逐文件回滚 P0-A2 修改；不得影响已提交的 P0-A1 阶段性基线，也不得修改本地 Attention 样本目录。
