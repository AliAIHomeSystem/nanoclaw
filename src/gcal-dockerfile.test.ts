/**
 * Dependency guard for the Google Calendar MCP server (host/vitest tree).
 *
 * `@cocal/google-calendar-mcp` is a stdio CLI installed globally in the image,
 * not an imported module, so no behavior test can drive it and `tsc` never sees
 * it. The only in-tree footprint is the manifest entry, so the guard is
 * structural: assert the package is present and pinned to an exact version.
 *
 * NOTE — this deliberately differs from the version shipped in the skill, which
 * asserts a Dockerfile `ARG` + `pnpm install -g` line. The Dockerfile has since
 * moved global CLIs into `container/cli-tools.json`, precisely so a skill can
 * add one by json-merge rather than by editing the Dockerfile. Guarding the ARG
 * would test a mechanism this repo no longer uses, and would fail against a
 * correct install. The invariant that matters is unchanged: the tool is
 * installed, and it is pinned.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

type CliTool = { name: string; version: string; onlyBuilt?: boolean };

function cliTools(): CliTool[] {
  const p = path.resolve(process.cwd(), 'container/cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CliTool[];
}

describe('container/cli-tools.json installs @cocal/google-calendar-mcp', () => {
  const tools = cliTools();
  const calendar = tools.find((t) => t.name === '@cocal/google-calendar-mcp');

  it('lists the package', () => {
    expect(calendar, 'calendar MCP missing from cli-tools.json').toBeDefined();
  });

  it('pins it to an exact version', () => {
    // Exact only: a range would let the supply-chain policy be bypassed by a
    // future publish, which is the whole reason the manifest pins.
    expect(calendar?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('does not opt the package into running build scripts', () => {
    // A stdio MCP server has no native postinstall; onlyBuilt would be granting
    // arbitrary code execution at image-build time for no reason.
    expect(calendar?.onlyBuilt).toBeUndefined();
  });
});
