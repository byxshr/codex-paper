import { buildPublicFileTree, validateSlug } from '../../../utils/librarySecurity.mjs'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

const ROOT_ITEM_ORDER = ['README.md', 'visual-assets.md', 'index.html', 'summary.md', 'insights.md', 'method.md', 'mental-model.md', 'reflection.md', 'qa.md', 'chat-notes.md', 'paper.pdf', 'images', 'code', 'quick-summary.md']
const NESTED_ITEM_ORDER = ['README.md', 'summary.md', 'insights.md', 'index.html']

function sortTree(nodes: FileNode[]) {
  nodes.sort((left, right) => {
    const order = left.path.includes('/') ? NESTED_ITEM_ORDER : ROOT_ITEM_ORDER
    const leftIndex = order.indexOf(left.name)
    const rightIndex = order.indexOf(right.name)
    const leftOrder = leftIndex === -1 ? order.length + (left.type === 'directory' ? 0 : 1) : leftIndex
    const rightOrder = rightIndex === -1 ? order.length + (right.type === 'directory' ? 0 : 1) : rightIndex
    return leftOrder - rightOrder || left.name.localeCompare(right.name)
  })
  for (const node of nodes) if (node.children) sortTree(node.children)
  return nodes
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!validateSlug(slug)) throw createError({ statusCode: 400, statusMessage: 'Valid paper slug is required' })
  return sortTree(buildPublicFileTree(slug!))
})
