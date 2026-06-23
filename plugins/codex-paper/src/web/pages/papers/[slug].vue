<template>
  <div class="reader-container">
    <!-- Loading State -->
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>正在加载学习材料...</p>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="error-state">
      <div class="error-icon">⚠</div>
      <h2>无法加载论文</h2>
      <p>{{ error }}</p>
      <NuxtLink to="/" class="back-home">← 返回论文库</NuxtLink>
    </div>

    <!-- Main Reading Interface -->
    <div v-else class="reader">
      <!-- Top Navigation Bar -->
      <nav class="top-bar">
        <NuxtLink to="/" class="back-to-library">
          <span class="back-arrow">←</span>
          <span class="back-text">论文库</span>
        </NuxtLink>

        <div class="paper-title-nav">
          <h1>{{ paper?.title }}</h1>
        </div>

        <div class="actions">
          <VSCodeButton :path="paperPath" />
          <a v-if="paper?.url" :href="paper.url" target="_blank" class="external-link" title="查看原论文">
            <span>原论文</span>
            <span class="arrow">↗</span>
          </a>
        </div>
      </nav>

      <!-- Main Content Area -->
      <div class="main-content">
        <!-- Sidebar File Tree -->
        <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
          <div class="sidebar-inner">
            <div v-if="!sidebarCollapsed" class="sidebar-header">
              <h3>学习材料</h3>
              <button @click="toggleSidebar" class="collapse-btn" title="收起">
                ←
              </button>
            </div>

            <button v-else @click="toggleSidebar" class="expand-btn" title="展开">
              →
            </button>

            <div v-if="!sidebarCollapsed" class="file-tree">
              <FileTreeNode
                v-for="node in fileTree"
                :key="node.path"
                :node="node"
                :selected-path="selectedFile"
                @select="selectFile"
              />
            </div>
          </div>
        </aside>

        <!-- Reading Pane -->
        <main class="reading-pane">
          <div class="reading-header">
            <div class="breadcrumb">
              <span class="crumb paper-name">{{ slug }}</span>
              <span class="separator">/</span>
              <span class="crumb file-name">{{ selectedFile || 'README.md' }}</span>
            </div>

            <div class="reading-actions">
              <!-- HTML file controls -->
              <div v-if="fileType === 'html'" class="html-controls">
                <button @click="toggleHtmlView" class="control-btn">
                  <span v-if="showHtmlPreview">源码</span>
                  <span v-else>预览</span>
                </button>
                <button @click="openHtmlInNewTab" class="control-btn">
                  <span>新标签打开</span>
                </button>
              </div>
              <button
                @click="toggleAskPanel"
                class="control-btn ask-toggle"
                :class="{ active: askPanelOpen }"
              >
                <span>Ask Codex</span>
              </button>
            </div>
          </div>

          <section v-if="askPanelOpen" class="ask-panel">
            <div class="ask-panel-header">
              <div>
                <h2>向 Codex 提问</h2>
                <p>回答会优先基于当前学习包和本地论文证据，并追加到 chat-notes.md。</p>
              </div>
              <button @click="toggleAskPanel" class="close-ask" title="关闭">×</button>
            </div>

            <textarea
              v-model="askQuestion"
              class="ask-input"
              rows="4"
              placeholder="输入你想追问的问题，例如：这篇论文的方法相比 baseline 的关键差异是什么？"
              :disabled="askLoading"
              @keydown.meta.enter.prevent="submitAsk"
              @keydown.ctrl.enter.prevent="submitAsk"
            ></textarea>

            <div class="ask-actions">
              <button
                @click="submitAsk"
                class="ask-submit"
                :disabled="askLoading || !askQuestion.trim()"
              >
                <span v-if="askLoading">回答中...</span>
                <span v-else>发送给 Codex</span>
              </button>
              <button
                v-if="fallbackPrompt"
                @click="copyFallbackPrompt"
                class="ask-secondary"
              >
                复制提示词
              </button>
              <span v-if="copyStatus" class="ask-copy-status">{{ copyStatus }}</span>
            </div>

            <p v-if="askError" class="ask-error">{{ askError }}</p>
            <div v-if="askSavedTo" class="ask-saved">
              <span>已保存到 {{ askSavedTo }}</span>
              <button type="button" @click="openChatNotes">查看历史</button>
            </div>

            <div v-if="askAnswer" class="ask-answer markdown-body" v-html="renderedAskAnswer"></div>
          </section>

          <nav v-if="reasoning?.available" class="reader-tabs" aria-label="v2 evidence views">
            <button
              v-for="tab in readerTabs"
              :key="tab.key"
              type="button"
              class="reader-tab"
              :class="{ active: activeReaderTab === tab.key }"
              @click="activeReaderTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </nav>

          <article v-if="activeReaderTab === 'materials'" class="content">
            <div v-if="fileLoading" class="file-loading">
              <div class="shimmer"></div>
            </div>
            <div v-else-if="fileType === 'image'" class="file-viewer image-viewer">
              <img :src="fileUrl" :alt="selectedFile" />
            </div>
            <div v-else-if="fileType === 'pdf'" class="file-viewer pdf-viewer">
              <iframe :src="fileUrl" frameborder="0"></iframe>
            </div>
            <div v-else-if="fileType === 'html'" class="file-viewer html-viewer">
              <iframe
                v-if="showHtmlPreview"
                :srcdoc="processedHtmlContent"
                frameborder="0"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              ></iframe>
              <pre v-else><code class="language-html" v-html="highlightedHtmlCode"></code></pre>
            </div>
            <div v-else-if="fileType === 'code'" class="file-viewer code-viewer">
              <pre><code :class="`language-${fileLanguage}`" v-html="highlightedCode"></code></pre>
            </div>
            <div v-else-if="fileType === 'notebook'" class="file-viewer notebook-viewer" v-html="renderedNotebook"></div>
            <div v-else-if="fileContent" v-html="renderedContent" class="markdown-body"></div>
            <div v-else class="empty-state">
              <p>暂无可显示内容</p>
            </div>
          </article>

          <article v-else class="content evidence-content">
            <section v-if="activeReaderTab === 'audit'" class="evidence-view">
              <header class="evidence-view__header">
                <div>
                  <h2>证据审计</h2>
                  <p>{{ reasoning.paperType }} · {{ reasoning.contextMode }} · {{ reasoning.evidenceQuality }}</p>
                </div>
                <span class="validation-pill">{{ reasoning.validationStatus || 'not validated' }}</span>
              </header>

              <div class="audit-grid">
                <article v-for="claim in reasoning.centralClaims || []" :key="claim.id" class="audit-card">
                  <div class="audit-card__top">
                    <EvidenceBadge :source-type="claim.sourceType" />
                    <span>{{ claim.confidence }}</span>
                  </div>
                  <h3>{{ claim.statement }}</h3>
                  <p v-if="claim.scope">Scope: {{ claim.scope }}</p>
                  <div class="evidence-buttons">
                    <button v-for="ref in claim.evidenceRefs" :key="ref" type="button" @click="openEvidence(ref)">
                      查看证据
                    </button>
                  </div>
                </article>
              </div>

              <h3 class="section-label">验证链</h3>
              <article v-for="validation in reasoning.validations || []" :key="validation.id" class="audit-card">
                <div class="audit-card__top">
                  <span class="node-type">{{ validation.kind }}</span>
                  <EvidenceBadge :source-type="validation.sourceType" />
                </div>
                <p><strong>问题:</strong> {{ validation.question }}</p>
                <p><strong>设计:</strong> {{ validation.design }}</p>
                <p><strong>观察:</strong> {{ validation.observation }}</p>
                <p><strong>结论:</strong> {{ validation.conclusion }}</p>
                <div class="evidence-buttons">
                  <button v-for="ref in validation.evidenceRefs" :key="ref" type="button" @click="openEvidence(ref)">
                    查看证据
                  </button>
                </div>
              </article>
            </section>

            <section v-else-if="activeReaderTab === 'reasoning'" class="evidence-view">
              <header class="evidence-view__header">
                <div>
                  <h2>作者推理</h2>
                  <p>从观察、约束或失败模式到设计和验证的路径。</p>
                </div>
              </header>
              <ReasoningPath :nodes="reasoning.authorReasoningPath || []" @select-evidence="openEvidence" />
            </section>

            <section v-else-if="activeReaderTab === 'reviewer'" class="evidence-view">
              <header class="evidence-view__header">
                <div>
                  <h2>审稿人视图</h2>
                  <p>最弱假设、最小复现、最强反例和不确定区域。</p>
                </div>
              </header>
              <ReviewerPanel :reasoning="reasoning" />
            </section>
          </article>
        </main>
      </div>
    </div>

    <EvidenceDrawer
      :open="evidenceDrawerOpen"
      :evidence="selectedEvidence"
      :slug="slug"
      @close="evidenceDrawerOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import hljs from 'highlight.js/lib/core'
