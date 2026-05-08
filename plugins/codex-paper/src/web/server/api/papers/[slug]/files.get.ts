import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

const HIDDEN_MACHINE_FILES = new Set([
  'analysis.json',
  'facts.json',
  'meta.json',
  'paper-data.json'
])

const ROOT_ITEM_ORDER = [
  'README.md',
  'index.html',
  'summary.md',
  'insights.md',
  'method.md',
  'mental-model.md',
  'reflection.md',
  'qa.md',
  'paper.pdf',
  'images',
  'code',
  'quick-summary.md'
]

const NESTED_ITEM_ORDER = [
  'README.md',
  'summary.md',
  'insights.md',
  'index.html'
]

function orderForNode(node: FileNode) {
  const orderedNames = node.path.includes('/') ? NESTED_ITEM_ORDER : ROOT_ITEM_ORDER
  const index = orderedNames.indexOf(node.name)

  if (index !== -1) {
    return index
  }

  return orderedNames.length + (node.type === 'directory' ? 0 : 1)
}

function buildFileTree(dirPath: string, relativePath: string = ''): FileNode[] {
  const items = fs.readdirSync(dirPath, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const item of items) {
    // Skip hidden files and node_modules
    if (item.name.startsWith('.') || item.name === 'node_modules') {
      continue
    }

    if (HIDDEN_MACHINE_FILES.has(item.name)) {
      continue
    }

    const itemPath = path.join(dirPath, item.name)
    const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name

    if (item.isDirectory()) {
      nodes.push({
        name: item.name,
        path: itemRelativePath,
        type: 'directory',
        children: buildFileTree(itemPath, itemRelativePath)
      })
    } else {
      nodes.push({
        name: item.name,
        path: itemRelativePath,
        type: 'file'
      })
    }
  }

  // Sort root materials in the study-package reading order. Inside nested
  // folders, keep directories ahead of unknown files after known items.
  return nodes.sort((a, b) => {
    const orderDiff = orderForNode(a) - orderForNode(b)
    if (orderDiff !== 0) {
      return orderDiff
    }

    return a.name.localeCompare(b.name)
  })
}

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')

  if (!slug) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Slug is required'
    })
  }

  try {
    const paperDir = path.join(homedir(), 'codex-papers/papers', slug)

    if (!fs.existsSync(paperDir)) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Paper directory not found'
      })
    }

    const fileTree = buildFileTree(paperDir)

    return fileTree
  } catch (e: any) {
    if (e.statusCode) throw e

    throw createError({
      statusCode: 500,
      statusMessage: e.message || 'Failed to load file tree'
    })
  }
})
