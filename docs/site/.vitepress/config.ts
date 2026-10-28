import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type HeadConfig } from "vitepress";

const repo = "https://github.com/cuonghuunguyen/claude-code-ui";
const site = "https://cuonghuunguyen.github.io/claude-code-ui/";
const ogImage = `${site}og.png`;

// A page without a `description:` in its frontmatter gets the first plain paragraph under its H1,
// so every page has its own search snippet without a second copy to keep in sync.
function firstParagraph(source: string): string | undefined {
  const body = source.replace(/^---[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(#|!\[|<img|<|\||:::|```|-|\d+\.)/.test(text)) continue;
    const plain = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return plain.length > 160 ? `${plain.slice(0, 157).replace(/\s+\S*$/, "")}…` : plain;
  }
  return undefined;
}

export default defineConfig({
  title: "claude-code-ui",
  description: "Run, watch and steer Claude Code sessions from your browser or phone.",
  base: "/claude-code-ui/",
  lang: "en-US",
  cleanUrls: true,
  // The screenshot pipeline (scenes.html, scenes) lives here but is not a page.
  srcExclude: ["shots/**"],
  sitemap: { hostname: "https://cuonghuunguyen.github.io/claude-code-ui/" },
  // Dead links fail the build (VitePress default); keep it that way.
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/claude-code-ui/icon.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "claude-code-ui" }],
    ["meta", { property: "og:image", content: ogImage }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: ogImage }],
  ],
  // Per page: description, canonical URL and the Open Graph / Twitter title and description; JSON-LD on the home page.
  transformPageData(pageData, { siteConfig }) {
    const fm = pageData.frontmatter;
    if (!fm.description) {
      const derived = firstParagraph(readFileSync(join(siteConfig.srcDir, pageData.relativePath), "utf8"));
      if (derived) pageData.description = derived;
    }
    const home = fm.layout === "home";
    const url = `${site}${pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;
    const title = home ? (fm.title ?? siteConfig.site.title) : `${pageData.title} | claude-code-ui`;
    const description = fm.description ?? pageData.description ?? siteConfig.site.description;
    const head: HeadConfig[] = [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
    if (home) {
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "claude-code-ui",
          description,
          url: site,
          image: ogImage,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Windows, macOS, Linux",
          license: "https://opensource.org/licenses/MIT",
          codeRepository: repo,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        }),
      ]);
    }
    fm.head = [...(fm.head ?? []), ...head];
  },
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
        text: "Working in a session",
        items: [
          { text: "The prompt box", link: "/features/prompt-box" },
          { text: "Permissions & modes", link: "/features/permissions" },
          { text: "Reading a session", link: "/features/timeline" },
          { text: "Usage & context", link: "/features/usage" },
        ],
      },
      {
        text: "Many sessions",
        items: [
          { text: "Projects & worktrees", link: "/features/projects" },
          { text: "Focus page", link: "/features/focus" },
          { text: "Notifications", link: "/features/notifications" },
          { text: "Orchestration (workers)", link: "/features/orchestration" },
        ],
      },
      {
        text: "Workspace & layout",
        items: [
          { text: "Sessions & tabs", link: "/features/sessions" },
          { text: "Panes & layout", link: "/features/panes" },
          { text: "Split view", link: "/features/split-view" },
          { text: "Context menus", link: "/features/context-menus" },
          { text: "Clean up", link: "/features/clean-up" },
          { text: "Command palette", link: "/features/palette" },
          { text: "Keep screen awake", link: "/features/keep-awake" },
        ],
      },
      {
        text: "Code & git",
        items: [
          { text: "Files", link: "/features/files" },
          { text: "Changes & diffs", link: "/features/changes" },
          { text: "Git graph", link: "/features/git-graph" },
          { text: "Terminal", link: "/features/terminal" },
        ],
      },
      {
        text: "Setup & access",
        items: [
          { text: "Phone & remote access", link: "/features/remote-access" },
          { text: "WSL & Docker", link: "/features/wsl-docker" },
          { text: "MCP, skills & plugins", link: "/features/config-dialogs" },
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