// Import common languages
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import type { Paper } from '~/composables/usePapers'

// Register languages
hljs.registerLanguage('python', python)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('html', xml) // Use xml for HTML syntax highlighting

// Configure marked with KaTeX extension
marked.use(markedKatex({
  throwOnError: false,
  output: 'html'
}))

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

const route = useRoute()
const slug = route.params.slug as string

// Main data
const { papers, loadPapers, getPaper } = usePapers()
const loading = ref(true)
const error = ref<string | null>(null)
const paper = ref<Paper | null>(null)

// File tree and selection
const fileTree = ref<FileNode[]>([])
const selectedFile = ref('')
const fileContent = ref('')
const fileType = ref('markdown')
const fileLanguage = ref('plaintext')
const fileUrl = ref('')
const fileLoading = ref(false)

// UI state
const sidebarCollapsed = ref(false)
const showHtmlPreview = ref(true)
const askPanelOpen = ref(false)
const askQuestion = ref('')
const askAnswer = ref('')
const askError = ref('')
const askLoading = ref(false)
const fallbackPrompt = ref('')
const copyStatus = ref('')
const askSavedTo = ref('')
const askEntryId = ref('')
const activeReaderTab = ref<'materials' | 'audit' | 'reasoning' | 'reviewer'>('materials')
const evidenceDrawerOpen = ref(false)
const selectedEvidence = ref<any | null>(null)
const { reasoning, loadReasoning, loadEvidence } = usePaperEvidence(slug)

