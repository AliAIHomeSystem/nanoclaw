/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  if (ctx.hostEnv.OPENCODE_SMALL_MODEL) env.OPENCODE_SMALL_MODEL = ctx.hostEnv.OPENCODE_SMALL_MODEL;

  // Model selection is PER-AGENT: the group's `model` (e.g.
  // `openrouter/z-ai/glm-5.2`, `openrouter/deepseek/deepseek-v4-pro`,
  // `ollama/qwen3:14b`) wins; the global OPENCODE_* env is only a fallback for
  // agents with no explicit model. The provider is the model's first segment,
  // and its endpoint is looked up below.
  const model = ctx.model || ctx.hostEnv.OPENCODE_MODEL;
  const KNOWN_ENDPOINTS: Record<string, string> = {
    ollama: 'http://ollama-span-proxy:11434/v1', // local, on the egress net
    openrouter: 'https://openrouter.ai/api/v1', // external, via OneCLI
  };
  // OpenRouter load-balances each model across many upstream hosts, and prompt
  // caches live on the individual host — every reroute reprocesses the whole
  // context at full input price (measured 2026-08-08: 90%+ of all fresh input
  // tokens were on reroute cache misses). Pin routing for models where the slug
  // is verified to serve the model AND has the best cache-read price; leave the
  // rest on default routing rather than guess — a slug that doesn't serve the
  // model would silently change nothing, and the author slug often doesn't
  // (z-ai does not serve glm-5.2). Slugs per
  // https://openrouter.ai/api/v1/models/<model>/endpoints.
  // Chosen per model from the endpoints listing (cache-read price x uptime x
  // quantization), 2026-08-08. A bare slug cannot disambiguate a provider's
  // variants, so only single-variant providers are pinned (kimi-k3 avoids
  // `morph`, whose second variant `morph/fast` is 2.4x the price at 0% uptime).
  const UPSTREAM_ORDER: Record<string, string> = {
    'openrouter/deepseek/deepseek-v4-pro': 'deepseek',
    'openrouter/deepseek/deepseek-v4-pro-0813': 'deepseek', // dated pin of the same snapshot the floating tag is cutting over to
    'openrouter/deepseek/deepseek-v4-flash-0731': 'deepseek',
    'openrouter/z-ai/glm-5.2': 'baidu', // fp8, 100% up, cheaper than headline (0.41 vs 0.72)
    'openrouter/moonshotai/kimi-k3': 'digitalocean', // single-variant; morph is ambiguous
    'openrouter/moonshotai/kimi-k2.5': 'streamlake', // only fp8 endpoint at the cheap tier (rest are int4/fp4)
    'openrouter/minimax/minimax-m3': 'gmicloud', // fp8, 1M ctx, cheapest prompt AND cache
    'openrouter/tencent/hy3': 'tencent', // the author, fp8, 99.9% up, price parity
    'openrouter/anthropic/claude-sonnet-5': 'anthropic', // the author, single-variant, price parity
    'openrouter/openai/gpt-5.6-sol': 'azure', // price-identical to the author; author slug is ambiguous (flex/priority variants at 0.5x/2x)
  };
  if (model) {
    const provider = model.includes('/') ? model.split('/')[0] : ctx.hostEnv.OPENCODE_PROVIDER || 'anthropic';
    env.OPENCODE_PROVIDER = provider;
    env.OPENCODE_MODEL = model;
    if (UPSTREAM_ORDER[model]) env.OPENCODE_UPSTREAM_ORDER = UPSTREAM_ORDER[model];
    if (provider !== 'anthropic') {
      const baseUrl = KNOWN_ENDPOINTS[provider] || ctx.hostEnv.OPENCODE_BASE_URL;
      if (baseUrl) {
        // The agent-runner reads the provider baseURL from ANTHROPIC_BASE_URL.
        env.ANTHROPIC_BASE_URL = baseUrl;
        // LOCAL (http://) endpoints bypass the OneCLI proxy to reach the egress
        // net directly; EXTERNAL (https://) ones go THROUGH it so OneCLI injects
        // the API key and handles egress.
        if (baseUrl.startsWith('http://')) {
          let host = baseUrl;
          try {
            host = new URL(baseUrl).hostname;
          } catch {
            /* leave as-is if not a full URL */
          }
          env.NO_PROXY = mergeNoProxy(env.NO_PROXY, host);
          env.no_proxy = mergeNoProxy(env.no_proxy, host);
        }
      }
    }
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
