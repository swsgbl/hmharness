/**
 * @hmharness/cognitive - abstract action mapping (blueprint §17 / TR-002 core)
 *
 * Cross-environment transfer fails at the LITERAL action layer (terminal's
 * writeFile and harmonyos's hdc-install share no type string). The abstract
 * layer names the INTENT: write / install / run / observe / remove / verify.
 * World-model beliefs replay through this map, so knowledge earned in one
 * environment can inform another — while the map itself stays explicit and
 * auditable (no silent fuzzy matching).
 */
export type AbstractAction = 'observe' | 'read' | 'write' | 'edit' | 'run' | 'install' | 'launch' | 'remove' | 'query' | 'navigate' | 'interact';

/** explicit, auditable literal→abstract edges. Extend deliberately. */
export const ABSTRACT_ACTION_MAP: Record<string, AbstractAction> = {
  // terminal environment
  'command': 'run',
  'writeFile': 'write',
  'deleteFile': 'remove',
  // agent tools (trajectory steps use tool names)
  'read_file': 'read',
  'write_file': 'write',
  'edit_file': 'edit',
  'run_command': 'run',
  'list_dir': 'observe',
  'web_fetch': 'query',
  'web_search': 'query',
  'browser_open': 'navigate',
  'desktop_click': 'interact',
  'desktop_type': 'interact',
  'desktop_screenshot': 'observe',
  // harmonyos environment
  'hdc-shell': 'run',
  'hdc-install': 'install',
  'hdc-aa-start': 'launch',
  // arc-agi-3 environment (all seven actions are game interactions;
  // ACTION6 is the coordinate variant of the same intent)
  'ACTION1': 'interact', 'ACTION2': 'interact', 'ACTION3': 'interact',
  'ACTION4': 'interact', 'ACTION5': 'interact', 'ACTION6': 'interact',
  'ACTION7': 'interact',
};

export function abstractOf(actionType: string): AbstractAction | undefined {
  return ABSTRACT_ACTION_MAP[actionType];
}

/** both sides map to the same abstract intent? */
export function abstractlyOverlaps(a: string, b: string): boolean {
  const aa = abstractOf(a);
  const ab = abstractOf(b);
  return aa !== undefined && aa === ab;
}
