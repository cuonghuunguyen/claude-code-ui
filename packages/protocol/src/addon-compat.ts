// `claudeUi` of an addon manifest: the Claude UI versions it works with (docs/site/features/addons.md "Compatibility").
// A small own comparator, no semver dependency. Forms: `*`, `x.y.z`, `>=x.y`, `>=x.y.z`, `^x.y[.z]`, `~x.y[.z]`.

const RANGE = /^(?:\*|(\d{1,6}\.\d{1,6}\.\d{1,6})|(>=|\^|~)(\d{1,6}\.\d{1,6}(?:\.\d{1,6})?))$/;
type V = [number, number, number];
const parts = (s: string): V => {
  const [a = 0, b = 0, c = 0] = s.split(".").map(Number);
  return [a, b, c];
};
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Why a `claudeUi` value is refused, else undefined. */
export const claudeUiError = (range: unknown): string | undefined =>
  typeof range === "string" && RANGE.test(range) ? undefined : "claudeUi: a version range such as >=1.5, ^1.5, ~1.5.2, 1.5.0 or *";

/** The app version as numbers: `1.5.0` (a suffix such as `-beta.1` is ignored); undefined for `dev` or anything else (then every range is met). */
export const appVersionOf = (v: string | undefined): V | undefined => {
  const m = v === undefined ? null : /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** Whether `version` meets `range`. A malformed range or a version that is not `x.y.z` (a source checkout) is met. `^` keeps the major (the minor while the major is 0), `~` keeps the minor. */
export function satisfiesClaudeUi(range: string, version: string | undefined): boolean {
  const v = appVersionOf(version);
  const m = RANGE.exec(range);
  if (!v || !m || range === "*") return true;
  if (m[1]) return cmp(v, parts(m[1])) === 0;
  const base = parts(m[3]!);
  if (cmp(v, base) < 0) return false;
  if (m[2] === ">=") return true;
  if (m[2] === "~") return v[0] === base[0] && v[1] === base[1];
  return base[0] > 0 ? v[0] === base[0] : v[0] === 0 && v[1] === base[1];
}

/** `needs Claude UI >=1.6 (this is 1.5.0)` */
export const claudeUiMessage = (range: string, version: string) => `needs Claude UI ${range} (this is ${version})`;