const readerTabs = [
  { key: 'materials', label: '学习材料' },
  { key: 'audit', label: '证据审计' },
  { key: 'reasoning', label: '作者推理' },
  { key: 'reviewer', label: '审稿人视图' }
] as const

const loadFileTree = async () => {
  const tree = await $fetch<FileNode[]>(`/api/papers/${slug}/files`)
  fileTree.value = tree
  return tree
}

// Load paper metadata and file tree
onMounted(async () => {
  try {
    if (papers.value.length === 0) {
      await loadPapers()
    }

    paper.value = getPaper(slug)

    if (!paper.value) {
      error.value = '未找到论文'
      return
    }

    // Load file tree
    await loadFileTree()
    await loadReasoning()

    await loadFile(pickDefaultFile(fileTree.value))

  } catch (e: any) {
    error.value = e.message || '加载论文失败'
  } finally {
    loading.value = false
  }
})

const flattenFiles = (nodes: FileNode[]): string[] => {
  return nodes.flatMap((node) => {
    if (node.type === 'directory') {
      return flattenFiles(node.children || [])
    }
    return [node.path]
  })
}

const pickDefaultFile = (nodes: FileNode[]) => {
  const files = flattenFiles(nodes)
  const preferred = [
    'README.md',
    'index.html',
    'summary.md',
    'insights.md',
    'method.md',
    'mental-model.md',
    'reflection.md',
    'qa.md',
    'paper.pdf',
    'quick-summary.md'
  ]
  return preferred.find((path) => files.includes(path)) || files[0] || 'README.md'
}

// Load a specific file
const loadFile = async (path: string) => {
  fileLoading.value = true
  try {
    const data = await $fetch(`/api/papers/${slug}/file`, {
      params: { path }
    })

    console.log('File loaded:', { path, type: data.type, contentLength: data.content?.length, language: data.language })

    selectedFile.value = path
    fileType.value = data.type || 'markdown'
    fileContent.value = data.content || ''
    fileLanguage.value = data.language || 'plaintext'
    fileUrl.value = data.url || ''

  } catch (e: any) {
    console.error('Error loading file:', e)
    fileContent.value = `文件加载失败: ${e.message}`
    fileType.value = 'text'
  } finally {
    fileLoading.value = false
  }
}

const selectFile = (path: string) => {
  activeReaderTab.value = 'materials'
  loadFile(path)
}

const openEvidence = async (evidenceId: string) => {
  try {
    selectedEvidence.value = await loadEvidence(evidenceId)
    evidenceDrawerOpen.value = true
  } catch (e: any) {
    selectedEvidence.value = {
      id: evidenceId,
      quote: e.data?.statusMessage || e.statusMessage || e.message || '证据加载失败',
      location: {}
    }
    evidenceDrawerOpen.value = true
  }
}

const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

const toggleHtmlView = () => {
  showHtmlPreview.value = !showHtmlPreview.value
}

const toggleAskPanel = () => {
  askPanelOpen.value = !askPanelOpen.value
}

const submitAsk = async () => {
  const question = askQuestion.value.trim()
  if (!question || askLoading.value) return

  askLoading.value = true
  askError.value = ''
  askAnswer.value = ''
  fallbackPrompt.value = ''
  copyStatus.value = ''
  askSavedTo.value = ''
  askEntryId.value = ''

  try {
    const response = await $fetch<{ answer: string; savedTo: string; entryId: string }>(`/api/papers/${slug}/ask`, {
      method: 'POST',
      body: {
        question,
        selectedFile: selectedFile.value
      }
    })

    askAnswer.value = response.answer
    askSavedTo.value = response.savedTo
    askEntryId.value = response.entryId
    await loadFileTree()
    if (selectedFile.value === response.savedTo) {
      await loadFile(response.savedTo)
      scrollToChatEntry(response.entryId)
    }
  } catch (e: any) {
    askError.value = e.data?.statusMessage || e.statusMessage || e.message || 'Codex 回答失败'
    fallbackPrompt.value = e.data?.data?.fallbackPrompt || ''
  } finally {
    askLoading.value = false
  }
}

const copyFallbackPrompt = async () => {
  if (!fallbackPrompt.value) return

  try {
    await navigator.clipboard.writeText(fallbackPrompt.value)
    copyStatus.value = '已复制'
  } catch {
    copyStatus.value = '复制失败'
  }
}

const scrollToChatEntry = (entryId: string) => {
  if (!entryId) return

  window.setTimeout(() => {
    document.getElementById(entryId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    })
  }, 100)
}

