import { describe, it, expect } from 'vitest';

import { resolveIntegrity, isControllerReason, stampIntegrity } from './integrity.js';

describe('resolveIntegrity', () => {
  it('labels controller chat trusted, non-controller chat untrusted', () => {
    expect(resolveIntegrity('chat', true)).toBe('trusted');
    expect(resolveIntegrity('chat', false)).toBe('untrusted');
    expect(resolveIntegrity('chat-sdk', true)).toBe('trusted');
    expect(resolveIntegrity('chat-sdk', false)).toBe('untrusted');
  });

  it('labels webhooks untrusted regardless of sender', () => {
    expect(resolveIntegrity('webhook', true)).toBe('untrusted');
    expect(resolveIntegrity('webhook', false)).toBe('untrusted');
  });

  it('labels platform-originated kinds internal', () => {
    expect(resolveIntegrity('task', false)).toBe('internal');
    expect(resolveIntegrity('system', false)).toBe('internal');
    expect(resolveIntegrity('agent_message', false)).toBe('internal');
    expect(resolveIntegrity('anything-unknown', true)).toBe('internal');
  });
});

describe('isControllerReason', () => {
  it('is true only for owner/admin reasons', () => {
    for (const r of ['owner', 'global_admin', 'admin_of_group']) expect(isControllerReason(r)).toBe(true);
    for (const r of ['member', 'not_member', 'unknown_user', null, undefined])
      expect(isControllerReason(r)).toBe(false);
  });
});

describe('stampIntegrity', () => {
  it('adds _integrity to a JSON object without disturbing other fields', () => {
    const out = JSON.parse(stampIntegrity(JSON.stringify({ text: 'hi', sender: 'Ali' }), 'trusted'));
    expect(out).toEqual({ text: 'hi', sender: 'Ali', _integrity: 'trusted' });
  });

  it('wraps non-JSON content as { text, _integrity }', () => {
    expect(JSON.parse(stampIntegrity('plain string', 'untrusted'))).toEqual({
      text: 'plain string',
      _integrity: 'untrusted',
    });
  });

  it('wraps non-object JSON (array/scalar) under value', () => {
    expect(JSON.parse(stampIntegrity('[1,2]', 'internal'))).toEqual({ value: [1, 2], _integrity: 'internal' });
    expect(JSON.parse(stampIntegrity('42', 'internal'))).toEqual({ value: 42, _integrity: 'internal' });
  });

  it('a later _integrity overrides an attacker-supplied one in the body', () => {
    // sender-controlled content can't forge its own trust: the gateway spread wins
    const out = JSON.parse(stampIntegrity(JSON.stringify({ text: 'x', _integrity: 'trusted' }), 'untrusted'));
    expect(out._integrity).toBe('untrusted');
  });
});
