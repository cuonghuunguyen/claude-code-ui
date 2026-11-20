// Inline visualizations (GH-690, docs/spec.md "Inline visualizations"): the visualize plugin's location and the GET /visualize shell page of the sandboxed frame.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The visualize plugin folder: the bundled dist copy, else the source checkout; undefined when neither exists. */
export function visualizePluginDir(base = import.meta.url): string | undefined {
  for (const u of [new URL("./plugins/visualize", base), new URL("../../../plugins/visualize", base)]) if (existsSync(fileURLToPath(u))) return fileURLToPath(u);
  return undefined;
}

const OC_HOW = "How: put the self-contained HTML fragment (no <html> wrapper) directly in the fence. Do not write a file and do not look for an uploads folder.\n\n";
let warned = false;

/** The Claude text for OpenCode: no uploads folder there, so the "How:" block (file write) becomes "HTML in the fence". A marker not found: the text as it is, one warning. */
function forOpenCode(body: string): string {
  const a = body.indexOf("\nHow:\n");
  const b = body.indexOf("\nDraw one whenever the reply covers");
  const ex = "Example fragment (the file content, or the fence content without an uploads folder):";
  if (a < 0 || b < a || !body.includes(ex)) {
    if (!warned) (warned = true), console.warn("visualize: SKILL.md layout changed, OpenCode gets the Claude text");
    return body;
  }
  return (body.slice(0, a + 1) + OC_HOW + body.slice(b + 1)).replace(ex, "Example fragment (the fence content):");
}

/** The skill as OpenCode's per-prompt `system` text: its description (the "when") and body, no frontmatter; undefined when `dir` is none or has no readable skill. `engine` "opencode" swaps the file-write step for the HTML in the fence. */
export function visualizeSystem(dir: string | undefined, engine: "claude" | "opencode" = "claude"): string | undefined {
  if (!dir) return undefined;
  try {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(join(dir, "skills/visualize/SKILL.md"), "utf8").replace(/\r\n/g, "\n"));
    const desc = m && /^description:\s*(.+)$/m.exec(m[1]!)?.[1];
    if (!desc) return undefined;
    const body = m![2]!.trim();
    return `${desc}\n\n${engine === "opencode" ? forOpenCode(body) : body}`;
  } catch {
    return undefined;
  }
}

/** The CSP of the shell page, one directive per entry with its reason; it stays in force after the shell's document.write. Relax here only (docs/spec.md "Security"). */
export const VISUALIZE_CSP = [
  "sandbox allow-scripts", // opaque origin: no cookies, storage, parent DOM; no popups, forms, top navigation
  "default-src 'none'", // no fetch/XHR/image/frame/navigation requests (WebRTC is not governed by CSP: not blocked)
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com", // the model's inline scripts plus the common chart/diagram CDNs; no eval
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com",
  "img-src data: blob:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'", // only the app frames it
].join("; ");

export const VISUALIZE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": VISUALIZE_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-dns-prefetch-control": "off",
} as const;

// Height = the root box (content height); scrollHeight would never fall below the frame height, so a narrower viewport could not shrink it.
// Runs inside the written document (document.open drops the shell's listeners): reports its height, applies theme updates and fires `themechange` so JS-drawn visuals recolour.
const INNER = `(function(){var p=parent,H=function(){p.postMessage({v:1,type:"height",height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*")};new ResizeObserver(H).observe(document.documentElement);addEventListener("load",H);addEventListener("message",function(e){var d=e.data;if(e.source===p&&d&&d.v===1&&d.type==="theme"&&d.vars){for(var k in d.vars)if(OK(k,d.vars[k]))document.documentElement.style.setProperty(k,d.vars[k]);dispatchEvent(new Event("themechange"))}})})();`;

// Narrow-frame fallbacks (a phone is ~360px wide): flex and grid items may shrink, long words wrap, monospace blocks scroll in their own box, media never exceeds the frame.
// :where() keeps them at specificity 0, so any rule of the fence HTML wins.
export const VISUALIZE_FIT = ":where(*,*::before,*::after){box-sizing:border-box;min-width:0}body{overflow-wrap:break-word}:where(pre){overflow-x:auto;max-width:100%}:where(img,svg,canvas,video,table){max-width:100%}:where(img,canvas,video){height:auto}";

/** The shell: waits for the host's render message, then replaces its document with the fence HTML after a style and script prefix. */
export const VISUALIZE_SHELL = `<!doctype html><meta charset="utf-8"><title>visualization</title><script>
var FIT=${JSON.stringify(VISUALIZE_FIT)};
var OK=function(k,v){return /^--[a-z0-9-]+$/.test(k)&&typeof v==="string"&&v.length<200&&!/[<;{}]/.test(v)};
var done=false;
addEventListener("message",function(e){
var d=e.data;
if(done||e.source!==parent||!d||d.v!==1||d.type!=="render"||typeof d.html!=="string")return;
done=true;
var vars="";for(var k in (d.vars||{}))if(OK(k,d.vars[k]))vars+=k+":"+d.vars[k]+";";
var ok="var OK="+OK.toString()+";";
document.open();
document.write("<!doctype html><meta charset=utf-8><style>:root{"+vars+"}html{color-scheme:var(--scheme,light)}html,body{margin:0;background:var(--background);color:var(--foreground);font:13px var(--font-sans,ui-sans-serif,system-ui,sans-serif)}body{padding:12px}"+FIT+"</style><scr"+"ipt>"+ok+${JSON.stringify(INNER)}+"</scr"+"ipt>"+d.html);
document.close();
});
parent.postMessage({v:1,type:"ready"},"*");
</script>`;