const openChatNotes = async () => {
  const target = askSavedTo.value || 'chat-notes.md'
  await loadFile(target)
  scrollToChatEntry(askEntryId.value)
}

const openHtmlInNewTab = () => {
  const blob = new Blob([processedHtmlContent.value], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
  // Clean up the URL after a delay
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const highlightedCode = computed(() => {
  if (!fileContent.value || fileType.value !== 'code') return ''

  try {
    return hljs.highlight(fileContent.value, {
      language: fileLanguage.value
    }).value
  } catch (e) {
    // If language not supported, return plain text
    return hljs.highlight(fileContent.value, { language: 'plaintext' }).value
  }
})

const paperFileBaseDir = (filePath: string) => {
  return filePath ? filePath.replace(/[^/]*$/, '') : ''
}

const normalizePaperAssetPath = (src: string, baseDir = '') => {
  const combinedPath = src.startsWith('/') ? src : `${baseDir}${src}`
  const parts: string[] = []

  for (const segment of combinedPath.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (parts.length === 0) {
        return null
      }
      parts.pop()
      continue
    }

    parts.push(segment)
  }

  return parts.join('/')
}

const rewritePaperImageSrc = (html: string, baseDir = '') => {
  return html.replace(
    /(<img\s[^>]*?)src\s*=\s*["'](?!data:|https?:|\/\/|\/api\/)([^"']+)["']/gi,
    (match, prefix, src) => {
      const fullPath = normalizePaperAssetPath(src, baseDir)
      if (!fullPath) {
        return match
      }
      return `${prefix}src="/api/papers/${slug}/raw?path=${encodeURIComponent(fullPath)}"`
    }
  )
}

// Process HTML content to fix HiDPI canvas rendering and rewrite relative image paths
const processedHtmlContent = computed(() => {
  if (!fileContent.value || fileType.value !== 'html') return ''

  let html = rewritePaperImageSrc(fileContent.value, paperFileBaseDir(selectedFile.value))

  // Inject a script before </body> (or at the end) to fix canvas HiDPI rendering
  // and make canvases responsive to viewport resizing via CSS scaling
  const dpiFixScript = `<script>
(function() {
  var dpr = window.devicePixelRatio || 1;
  if (dpr <= 1) return;

  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    if (type === '2d' && !this.dataset.dpiFixed) {
      var logicalW = this.getAttribute('width') ? parseInt(this.getAttribute('width')) : this.width;
      var logicalH = this.getAttribute('height') ? parseInt(this.getAttribute('height')) : this.height;
      this.dataset.dpiFixed = '1';
      this.dataset.logicalWidth = logicalW;
      this.dataset.logicalHeight = logicalH;

      // Scale internal resolution for HiDPI sharpness
      this.width = logicalW * dpr;
      this.height = logicalH * dpr;
      // Use max-width + auto height for responsive CSS scaling
      // This lets the canvas shrink with its container while maintaining aspect ratio
      this.style.maxWidth = '100%';
      this.style.height = 'auto';
      this.style.aspectRatio = logicalW + ' / ' + logicalH;

      var ctx = origGetContext.call(this, type, attrs);
      ctx.scale(dpr, dpr);
      return ctx;
    }
    return origGetContext.call(this, type, attrs);
  };

  // Override width/height getters so drawing code reads logical dimensions
  var widthDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  var heightDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');

  Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
    get: function() {
      if (this.dataset.dpiFixed && this.dataset.logicalWidth) {
        return parseInt(this.dataset.logicalWidth);
      }
      return widthDesc.get.call(this);
    },
    set: function(v) {
      widthDesc.set.call(this, v);
    },
    configurable: true
  });

  Object.defineProperty(HTMLCanvasElement.prototype, 'height', {
    get: function() {
      if (this.dataset.dpiFixed && this.dataset.logicalHeight) {
        return parseInt(this.dataset.logicalHeight);
      }
      return heightDesc.get.call(this);
    },
    set: function(v) {
      heightDesc.set.call(this, v);
    },
    configurable: true
  });
})();
<\/script>`

  // Insert before the first <script> tag so it runs before any canvas drawing code
  if (html.includes('<script')) {
    html = html.replace(/<script/, dpiFixScript + '\n<script')
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', dpiFixScript + '\n</body>')
  } else {
    html = dpiFixScript + '\n' + html
  }

  return html
})

const highlightedHtmlCode = computed(() => {
  if (!fileContent.value || fileType.value !== 'html') return ''

  try {
    return hljs.highlight(fileContent.value, { language: 'xml' }).value
  } catch (e) {
    return hljs.highlight(fileContent.value, { language: 'plaintext' }).value
  }
})

const renderedNotebook = computed(() => {
  if (!fileContent.value || fileType.value !== 'notebook') return ''

  // The server returns pre-structured HTML with class markers.
  // We parse markdown cells with marked and highlight code cells with hljs.
  let html = fileContent.value

  // Render markdown cells: content between <div class="nb-cell nb-markdown"> tags
  html = html.replace(/<div class="nb-cell nb-markdown">([\s\S]*?)<\/div>/g, (_match, md) => {
    return `<div class="nb-cell nb-markdown">${marked.parse(md)}</div>`
  })

  // Highlight code cells
  const lang = fileLanguage.value || 'python'
  html = html.replace(/<code class="language-[^"]*">([\s\S]*?)<\/code>/g, (_match, code) => {
    // Unescape HTML entities back to raw text for hljs
    const raw = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    try {
      return `<code class="language-${lang}">${hljs.highlight(raw, { language: lang }).value}</code>`
    } catch {
      return `<code class="language-${lang}">${code}</code>`
    }
  })

  return rewritePaperImageSrc(html, paperFileBaseDir(selectedFile.value))
})

