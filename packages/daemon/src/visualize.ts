// Inline visualizations (GH-690, docs/spec.md "Inline visualizations"): the visualize plugin's location and the GET /visualize shell page of the sandboxed frame.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The visualize plugin folder: the bundled dist copy, else the source checkout; undefined when neither exists. */
export function visualizePluginDir(): string | undefined {
  for (const u of [new URL("./plugins/visualize", import.meta.url), new URL("../../../plugins/visualize", import.meta.url)]) if (existsSync(fileURLToPath(u))) return fileURLToPath(u);
  return undefined;
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
// Runs inside the written document (document.open drops the shell's listeners): reports its height, applies theme updates.
const INNER = `(function(){var p=parent,H=function(){p.postMessage({v:1,type:"height",height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*")};new ResizeObserver(H).observe(document.documentElement);addEventListener("load",H);addEventListener("message",function(e){var d=e.data;if(e.source===p&&d&&d.v===1&&d.type==="theme"&&d.vars)for(var k in d.vars)if(OK(k,d.vars[k]))document.documentElement.style.setProperty(k,d.vars[k])})})();`;

/** The shell: waits for the host's render message, then replaces its document with the fence HTML after a style and script prefix. */
export const VISUALIZE_SHELL = `<!doctype html><meta charset="utf-8"><title>visualization</title><script>
var OK=function(k,v){return /^--[a-z0-9-]+$/.test(k)&&typeof v==="string"&&v.length<200&&!/[<;{}]/.test(v)};
var done=false;
addEventListener("message",function(e){
var d=e.data;
if(done||e.source!==parent||!d||d.v!==1||d.type!=="render"||typeof d.html!=="string")return;
done=true;
var vars="";for(var k in (d.vars||{}))if(OK(k,d.vars[k]))vars+=k+":"+d.vars[k]+";";
var ok="var OK="+OK.toString()+";";
document.open();
document.write("<!doctype html><meta charset=utf-8><style>:root{"+vars+"}html{color-scheme:var(--scheme,light)}html,body{margin:0;background:var(--background);color:var(--foreground);font:13px ui-sans-serif,system-ui,sans-serif}</style><scr"+"ipt>"+ok+${JSON.stringify(INNER)}+"</scr"+"ipt>"+d.html);
document.close();
});
parent.postMessage({v:1,type:"ready"},"*");
</script>`;
