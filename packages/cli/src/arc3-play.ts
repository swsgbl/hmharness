/**
 * @hmharness/cli - `hmh cognitive play --env=arc3` (blueprint §14 finale)
 *
 * The LLM PLAYS the game for real: each step renders the frame pair to a
 * PNG, the vision model looks at it, reasons about which action to take,
 * and the choice (with the model's own words as `reasoning`) goes to the
 * official API. Every step lands in the cognitive trajectory — ARC-AGI-3's
 * replay and our world model share the same evidence.
 */
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;

/**
 * §26 final research question, measured: with the SAME model and the SAME
 * game, how much does the cognitive layer (world-model beliefs + distilled
 * lessons injected into the prompt) contribute vs a bare prompt?
 *
 *   arm A (cognitive): play with cognitive context
 *   arm B (bare):      play with the context stripped — same model, same game
 *
 * Both runs land as trajectories; the delta is the HARNESS's contribution
 * (the model was never touched). Recorded to cognitive/ablation.jsonl.
 */
export async function runArc3Ablation(
  write: (s: string) => void,
  opts: { game?: string; steps: number },
  deps: Parameters<typeof runArc3Play>[2],
): Promise<void> {
  const { appendFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const home = deps.home();
  // lock ONE game for both arms (games[0] ordering is not stable across calls)
  let gameId = opts.game;
  if (!gameId) {
    const { Arc3RestBridge } = await import('@hmharness/environments');
    const games = await new Arc3RestBridge().listGames();
    gameId = games[0]?.game_id ?? '';
  }
  write(`消融实验 · 相同模型 · 相同游戏 ${gameId} · ${opts.steps} 步/臂（§26: harness 增益几何？）\n`);
  const withCognitive = await runArc3Play((s) => write(s.replace(/^/, '  ')), { ...opts, game: gameId, quiet: false, bare: false }, deps);
  write('\n  ——— 裸提示词臂 ———\n');
  const bare = await runArc3Play((s) => write(s.replace(/^/, '  ')), { ...opts, game: gameId, quiet: false, bare: true }, deps);
  if (!withCognitive || !bare) { write('（实验失败）\n'); return; }
  const record = {
    at: new Date().toISOString(),
    game: gameId,
    steps: opts.steps,
    withCognitive: { levels: withCognitive.levelsCompleted, actions: withCognitive.actions, distinctActions: withCognitive.distinctActions, trajectoryId: withCognitive.trajectoryId },
    bare: { levels: bare.levelsCompleted, actions: bare.actions, distinctActions: bare.distinctActions, trajectoryId: bare.trajectoryId },
    harnessDeltaLevels: withCognitive.levelsCompleted - bare.levelsCompleted,
    harnessDeltaDiversity: withCognitive.distinctActions - bare.distinctActions,
  };
  await mkdir(join(home, 'cognitive'), { recursive: true }).catch(() => undefined);
  await appendFile(join(home, 'cognitive', 'ablation.jsonl'), JSON.stringify(record) + '\n', 'utf8').catch(() => undefined);
  write(`\n结论 · 认知层 ${withCognitive.levelsCompleted} 关 vs 裸提示词 ${bare.levelsCompleted} 关 → harness 净贡献 ${record.harnessDeltaLevels >= 0 ? '+' : ''}${record.harnessDeltaLevels} 关\n`);
  write(`  动作多样性 认知层 ${withCognitive.distinctActions} 种 vs 裸 ${bare.distinctActions} 种（关卡持平时行为差异信号）\n`);
  write(`（样本=${opts.steps} 步/臂，单次实验；多次运行后 cognitive/ablation.jsonl 聚合更可靠）\n`);
}

export async function runArc3Play(
  write: (s: string) => void,
  opts: { game?: string; steps: number; vision?: boolean; bare?: boolean; quiet?: boolean },
  deps: { home: () => string; loadConfig: () => Promise<unknown>; resolveProvider: (cfg: unknown, route: string) => { baseUrl: string; apiKey: string; model: string } | undefined },
): Promise<{ trajectoryId: string; levelsCompleted: number; levelCount: number; actions: number; distinctActions: number } | null> {
  const home = deps.home();
  const { Arc3RestBridge, Arc3Environment, renderFramePng } = await import('@hmharness/environments');
  const { TrajectoryRecorder, TrajectoryStore, CognitiveMemory } = await import('@hmharness/cognitive');
  const kernel = await import('@hmharness/kernel');

  const bridge = new Arc3RestBridge();
  const games = await bridge.listGames();
  if (games.length === 0) { write('（API 未返回游戏）\n'); return null; }
  const game = opts.game ? games.find((g) => g.game_id.startsWith(opts.game!)) : undefined;
  const gameId = game?.game_id ?? games[0]!.game_id;
  if (!opts.quiet) write(`ARC-AGI-3 对局 · ${gameId}（共 ${games.length} 个游戏可选）· ${opts.steps} 步${opts.vision === false ? ' · 无视觉' : ' · 视觉推理' }${opts.bare ? ' · 裸提示词(消融臂)' : ''}\n`);

  const env = new Arc3Environment({ bridge, gameId });
  const rec = new TrajectoryRecorder(`trj-arc3-play-${Date.now().toString(36)}`, `arc3-${gameId}`, { id: 'arc3', version: '1.0.0' }, { id: 'goal-arc3', description: `complete levels in game ${gameId}` });

  // cognitive context (blueprint M3 for ARC): arc3 world-model beliefs +
  // lessons distilled from earlier plays — the ablation's "with" arm injects
  // this into the prompt; the bare arm sees none of it
  let cognitiveNote = '';
  if (!opts.bare) {
    try {
      const { analyzeWorldModel } = await import('@hmharness/cognitive');
      const wm = await analyzeWorldModel(home, 'arc3');
      const beliefs = wm.beliefs.filter((b) => b.actionType.startsWith('ACTION')).slice(0, 5);
      const mem = new CognitiveMemory(home);
      await mem.load();
      const lessons = mem.retrieve({ layer: 'episodic', text: 'ARC3', limit: 3 }).map((e) => e.content.slice(0, 90));
      const parts: string[] = [];
      if (beliefs.length) parts.push(`Historical action outcomes on ARC games: ${beliefs.map((b) => `${b.actionType} ${Math.round(b.confidence * 100)}% reliable (n=${b.evidenceCount})`).join(', ')}.`);
      if (lessons.length) parts.push(`Lessons from earlier ARC plays: ${lessons.join(' | ')}`);
      cognitiveNote = parts.length ? `\nCognitive context from past runs:\n${parts.join('\n')}\n` : '';
    } catch { /* context is best-effort; bare prompt still works */ }
  }

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
          `Recent moves: ${history.slice(-5).join('; ') || '(none)'}.` +
          cognitiveNote +
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
    if (!opts.quiet) write(`  ${String(step).padStart(3)} ${actionType.padEnd(8)} ${r.outcome === 'success' ? GREEN('✓') : RED('✗')} 关卡 ${out.levelsCompleted ?? '?'}${out.levelProgressed ? GREEN(' ↑') : ''}\n`);
    if (!opts.quiet && r.outcome === 'failure' && r.error) write(DIM(`      ${r.error.code}: ${r.error.message.slice(0, 80)}\n`));
  }

  const score = await env.evaluate();
  const traj = rec.finish(Number(score.metrics.levelsCompleted ?? 0) > state0.levelsCompleted);
  await new TrajectoryStore(home).append(traj);
  const distinctActions = new Set(traj.steps.map((s) => s.action.type)).size;
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
  if (!opts.quiet) {
    write(`对局结束 · 官方记分卡: ${score.metrics.levelsCompleted}/${score.metrics.levelCount} 关 · ${score.metrics.actions} 动作\n`);
    write(`轨迹 ${traj.id} 已落盘（面板可回放每步+模型推理）\n`);
  }
  return {
    trajectoryId: traj.id,
    levelsCompleted: Number(score.metrics.levelsCompleted ?? 0),
    levelCount: Number(score.metrics.levelCount ?? 0),
    actions: Number(score.metrics.actions ?? opts.steps),
    distinctActions,
  };
}
