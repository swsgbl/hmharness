/**
 * @hmharness/evolution - Project Knowledge Graph (P1-04)
 *
 * The audit called for: "Project/Module/API/Bug/Decision/Skill/SDK/Device 关系"
 *
 * A lightweight in-memory graph with typed nodes and edges, persisted as JSONL.
 * Query by node type, edge type, or traversal.
 */

export type KGNodeType = 'project' | 'module' | 'api' | 'bug' | 'decision' | 'skill' | 'sdk' | 'device' | 'person';

export type KGEdgeType =
  | 'contains'      // project contains module
  | 'depends_on'    // module depends on module/api
  | 'uses'          // module uses api/sdk
  | 'fixes'         // skill/decision fixes bug
  | 'decided_by'    // bug decided_by decision
  | 'built_with'    // project built_with sdk
  | 'runs_on'       // project runs_on device
  | 'authored_by'   // decision authored_by person
  | 'relates_to';   // generic

export interface KGNode {
  id: string;
  type: KGNodeType;
  label: string;
  properties?: Record<string, unknown>;
}

export interface KGEdge {
  from: string;
  to: string;
  type: KGEdgeType;
  properties?: Record<string, unknown>;
}

export interface KnowledgeGraph {
  nodes: KGNode[];
  edges: KGEdge[];
}

export function emptyGraph(): KnowledgeGraph {
  return { nodes: [], edges: [] };
}

export function addNode(g: KnowledgeGraph, node: KGNode): KnowledgeGraph {
  if (g.nodes.some(n => n.id === node.id)) return g;
  return { ...g, nodes: [...g.nodes, node] };
}

export function addEdge(g: KnowledgeGraph, edge: KGEdge): KnowledgeGraph {
  return { ...g, edges: [...g.edges, edge] };
}

export function findNode(g: KnowledgeGraph, id: string): KGNode | undefined {
  return g.nodes.find(n => n.id === id);
}

export function nodesByType(g: KnowledgeGraph, type: KGNodeType): KGNode[] {
  return g.nodes.filter(n => n.type === type);
}

export function edgesByType(g: KnowledgeGraph, type: KGEdgeType): KGEdge[] {
  return g.edges.filter(e => e.type === type);
}

/** Get all nodes connected to a given node (either direction) */
export function neighbors(g: KnowledgeGraph, nodeId: string): KGNode[] {
  const ids = new Set<string>();
  for (const e of g.edges) {
    if (e.from === nodeId) ids.add(e.to);
    if (e.to === nodeId) ids.add(e.from);
  }
  return g.nodes.filter(n => ids.has(n.id));
}

/** Get all nodes reachable from a starting node via specific edge types */
export function traverse(g: KnowledgeGraph, startId: string, edgeTypes: KGEdgeType[]): KGNode[] {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of g.edges) {
      if (e.from === current && edgeTypes.includes(e.type) && !visited.has(e.to)) {
        visited.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return g.nodes.filter(n => visited.has(n.id));
}

/** Serialize to JSONL for persistence */
export function tojsonl(g: KnowledgeGraph): string {
  const lines = g.nodes.map(n => JSON.stringify({ _t: 'node', ...n }));
  lines.push(...g.edges.map(e => JSON.stringify({ _t: 'edge', ...e })));
  return lines.join('\n') + '\n';
}

/** Deserialize from JSONL */
export function fromjsonl(text: string): KnowledgeGraph {
  const g = emptyGraph();
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const obj = JSON.parse(line);
      if (obj._t === 'node') g.nodes.push(obj as KGNode);
      else if (obj._t === 'edge') g.edges.push(obj as KGEdge);
    } catch { /* skip malformed */ }
  }
  return g;
}

/** Count nodes and edges by type for a summary */
export function graphStats(g: KnowledgeGraph): { nodes: number; edges: number; byNodeType: Record<string, number>; byEdgeType: Record<string, number> } {
  const byNodeType: Record<string, number> = {};
  for (const n of g.nodes) byNodeType[n.type] = (byNodeType[n.type] ?? 0) + 1;
  const byEdgeType: Record<string, number> = {};
  for (const e of g.edges) byEdgeType[e.type] = (byEdgeType[e.type] ?? 0) + 1;
  return { nodes: g.nodes.length, edges: g.edges.length, byNodeType, byEdgeType };
}
