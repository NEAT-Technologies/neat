import path from 'node:path'
import Parser from 'tree-sitter'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import type { EdgeEvidence, GraphEdge } from '@neat.is/types'
import {
  EdgeType,
  Provenance,
  confidenceForExtracted,
  passesExtractedFloor,
} from '@neat.is/types'
import type { NeatGraph } from '../../graph.js'
import {
  isTestPath,
  makeEdgeId,
  urlMatchesHost,
  type DiscoveredService,
} from '../shared.js'
import { recordExtractionError, noteExtractedDropped } from '../errors.js'
import { loadSourceFiles, lineOf, snippet } from './shared.js'

// JS uses `string_fragment` for the textual interior of a template/string;
// Python uses `string_content` inside a `string` node. Either way we want the
// raw textual content (no quotes), so we accept both.
const STRING_LITERAL_NODE_TYPES = new Set(['string_fragment', 'string_content'])

// ADR-065 #3 — JSX external-link exclusion. Tags whose URL-attr strings are
// user-clickable hyperlinks, not service-to-service calls.
const JSX_EXTERNAL_LINK_TAGS = new Set(['a', 'Link', 'NavLink', 'ExternalLink', 'Anchor'])

// Walk upward from a string-literal node to detect whether it sits inside a
// JSX attribute on an external-link element. Returns true if the literal
// should be filtered.
function isInsideJsxExternalLink(node: Parser.SyntaxNode): boolean {
  let cursor: Parser.SyntaxNode | null = node.parent
  // Step out of the string wrapper if needed (parent is `string` /
  // `template_string`).
  while (cursor) {
    if (cursor.type === 'jsx_attribute') {
      // The element that owns this attribute. jsx_attribute lives inside
      // jsx_opening_element / jsx_self_closing_element.
      let owner: Parser.SyntaxNode | null = cursor.parent
      while (owner && owner.type !== 'jsx_opening_element' && owner.type !== 'jsx_self_closing_element') {
        owner = owner.parent
      }
      if (!owner) return false
      // First named child of an opening/self-closing element is the tag name
      // (`identifier` or `member_expression`).
      const tagNode = owner.namedChild(0)
      const tagName = tagNode?.text ?? ''
      // For `<Foo.Bar>` we just want the rightmost ident; pick after the
      // last dot.
      const right = tagName.includes('.') ? tagName.split('.').pop()! : tagName
      return JSX_EXTERNAL_LINK_TAGS.has(right)
    }
    cursor = cursor.parent
  }
  return false
}

// Collect (literal text, ast-node) pairs so the JSX-context check has the
// node available. Comment tokens have no string_fragment / string_content
// children in tree-sitter — JSDoc text lives inside `comment` nodes — so
// comment-body exclusion comes for free with this AST walk (ADR-065 #2).
function collectStringLiterals(
  node: Parser.SyntaxNode,
  out: { text: string; node: Parser.SyntaxNode }[],
): void {
  if (STRING_LITERAL_NODE_TYPES.has(node.type)) out.push({ text: node.text, node })
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)
    if (child) collectStringLiterals(child, out)
  }
}

export function callsFromSource(
  source: string,
  parser: Parser,
  knownHosts: Set<string>,
): Set<string> {
  const tree = parser.parse(source)
  const literals: { text: string; node: Parser.SyntaxNode }[] = []
  collectStringLiterals(tree.rootNode, literals)
  const targets = new Set<string>()
  for (const lit of literals) {
    // ADR-065 #3 — JSX external-link exclusion. URL strings on <a>, <Link>,
    // <NavLink>, <ExternalLink>, <Anchor> are user-clickable hyperlinks, not
    // service calls.
    if (isInsideJsxExternalLink(lit.node)) continue
    for (const host of knownHosts) {
      // ADR-065 #5 — exact hostname match (not substring containment).
      // `medusa.cloud` no longer matches `@medusajs/medusa`.
      if (urlMatchesHost(lit.text, host)) {
        targets.add(host)
      }
    }
  }
  return targets
}

