/**
 * @hmharness/kernel - shell fast-path gate
 *
 * One shared implementation for every "run this without an approval card"
 * decision over remotely/exec-ed shell strings (the agent's ssh_run tool and
 * the web /api/ssh proxy). String allowlists are bypassable in general -
 * documented bypass classes include command substitution `$()`/backticks
 * (cli-mcp-server 0.2.5, CVE-2026-28470), `&&`-blind-spots (Claude Code),
 * and argument-level execution such as `find -exec`/`-delete`
 * (GHSA-cv3g-hj65-pcfh). The design here closes all of them at once:
 *
 *   fast path = ONE bare read-only verb + plain arguments + ZERO shell
 *   metacharacters anywhere (no $ ` ( ) { } < > | ; & \ quotes/newlines)
 *   and no verb whose own ARGUMENTS can execute or mutate (find, echo,
 *   xargs, awk, date -s are excluded outright).
 *
 * Everything else returns false - i.e. needs an approval card. Fail closed:
 * an unknown or oddly-shaped command is never a fast path.
 */

/** Metacharacters that enable substitution, chaining, or redirection. */
const SHELL_METACHARS = /[$`(){}<>|;&'"\\\n\r]/

/** Verbs safe to run with plain arguments only (read-only, no exec-in-args). */
const BARE_PROBE_VERBS =
  /^(ls|cat|head|tail|df|du|free|uptime|whoami|hostname|uname|ps|grep|wc|id|pwd|date)(\s+[A-Za-z0-9_.:@/=,-]+)*\s*$/

/**
 * True only for a bare read-only probe (e.g. `df -h`, `ps aux`, `cat /etc/hosts`).
 * Callers: `if (!isBareProbe(cmd)) → approval required`.
 */
export function isBareProbe(cmd: string): boolean {
  if (!cmd || SHELL_METACHARS.test(cmd)) return false
  if (/\bdate\b/.test(cmd) && /\s--?s(e[rt])?\b/.test(cmd)) return false // clock set
  return BARE_PROBE_VERBS.test(cmd)
}
