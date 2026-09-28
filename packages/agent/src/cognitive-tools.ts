/**
 * @hmharness/agent - cognitive query tool (blueprint §18/UX-004 seed)
 *
 * Gives the LIVE model read access to its own accumulated world model:
 * which tool types historically succeed, how calibrated its predictions
 * are, and what the diagnosis layer thinks is worth learning. Read-only by
 * design — the model cannot write beliefs; those update only from real
 * trajectories (no self-grading channel).
 */
import type { Tool, ToolResult, ToolContext } from '@hmharness/kernel';

export const cognitiveQueryTool: Tool = {
  name: 'cognitive_query',
  description:
    'Query the cognitive layer\'s accumulated knowledge about past runs: which action/tool types historically succeed (belief table with confidence and evidence counts), prediction calibration, planner-trusted action types, learning opportunities, and memory contradictions. Read-only. Args: focus=beliefs|calibration|diagnosis|memory (optional; omit for a summary).',
  parameters: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'beliefs | calibration | diagnosis | memory (optional)' },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const focus = String(args.focus ?? 'summary');
    try {
      const { analyzeWorldModel, diagnoseOpportunities, CognitiveMemory } = await import('@hmharness/cognitive');
      const lines: string[] = [];
      if (focus === 'summary' || focus === 'beliefs') {
        const wm = await analyzeWorldModel(ctx.home);
        lines.push(`world model (${wm.trajectoriesReplayed} trajectories, ${wm.stepsReplayed} steps replayed):`);
        if (wm.beliefs.length === 0) lines.push('  (no beliefs yet — run a few tasks first)');
        for (const b of wm.beliefs.slice(0, 12)) {
          lines.push(`  ${b.actionType.padEnd(24)} conf=${b.confidence.toFixed(2)} n=${b.evidenceCount}`);
        }
        if (focus === 'beliefs') {
          lines.push(`planner gate: trusted=[${wm.plannerGate.trusted.join(',')}] untrusted=[${wm.plannerGate.untrusted.join(',')}] unknown=[${wm.plannerGate.unknown.join(',')}]`);
        }
      }
      if (focus === 'summary' || focus === 'calibration') {
        const wm = await analyzeWorldModel(ctx.home);
        const cal = wm.calibration;
        lines.push(`calibration: ${cal.resolved} resolved predictions${cal.meanError !== undefined ? `, mean |error|=${cal.meanError}` : ' (no predictions recorded yet — steps carry no confidence)'}`);
      }
      if (focus === 'summary' || focus === 'diagnosis') {
        const d = await diagnoseOpportunities(ctx.home);
        lines.push(`diagnosis (${d.trajectories} trajectories):`);
        if (d.opportunities.length === 0) lines.push('  (no learning opportunity meets the evidence threshold yet)');
        for (const o of d.opportunities.slice(0, 6)) {
          lines.push(`  [${o.suggestedTargets.join('/')}] ${o.signal}`);
        }
      }
      if (focus === 'summary' || focus === 'memory') {
        const mem = new CognitiveMemory(ctx.home);
        await mem.load();
        const stats = mem.stats();
        lines.push(`memory: working:${stats.working} episodic:${stats.episodic} semantic:${stats.semantic} procedural:${stats.procedural} world:${stats.world}, contradictions pending: ${mem.detectContradictions().length}`);
      }
      return { output: lines.join('\n') };
    } catch (err) {
      return { output: 'cognitive_query failed: ' + String(err).slice(0, 200), isError: true };
    }
  },
};
