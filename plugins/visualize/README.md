# visualize

Skill `visualize` for claude-ui: Claude answers with a ```` ```visualize ```` fence holding a self-contained HTML fragment, and claude-ui draws it inline in a sandboxed frame (no access to the app, files or network except script CDNs). claude-ui loads this plugin itself when Settings › Chat › Inline visualizations is on; it needs no install. Its `SessionStart` hook puts the skill into the session's context at start, because a listed skill alone is rarely invoked for an explanation.
