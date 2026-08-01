import { describe, expect, it } from 'vitest';

import { mergeNoProxy } from './no-proxy.js';

describe('mergeNoProxy', () => {
  it('returns the additions when there is no current value', () => {
    expect(mergeNoProxy(undefined, 'n8n')).toBe('n8n');
    expect(mergeNoProxy('', 'n8n')).toBe('n8n');
    expect(mergeNoProxy('   ', 'n8n')).toBe('n8n');
  });

  it('appends without dropping existing entries', () => {
    expect(mergeNoProxy('127.0.0.1,localhost', 'n8n')).toBe('127.0.0.1,localhost,n8n');
  });

  it('does not duplicate a host already present', () => {
    expect(mergeNoProxy('127.0.0.1,n8n', 'n8n')).toBe('127.0.0.1,n8n');
  });

  it('tolerates whitespace- and comma-separated shapes', () => {
    expect(mergeNoProxy('127.0.0.1, localhost', 'n8n')).toBe('127.0.0.1,localhost,n8n');
    expect(mergeNoProxy('127.0.0.1 localhost', 'n8n')).toBe('127.0.0.1,localhost,n8n');
  });

  it('accepts multiple additions at once', () => {
    expect(mergeNoProxy('localhost', 'n8n,ollama-span-proxy')).toBe('localhost,n8n,ollama-span-proxy');
  });
});
