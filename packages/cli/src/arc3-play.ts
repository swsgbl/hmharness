/**
 * @hmharness/cli - `hmh cognitive play --env=arc3` (blueprint §14 finale)
 *
 * The LLM PLAYS the game for real: each step renders the frame pair to a
 * PNG, the vision model looks at it, reasons about which action to take,
 * and the choice (with the model's own words as `reasoning`) goes to the
 * official API. Every step lands in the cognitive trajectory — ARC-AGI-3's
 * replay and our world model share the same evidence.
 */
import type { stdout as StdoutT } from 'node:process';

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

export async function runArc3Play(
  write: (s: string) => void,
  opts: { game?: string; steps: number; vision?: boolean },
  deps: { home: () => string; loadConfig: () => Promise<unknown>; resolveProvider: (cfg: unknown, route: string) => { baseUrl: string; apiKey: string; model: string } | undefined },
): Promise<void> {
  const home = deps.home();
  const { Arc3RestBridge, Arc3Environment, renderFramePng } = await import('@hmharness/environments');
  const { TrajectoryRecorder, TrajectoryStore, CognitiveMemory } = await import('@hmharness/cognitive');
  const kernel = await import('@hmharness/kernel');

  const bridge = new Arc3RestBridge();
  const games = await bridge.listGames();
  if (games.length === 0) { write('（API 未返回游戏）\n'); return; }
  const game = opts.game ? games.find((g) => g.game_id.startsWith(opts.game!)) : undefined;
  const gameId = game?.game_id ?? games[0]!.game_id;
  write(`ARC-AGI-3 对局 · ${gameId}（共 ${games.length} 个游戏可选）· ${opts.steps} 步${opts.vision === false ? ' · 无视觉' : ' · 视觉推理' }\n`);

  const env = new Arc3Environment({ bridge, gameId });
  const rec = new TrajectoryRecorder(`trj-arc3-play-${Date.now().toString(36)}`, `arc3-${gameId}`, { id: 'arc3', version: '1.0.0' }, { id: 'goal-arc3', description: `complete levels in game ${gameId}` });

  const cfg = await deps.loadConfig();
  const visionProvider = deps.resolveProvider(cfg, 'vision') ?? deps.resolveProvider(cfg, 'chat');

  const obs = await env.reset();
  const state0 = obs.state as { levelsCompleted: number; winLevels: number };
  write(`  开局 · 需过 ${state0.winLevels} 关，已过 ${state0.levelsCompleted}\n`);

  const history: string[] = [];
  for (let step = 1; step <= opts.steps; step++) {
    const obs2 = await env.observe();
    const raw = (obs2.raw ?? {}) as { frame?: unknown };
    const actions = obs2.availableActions.map((a) => a.type);

    let actionType = actions[0];
    let reason = 'no vision — first available action';
    let visionNote = '';
    if (opts.vision !== false && visionProvider?.apiKey && Array.isArray(raw.frame)) {
      const png = renderFramePng(raw.frame, 8);
      if (png) {
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        const prompt =
          `You are playing an ARC-AGI-3 game (${gameId}). The image shows the game grid(s) side by side. ` +
          `Available actions: ${actions.join(', ')}${actions.includes('ACTION6') ? ' (ACTION6 needs x,y on the grid; estimate from the image)' : ''}. ` +
          `Recent moves: ${history.slice(-5).join('; ') || '(none)'}. ` +
          `Reason briefly about what the game wants, then answer with EXACTLY one line first: ACTION<n> or ACTION6 x,y`;
        try {
          const answer = await kernel.chatVision(visionProvider, prompt, dataUrl, { maxTokens: 1500 });
          const lines = String(answer).trim().split('\n').map((l) => l.trim()).filter(Boolean);
          const line = lines.find((l) => /ACTION\s*\d/i.test(l)) ?? '';
          const m = line.match(/ACTION\s*6\s*[, ]*\s*(\d{1,2})\s*[, ]+\s*(\d{1,2})/i) ?? line.match(/ACTION\s*(\d)/i);
          if (m) {
            if (m[0].toUpperCase().includes('ACTION6') && m.length === 3) {
              actionType = 'ACTION6';
              (opts as { xy?: [number, number] }).xy = [Number(m[1]), Number(m[2])];
            } else {
              actionType = `ACTION${m[1]}`;
            }
          }
          reason = (line || lines.join(' ')).slice(0, 200);
          visionNote = DIM(`  模型: ${reason.slice(0, 90)}\n`);
        } catch (err) {
          visionNote = YELLOW(`  视觉调用失败(${String(err).slice(0, 70)})，退回首选动作\n`);
        }
      }
    }
    write(visionNote);
    const xy = (opts as { xy?: [number, number] }).xy;
    delete (opts as { xy?: [number, number] }).xy;
    const args = actionType === 'ACTION6' ? { x: xy?.[0] ?? 32, y: xy?.[1] ?? 32 } : {};

    const started = Date.now();
    const r = await env.act({ id: `s${step}`, type: actionType, args, reason });
    const out = (r.output ?? {}) as { levelsCompleted?: number; levelProgressed?: boolean };
    history.push(`${actionType}${actionType === 'ACTION6' ? `(${args.x},${args.y})` : ''}→${r.outcome}${out.levelProgressed ? '+LEVEL' : ''}`);
    rec.record({ action: { id: `s${step}`, type: actionType, args, reason }, outcome: r.outcome, evidence: [`arc3:${gameId}`], durationMs: Date.now() - started });
    write(`  ${String(step).padStart(3)} ${actionType.padEnd(8)} ${r.outcome === 'success' ? GREEN('✓') : RED('✗')} 关卡 ${out.levelsCompleted ?? '?'}${out.levelProgressed ? GREEN(' ↑') : ''}\n`);
    if (r.outcome === 'failure' && r.error) write(DIM(`      ${r.error.code}: ${r.error.message.slice(0, 80)}\n`));
  }

  const score = await env.evaluate();
  const traj = rec.finish(Number(score.metrics.levelsCompleted ?? 0) > state0.levelsCompleted);
  await new TrajectoryStore(home).append(traj);
  const mem = new CognitiveMemory(home);
  await mem.load();
  await mem.write({
    layer: 'episodic',
    content: `ARC3 PLAY ${gameId}: ${score.metrics.levelsCompleted}/${score.metrics.levelCount} levels in ${opts.steps} actions`,
    payload: { trajectoryId: traj.id, gameId },
    source: 'arc3-play',
    provenance: `trajectory:${traj.id}`,
    confidence: 0.8,
    environment: 'arc3',
    session: traj.sessionId,
    tags: ['arc3', 'play'],
  }).catch(() => undefined);
  await env.close();
  write(`对局结束 · 官方记分卡: ${score.metrics.levelsCompleted}/${score.metrics.levelCount} 关 · ${score.metrics.actions} 动作\n`);
  write(`轨迹 ${traj.id} 已落盘（面板可回放每步+模型推理）\n`);
}
