'use client'

// The glyph vocabulary, ported from the marketing site (neat-web-v1/v2).
// Shapes encode node kind; fill/stroke encodes provenance. Triangle fires,
// circle runs, rectangle stores, hexagon coordinates, diamond is fast/
// transient, pentagon is security/edge. FileNode — the primary node of the
// file-first graph — gets the filled square so it reads as "the thing that
// holds the code".

export type GlyphKind =
  | 'file'
  | 'service'
  | 'db'
  | 'storage'
  | 'external'
  | 'compute'
  | 'cluster'
  | 'namespace'
  | 'vpc'

const VIEWBOX = '0 0 12 12'

interface GlyphProps {
  kind: GlyphKind
  className?: string
  filled?: boolean
}

// Map a node kind to its glyph shape SVG inner markup.
function shapeFor(kind: GlyphKind): React.ReactNode {
  switch (kind) {
    case 'file':
      // filled square — the primary node
      return <rect x="1.5" y="1.5" width="9" height="9" />
    case 'service':
      // hexagon — a service coordinates its files
      return <polygon points="6,0.5 11,3.25 11,8.75 6,11.5 1,8.75 1,3.25" strokeLinejoin="round" />
    case 'db':
      // circle — a datastore runs
      return <circle cx="6" cy="6" r="5" />
    case 'storage':
      // rectangle — stores
      return <rect x="1" y="2.5" width="10" height="7" />
    case 'external':
      // pentagon — frontier / edge
      return <polygon points="6,0.5 11.5,4.3 9.4,11 2.6,11 0.5,4.3" strokeLinejoin="round" />
    case 'compute':
      // diamond — transient compute
      return <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" strokeLinejoin="round" />
    case 'cluster':
    case 'namespace':
    case 'vpc':
      // triangle — infra container
      return <polygon points="6,1 11.5,11 0.5,11" strokeLinejoin="round" />
    default:
      return <circle cx="6" cy="6" r="5" />
  }
}

export function Glyph({ kind, className, filled }: GlyphProps) {
  const isFilled = filled ?? kind === 'file'
  return (
    <svg
      className={`glyph${isFilled ? ' filled' : ''}${className ? ` ${className}` : ''}`}
      viewBox={VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {shapeFor(kind)}
    </svg>
  )
}

// The kind label used in the legend, in the order they appear in the graph.
export const GLYPH_LEGEND: { kind: GlyphKind; label: string }[] = [
  { kind: 'file', label: 'file' },
  { kind: 'service', label: 'service' },
  { kind: 'db', label: 'database' },
  { kind: 'storage', label: 'config' },
  { kind: 'compute', label: 'compute' },
  { kind: 'external', label: 'frontier' },
]
