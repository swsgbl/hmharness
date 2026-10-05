/**
 * @hmharness/agent - live LSP sensor → Code World Model bridge (audit line B)
 *
 * The mapping functions (lspSymbolsToOntology etc.) are pure; THIS class
 * makes them LIVE: an LspClient's push stream (diagnostics) and pull
 * results (documentSymbols) flow into a CodeWorldModel continuously, with
 * openDoc() driving the server to analyze the file in the first place.
 *
 * Usage: create with a connected LspClient + a CodeWorldModel + the
 * workspace root; call syncFile(uri, text) after each edit the agent makes
 * — the model then carries a current code world for the slice/MEA/digest
 * layers to reason over.
 */
import { join } from 'node:path';
import type { CodeWorldModel } from '@hmharness/cognitive';
import type { LspClient, Diagnostic } from '@hmharness/lsp';
import { fileToUri } from '@hmharness/lsp';
import { syncCodeWorldModel } from './code-wm-sensor.ts';

export interface LiveCodeWmSensorOptions {
  workspaceRoot: string;
  languageId?: string;
}

export class LiveCodeWmSensor {
  private diagPushes = 0;
  private lastSyncAt: string | null = null;
  private tracked = new Set<string>();

  constructor(
    private client: LspClient,
    private cwm: CodeWorldModel,
    private opts: LiveCodeWmSensorOptions,
  ) {}

  /**
   * Full sync for one file: open the doc on the server (triggers analysis),
   * pull symbols, pull diagnostics from the model's sensor state, push both
   * into the Code WM. Returns the ingested counts.
   */
  async syncFile(absPath: string, text: string): Promise<{ entitiesIngested: number; relationsIngested: number; diagnosticsIngested: number }> {
    const uri = fileToUri(absPath);
    this.client.openDoc(uri, this.opts.languageId ?? 'typescript', text);
    const symbols = await this.client.documentSymbols({ uri }).catch(() => []);
    const diagnostics = this.pullDiagnostics(uri);
    const result = syncCodeWorldModel(this.cwm, { uri, symbols, diagnostics });
    this.diagPushes += result.diagnosticsIngested;
    this.lastSyncAt = new Date().toISOString();
    this.tracked.add(uri);
    return result;
  }

  /** Pull the CURRENT diagnostics for a uri from the model's sensor state.
   *  Range-restored: the Code WM keeps message-level state (no ranges);
   *  zero ranges are the honest placeholder for sensor re-reads, never a
   *  fabricated location. */
  pullDiagnostics(uri: string): Diagnostic[] {
    const diags = this.cwm.diagnosticsFor(uri);
    return diags.map((d) => ({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: (d.severity ?? 1) as Diagnostic['severity'],
      message: d.message,
      source: 'cwm',
    }));
  }

  get stats(): { tracked: number; diagPushes: number; lastSyncAt: string | null } {
    return { tracked: this.tracked.size, diagPushes: this.diagPushes, lastSyncAt: this.lastSyncAt };
  }

  /** Sync many files (workspace scan path). */
  async syncFiles(files: Array<{ path: string; text: string }>): Promise<{ entitiesIngested: number; relationsIngested: number; diagnosticsIngested: number }> {
    const total = { entitiesIngested: 0, relationsIngested: 0, diagnosticsIngested: 0 };
    for (const f of files) {
      const r = await this.syncFile(join(this.opts.workspaceRoot, f.path), f.text);
      total.entitiesIngested += r.entitiesIngested;
      total.relationsIngested += r.relationsIngested;
      total.diagnosticsIngested += r.diagnosticsIngested;
    }
    return total;
  }
}
