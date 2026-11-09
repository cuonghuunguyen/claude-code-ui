# Subscription login only, no API key

The daemon authenticates with the owner's Claude subscription login (the credentials of `claude login`), not an API key. The SDK overview says "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products". We read this as targeting products offered to other users; claude-ui is a personal, single-user tool running on the owner's machine with the owner's subscription. This is a judgement, not a confirmed permission; revisit if Anthropic clarifies personal use or if the tool is ever shared.

claude-ui implements no OAuth flow and never shows or handles the login URL, code or tokens. Logging in (GH-615) runs the official CLI, `claude auth login` of the SDK's bundled binary, in a terminal: the user answers the CLI's own prompts, and the daemon only notices the exit code. This keeps the product from offering claude.ai login itself; the judgement above still covers using the subscription credentials through the SDK.

Token accounts (GH-615): the user creates a token with the official `claude setup-token` and pastes it; claude-ui only passes it as the documented `CLAUDE_CODE_OAUTH_TOKEN` env var of its CLI processes. The switch between accounts is always a manual choice, never automatic. Whether several subscriptions of one person may be used this way under Anthropic's terms is not verified; it is the owner's judgement, as above.

## Amendment: applies to the Claude Engine only

This ADR covers the Claude Engine. For the OpenCode Engine the daemon relays provider login (API key and OAuth) and logout to the OpenCode server, which stores the credentials in its own auth store; the daemon never writes them to its own files. Reason: OpenCode's providers are the user's own accounts with their own terms, and without a login screen the OpenCode Engine would be unusable from the browser. The Anthropic terms judgement above is not extended to other providers.