function makeJsParser(): Parser {
  const p = new Parser()
  p.setLanguage(JavaScript)
  return p
}

function makePyParser(): Parser {
  const p = new Parser()
  p.setLanguage(Python)
  return p
}

// HTTP CALLS via URL substring match. Parser is picked per file extension:
// .py uses tree-sitter-python; everything else uses tree-sitter-javascript.
// The demo's CALLS edges stay byte-for-byte identical to the M1 baseline.
export async function addHttpCallEdges(
  graph: NeatGraph,
  services: DiscoveredService[],
): Promise<number> {
  const jsParser = makeJsParser()
  const pyParser = makePyParser()

  const knownHosts = new Set<string>()
  const hostToNodeId = new Map<string, string>()
  for (const service of services) {
    knownHosts.add(path.basename(service.dir))
    knownHosts.add(service.pkg.name)
    hostToNodeId.set(path.basename(service.dir), service.node.id)
    hostToNodeId.set(service.pkg.name, service.node.id)
  }

  let edgesAdded = 0
  for (const service of services) {
    const files = await loadSourceFiles(service.dir)
    // Every distinct call site per target instead of the first file only
    // (#396 / ADR-087). Insertion order is file-walk order, so `sites[0]`
    // stays the same primary evidence first-write-wins produced before.
    const sitesByTarget = new Map<string, EdgeEvidence[]>()
    for (const file of files) {
      // ADR-065 #1 — test-scope exclusion.
      if (isTestPath(file.path)) continue
      const parser = path.extname(file.path) === '.py' ? pyParser : jsParser
      let targets: Set<string>
      try {
        targets = callsFromSource(file.content, parser, knownHosts)
      } catch (err) {
        recordExtractionError('http call extraction', file.path, err)
        continue
      }
      for (const t of targets) {
        const targetId = hostToNodeId.get(t)
        if (!targetId || targetId === service.node.id) continue
        // `callsFromSource` dedupes hosts per file, so each file contributes at
        // most one site per target — the URL literal's line. `//${host}` is the
        // scheme-relative form so this lands on the URL, matching the prior
        // primary-evidence line computation exactly.
        const line = lineOf(file.content, `//${t}`)
        const ev: EdgeEvidence = {
          file: path.relative(service.dir, file.path),
          line,
          snippet: snippet(file.content, line),
        }
        const sites = sitesByTarget.get(targetId)
        if (sites) {
          if (!sites.some((s) => s.file === ev.file && s.line === ev.line)) sites.push(ev)
        } else {
          sitesByTarget.set(targetId, [ev])
        }
      }
    }
    for (const [targetId, sites] of sitesByTarget) {
      const ev = sites[0]!
      // URL-string match against a registered service hostname is the
      // hostname-shape tier per ADR-066 — structurally tight (urlMatchesHost
      // requires scheme + exact hostname) but no framework-aware recognizer
      // confirms the call. Drops below the default precision floor (0.7) and
      // never enters the graph unless the floor is lowered for diagnostics.
      const confidence = confidenceForExtracted('hostname-shape-match')
      const edgeId = makeEdgeId(service.node.id, targetId, EdgeType.CALLS)
      if (!passesExtractedFloor(confidence)) {
        noteExtractedDropped({
          source: service.node.id,
          target: targetId,
          type: EdgeType.CALLS,
          confidence,
          confidenceKind: 'hostname-shape-match',
          evidence: ev,
        })
        continue
      }
      const edge: GraphEdge = {
        id: edgeId,
        source: service.node.id,
        target: targetId,
        type: EdgeType.CALLS,
        provenance: Provenance.EXTRACTED,
        confidence,
        evidence: ev,
        // Only carry `sites` when there's more than one — single-site edges
        // stay byte-identical to the prior shape.
        ...(sites.length > 1 ? { sites } : {}),
      }
      if (!graph.hasEdge(edge.id)) {
        graph.addEdgeWithKey(edge.id, edge.source, edge.target, edge)
        edgesAdded++
      }
    }
  }
  return edgesAdded
}
