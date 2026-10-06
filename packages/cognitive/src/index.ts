/**
 * @hmharness/cognitive - the Cognitive OS core layer
 *
 * Blueprint: HMH Cognitive OS (2026-09). Kernel stays the source of truth;
 * this layer owns cognitive STRATEGY: environment protocol, world model,
 * goals, exploration, RLM, five-layer memory, skill compilation, continual
 * learning control plane, evolution-2.0 governance, multi-agent topology,
 * GeneralBench and the transfer lab. Nothing here touches approval/sandbox
 * internals — governance composes them, never bypasses them.
 */
export * from './protocol.ts';
export * from './registry.ts';
export * from './trajectory.ts';
export * from './world-model.ts';
export * from './goal.ts';
export * from './exploration.ts';
export * from './rlm.ts';
export { runSandboxedEval } from './rlm-sandbox.ts';
export type { SandboxResult, SandboxOptions } from './rlm-sandbox.ts';
export * from './memory.ts';
export * from './skill-compiler.ts';
export * from './continual.ts';
export * from './evolution2.ts';
export * from './multi-agent.ts';
export * from './benchmark.ts';
export * from './status.ts';
export * from './analysis.ts';
export * from './explore-runner.ts';
export * from './transfer-lab.ts';
export * from './abstract-actions.ts';
export * from './learning-loop.ts';
export * from './governance.ts';
export * from './crowd.ts';
export * from './slice.ts';
export * from './mea.ts';
export * from './evalset.ts';
export * from './code-world-model.ts';
export * from './ledger.ts';
export * from './code-world-store.ts';
