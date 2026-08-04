import { describe, it, expect } from 'bun:test';

import { isTransientUpstreamError } from './opencode.js';

describe('isTransientUpstreamError', () => {
  it('retries the aggregator stalls that arrive as in-stream errors', () => {
    // The shape actually observed: HTTP 200 on the wire, the failure reported
    // as a session.error payload, delivered to the user as the agent's answer.
    for (const msg of [
      '{"code":504,"message":"Upstream idle timeout exceeded"}',
      'upstream error',
      '{"code":502,"message":"Bad gateway"}',
      '{"code":503,"message":"Service temporarily unavailable"}',
      'Provider returned error: model is overloaded',
      'socket hang up',
      'read ECONNRESET',
    ]) {
      expect(isTransientUpstreamError(msg)).toBe(true);
    }
  });

  it('fails fast on refusals and bad requests', () => {
    for (const msg of [
      'I cannot help with that request.',
      '{"code":400,"message":"Invalid request: messages must not be empty"}',
      '{"code":401,"message":"Unauthorized"}',
      'Model not found: z-ai/glm-5.2',
      'context length exceeded',
    ]) {
      expect(isTransientUpstreamError(msg)).toBe(false);
    }
  });

  it('does not match a status code embedded in a larger number', () => {
    // Guards the \b anchors: the haystack is usually JSON.stringify(error),
    // where token counts and trace ids routinely contain 502/503/504.
    expect(isTransientUpstreamError('{"code":400,"tokens_in":1502}')).toBe(false);
    expect(isTransientUpstreamError('{"code":400,"trace":"a504f"}')).toBe(false);
  });
});
