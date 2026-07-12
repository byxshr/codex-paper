# Web 主动内容安全边界

## 安全目标

论文包、Notebook 和模型回答均视为不可信输入。即使输入包含恶意 HTML、SVG、Markdown、链接或 rich output，Viewer 也不得在自身同源上下文中执行脚本、自动发起外部请求、提交表单、控制父页面导航或获得 opener。

本边界独立于 study validator。validator 通过不代表内容可以在 Viewer 中执行。

## 应用外壳

- Viewer 是 `ssr: false` 的客户端 SPA。
- 应用脚本仅允许同源外部文件；Nuxt runtime bootstrap 由同源外部脚本提供，HTML shell 不含内联可执行脚本。
- 应用 CSP 禁止 inline script、事件属性、inline style、object、worker、外部连接和被其他页面嵌入。
- 使用系统字体和随构建产物发布的 KaTeX 字体，不访问远程字体服务。
- API 响应统一 `Cache-Control: no-store`，并设置 no-referrer、nosniff、DNS prefetch off 和受限 Permissions Policy。

## 可信渲染管线

`server/utils/activeContentSecurity.mjs` 是唯一主动内容转换入口，依赖精确锁定的 `sanitize-html@2.17.5`。

### Markdown 与 Ask

- raw HTML 作为转义源码显示，不解释成标签。
- marked/KaTeX 输出再次经过标签和属性 allowlist。
- 禁止 style、事件属性、script、iframe、form、object、embed、meta、base 和 SVG。
- 外链只允许 HTTP(S)，强制 `target="_blank" rel="noopener noreferrer"`；页内锚点保留。
- 图片仅允许当前论文内公开 raster 文件，或具有正确文件签名的 PNG/JPEG/GIF/WebP data URI；外部图片与 SVG 均阻断。

### Notebook

API 返回结构化 view model，而不是整段 Notebook HTML：

- Markdown cell 返回服务端净化后的 `renderedHtml`。
- code、raw、stream、error 和 text 使用 Vue 文本插值。
- 具有有效文件签名的 PNG/JPEG base64 output 可以显示。
- `text/html`、SVG 和 JavaScript rich output 返回 `blocked` 节点并以文本显示。
- `content` 固定为 `null`，客户端不重新解析原始 Notebook。

### HTML

HTML 默认显示源码。“静态安全预览”必须由用户显式点击后开启：

- 删除源 script、style/style 属性、表单、iframe、媒体、object/embed、meta/base/link、SVG、事件属性、链接导航和外部资源。
- 不保留包内 CSS；只使用 Viewer 注入的只读基础排版。
- `srcdoc` 内含 `default-src 'none'`、`script-src 'none'`、`connect-src 'none'`、`form-action 'none'` 等 CSP。
- iframe 使用空 sandbox、opaque origin 和 `referrerpolicy="no-referrer"`，没有任何 allow token。
- 不提供 blob 或新标签执行入口。

### SVG、PDF 与 raster

- SVG 在 file API 中返回源码与 `downloadUrl`；raw 响应使用 `application/octet-stream`、attachment、nosniff 和 sandbox CSP。
- SVG 不属于普通 image 类型，也不能出现在 Markdown/Notebook/HTML 的可执行渲染路径。
- PDF 与可信 raster 继续通过受认证的 same-origin raw API 显示。

## 接口契约

- `GET /api/papers/:slug`：兼容保留 `markdown`，新增安全 `renderedHtml`。
- `GET /api/papers/:slug/file`：按类型返回 `renderedHtml`、`previewHtml`、`notebook` 或 `downloadUrl`；Notebook `content` 为 `null`。
- `POST /api/papers/:slug/ask`：保留原始 `answer`，新增安全 `answerHtml`。
- `GET /api/papers`：`url`、`githubLinks`、`codeLinks` 只保留 HTTP(S)。

这些 API 仍受 P0-A1 的 session、Host、Origin、CSRF、no-follow resolver 和大小预算保护。

## 剩余风险

- 交互式 `index.html` 仍是导出产物，但必须在未来专用运行环境或用户自行控制的导出流程中运行；当前 Viewer 不执行它。
- highlight.js 只处理源码字符串并输出转义 token；所有新增 `v-html` 必须通过静态门禁加入明确批准集合。
- `KATEX_ALLOWED_CLASSES` 是与当前 pinned KaTeX CSS 对齐的有限快照。升级 KaTeX 时必须比对新版本生成类与 bundled CSS、更新白名单并运行复杂矩阵/重音/伸缩公式回归；缺类通常造成视觉降级，不应通过放开任意 class 来修复。
- CSP 是纵深防御，不替代服务端净化。任何新的内容类型都必须先定义降级策略和恶意 fixture。
- P0-A3 将单独处理生成代码执行策略与 sandbox，不属于本边界。
