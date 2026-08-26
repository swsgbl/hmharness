/**
 * @hmh/kernel - config
 * HMH_HOME isolation: all hmharness state lives under one root
 * (env HMH_HOME wins, default ~/.hmharness). Nothing is ever shared with
 * any other harness on the machine - the lesson that motivated this
 * clean-room project.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HmhConfig } from './types.ts';

export const STATE_DIRS = ['sessions', 'memory', 'skills', 'insights', 'bench'] as const;

export function homeDir(): string {
  return process.env.HMH_HOME ?? join(homedir(), '.hmharness');
}

export function defaultConfig(): HmhConfig {
  return {
    // Defaults target the machine-local FreeRide gateway (OpenAI-compatible,
    // no real key needed). Override via config.json or env for any vendor.
    provider: {
      baseUrl: process.env.HMH_BASE_URL ?? 'http://localhost:11343/v1',
      apiKey: process.env.HMH_API_KEY ?? 'any',
      model: process.env.HMH_MODEL ?? 'nvidia/nemotron-3.5-lightning:free',
    },
    maxTurns: 25,
  };
}

export async function loadConfig(): Promise<HmhConfig> {
  const home = homeDir();
  const file = join(home, 'config.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as HmhConfig;
    return { ...defaultConfig(), ...raw, provider: { ...defaultConfig().provider, ...raw.provider } };
  } catch {
    return defaultConfig();
  }
}

export async function initHome(): Promise<{ home: string; created: string[] }> {
  const home = homeDir();
  const created: string[] = [];
  await mkdir(home, { recursive: true });
  for (const dir of STATE_DIRS) {
    const p = join(home, dir);
    try {
      await mkdir(p, { recursive: true });
    } catch {
      /* exists */
    }
  }
  const configFile = join(home, 'config.json');
  try {
    await readFile(configFile, 'utf8');
  } catch {
    await writeFile(configFile, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8');
    created.push('config.json');
  }
  return { home, created };
}
