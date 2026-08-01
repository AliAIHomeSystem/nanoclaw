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
  for (const key of ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  // Local-model providers (e.g. ollama): the agent-runner reads the provider
  // baseURL from ANTHROPIC_BASE_URL, and the call must bypass the OneCLI HTTPS
  // proxy (which only fronts external APIs). Point ANTHROPIC_BASE_URL at the
  // configured local endpoint and add its host to NO_PROXY so it's reached
  // directly on the egress network. Set OPENCODE_BASE_URL to enable.
  const provider = ctx.hostEnv.OPENCODE_PROVIDER || 'anthropic';
  const localBaseUrl = ctx.hostEnv.OPENCODE_BASE_URL;
  if (provider !== 'anthropic' && localBaseUrl) {
    env.ANTHROPIC_BASE_URL = localBaseUrl;
    let host = localBaseUrl;
    try {
      host = new URL(localBaseUrl).hostname;
    } catch {
      /* leave as-is if not a full URL */
    }
    env.NO_PROXY = mergeNoProxy(env.NO_PROXY, host);
    env.no_proxy = mergeNoProxy(env.no_proxy, host);
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
