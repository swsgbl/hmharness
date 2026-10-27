'use strict';

/**
 * Release policy for a version that is already present on npm.
 * A package may be skipped automatically only after a byte-for-byte
 * registry tarball comparison succeeded. An explicit force flag is a
 * deliberate, auditable escape hatch, never an implicit success.
 */
function registrySkipDecision(comparison, forceSkipCheck = false) {
  if (comparison && comparison.ok === true && comparison.verified === true) {
    return { skip: true, verified: true, reason: 'registry tarball content matched exactly' };
  }
  const reason = (comparison && typeof comparison.reason === 'string' && comparison.reason.trim())
    || (comparison && Array.isArray(comparison.diffs) && comparison.diffs.length
      ? 'published tarball differs from local source'
      : 'registry content comparison was not verified');
  if (forceSkipCheck) return { skip: true, verified: false, reason };
  return { skip: false, verified: false, reason };
}

module.exports = { registrySkipDecision };
