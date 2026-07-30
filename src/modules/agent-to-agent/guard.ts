/**
 * Agent-to-agent guard adapter — the module's catalog entries, composed at
 * the module edge (imported by ./index.ts).
 *
 * agents.create — by cli_scope: `global` scope (trusted owner agent groups)
 * creates directly; everything else — the default `group` scope, and
 * unknown/missing config, fail-closed — is DENIED. Confined agents must not
 * self-create; new agents are commissioned through Forge → Gate 2 (the
 * dedicated gate bot / executor path), keeping creation authority off the
 * chat/LLM path. (Site policy: previously group scope HELD for owner approval;
 * tightened to DENY so the gate-bot commissioning path is the only route.)
 *
 * a2a.send — the decision moved verbatim out of routeAgentMessage, in its
 * original check order: a missing destination row denies; a missing target
 * group denies; self-sends allow without a destination row; an
 * agent_message_policies row for the (from, to) pair holds for the row's
 * named approver. The ghost-policy edge (policy row with no destination row)
 * denies — the destination check precedes the policy check, exactly today's
 * outcome. Policy rows can only tighten (hold), never allow: absence of a
 * row falls through to the structural checks.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { hasDestination } from './db/agent-destinations.js';
import { getMessagePolicy } from './db/agent-message-policies.js';

/**
 * pending_approvals action string for held a2a messages. Lives here (not in
 * agent-route.ts) so agent-route can import this adapter — loading the
 * consult site guarantees its catalog entry is registered — without a cycle.
 */
export const A2A_MESSAGE_GATE_ACTION = 'a2a_message_gate';

export const agentsCreate = defineGuardedAction({
  action: 'agents.create',
  grantActionName: 'create_agent',
  // Bind a create_agent grant to the name that was approved.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_agent is a container-originated action.');
    const cliScope = getContainerConfig(input.actor.agentGroupId)?.cli_scope ?? 'group';
    if (cliScope === 'global') {
      // Trusted owner agent group — an approval tap on every sub-agent spawn
      // would be needless friction.
      return ALLOW('trusted global-scope agent group');
    }
    // Confined (default `group` scope) — and any unknown config value,
    // fail-closed — may NOT self-create. New agents are commissioned through
    // Forge → Gate 2 (approval on the dedicated gate bot, creation via the
    // executor), never the native tool on the chat/LLM path.
    return DENY(
      'agent-initiated create_agent is disabled for confined (group-scope) agents — ' +
        'request the new agent through Forge (the Architect), which builds it via Gate 2.',
    );
  },
});

export const a2aSend = defineGuardedAction({
  action: 'a2a.send',
  grantActionName: A2A_MESSAGE_GATE_ACTION,
  // Bind an a2a grant to the exact held message target.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { platform_id?: string }).platform_id === input.resource?.to;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('agent-to-agent send requires an agent actor');
    const from = input.actor.agentGroupId;
    const to = input.resource?.to ?? '';
    const isSelf = to === from;
    if (!isSelf && !hasDestination(from, 'agent', to)) {
      return DENY(`unauthorized agent-to-agent: ${from} has no destination for ${to}`);
    }
    if (!getAgentGroup(to)) {
      return DENY(`target agent group ${to} not found for message ${String(input.payload.id)}`);
    }
    if (isSelf) return ALLOW('self-send');
    const policy = getMessagePolicy(from, to);
    if (policy) {
      return HOLD(`a2a message policy ${from}→${to} holds for ${policy.approver}`, policy.approver);
    }
    return ALLOW('destination grant exists');
  },
});