const renderedContent = computed(() => {
  if (!fileContent.value) return ''
  if (fileType.value === 'markdown') {
    const html = marked.parse(fileContent.value) as string
    return rewritePaperImageSrc(html, paperFileBaseDir(selectedFile.value))
  }
  if (fileType.value === 'text') {
    return `<pre>${fileContent.value}</pre>`
  }
  return fileContent.value
})

const renderedAskAnswer = computed(() => {
  if (!askAnswer.value) return ''
  return marked.parse(askAnswer.value) as string
})

const paperPath = computed(() => `~/codex-papers/papers/${slug}`)

useHead({
  title: paper.value ? `${paper.value.title} - 论文库` : '论文 - 论文库'
})
</script>

<style>
/* Global styles for highlight.js - must be non-scoped */
@import 'highlight.js/styles/github.css';
/* KaTeX styles for math rendering */
@import 'katex/dist/katex.min.css';
</style>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');

* {
  box-sizing: border-box;
}

.reader-container {
  min-height: 100vh;
  background: #ffffff;
  font-family: 'Inter', sans-serif;
}

/* Loading State */
.loading-state {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.5rem;
  color: #374151;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 3px solid #e5e7eb;
  border-top-color: #6b7280;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Error State */
.error-state {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 2rem;
  text-align: center;
}

.error-icon {
  font-size: 4rem;
  opacity: 0.6;
}

.error-state h2 {
  font-family: 'Crimson Pro', serif;
  font-size: 1.75rem;
  font-weight: 600;
  color: #1f2937;
  margin: 0;
}

.error-state p {
  color: #6b7280;
  margin: 0;
}

.back-home {
  margin-top: 1rem;
  padding: 0.75rem 1.5rem;
  background: #1f2937;
  color: #ffffff;
  text-decoration: none;
  border-radius: 6px;
  font-size: 0.9rem;
  transition: background 0.2s;
}

.back-home:hover {
  background: #111827;
}

/* Top Navigation */
.top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 64px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  padding: 0 2rem;
  gap: 2rem;
  z-index: 100;
  backdrop-filter: blur(10px);
  background: rgba(255, 255, 255, 0.95);
}

.back-to-library {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  text-decoration: none;
  color: #1f2937;
  font-weight: 500;
  white-space: nowrap;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  transition: all 0.2s;
  font-family: 'Inter', sans-serif;
}

.back-to-library:hover {
  background: #f8f9fa;
  color: #6b7280;
}

.back-arrow {
  font-size: 1.1rem;
  font-weight: 600;
}

.back-text {
  font-size: 0.95rem;
}

.paper-title-nav {
  flex: 1;
  overflow: hidden;
}

