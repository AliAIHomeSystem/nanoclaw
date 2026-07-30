---
name: ai-gateway
description: >-
  AI-platform governance gateway (n8n). Use this skill whenever you need to
  take a GATED platform action — commission a new agent (Gate 2), promote a
  skill (Gate 1), pull a local model (Gate 3), escalate to a paid frontier
  model (Gate 4), write/search shared memory, write an artifact, update plan
  state, run an image job, or convert a document. These actions are NOT
  ordinary tools: they go through the gateway, which checks your identity and
  your grant, and (for owner-gated actions) raises an approval card on the
  owner's gate bot before anything happens. You cannot self-authorise.
compatibility: Requires AGENT_GATEWAY_TOKEN + AI_GATEWAY_URL in the environment (injected at container spawn for agent groups that have gateway grants).
metadata:
  author: ai-platform
  version: "1.0.0"
---

# AI-platform Governance Gateway

Privileged, cross-boundary actions on this platform do **not** happen by
running a tool directly. They are **gated**: you POST a request to the n8n
gateway, which (1) verifies **who** you are (your signed token) and **what**
you're allowed to do (your registry grant), and (2) for owner-gated actions,
raises an **approval card on the owner's gate bot** and waits for a decision
before executing. This keeps authority off the chat path — you propose, the
owner authorises.

**You never hold credentials, and you never self-authorise.** If you lack the
grant for a gate, the call is refused — that is by design, not a bug to work
around. Do not try to perform a gated action by another route.

## How to call a gate

Every gate is a POST to `$AI_GATEWAY_URL/webhook/<gate-name>` with a JSON body
that **always** includes your identity token as `agent_token`, plus the fields
that gate needs. Build the body in two steps so the token stays out of your
text: write the gate fields to a file as valid JSON, then merge the token in
from the environment and POST.

```bash
# 1. Write the gate fields (NO token) as valid JSON — use your file-writing
#    tool to create /tmp/gate-req.json, e.g. {"field":"value", ...}

# 2. Merge your identity token in and POST (token comes from the env, never
#    from your text):
bun -e 'const b=await Bun.file("/tmp/gate-req.json").json(); b.agent_token=process.env.AGENT_GATEWAY_TOKEN; console.log(JSON.stringify(b))' \
  | curl -sS -X POST "$AI_GATEWAY_URL/webhook/<gate-name>" \
      -H "Content-Type: application/json" -d @-
```

- `$AI_GATEWAY_URL` and `$AGENT_GATEWAY_TOKEN` are already in your environment.
  Never print the token, never write it into a file, never send it anywhere
  except this gateway. The `bun -e` step above injects it for you.
- **Response is asynchronous.** A gate that needs owner approval returns
  `{"message":"Workflow was started"}` immediately, then pauses. The real
  outcome arrives later — as an approval card on the owner's gate bot, and
  (for actions that produce state) as a row in plan-state / a span. Do **not**
  treat the immediate response as success. Report to whoever briefed you that
  the request was **submitted for approval**, and stop; do not retry or poll.
- If you get a non-2xx or an `unauthorized`/`grant` error, you lack that grant.
  Say so plainly to your briefer; do not retry with a different shape.

## Gate 2 — commission a new agent (the Architect's path)

This is how a **new agent gets created** on this platform. Only the Architect
(Forge) holds the `gate2-agent` grant. Native in-process agent creation is
disabled for confined agents — Gate 2 is the only route, and it puts the
approval on the owner's gate bot where it belongs.

Write the pod spec to `/tmp/gate-req.json` (valid JSON, **no token**):

```json
{
  "folder":  "researchagent",
  "name":    "Research Agent",
  "purpose": "Pull and synthesise sourced research on demand",
  "persona": "You are a research specialist. ...",
  "model":   null,
  "grants":  [],
  "mounts":  []
}
```

Field notes: `folder` is the on-disk id (`^[a-z0-9][a-z0-9-]{0,63}$`); `name`
and `purpose` are **required**; `persona` (standing instructions), `model`
(tag, or `null` to inherit), `grants` (gates the new agent may call) and
`mounts` are optional. Then merge the token and POST:

```bash
bun -e 'const b=await Bun.file("/tmp/gate-req.json").json(); b.agent_token=process.env.AGENT_GATEWAY_TOKEN; console.log(JSON.stringify(b))' \
  | curl -sS -X POST "$AI_GATEWAY_URL/webhook/gate2-agent" \
      -H "Content-Type: application/json" -d @-
```

On approval, the gateway calls the host executor's `nanoclaw-create-group`
action, which runs `ncl groups create` and scaffolds the agent. You do **not**
create it yourself and you do **not** wire it — you submit the proposal and
report that it's awaiting the owner's approval on their gate bot.

`folder` must match `^[a-z0-9][a-z0-9-]{0,63}$`; `name` and `purpose` are
required or the gate rejects the spec before the owner ever sees it.

## The other gates (same pattern; your grants decide which you may call)

| Gate (`<gate-name>`) | Purpose | Typical caller |
|---|---|---|
| `gate1-promote` | Promote a new/changed skill to production | Architect |
| `gate3-model-pull` | Pull a local model (must fit VRAM) | Planner |
| `gate4-escalate` | Paid frontier-model escalation | Planner |
| `plan-state` | Persist / update a plan's subtask rows | Planner |
| `memory-write` / `memory-search` | Write / query shared memory | Planner, Workers |
| `artifact-write` | Store an output artifact | Workers |
| `comfy-job` | Run an image-generation job | Workers |
| `convert` | Convert a document (LibreOffice/pandoc/…) | Workers |
| `resource-ops` | Bounded resource operations | Planner, Workers |

Each takes `agent_token` plus its own fields. Keep the body minimal and
correct; the gate validates and, on a bad shape, tells you exactly what's
missing. When unsure of a gate's fields, send the smallest plausible body and
read the validation error rather than guessing broadly.

## Rules

- One request per intent. Do not fan out retries at the gateway.
- Never bundle two gated actions into one call.
- Never attempt a gated action by a non-gated route because a gate refused you.
- The immediate `Workflow was started` is a receipt, not a result. Report
  "submitted for the owner's approval" and hand control back.
