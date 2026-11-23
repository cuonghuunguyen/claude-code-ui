// The hash route of the addon preview page (addon-preview.tsx); apart from it so the app shell does not load the page to test the hash.
export const PREVIEW_HASH = "#/addon-preview";
export const isPreviewHash = (hash: string) => hash === PREVIEW_HASH;
