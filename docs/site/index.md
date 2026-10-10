---
layout: home

hero:
  name: claude-code-ui
  text: Claude Code in your browser
  tagline: Run, watch and steer many Claude Code sessions from your browser or phone. Everything runs on your own machine.
  actions:
    - theme: brand
      text: Install in 30 seconds
      link: /guide/install
    - theme: alt
      text: A quick tour
      link: /guide/tour
    - theme: alt
      text: GitHub
      link: https://github.com/cuonghuunguyen/claude-code-ui

features:
  - title: Many sessions, one screen
    details: Sessions in tabs, grouped by project. They keep running when you close the browser.
  - title: Same rules as Claude Code
    details: Same permission prompts, modes, models, slash commands, skills and /rewind.
  - title: Answer from anywhere
    details: The Focus page and push notifications show what needs you, across all projects.
  - title: A small IDE around it
    details: File tree and editor, diffs, a git graph and a real terminal next to the chat.
  - title: Your phone too
    details: Open it over Tailscale and install it as an app on Android or iOS.
  - title: Private
    details: No cloud, no relay, no telemetry. Your code and chats stay on your machine.
---

## 30-second install

You need Node.js 22+ and Claude Code logged in (`claude login`).

```sh
npx claude-code-ui
```

It prints a link and a QR code. Open the link. Done. [More details](/guide/install).

<img class="only-light" src="/screenshots/workspace-light.png" alt="claude-code-ui: projects and sessions on the left, a session in the middle, the changes panel on the right">
<img class="only-dark" src="/screenshots/workspace-dark.png" alt="claude-code-ui in dark mode">

::: info Unofficial
claude-code-ui is a community project. It is not made by or affiliated with Anthropic.
:::
