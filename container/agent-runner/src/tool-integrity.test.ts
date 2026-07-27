import { describe, it, expect } from 'bun:test';

import { isUntrustedToolOutput, untrustedToolMarker } from './tool-integrity.js';

describe('isUntrustedToolOutput', () => {
  it('marks built-in web fetchers untrusted', () => {
    expect(isUntrustedToolOutput('WebFetch')).toBe(true);
    expect(isUntrustedToolOutput('WebSearch')).toBe(true);
  });

  it('marks external MCP server tools untrusted', () => {
    expect(isUntrustedToolOutput('mcp__gmail__search')).toBe(true);
    expect(isUntrustedToolOutput('mcp__google-calendar__list_events')).toBe(true);
    expect(isUntrustedToolOutput('mcp__whatever__anything')).toBe(true);
  });

  it('does NOT mark the internal nanoclaw MCP tools', () => {
    expect(isUntrustedToolOutput('mcp__nanoclaw__ask_user_question')).toBe(false);
    expect(isUntrustedToolOutput('mcp__nanoclaw__send_message')).toBe(false);
  });

  it('does NOT mark local workspace tools', () => {
    for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'TodoWrite', 'Skill']) {
      expect(isUntrustedToolOutput(t)).toBe(false);
    }
  });

  it('handles empty / missing tool name', () => {
    expect(isUntrustedToolOutput('')).toBe(false);
  });
});

describe('untrustedToolMarker', () => {
  it('is a labelled integrity block naming the source, framed as data', () => {
    const m = untrustedToolMarker('mcp__gmail__search');
    expect(m).toContain('value="untrusted"');
    expect(m).toContain('source="mcp__gmail__search"');
    expect(m.toLowerCase()).toContain('data only');
    expect(m).toContain('</integrity>');
  });

  it('sanitizes the source name (no attribute breakout)', () => {
    const m = untrustedToolMarker('evil"><script>');
    expect(m).not.toContain('<script>');
    expect(m).not.toContain('"><');
    expect(m).toContain('source="evil___script_"');
  });
});
