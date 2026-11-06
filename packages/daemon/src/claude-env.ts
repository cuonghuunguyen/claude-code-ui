// The env of every Claude CLI process of this daemon (GH-615): API keys stripped (ADR 0002), the Claude account applied.
// shortcut: module state, one per daemon process (tests that start several daemons in one process share it; each server sets it at start).
let token: string | null | undefined; // undefined = inherited (Default), null = CLI login, string = a token account

export function withoutApiKeys(env: NodeJS.ProcessEnv) {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

/** Default: undefined; CLI login: null (no CLAUDE_CODE_OAUTH_TOKEN); a token account: its token. */
export const setClaudeToken = (t: string | null | undefined) => void (token = t);

export function claudeEnv(env: NodeJS.ProcessEnv = process.env, t = token) {
  const e = withoutApiKeys(env);
  if (t === null) delete e.CLAUDE_CODE_OAUTH_TOKEN;
  else if (t) e.CLAUDE_CODE_OAUTH_TOKEN = t;
  return e;
}
