'use strict';
// board-defaults.cjs — config defaults for BOARD deployments.
//
// 2026-10-29 device incident: a restricted-network board inherited the
// internet tunnel's all-night retry storm because `web.tunnel` was simply
// ABSENT from its config (the server treats absent as "maybe on"). Board
// installs are overwhelmingly intranet — an absent web.tunnel is therefore
// written as `false` at install time. An EXPLICIT value (true or false) is
// the user's decision and is NEVER overwritten; the operation is idempotent.
//
// Pure functions only, zero deps. Shared by the twin installers
// (scripts/install-kaihongos.cjs and packages/cli/board/install-kaihongos.cjs);
// unit-tested from scripts/__tests__/board-defaults.test.cjs.

/** Pure: return the config with board defaults filled in WHERE (and only
 *  where) the key is absent. Returns the SAME object when nothing changes
 *  (explicit value), a NEW object otherwise — the input is never mutated. */
function withBoardDefaults(cfg) {
  if (typeof cfg !== 'object' || cfg === null) return cfg;
  const web = cfg.web;
  if (typeof web === 'object' && web !== null && Object.prototype.hasOwnProperty.call(web, 'tunnel')) {
    return cfg; // explicit true/false — the user's decision, never overwrite
  }
  const kept = typeof web === 'object' && web !== null ? web : {};
  return Object.assign({}, cfg, { web: Object.assign({}, kept, { tunnel: false }) });
}

/** Apply withBoardDefaults() to the config file at `configPath`. Returns:
 *  - 'written'    default injected (web.tunnel was absent)
 *  - 'explicit'   web.tunnel already had a user value — kept as-is
 *  - 'missing'    no config file yet — nothing to do (hmh init creates it)
 *  - 'corrupt'    unparseable JSON — NEVER touched (a destroyed config is
 *                 worse than a missing default)
 *  - 'write-error' the injection could not be persisted (read-only fs etc.) */
function ensureBoardDefaults(configPath) {
  const fs = require('fs');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return 'missing';
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (_) {
    return 'corrupt';
  }
  if (typeof cfg !== 'object' || cfg === null) return 'corrupt';
  const next = withBoardDefaults(cfg);
  if (next === cfg) return 'explicit';
  try {
    // same format the kernel's patchConfig() writes — no gratuitous churn
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
    return 'written';
  } catch (_) {
    return 'write-error';
  }
}

module.exports = { withBoardDefaults, ensureBoardDefaults };