.paper-title-nav h1 {
  font-family: 'Crimson Pro', serif;
  font-size: 1.1rem;
  font-weight: 600;
  color: #374151;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.external-link {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid #d1d5db;
  color: #374151;
  text-decoration: none;
  border-radius: 6px;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.external-link:hover {
  background: #f8f9fa;
  border-color: #6b7280;
}

.arrow {
  font-size: 0.75em;
  opacity: 0.7;
}

/* Main Content */
.main-content {
  display: flex;
  margin-top: 64px;
  min-height: calc(100vh - 64px);
}

/* Sidebar */
.sidebar {
  width: 280px;
  background: #ffffff;
  border-right: 1px solid #e5e7eb;
  transition: width 0.3s ease;
  position: sticky;
  top: 64px;
  height: calc(100vh - 64px);
  align-self: flex-start;
}

.sidebar.collapsed {
  width: 48px;
}

.sidebar.collapsed .file-tree {
  display: none;
}

.sidebar-inner {
  height: 100%;
  overflow-y: auto;
  position: relative;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 1rem;
  height: 53px;
  border-bottom: 1px solid #e5e7eb;
  background: #ffffff;
}

.sidebar-header h3 {
  font-family: 'Crimson Pro', serif;
  font-size: 1rem;
  font-weight: 600;
  color: #1f2937;
  margin: 0;
}

.collapse-btn {
  background: none;
  border: none;
  color: #6b7280;
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
  transition: color 0.2s;
}

.collapse-btn:hover {
  color: #1f2937;
}

.expand-btn {
  position: absolute;
  top: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: #ffffff;
  border: 1px solid #e5e7eb;
  color: #6b7280;
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0.5rem;
  line-height: 1;
  border-radius: 4px;
  transition: all 0.2s;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.expand-btn:hover {
  background: #f8f9fa;
  color: #1f2937;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.file-tree {
  padding: 0.75rem 0;
}

/* Reading Pane */
.reading-pane {
  flex: 1;
  background: #ffffff;
  min-width: 0;
}

.reading-header {
  padding: 0 3rem;
  height: 53px;
  border-bottom: 1px solid #e5e7eb;
  background: #ffffff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: #6b7280;
  font-family: 'Inter', monospace;
}

.crumb {
  opacity: 0.7;
}

.file-name {
  opacity: 1;
  font-weight: 500;
  color: #1f2937;
}

.separator {
  opacity: 0.4;
}

.reading-actions,
.html-controls {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.control-btn {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  background: #ffffff;
  border: 1px solid #d1d5db;
  color: #374151;
  font-size: 0.875rem;
  font-family: 'Inter', sans-serif;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.control-btn:hover {
  background: #f8f9fa;
  border-color: #6b7280;
}

.control-btn:active {
  transform: translateY(1px);
}

.ask-toggle.active {
  background: #111827;
  border-color: #111827;
  color: #ffffff;
}

.ask-panel {
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
  padding: 1.25rem 3rem;
}

.ask-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.ask-panel-header h2 {
  margin: 0;
  font-family: 'Crimson Pro', serif;
  font-size: 1.2rem;
  font-weight: 600;
  color: #111827;
}

.ask-panel-header p {
  margin: 0.25rem 0 0;
  color: #6b7280;
  font-size: 0.875rem;
  line-height: 1.5;
}

.close-ask {
  width: 32px;
  height: 32px;
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #6b7280;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1.25rem;
  line-height: 1;
}

.close-ask:hover {
  color: #111827;
  border-color: #9ca3af;
}

.ask-input {
  width: 100%;
  resize: vertical;
  min-height: 96px;
  max-height: 240px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0.875rem 1rem;
  color: #111827;
  background: #ffffff;
  font: 0.95rem/1.6 'Inter', sans-serif;
}

.ask-input:focus {
  outline: none;
  border-color: #111827;
  box-shadow: 0 0 0 3px rgba(17, 24, 39, 0.08);
}

.ask-input:disabled {
  color: #6b7280;
  background: #f3f4f6;
}

.ask-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.875rem;
  flex-wrap: wrap;
}

.ask-submit,
.ask-secondary {
  border-radius: 6px;
  font: 0.875rem/1 'Inter', sans-serif;
  cursor: pointer;
  padding: 0.65rem 1rem;
  transition: all 0.2s;
}

.ask-submit {
  border: 1px solid #111827;
  background: #111827;
  color: #ffffff;
}

.ask-submit:hover:not(:disabled) {
  background: #374151;
  border-color: #374151;
}

.ask-submit:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ask-secondary {
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #374151;
}

.ask-secondary:hover {
  border-color: #9ca3af;
}

.ask-copy-status {
  color: #6b7280;
  font-size: 0.85rem;
}

.ask-error {
  margin: 0.875rem 0 0;
  color: #b91c1c;
  font-size: 0.9rem;
}

.ask-saved {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.875rem;
  color: #166534;
  font-size: 0.875rem;
}

.ask-saved button {
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  background: #f0fdf4;
  color: #166534;
  cursor: pointer;
  font: 0.825rem/1 'Inter', sans-serif;
  font-weight: 600;
  padding: 0.45rem 0.65rem;
}

.ask-saved button:hover {
  background: #dcfce7;
}

.ask-answer {
  margin-top: 1rem;
  padding: 1rem 1.25rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #ffffff;
  font-size: 1rem;
  line-height: 1.7;
}

.reader-tabs {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 3rem;
  border-bottom: 1px solid #e5e7eb;
  background: #ffffff;
  overflow-x: auto;
}

.reader-tab {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  color: #374151;
  cursor: pointer;
  font: 0.875rem/1 Inter, sans-serif;
  padding: 0.55rem 0.8rem;
  white-space: nowrap;
}

.reader-tab:hover {
  background: #f9fafb;
}

.reader-tab.active {
  background: #111827;
  border-color: #111827;
  color: #ffffff;
}

/* Content Area */
.content {
  max-width: 920px;
  margin: 0 auto;
  padding: 3rem;
  animation: fadeIn 0.4s ease;
}

.evidence-content {
  max-width: 1040px;
  font-family: Inter, sans-serif;
}

.evidence-view {
  display: grid;
  gap: 1rem;
}

.evidence-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 1rem;
}

.evidence-view__header h2 {
  margin: 0;
  color: #111827;
  font: 700 1.35rem/1.25 Inter, sans-serif;
}

.evidence-view__header p {
  margin: 0.35rem 0 0;
  color: #6b7280;
  font-size: 0.9rem;
}

.validation-pill {
  border: 1px solid #d1d5db;
  border-radius: 999px;
  padding: 0.35rem 0.7rem;
  color: #374151;
  background: #ffffff;
  font-size: 0.8rem;
}

.audit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem;
}

.audit-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  background: #ffffff;
}

