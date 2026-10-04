/**
 * @hmharness/cognitive - Code World Model (2026-10-04 audit line B / W7)
 *
 * "LSP + API KG + build/runtime facts 统一成 CodeEntity/Relation/
 * Diagnostic/BuildFact/RuntimeFact" — one typed store for the code world,
 * fed by sensors the host wires (LSP symbols/diagnostics, API KG, build
 * runs, runtime probes). Cognitive keeps zero dependency on the lsp
 * package: facts arrive as plain data, the model owns the ontology.
 *
 * The WM-2 discipline applies verbatim: an edit is PREDICTED before it
 * happens (which entities, relations and diagnostics it should touch,
 * derived from the relation graph), the ACTUAL delta is recorded after,
 * and the prediction error is computed — the code world gets the same
 * predict-before/actual-after/error scoring the environment world has.
 */
import { stableHash } from './protocol.ts';

/* ---------------- ontology (audit line B, verbatim) ---------------- */

export interface CodeEntity {
  /** stable id: `${uri}#${name}` */
  id: string;
  kind: 'file' | 'module' | 'function' | 'class' | 'method' | 'field';
  name: string;
  uri: string;
  range?: { startLine: number; endLine: number };
}

export type RelationKind = 'defines' | 'calls' | 'references' | 'imports' | 'implements';

export interface SymbolRelation {
  from: string; // entity id
  to: string; // entity id
  kind: RelationKind;
}

export interface CodeDiagnostic {
  uri: string;
  severity: 1 | 2 | 3 | 4; // LSP severity scale
  message: string;
  source: 'lsp' | 'build' | 'runtime';
}

export interface BuildFact {
  ok: boolean;
  outputDigest?: string;
  at: string;
}

export interface RuntimeFact {
  kind: string;
  detail: string;
  at: string;
}

/* ---------------- edit delta prediction (WM-2 discipline) ---------------- */

export interface EditDelta {
  editKind: 'rename' | 'delete' | 'modify';
  target: string; // entity id being edited
  touchedEntities: string[];
  touchedRelations: string[]; // `${from}->${to}:${kind}`
  newDiagnosticEstimate: number;
}

export interface PredictionError {
  /** Jaccard over the union of touched entities+relations */
  jaccard: number;
  precision: number;
  recall: number;
  /** entities/relations the edit touched that prediction missed (surprise) */
  missed: string[];
  /** predicted but untouched (overprediction) */
  spurious: string[];
}

/* ---------------- the model ---------------- */

export class CodeWorldModel {
  private entities = new Map<string, CodeEntity>();
  private relations: SymbolRelation[] = [];
  /** latest diagnostics per uri (sensors push; overwrite per uri) */
  private diagnostics = new Map<string, CodeDiagnostic[]>();
  private latestBuild: BuildFact | null = null;
  private runtimeFacts: RuntimeFact[] = [];
  private openPredictions = new Map<string, { predicted: EditDelta; at: string }>();

  /** Ingest sensors' output — idempotent per entity id; diagnostics replace per uri. */
  ingest(input: {
    entities?: CodeEntity[];
    relations?: SymbolRelation[];
    diagnostics?: CodeDiagnostic[];
    build?: BuildFact;
    runtime?: RuntimeFact;
  }): void {
    for (const e of input.entities ?? []) this.entities.set(e.id, e);
    this.relations.push(...(input.relations ?? []));
    for (const d of input.diagnostics ?? []) {
      const cur = this.diagnostics.get(d.uri) ?? [];
      const next = cur.filter((x) => x.message !== d.message || x.source !== d.source);
      next.push(d);
      this.diagnostics.set(d.uri, next);
    }
    if (input.build) this.latestBuild = input.build;
    if (input.runtime) this.runtimeFacts.push(input.runtime);
  }

  get entityCount(): number {
    return this.entities.size;
  }
  get relationCount(): number {
    return this.relations.length;
  }
  get diagnosticCount(): number {
    return [...this.diagnostics.values()].reduce((s, l) => s + l.length, 0);
  }
  get build(): BuildFact | null {
    return this.latestBuild;
  }

  entity(id: string): CodeEntity | undefined {
    return this.entities.get(id);
  }

  relationsOf(entityId: string): SymbolRelation[] {
    return this.relations.filter((r) => r.from === entityId || r.to === entityId);
  }

  diagnosticsFor(uri: string): CodeDiagnostic[] {
    return [...(this.diagnostics.get(uri) ?? [])];
  }

  /**
   * PREDICT an edit's blast radius from the relation graph: renaming or
   * deleting entity X touches X itself plus every relation that names X
   * (callers, referrers, importers). newDiagnosticEstimate is the count of
   * existing diagnostics on the touched files — the honest floor, not a
   * guess about new ones.
   */
  predictEditDelta(edit: { editKind: 'rename' | 'delete' | 'modify'; target: string }): EditDelta {
    const touchedEntities = new Set<string>([edit.target]);
    const touchedRelations = new Set<string>();
    for (const r of this.relations) {
      if (r.from === edit.target || r.to === edit.target) {
        touchedRelations.add(`${r.from}->${r.to}:${r.kind}`);
        touchedEntities.add(r.from);
        touchedEntities.add(r.to);
      }
    }
    const uris = new Set([...touchedEntities].map((id) => id.split('#')[0]!));
    let diagFloor = 0;
    for (const uri of uris) diagFloor += (this.diagnostics.get(uri) ?? []).length;
    const predicted: EditDelta = {
      editKind: edit.editKind,
      target: edit.target,
      touchedEntities: [...touchedEntities],
      touchedRelations: [...touchedRelations],
      newDiagnosticEstimate: diagFloor,
    };
    this.openPredictions.set(edit.target, { predicted, at: new Date().toISOString() });
    return predicted;
  }

  /**
   * Record what ACTUALLY happened and settle the open prediction. The
   * actual may legally differ — surprise (missed) is exactly the signal
   * that the graph is incomplete.
   */
  recordEditDelta(target: string, actual: { touchedEntities: string[]; touchedRelations: string[] }): PredictionError | null {
    const open = this.openPredictions.get(target);
    if (!open) return null;
    this.openPredictions.delete(target);
    const p = new Set([...open.predicted.touchedEntities, ...open.predicted.touchedRelations]);
    const a = new Set([...actual.touchedEntities, ...actual.touchedRelations]);
    const union = new Set([...p, ...a]);
    const inter = [...p].filter((x) => a.has(x));
    const missed = [...a].filter((x) => !p.has(x));
    const spurious = [...p].filter((x) => !a.has(x));
    return {
      jaccard: union.size ? Number((inter.length / union.size).toFixed(3)) : 1,
      precision: a.size ? Number((inter.length / a.size).toFixed(3)) : 1,
      recall: p.size ? Number((inter.length / p.size).toFixed(3)) : 1,
      missed,
      spurious,
    };
  }

  /** Snapshot hash — for holdout discipline and drift detection. */
  stateHash(): string {
    return stableHash({
      entities: [...this.entities.keys()].sort(),
      relations: this.relations.map((r) => `${r.from}->${r.to}:${r.kind}`).sort(),
      diagnosticUris: [...this.diagnostics.keys()].sort(),
      build: this.latestBuild,
    });
  }
}
