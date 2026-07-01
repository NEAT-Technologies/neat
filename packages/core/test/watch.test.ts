import { describe, expect, it, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyChange, runExtractPhases } from '../src/watch.js'
import { resetGraph, getGraph } from '../src/graph.js'
import { extractFromDirectory } from '../src/extract.js'
import { retireEdgesByFile } from '../src/extract/retire.js'
import { NodeType, EdgeType } from '@neat.is/types'
import type { GraphNode, GraphEdge } from '@neat.is/types'

const sep = path.sep
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TS_SERVICE = path.resolve(__dirname, 'fixtures', 'imports', 'ts-service')

// Every FileNode should be owned by exactly one CONTAINS edge from its service.
// A FileNode with no inbound CONTAINS is a corrupted snapshot — the file exists
// on disk but the graph has orphaned it from its owner.
function fileNodesWithoutContainer(graph: ReturnType<typeof getGraph>): string[] {
  const orphans: string[] = []
  graph.forEachNode((id, attrs) => {
    if ((attrs as GraphNode).type !== NodeType.FileNode) return
    const hasContainer = graph
      .inboundEdges(id)
      .some((e) => (graph.getEdgeAttributes(e) as GraphEdge).type === EdgeType.CONTAINS)
    if (!hasContainer) orphans.push(id)
  })
  return orphans
}

describe('classifyChange', () => {
  it('routes package.json to services + aliases + databases', () => {
    const phases = classifyChange(`packages${sep}service-a${sep}package.json`)
    expect([...phases].sort()).toEqual(['aliases', 'databases', 'services'])
  })

  it('routes Python manifests to the same trio', () => {
    expect([...classifyChange(`svc${sep}requirements.txt`)].sort()).toEqual([
      'aliases',
      'databases',
      'services',
    ])
    expect([...classifyChange(`svc${sep}pyproject.toml`)].sort()).toEqual([
      'aliases',
      'databases',
      'services',
    ])
  })

  it('routes JS/TS/Python source to files + imports + calls', () => {
    expect([...classifyChange(`src${sep}index.ts`)].sort()).toEqual(['calls', 'files', 'imports'])
    expect([...classifyChange(`src${sep}index.js`)].sort()).toEqual(['calls', 'files', 'imports'])
    expect([...classifyChange(`src${sep}page.tsx`)].sort()).toEqual(['calls', 'files', 'imports'])
    expect([...classifyChange(`app${sep}main.py`)].sort()).toEqual(['calls', 'files', 'imports'])
  })

  it('routes .env / prisma / knex / ormconfig to databases + configs', () => {
    expect([...classifyChange(`service-b${sep}.env`)].sort()).toEqual(['configs', 'databases'])
    expect([...classifyChange(`service-b${sep}.env.production`)].sort()).toEqual([
      'configs',
      'databases',
    ])
    expect([...classifyChange(`prisma${sep}schema.prisma`)].sort()).toEqual([
      'configs',
      'databases',
    ])
    // knexfile.ts also looks like JS source — its imports/calls rerun is a
    // no-op for the file but cheap, so we accept the overlap.
    expect([...classifyChange(`knexfile.ts`)].sort()).toEqual([
      'calls',
      'configs',
      'databases',
      'files',
      'imports',
    ])
    expect([...classifyChange(`ormconfig.json`)].sort()).toEqual(['configs', 'databases'])
  })

  it('routes Dockerfile / compose / Terraform to infra + aliases', () => {
    expect([...classifyChange('Dockerfile')].sort()).toEqual(['aliases', 'infra'])
    expect([...classifyChange('docker-compose.yml')].sort()).toEqual([
      'aliases',
      'infra',
    ])
    expect([...classifyChange('docker-compose.prod.yaml')].sort()).toEqual([
      'aliases',
      'infra',
    ])
    expect([...classifyChange(`infra${sep}main.tf`)].sort()).toEqual(['aliases', 'infra'])
  })

  it('routes k8s yaml under k8s/ to infra + aliases + db/configs', () => {
    // k8s manifests are yaml — we add infra+aliases via the dir hint AND
    // databases+configs via the generic .yaml fallback. Belt-and-suspenders is
    // fine; the phases dedupe via Set.
    const phases = classifyChange(`k8s${sep}deployment.yaml`)
    expect(phases.has('infra')).toBe(true)
    expect(phases.has('aliases')).toBe(true)
  })

  it('returns an empty set for files with no known mapping', () => {
    expect([...classifyChange(`README.md`)]).toEqual([])
    expect([...classifyChange(`assets${sep}logo.png`)]).toEqual([])
  })

  it('case-insensitive for Dockerfile and friends', () => {
    expect([...classifyChange('dockerfile')].sort()).toEqual(['aliases', 'infra'])
    expect([...classifyChange('Dockerfile')].sort()).toEqual(['aliases', 'infra'])
  })

  it('re-enumerates files so a source edit rebuilds its FileNode', () => {
    // A source edit retires the file's CONTAINS edge (evidence.file matches).
    // The re-extract has to walk files again to put it back, or the FileNode
    // is left orphaned from its service.
    expect(classifyChange(`src${sep}index.ts`).has('files')).toBe(true)
    expect(classifyChange(`app${sep}main.py`).has('files')).toBe(true)
  })
})

describe('watch re-extract on an edited imported file', () => {
  beforeEach(() => resetGraph())

  const importsEdge =
    'IMPORTS:file:fixture-imports-ts-service:index.ts->file:fixture-imports-ts-service:mongo.ts'

  it('rebuilds the graph cleanly when the imported file changes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, TS_SERVICE)
    expect(graph.hasEdge(importsEdge)).toBe(true)
    expect(fileNodesWithoutContainer(graph)).toEqual([])

    // mongo.ts is imported by index.ts. Editing it retires mongo.ts's CONTAINS
    // edge; the re-extract must recreate it.
    retireEdgesByFile(graph, 'mongo.ts')
    await runExtractPhases(graph, TS_SERVICE, classifyChange('mongo.ts'))

    expect(graph.hasEdge(importsEdge)).toBe(true)
    expect(fileNodesWithoutContainer(graph)).toEqual([])
  })

  it('does not crash or orphan nodes when the importer file changes', async () => {
    const graph = getGraph()
    await extractFromDirectory(graph, TS_SERVICE)

    // Editing the importer retires its CONTAINS *and* its outbound IMPORTS,
    // which orphans the importer FileNode. Without a file re-enumeration the
    // next addImports emits an edge from a node that no longer exists and
    // throws.
    retireEdgesByFile(graph, 'index.ts')
    await expect(
      runExtractPhases(graph, TS_SERVICE, classifyChange('index.ts')),
    ).resolves.toBeDefined()

    expect(graph.hasNode('file:fixture-imports-ts-service:index.ts')).toBe(true)
    expect(graph.hasEdge(importsEdge)).toBe(true)
    expect(fileNodesWithoutContainer(graph)).toEqual([])
  })
})