.audit-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  color: #6b7280;
  font-size: 0.8rem;
}

.audit-card h3,
.section-label {
  margin: 0;
  color: #111827;
  font: 700 1rem/1.4 Inter, sans-serif;
}

.audit-card p {
  color: #374151;
  line-height: 1.55;
}

.evidence-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.75rem;
}

.evidence-buttons button {
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #ffffff;
  color: #374151;
  cursor: pointer;
  font: 0.78rem/1 Inter, sans-serif;
  padding: 0.35rem 0.6rem;
}

.node-type {
  color: #6b7280;
  font: 700 0.75rem/1 Inter, sans-serif;
  text-transform: uppercase;
}

/* Full-width content for HTML files */
.content:has(.html-viewer) {
  max-width: 100%;
  padding: 1rem;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.file-loading {
  padding: 2rem;
}

.shimmer {
  height: 400px;
  background: linear-gradient(
    90deg,
    #f8f9fa 25%,
    #e5e7eb 50%,
    #f8f9fa 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 8px;
}

@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.empty-state {
  padding: 4rem 2rem;
  text-align: center;
  color: #9ca3af;
}

/* Markdown Styles */
.markdown-body {
  font-family: 'Crimson Pro', serif;
  font-size: 1.125rem;
  line-height: 1.8;
  color: #1f2937;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: 'Crimson Pro', serif;
  font-weight: 600;
  color: #111827;
  margin-top: 2rem;
  margin-bottom: 1rem;
  line-height: 1.3;
}

.markdown-body :deep(h1) {
  font-size: 2.25rem;
  border-bottom: 2px solid #e5e7eb;
  padding-bottom: 0.5rem;
  margin-top: 0;
}

.markdown-body :deep(h2) {
  font-size: 1.75rem;
  border-bottom: 1px solid #f8f9fa;
  padding-bottom: 0.4rem;
}

.markdown-body :deep(h3) {
  font-size: 1.375rem;
}

.markdown-body :deep(h4) {
  font-size: 1.125rem;
}

.markdown-body :deep(p) {
  margin-bottom: 1.5rem;
}

.markdown-body :deep(a) {
  color: #6b7280;
  text-decoration: underline;
  text-decoration-color: #d1d5db;
  text-underline-offset: 2px;
  transition: all 0.2s;
}

.markdown-body :deep(a:hover) {
  color: #374151;
  text-decoration-color: #6b7280;
}

.markdown-body :deep(code) {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
  font-size: 0.8em;
  background: #f8f9fa;
  padding: 0.2em 0.4em;
  border-radius: 3px;
  border: 1px solid #e5e7eb;
  color: #374151;
}

.markdown-body :deep(pre) {
  background: #111827;
  color: #e5e7eb;
  padding: 1.5rem;
  border-radius: 8px;
  overflow-x: auto;
  margin: 1.5rem 0;
  border: 1px solid #1f2937;
  font-size: 0.875rem;
  line-height: 1.6;
}

.markdown-body :deep(pre code) {
  background: none;
  border: none;
  color: inherit;
  padding: 0;
  font-size: 0.875rem;
}

.markdown-body :deep(blockquote) {
  border-left: 4px solid #6b7280;
  padding-left: 1.5rem;
  margin: 1.5rem 0;
  color: #374151;
  font-style: italic;
  background: #ffffff;
  padding: 1rem 1.5rem;
  border-radius: 0 6px 6px 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 2rem;
  margin-bottom: 1.5rem;
}

.markdown-body :deep(li) {
  margin-bottom: 0.5rem;
}

.markdown-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  margin: 2rem 0;
  box-shadow: 0 4px 12px rgba(61, 52, 48, 0.08);
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1.5rem 0;
  font-size: 0.95rem;
}

.markdown-body :deep(table th),
.markdown-body :deep(table td) {
  border: 1px solid #e5e7eb;
  padding: 0.75rem 1rem;
  text-align: left;
}

.markdown-body :deep(table th) {
  background: #ffffff;
  font-weight: 600;
  color: #1f2937;
}

.markdown-body :deep(table td) {
  background: #ffffff;
}

.markdown-body :deep(hr) {
  border: none;
  height: 1px;
  background: #e5e7eb;
  margin: 3rem 0;
}

/* File Viewers */
.file-viewer {
  width: 100%;
}

.image-viewer {
  text-align: center;
  padding: 2rem;
}

.image-viewer img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.pdf-viewer {
  height: calc(100vh - 200px);
  min-height: 600px;
}

.pdf-viewer iframe {
  width: 100%;
  height: 100%;
  border-radius: 8px;
}

.html-viewer {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 150px);
  width: 100%;
  margin: 0;
  padding: 0;
}

