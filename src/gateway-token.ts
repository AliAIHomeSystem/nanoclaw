/**
 * Per-agent gateway token — the identity half of the n8n gate auth check
 * (design: "proves WHO is calling"; the registry-grant check in n8n's `auth`
 * sub-workflow proves AUTHORITY). Reconciles the design's NanoClaw-signed-JWT
 * auth module against NanoClaw v2's actual capabilities: v2 has no JWT signing
 * or agent-identity token for outbound calls (it uses OneCLI for external
 * credential injection instead), so this fills that specific gap with a
 * minimal HMAC-signed token rather than full JWT infrastructure.
 *
 * Format: `<payload-base64url>.<hmac-hex>` where payload is
 * `{ sub: agentGroupId, folder, containerName, iat, exp }`. Signed with
 * GATEWAY_SIGNING_SECRET, held by this host process and by the n8n gateway's
 * env — never by an agent container, so a container cannot mint a token for
 * a different agent group.
 */
import crypto from 'crypto';

import { GATEWAY_SIGNING_SECRET } from './config.js';
import { log } from './log.js';

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h; re-minted on every container spawn anyway

export interface GatewayTokenPayload {
  sub: string; // agent_group_id
  folder: string; // agent group folder (registry grant lookup key)
  containerName: string;
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Mint a signed gateway token for one agent group's spawned container. Returns '' if no signing secret is configured (gateway calls disabled, not broken — same pattern as EGRESS_LOCKDOWN). */
export function mintGatewayToken(agentGroupId: string, folder: string, containerName: string): string {
  if (!GATEWAY_SIGNING_SECRET) {
    log.warn('GATEWAY_SIGNING_SECRET not set — spawning without a gateway token', { agentGroupId });
    return '';
  }
  const now = Math.floor(Date.now() / 1000);
  const payload: GatewayTokenPayload = {
    sub: agentGroupId,
    folder,
    containerName,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', GATEWAY_SIGNING_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}
