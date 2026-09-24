import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyGraph, addNode, addEdge, findNode, nodesByType, neighbors, traverse, tojsonl, fromjsonl, graphStats,
} from '../knowledge-graph.ts';

test('empty graph has no nodes/edges', () => {
  const g = emptyGraph();
  assert.equal(g.nodes.length, 0);
  assert.equal(g.edges.length, 0);
});

test('addNode adds and deduplicates', () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'p1', type: 'project', label: 'Project 1' });
  g = addNode(g, { id: 'p1', type: 'project', label: 'Project 1' }); // dup
  assert.equal(g.nodes.length, 1);
});

test('nodesByType filters correctly', () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'p1', type: 'project', label: 'P1' });
  g = addNode(g, { id: 'm1', type: 'module', label: 'M1' });
  g = addNode(g, { id: 'm2', type: 'module', label: 'M2' });
  assert.equal(nodesByType(g, 'module').length, 2);
  assert.equal(nodesByType(g, 'project').length, 1);
  assert.equal(nodesByType(g, 'bug').length, 0);
});

test('neighbors finds connected nodes', () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'p1', type: 'project', label: 'P1' });
  g = addNode(g, { id: 'm1', type: 'module', label: 'M1' });
  g = addNode(g, { id: 'm2', type: 'module', label: 'M2' });
  g = addEdge(g, { from: 'p1', to: 'm1', type: 'contains' });
  g = addEdge(g, { from: 'p1', to: 'm2', type: 'contains' });
  const ns = neighbors(g, 'p1');
  assert.equal(ns.length, 2);
});

test('traverse follows edges transitively', () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'a', type: 'project', label: 'A' });
  g = addNode(g, { id: 'b', type: 'module', label: 'B' });
  g = addNode(g, { id: 'c', type: 'api', label: 'C' });
  g = addEdge(g, { from: 'a', to: 'b', type: 'contains' });
  g = addEdge(g, { from: 'b', to: 'c', type: 'depends_on' });
  const reachable = traverse(g, 'a', ['contains', 'depends_on']);
  assert.equal(reachable.length, 3);
});

test('tojsonl/fromjsonl round-trip', () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'n1', type: 'bug', label: 'Bug 1' });
  g = addEdge(g, { from: 'n1', to: 'n1', type: 'relates_to' });
  const jsonl = tojsonl(g);
  const restored = fromjsonl(jsonl);
  assert.equal(restored.nodes.length, 1);
  assert.equal(restored.edges.length, 1);
  assert.equal(restored.nodes[0].id, 'n1');
});

test('graphStats counts by type', () => {
  let g = emptyGraph();
  g = addNode(g, { id: 'p1', type: 'project', label: 'P1' });
  g = addNode(g, { id: 'b1', type: 'bug', label: 'B1' });
  g = addNode(g, { id: 'b2', type: 'bug', label: 'B2' });
  g = addEdge(g, { from: 'p1', to: 'b1', type: 'contains' });
  const s = graphStats(g);
  assert.equal(s.nodes, 3);
  assert.equal(s.edges, 1);
  assert.equal(s.byNodeType.bug, 2);
  assert.equal(s.byEdgeType.contains, 1);
});