.html-viewer iframe {
  flex: 1;
  width: 100%;
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}

.html-viewer pre {
  flex: 1;
  margin: 0;
  border-radius: 8px;
  overflow: auto;
  background: #ffffff !important;
  padding: 1.5rem;
  border: 1px solid #e5e7eb;
}

.html-viewer code {
  font-size: 0.875rem;
  line-height: 1.6;
}

.code-viewer {
  margin: 0;
}

.code-viewer pre {
  margin: 0;
  border-radius: 0;
  max-height: calc(100vh - 200px);
  overflow: auto;
  background: #ffffff !important;
  padding: 1.5rem;
}

.code-viewer code {
  font-size: 0.875rem;
  line-height: 1.6;
}

/* Notebook Viewer */
.notebook-viewer {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.5rem 3rem;
}

.notebook-viewer :deep(.nb-cell) {
  margin-bottom: 1rem;
}

.notebook-viewer :deep(.nb-markdown) {
  font-family: 'Crimson Pro', serif;
  font-size: 1.1rem;
  line-height: 1.8;
  color: #1f2937;
  padding: 0.5rem 0;
}

.notebook-viewer :deep(.nb-markdown h1),
.notebook-viewer :deep(.nb-markdown h2),
.notebook-viewer :deep(.nb-markdown h3),
.notebook-viewer :deep(.nb-markdown h4) {
  font-family: 'Crimson Pro', serif;
  font-weight: 600;
  color: #111827;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
}

.notebook-viewer :deep(.nb-markdown h1) { font-size: 2rem; }
.notebook-viewer :deep(.nb-markdown h2) { font-size: 1.6rem; }
.notebook-viewer :deep(.nb-markdown h3) { font-size: 1.3rem; }

.notebook-viewer :deep(.nb-markdown p) {
  margin-bottom: 1rem;
}

.notebook-viewer :deep(.nb-markdown code) {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
  font-size: 0.8em;
  background: #f8f9fa;
  padding: 0.15em 0.35em;
  border-radius: 3px;
  border: 1px solid #e5e7eb;
}

.notebook-viewer :deep(.nb-markdown pre) {
  background: #111827;
  color: #e5e7eb;
  padding: 1rem;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 0.85rem;
}

.notebook-viewer :deep(.nb-markdown pre code) {
  background: none;
  border: none;
  color: inherit;
  padding: 0;
}

.notebook-viewer :deep(.nb-markdown img) {
  max-width: 100%;
  height: auto;
}

.notebook-viewer :deep(.nb-input) {
  position: relative;
  background: #fafafa;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
}

.notebook-viewer :deep(.nb-prompt) {
  display: block;
  padding: 0.5rem 1rem 0;
  font-family: 'SF Mono', 'Monaco', monospace;
  font-size: 0.75rem;
  font-weight: 600;
  color: #6b7280;
}

.notebook-viewer :deep(.nb-prompt.nb-in) {
  color: #2563eb;
}

.notebook-viewer :deep(.nb-input pre) {
  margin: 0;
  padding: 0.5rem 1rem 0.75rem;
  background: transparent;
  font-size: 0.85rem;
  line-height: 1.6;
  overflow-x: auto;
}

.notebook-viewer :deep(.nb-input code) {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
  font-size: 0.85rem;
}

.notebook-viewer :deep(.nb-output) {
  border-left: 3px solid #e5e7eb;
  margin-left: 0.75rem;
  padding-left: 1rem;
  margin-top: 0.25rem;
}

.notebook-viewer :deep(.nb-output pre) {
  margin: 0;
  padding: 0.5rem 0;
  background: transparent;
  font-family: 'SF Mono', 'Monaco', monospace;
  font-size: 0.825rem;
  line-height: 1.5;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}

.notebook-viewer :deep(.nb-stderr) {
  border-left-color: #fca5a5;
}

.notebook-viewer :deep(.nb-stderr pre) {
  color: #dc2626;
}

.notebook-viewer :deep(.nb-rich) {
  overflow-x: auto;
}

.notebook-viewer :deep(.nb-rich table) {
  border-collapse: collapse;
  font-size: 0.875rem;
  margin: 0.5rem 0;
}

.notebook-viewer :deep(.nb-rich th),
.notebook-viewer :deep(.nb-rich td) {
  border: 1px solid #e5e7eb;
  padding: 0.4rem 0.75rem;
  text-align: left;
}

.notebook-viewer :deep(.nb-rich th) {
  background: #f8f9fa;
  font-weight: 600;
}

.notebook-viewer :deep(.nb-image) {
  padding: 0.5rem 0;
}

.notebook-viewer :deep(.nb-image img) {
  max-width: 100%;
  height: auto;
}

.notebook-viewer :deep(.nb-raw pre) {
  background: #f8f9fa;
  padding: 1rem;
  border-radius: 6px;
  border: 1px solid #e5e7eb;
  font-size: 0.85rem;
  color: #6b7280;
}
</style>
