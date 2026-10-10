import { defineConfig } from "vitepress";

const repo = "https://github.com/cuonghuunguyen/claude-code-ui";

export default defineConfig({
  title: "claude-code-ui",
  description: "Run, watch and steer Claude Code sessions from your browser or phone.",
  base: "/claude-code-ui/",
  lang: "en-US",
  cleanUrls: true,
  // Dead links fail the build (VitePress default); keep it that way.
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/claude-code-ui/icon.svg" }]],
  themeConfig: {
    logo: "/icon.svg",
    search: { provider: "local" },
    nav: [
      { text: "Get started", link: "/guide/install" },
      { text: "Shortcuts", link: "/reference/shortcuts" },
      { text: "Changelog", link: `${repo}/blob/main/CHANGELOG.md` },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Install & first run", link: "/guide/install" },
          { text: "A quick tour", link: "/guide/tour" },
        ],
      },
      {
        text: "Features",
        items: [
          { text: "Projects & worktrees", link: "/features/projects" },
          { text: "Sessions & tabs", link: "/features/sessions" },
          { text: "The prompt box", link: "/features/prompt-box" },
          { text: "Permissions & modes", link: "/features/permissions" },
          { text: "Reading a session", link: "/features/timeline" },
          { text: "Focus page", link: "/features/focus" },
          { text: "Notifications", link: "/features/notifications" },
          { text: "Files", link: "/features/files" },
          { text: "Changes & diffs", link: "/features/changes" },
          { text: "Git graph", link: "/features/git-graph" },
          { text: "Terminal", link: "/features/terminal" },
          { text: "Command palette", link: "/features/palette" },
          { text: "Usage & context", link: "/features/usage" },
          { text: "MCP, skills & plugins", link: "/features/config-dialogs" },
          { text: "Phone & remote access", link: "/features/remote-access" },
          { text: "WSL & Docker", link: "/features/wsl-docker" },
          { text: "Orchestration (workers)", link: "/features/orchestration" },
          { text: "Updates", link: "/features/updates" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Keyboard shortcuts", link: "/reference/shortcuts" },
          { text: "Settings", link: "/reference/settings" },
          { text: "CLI flags", link: "/reference/cli" },
          { text: "Troubleshooting & FAQ", link: "/reference/troubleshooting" },
          { text: "Privacy", link: "/reference/privacy" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/site/:path`, text: "Edit this page on GitHub" },
    footer: { message: "MIT licensed. Unofficial; not affiliated with Anthropic." },
    outline: { level: [2, 3] },
  },
});
