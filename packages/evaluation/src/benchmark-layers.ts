/**
 * @hmharness/evaluation - benchmark layer taxonomy (upgrade pack 04 section 1, P2)
 *
 * The pack's four physically separated dataset layers, each with a
 * machine-enforced WRITER policy - the headline rule being: the hidden
 * holdout is writable ONLY by the evaluator; the agent and the
 * self-evolution loop can never write it (and can never READ it as a
 * training feed). A rule that lives in a doc is a hope; a rule that lives
 * in assertLayerWrite is a gate.
 *
 *   internal   - developer-visible, fast regression; evolution may train on it
 *   public     - external public tasks; HMH MUST NOT MODIFY (read-only
 *                ingestion - not even 'developer' may write)
 *   real-user  - desensitized real-user tasks; user-sourced ingestion
 *   hidden     - evaluator-only writes, invisible to evolution/agent
 */
export type BenchmarkLayer = 'internal' | 'public' | 'real-user' | 'hidden';

/** who can appear as a writer */
export type LayerWriter = 'developer' | 'public-source' | 'user' | 'evaluator' | 'evolution' | 'agent';

export interface LayerPolicy {
  layer: BenchmarkLayer;
  /** the ONLY writers allowed - everyone else refuses */
  writableBy: readonly LayerWriter[];
  /** may self-evolution read tasks of this layer as a training feed */
  visibleToEvolution: boolean;
  description: string;
}

export const LAYER_POLICIES: Record<BenchmarkLayer, LayerPolicy> = {
  internal: {
    layer: 'internal',
    writableBy: ['developer'],
    visibleToEvolution: true,
    description: 'developer-visible fast regression set',
  },
  public: {
    layer: 'public',
    // "HMH 不得修改": ingestion only - no hmh-side writer may mutate a public set
    writableBy: ['public-source'],
    visibleToEvolution: true,
    description: 'external public tasks, ingested read-only',
  },
  'real-user': {
    layer: 'real-user',
    writableBy: ['user'],
    visibleToEvolution: true,
    description: 'desensitized real-user tasks',
  },
  hidden: {
    layer: 'hidden',
    writableBy: ['evaluator'],
    visibleToEvolution: false,
    description: 'hidden holdout - evaluator-only writes, invisible to evolution and agent',
  },
};

/** The machine guard: a disallowed writer refuses WITH the policy stated. */
export function assertLayerWrite(layer: BenchmarkLayer, writer: LayerWriter): void {
  const policy = LAYER_POLICIES[layer];
  if (!policy.writableBy.includes(writer)) {
    throw new Error(`layer '${layer}' refuses writer '${writer}' - allowed writers: [${policy.writableBy.join(', ')}] (${policy.description})`);
  }
}

export interface LayeredTask {
  id: string;
  layer: BenchmarkLayer;
}

export interface EvolutionFeedCheck {
  ok: boolean;
  /** hidden task ids found in the feed - each one is a contamination */
  violations: string[];
}

/** No hidden task may ever enter an evolution training feed. */
export function evolutionFeedOK(feed: LayeredTask[]): EvolutionFeedCheck {
  const violations = feed.filter((t) => LAYER_POLICIES[t.layer] && !LAYER_POLICIES[t.layer].visibleToEvolution).map((t) => t.id);
  return { ok: violations.length === 0, violations };
}
