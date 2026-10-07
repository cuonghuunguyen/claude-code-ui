// jsdom's getComputedStyle matches every rule of its UA stylesheet per element; floating-ui (Base UI popups) calls it for
// each ancestor on every open, ~300 ms per popup, which timed tests out under load. No test asserts layout: inline styles are enough.
if (typeof window !== "undefined") window.getComputedStyle = (el: Element) => (el as HTMLElement).style ?? new CSSStyleDeclaration();
