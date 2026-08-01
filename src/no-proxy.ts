/**
 * NO_PROXY list merging.
 *
 * Several places need to add a host to an existing NO_PROXY value without
 * dropping what is already there (the host's own setting, a provider's
 * contribution, the gateway bypass). Splitting on both commas and whitespace
 * tolerates the shapes that show up in practice — `a,b`, `a, b`, `a b`.
 *
 * Kept deliberately separate from the opencode provider's private copy: that
 * file is installed from the `providers` branch by /add-opencode and would be
 * overwritten on re-install, so trunk must not depend on it.
 */
export function mergeNoProxy(current: string | undefined, additions: string): string {
  const parts = new Set<string>();
  for (const source of [current ?? '', additions]) {
    for (const entry of source.split(/[\s,]+/)) {
      const trimmed = entry.trim();
      if (trimmed) parts.add(trimmed);
    }
  }
  return [...parts].join(',');
}
