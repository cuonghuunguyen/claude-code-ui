/** Vite `build.assetsInlineLimit`: default limit (4 KiB) for every asset except fonts. A font under the limit (KaTeX_Size3, 3.6 KB) would become a `data:` URL that the app CSP (`font-src 'self'`) blocks. */
const DEFAULT_LIMIT = 4096;

export function assetsInlineLimit(file: string, content: Buffer): boolean | undefined {
  if (/\.(woff2?|ttf|otf)$/i.test(file)) return false;
  return content.byteLength < DEFAULT_LIMIT ? true : undefined;
}
