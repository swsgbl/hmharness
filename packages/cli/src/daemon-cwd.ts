/**
 * @hmharness/cli - working directory for detached daemons
 *
 * A process holds its working directory for as long as it lives, and on Windows
 * that handle locks the directory against rename and delete. A daemon started
 * from inside the installed package (a launcher that cd's there first) therefore
 * blocked the next `npm i -g` with EBUSY until it was killed (seen on the
 * v0.23.53 upgrade, 2026-11-26). No daemon needs that directory: HMH_HOME is
 * theirs and is never replaced.
 *
 * The caller's directory is otherwise kept on purpose. The web daemon seeds its
 * first workspace from the directory it was started in (web/server.ts), and
 * relative paths resolve against it - so only the one harmful case is swapped out.
 */
import { dirname, resolve, sep } from 'node:path';
import { homeDir } from '@hmharness/kernel';

/** The package an entry point is installed in: <package>/dist/main.js -> <package>. */
export function packageRootOf(entry: string): string {
  return dirname(dirname(resolve(entry)));
}

/** Is `path` the directory `dir` itself or somewhere below it? (Case-insensitive on Windows.) */
export function isInside(dir: string, path: string): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const a = fold(dir);
  const b = fold(path);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** The directory a daemon is spawned with: the caller's, unless that is the
 *  installed package (then HMH_HOME). `entry` is the CLI's own entry path. */
export function daemonCwd(origin: string, entry: string): string {
  return isInside(packageRootOf(entry), origin) ? homeDir() : origin;
}
