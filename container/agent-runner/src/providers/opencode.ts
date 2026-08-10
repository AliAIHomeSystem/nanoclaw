import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { recordUsage } from '../db/connection.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/**
 * Transient upstream failures worth retrying rather than surfacing as the turn's
 * answer. Aggregators report an upstream stall as an in-stream error with HTTP
 * 200, so these never appear as a 5xx anywhere local — the only evidence is this
 * message. Deliberately narrow: a genuine model refusal or a bad request must
 * still fail fast rather than be retried three times.
 *
 * The status codes are \b-anchored because the haystack is often
 * `JSON.stringify(error)` — an unanchored `502` also matches a token count of
 * 1502 or a trace id ending in 504, which would retry a hard failure twice.
 */
const TRANSIENT_UPSTREAM_RE =
  /upstream idle timeout|upstream error|\b(?:502|503|504)\b|overloaded|temporarily unavailable|timeout|ECONNRESET|socket hang up/i;
const MAX_UPSTREAM_RETRIES = 2;

/** Exported for test: pins which session errors are retried in place. */
export function isTransientUpstreamError(message: string): boolean {
  return TRANSIENT_UPSTREAM_RE.test(message);
}

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  // Cost metadata ($ per MILLION tokens) for models OpenCode's bundled models.dev
  // catalog does not know. A model we declare here merges with the catalog entry
  // when one exists (kimi-k2.5 gets priced that way); when none exists, a
  // declaration without `cost` makes OpenCode report cost 0 for every call —
  // which silently blanks per-step cost reporting and the telemetry spend column.
  // That is exactly what happened with deepseek-v4-pro. Prices from
  // https://openrouter.ai/api/v1/models, checked 2026-08-06.
  // All entries priced at the endpoint OPENCODE_UPSTREAM_ORDER pins the model
  // to (src/providers/opencode.ts on the host), not OpenRouter's headline
  // cheapest-endpoint rate — pinned-endpoint rates are what actually bills.
  // glm-5.2 was the second catalog-unknown model found reporting cost 0.
  const MODEL_COSTS: Record<string, { input: number; output: number; cache_read?: number }> = {
    'deepseek/deepseek-v4-pro': { input: 0.435, output: 0.87, cache_read: 0.003625 },
    'deepseek/deepseek-v4-flash-0731': { input: 0.14, output: 0.28, cache_read: 0.0028 },
    'z-ai/glm-5.2': { input: 0.406, output: 1.276, cache_read: 0.0754 },
    'moonshotai/kimi-k3': { input: 2.85, output: 14.25, cache_read: 0.285 },
    'moonshotai/kimi-k2.5': { input: 0.54, output: 2.7, cache_read: 0.09 },
    'minimax/minimax-m3': { input: 0.24, output: 0.96, cache_read: 0.048 },
    'tencent/hy3': { input: 0.132, output: 0.528, cache_read: 0.033 },
    'anthropic/claude-sonnet-5': { input: 2.0, output: 10.0, cache_read: 0.2 },
  };

  // Upstream routing pin, host-set only for verified openrouter models
  // (src/providers/opencode.ts). extraBody merges into every request body
  // (@openrouter/ai-sdk-provider settings.extraBody). No allow_fallbacks:false —
  // an upstream outage should degrade to a cache miss on another host, not a
  // failed call.
  const upstreamOrder = (process.env.OPENCODE_UPSTREAM_ORDER || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: {
              apiKey: 'placeholder',
              baseURL: proxyUrl,
              ...(upstreamOrder.length > 0 ? { extraBody: { provider: { order: upstreamOrder } } } : {}),
            },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [
                      mid,
                      {
                        id: mid,
                        name: mid,
                        tool_call: true,
                        ...(MODEL_COSTS[mid as string] ? { cost: MODEL_COSTS[mid as string] } : {}),
                      },
                    ]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  /** Base URL of the opencode server. The v1 client this provider uses has no
   *  question.* methods (they exist only on the v2 client), so the question
   *  endpoints are reached by raw fetch against this. */
  baseUrl: string;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      baseUrl: url,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {
    // No-op by design. The memory session hook is a Claude Code CLI mechanism
    // (injected into ~/.claude settings.json as a SessionStart hook). OpenCode
    // does not read Claude Code settings hooks — it loads shared base + per-group
    // fragments + per-group memory through its own native `instructions` pipeline
    // (see buildConfig: /app/CLAUDE.md, .claude-fragments/*.md, CLAUDE.local.md).
    // Accept and ignore the registration for AgentProvider interface conformance.
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream, baseUrl } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let upstreamRetries = 0;
        // Set when the model tries to ask an interactive question (see below).
        let questionText = '';
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as
                  | {
                      id?: string;
                      role?: string;
                      modelID?: string;
                      providerID?: string;
                      cost?: number;
                      tokens?: {
                        input?: number;
                        output?: number;
                        reasoning?: number;
                        cache?: { read?: number; write?: number };
                      };
                    }
                  | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                // Assistant messages carry exact token counts and cost. Record
                // them: this is the only place the platform can see real spend
                // per agent — the credential proxy in front of the provider logs
                // request metadata but never parses response bodies, so without
                // this there is no cost attribution at all. Best-effort by
                // design; accounting must never break a reply.
                if (info?.id && info.role === 'assistant' && info.tokens) {
                  try {
                    const cache = (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0);
                    recordUsage({
                      messageId: info.id,
                      model: info.providerID ? `${info.providerID}/${info.modelID ?? ''}` : info.modelID,
                      tokensIn: info.tokens.input,
                      // Reasoning tokens are billed as output; folding them in
                      // keeps this comparable to the provider's own invoice.
                      tokensOut: (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0),
                      tokensCache: cache,
                      cost: info.cost,
                    });
                  } catch (err) {
                    log(`usage record failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  const msg = sessionErrorMessage(props);
                  // Transient upstream failures are common on aggregators: the
                  // gateway returns HTTP 200 and reports the stall as an error
                  // event INSIDE the stream, so nothing local times out and no
                  // proxy log shows a 5xx. Previously any session.error ended the
                  // turn, and the raw error object was delivered to the user as
                  // the agent's answer — observed as
                  // "Error: {code:504, Upstream idle timeout exceeded}" after a
                  // successful render, losing the work that had already been done.
                  // Retry in place: the session still holds the conversation, so
                  // re-prompting resumes rather than restarting.
                  if (isTransientUpstreamError(msg) && upstreamRetries < MAX_UPSTREAM_RETRIES) {
                    upstreamRetries += 1;
                    const backoffMs = 2000 * upstreamRetries;
                    log(
                      `Transient upstream error (attempt ${upstreamRetries}/${MAX_UPSTREAM_RETRIES}), ` +
                        `retrying in ${backoffMs}ms: ${msg.slice(0, 160)}`,
                    );
                    yield { type: 'progress', message: `upstream stalled — retrying (${upstreamRetries})` };
                    await new Promise((r) => setTimeout(r, backoffMs));
                    const retryRes = await client.session.promptAsync({
                      path: { id: sessionId },
                      body: { parts: [{ type: 'text', text }] },
                    });
                    if (retryRes.error) {
                      self.activeSessionId = undefined;
                      throw new Error(`OpenCode promptAsync (retry): ${JSON.stringify(retryRes.error)}`);
                    }
                    lastEventAt = Date.now();
                    break;
                  }
                  self.activeSessionId = undefined;
                  throw new Error(msg);
                }
                break;
              }
              // OpenCode has an INTERACTIVE question mechanism built for its TUI: the
              // model calls it, the server publishes question.asked, and the model
              // blocks until something replies to /question/<id>/reply or /reject.
              //
              // Nothing here can reply. There is no human attached to this runtime —
              // the user is on Telegram, on the far side of two SQLite databases and a
              // poll loop. Unhandled, the failure is total and silent: the model waits,
              // the 5-minute idle timeout fires, the session is cleared and retried,
              // the retry blocks the same way, and the container spins in that loop
              // until it is killed. No output, no error, no timeout ever reaching the
              // user. Observed exactly once in the wild, on a persona whose own hard
              // rules tell it to "ask a single batch of clarifying questions".
              //
              // So: capture the questions as text, reject the request to unblock the
              // model, and let the questions be the turn's answer if it produces
              // nothing else. The user reads them in chat and replies normally — the
              // next message carries the answers. An interactive prompt becomes a
              // conversation, which is the only shape this transport has.
              case 'question.asked': {
                const q = ev.properties as {
                  id?: string;
                  questions?: Array<{ question?: string; options?: Array<{ label?: string; value?: string }> }>;
                };
                if (!q.id) break;
                const asked = (q.questions ?? []).map((qq, i) => {
                  const opts = (qq.options ?? [])
                    .map((o) => o.label ?? o.value)
                    .filter((o): o is string => Boolean(o));
                  return `${i + 1}. ${qq.question ?? ''}${opts.length ? `\n   (${opts.join(' / ')})` : ''}`;
                });
                if (asked.length) {
                  questionText = asked.join('\n');
                  log(`Interactive question intercepted (${asked.length}) — rejecting and surfacing to the user`);
                }
                try {
                  await fetch(`${baseUrl}/question/${encodeURIComponent(q.id)}/reject`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                  });
                } catch (err) {
                  log(`Failed to reject question: ${err instanceof Error ? err.message : String(err)}`);
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        // Questions are the fallback, not an override: if the model went on to say
        // something after being unblocked, that answer is the better reply.
        yield { type: 'result', text: resultText || questionText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
