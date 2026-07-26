/**
 * Integrity labelling of inbound content (platform standard: "labels are set by
 * tools and gateway only — never by the model"). The host router is the gateway:
 * it stamps every message with a provenance label BEFORE it reaches the untrusted
 * container, so the agent-runner renders trust rather than deciding it.
 *
 * - `trusted`  — a channel message from a controller of this agent group (owner
 *                or admin). The authoritative instruction channel.
 * - `untrusted`— a channel message from a non-controller (a registered member,
 *                i.e. another human whose words are input, not commands), or an
 *                external `webhook` event. Prompt-injection surface: the agent is
 *                instructed to treat it as data, not instructions.
 * - `internal` — platform-originated content (scheduled `task` runs, `system`
 *                responses, agent-to-agent). Not human input at all.
 *
 * Tool outputs (web fetch / Gmail / MCP servers) are the other half of this
 * standard and are labelled at the tool mediation layer, not here.
 */
export type Integrity = 'trusted' | 'untrusted' | 'internal';

/** Reasons from canAccessAgentGroup that denote a controller (may issue instructions). */
const CONTROLLER_REASONS = new Set(['owner', 'global_admin', 'admin_of_group']);

export function isControllerReason(reason: string | null | undefined): boolean {
  return reason != null && CONTROLLER_REASONS.has(reason);
}

/**
 * Resolve the integrity label for one inbound message. Pure so it is trivially
 * testable; the router supplies `senderIsController` from canAccessAgentGroup.
 */
export function resolveIntegrity(kind: string, senderIsController: boolean): Integrity {
  switch (kind) {
    case 'chat':
    case 'chat-sdk':
      return senderIsController ? 'trusted' : 'untrusted';
    case 'webhook':
      return 'untrusted';
    case 'task':
    case 'system':
      return 'internal';
    default:
      // Agent-to-agent and any future platform-originated kind: internal by
      // default. A new HUMAN-input kind must opt into untrusted explicitly.
      return 'internal';
  }
}

/**
 * Stamp a message's content JSON with its integrity label under `_integrity`
 * (underscore = gateway-set metadata the formatter reads but never echoes).
 * Robust to non-JSON content: wraps it as `{ text, _integrity }`.
 */
export function stampIntegrity(content: string, integrity: Integrity): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return JSON.stringify({ text: content, _integrity: integrity });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return JSON.stringify({ value: parsed, _integrity: integrity });
  }
  return JSON.stringify({ ...(parsed as Record<string, unknown>), _integrity: integrity });
}
