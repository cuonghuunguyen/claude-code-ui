import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme, type HeadConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

const repo = "https://github.com/cuonghuunguyen/claude-code-ui";
const site = "https://cuonghuunguyen.github.io/claude-code-ui/";
const ogImage = `${site}og.png`;
const srcDir = fileURLToPath(new URL("..", import.meta.url));

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

// A page with `faq: true` in its frontmatter: each `### Question?` and the paragraphs under it, as plain text,
// for the FAQPage structured data that search engines and AI answer engines read.
function faqEntries(source: string): { q: string; a: string }[] {
  const body = source.replace(/^---[\s\S]*?\n---\n/, "");
  const entries: { q: string; a: string }[] = [];
  for (const section of body.split(/^### /m).slice(1)) {
    const [heading, ...rest] = section.split("\n");
    const answer = rest
      .join("\n")
      .split(/^#{1,3} /m)[0]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const q = heading.replace(/\s*\{#[^}]*\}\s*$/, "").trim().replace(/`/g, "");
    if (q.endsWith("?") && answer) entries.push({ q, a: answer });
  }
  return entries;
}

type Labels = Record<string, string>;
/** The sidebar and nav of one locale: `prefix` "" (English) or "/vi"; `l` maps an English label to that locale's text. */
const nav = (prefix: string, l: Labels): DefaultTheme.NavItem[] => [
  { text: l["Get started"] ?? "Get started", link: `${prefix}/guide/install` },
  { text: l["Shortcuts"] ?? "Shortcuts", link: `${prefix}/reference/shortcuts` },
  { text: l["Changelog"] ?? "Changelog", link: `${repo}/blob/main/CHANGELOG.md` },
];
const SIDEBAR: [string, [string, string][]][] = [
  ["Getting started", [["Install & first run", "/guide/install"], ["A quick tour", "/guide/tour"], ["FAQ", "/guide/faq"], ["How it compares", "/guide/compare"]]],
  ["Working in a session", [["The prompt box", "/features/prompt-box"], ["Permissions & modes", "/features/permissions"], ["Reading a session", "/features/timeline"], ["Usage & context", "/features/usage"], ["Ask an aside (/btw)", "/features/aside"], ["Background shells", "/features/background-shells"]]],
  ["Many sessions", [["Projects & worktrees", "/features/projects"], ["Focus page", "/features/focus"], ["Notifications", "/features/notifications"], ["Orchestration (workers)", "/features/orchestration"]]],
  ["Workspace & layout", [["Sessions & tabs", "/features/sessions"], ["Panes & layout", "/features/panes"], ["Split view", "/features/split-view"], ["Context menus", "/features/context-menus"], ["Clean up", "/features/clean-up"], ["Command palette", "/features/palette"], ["Keep screen awake", "/features/keep-awake"]]],
  ["Code & git", [["Files", "/features/files"], ["Changes & diffs", "/features/changes"], ["Git graph", "/features/git-graph"], ["Terminal", "/features/terminal"]]],
  ["Setup & access", [["Phone & remote access", "/features/remote-access"], ["WSL & Docker", "/features/wsl-docker"], ["MCP, skills & plugins", "/features/config-dialogs"], ["Addons", "/features/addons"], ["Updates", "/features/updates"]]],
  ["Reference", [["Keyboard shortcuts", "/reference/shortcuts"], ["Settings", "/reference/settings"], ["CLI flags", "/reference/cli"], ["Troubleshooting & FAQ", "/reference/troubleshooting"], ["Privacy", "/reference/privacy"]]],
];
const sidebar = (prefix: string, l: Labels): DefaultTheme.SidebarItem[] =>
  SIDEBAR.map(([text, items]) => ({ text: l[text] ?? text, items: items.map(([t, link]) => ({ text: l[t] ?? t, link: `${prefix}${link}` })) }));

const VI: Labels = {
  "Get started": "Bắt đầu",
  Shortcuts: "Phím tắt",
  Changelog: "Nhật ký thay đổi",
  "Getting started": "Bắt đầu",
  "Install & first run": "Cài đặt và chạy lần đầu",
  "A quick tour": "Tham quan nhanh",
  FAQ: "Hỏi đáp",
  "How it compares": "So sánh với công cụ khác",
  "Working in a session": "Làm việc trong một phiên",
  "The prompt box": "Ô prompt",
  "Permissions & modes": "Quyền và chế độ",
  "Reading a session": "Đọc một phiên",
  "Usage & context": "Mức dùng và ngữ cảnh",
  "Ask an aside (/btw)": "Hỏi bên lề (/btw)",
  "Background shells": "Shell nền",
  "Many sessions": "Nhiều phiên",
  "Projects & worktrees": "Dự án và worktree",
  "Focus page": "Trang Focus",
  Notifications: "Thông báo",
  "Orchestration (workers)": "Điều phối (worker)",
  "Workspace & layout": "Không gian làm việc và bố cục",
  "Sessions & tabs": "Phiên và tab",
  "Panes & layout": "Khung và bố cục",
  "Split view": "Chia màn hình",
  "Context menus": "Menu ngữ cảnh",
  "Clean up": "Dọn dẹp",
  "Command palette": "Bảng lệnh",
  "Keep screen awake": "Giữ màn hình sáng",
  "Code & git": "Mã nguồn và git",
  Files: "Tệp",
  "Changes & diffs": "Thay đổi và diff",
  "Git graph": "Đồ thị git",
  Terminal: "Terminal",
  "Setup & access": "Thiết lập và truy cập",
  "Phone & remote access": "Điện thoại và truy cập từ xa",
  "WSL & Docker": "WSL và Docker",
  "MCP, skills & plugins": "MCP, skill và plugin",
  Addons: "Addon",
  Updates: "Cập nhật",
  Reference: "Tham khảo",
  "Keyboard shortcuts": "Phím tắt",
  Settings: "Cài đặt",
  "CLI flags": "Tham số CLI",
  "Troubleshooting & FAQ": "Khắc phục sự cố và hỏi đáp",
  Privacy: "Quyền riêng tư",
};

// The llms.txt table of contents: the English sidebar, each link with the page's description (frontmatter, else
// the first paragraph, as for search snippets), so an AI reading llms.txt knows what each page answers.
function llmsToc(): string {
  return SIDEBAR.map(([text, items]) => {
    const links = items.map(([title, link]) => {
      const source = readFileSync(join(srcDir, `${link}.md`), "utf8");
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? "";
      const description = /^description:\s*(.+)$/m.exec(fm)?.[1].trim() ?? firstParagraph(source);
      return `- [${title}](${site}${link.slice(1)}.md)${description ? `: ${description}` : ""}`;
    });
    return `### ${text}\n\n${links.join("\n")}`;
  }).join("\n\n");
}

export default defineConfig({
  title: "claude-code-ui",
  description: "Run, watch and steer Claude Code sessions from your browser or phone.",
  base: "/claude-code-ui/",
  // English at /, Vietnamese at /vi/ (same relative paths); the navbar language menu links to the same page in the other one.
  locales: {
    root: { label: "English", lang: "en-US", themeConfig: { nav: nav("", {}), sidebar: sidebar("", {}) } },
    vi: {
      label: "Tiếng Việt",
      lang: "vi-VN",
      description: "Chạy, theo dõi và điều khiển các phiên Claude Code từ trình duyệt hoặc điện thoại.",
      themeConfig: {
        nav: nav("/vi", VI),
        sidebar: sidebar("/vi", VI),
        editLink: { pattern: `${repo}/edit/main/docs/site/:path`, text: "Sửa trang này trên GitHub" },
        footer: { message: "Giấy phép MIT. Không chính thức; không liên kết với Anthropic." },
        outline: { level: [2, 3], label: "Trên trang này" },
        docFooter: { prev: "Trang trước", next: "Trang sau" },
        langMenuLabel: "Đổi ngôn ngữ",
        returnToTopLabel: "Về đầu trang",
        sidebarMenuLabel: "Menu",
        darkModeSwitchLabel: "Giao diện",
        lightModeSwitchTitle: "Chuyển sang giao diện sáng",
        darkModeSwitchTitle: "Chuyển sang giao diện tối",
        notFound: { title: "KHÔNG TÌM THẤY TRANG", quote: "Trang này không tồn tại.", linkLabel: "Về trang chủ", linkText: "Về trang chủ" },
      },
    },
  },
  cleanUrls: true,
  // The screenshot pipeline (scenes.html, scenes) lives here but is not a page.
  srcExclude: ["shots/**"],
  // llms.txt, llms-full.txt and a Markdown copy of every English page, for AI assistants and answer engines.
  vite: {
    plugins: [
      llmstxt({
        domain: "https://cuonghuunguyen.github.io",
        ignoreFiles: ["shots/**", "vi/**"],
        customTemplateVariables: {
          description:
            "claude-code-ui is a free, open-source (MIT) web UI and GUI for Claude Code. A small local daemon runs Claude Code sessions on your own machine; you run, watch and steer many of them from any browser, including your phone. No cloud, no relay, no telemetry. Unofficial; not affiliated with Anthropic.",
          details: [
            "- Run: `npx claude-code-ui` (or `npm i -g claude-code-ui`; the command is `claude-ui`). Needs Node.js 22+ and Claude Code logged in (`claude login`); uses the Claude subscription, no API key.",
            `- Source: ${repo} (npm package \`claude-code-ui\`).`,
            "- Not the same project as CloudCLI (also called \"Claude Code UI\", repo siteboon/claudecodeui), opcode or claude-code-webui.",
          ].join("\n"),
          toc: llmsToc(),
        },
      }),
    ],
  },
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
    if (fm.faq) {
      const source = readFileSync(join(siteConfig.srcDir, pageData.relativePath), "utf8");
      head.push([
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqEntries(source).map(({ q, a }) => ({
            "@type": "Question",
            name: q,
            acceptedAnswer: { "@type": "Answer", text: a },
          })),
        }),
      ]);
    }
    fm.head = [...(fm.head ?? []), ...head];
  },
  themeConfig: {
    logo: "/icon.svg",
    search: {
      provider: "local",
      options: {
        locales: {
          vi: {
            translations: {
              button: { buttonText: "Tìm kiếm", buttonAriaLabel: "Tìm kiếm" },
              modal: {
                displayDetails: "Hiện chi tiết",
                resetButtonTitle: "Xóa truy vấn",
                backButtonTitle: "Đóng tìm kiếm",
                noResultsText: "Không có kết quả cho",
                footer: { selectText: "chọn", navigateText: "di chuyển", closeText: "đóng" },
              },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/site/:path`, text: "Edit this page on GitHub" },
    footer: { message: "MIT licensed. Unofficial; not affiliated with Anthropic." },
    outline: { level: [2, 3] },
  },
});
