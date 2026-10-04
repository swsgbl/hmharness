/**
 * @hmharness/agent - LSP → Code World Model sensor wiring (audit line B)
 *
 * "LSP 提供 symbol/definition/reference/... 结构化观察，可作为 Code World
 * Model 的传感器；不要把它做成 IDE" (02 doc). This adapter lives in agent
 * — the composition layer that already depends on BOTH @hmharness/lsp and
 * @hmharness/cognitive — so neither layering direction is violated.
 *
 * Mapping (LSP 3.18 shapes → audit ontology):
 *   DocumentSymbol tree → CodeEntity per symbol + 'defines' relation per
 *     parent→child edge (the only relation LSP symbols PROVE; calls/
 *     references need deeper requests — later sensors)
 *   publishDiagnostics payload → CodeDiagnostic (source: 'lsp' — the
 *     feedback-not-proof label travels into the model)
 *   BuildFact/RuntimeFact have their own sensors (build tool, runs) —
 *     not this adapter's job.
 */
import {
  CodeWorldModel,
  type CodeDiagnostic,
  type CodeEntity,
  type SymbolRelation,
} from '@hmharness/cognitive';
import type { Diagnostic, DocumentSymbol } from '@hmharness/lsp';

/** Map a LSP symbol kind number to the audit's entity kind (best effort). */
function entityKind(symbolKind: number): CodeEntity['kind'] {
  // LTS subset of LSP SymbolKind; unknown kinds land as 'field' — honest
  // coarseness beats a wrong specific kind (the audit ontology has no
  // 'property' kind — methods/fields cover the LSP property case)
  if (symbolKind === 12) return 'function';
  if (symbolKind === 5) return 'class';
  if (symbolKind === 6) return 'method';
  if (symbolKind === 2) return 'module';
  if (symbolKind === 1) return 'file';
  return 'field';
}

/**
 * LSP DocumentSymbol tree → entities + 'defines' relations. Nested children
 * become defines edges (a document defines its top-level symbols; a class
 * defines its methods). Only what the symbols response PROVES is emitted.
 */
export function lspSymbolsToOntology(uri: string, symbols: DocumentSymbol[]): { entities: CodeEntity[]; relations: SymbolRelation[] } {
  const entities: CodeEntity[] = [];
  const relations: SymbolRelation[] = [];
  const walk = (list: DocumentSymbol[], parentId: string | null): void => {
    for (const s of list) {
      const id = `${uri}#${s.name}`;
      entities.push({
        id,
        kind: entityKind(s.kind),
        name: s.name,
        uri,
        ...(s.range?.start ? { range: { startLine: s.range.start.line + 1, endLine: (s.range.end?.line ?? s.range.start.line) + 1 } } : {}),
      });
      if (parentId) relations.push({ from: parentId, to: id, kind: 'defines' });
      if (s.children?.length) walk(s.children, id);
    }
  };
  walk(symbols, null);
  return { entities, relations };
}

/** LSP diagnostics payload → audit CodeDiagnostic (source pinned to 'lsp'). */
export function lspDiagnosticsToOntology(uri: string, diagnostics: Diagnostic[]): CodeDiagnostic[] {
  return diagnostics.map((d) => ({
    uri,
    severity: (d.severity ?? 1) as CodeDiagnostic['severity'],
    message: d.message,
    source: 'lsp', // the feedback-not-proof label rides into the model
  }));
}

export interface CodeWorldSyncInput {
  uri: string;
  symbols?: DocumentSymbol[];
  diagnostics?: Diagnostic[];
}

/** One sensor sync: symbols + diagnostics from LSP into the model. */
export function syncCodeWorldModel(cwm: CodeWorldModel, input: CodeWorldSyncInput): { entitiesIngested: number; relationsIngested: number; diagnosticsIngested: number } {
  const result = { entitiesIngested: 0, relationsIngested: 0, diagnosticsIngested: 0 };
  if (input.symbols?.length) {
    const { entities, relations } = lspSymbolsToOntology(input.uri, input.symbols);
    cwm.ingest({ entities, relations });
    result.entitiesIngested = entities.length;
    result.relationsIngested = relations.length;
  }
  if (input.diagnostics) {
    const diags = lspDiagnosticsToOntology(input.uri, input.diagnostics);
    cwm.ingest({ diagnostics: diags });
    result.diagnosticsIngested = diags.length;
  }
  return result;
}
