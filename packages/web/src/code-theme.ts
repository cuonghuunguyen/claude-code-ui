import { HighlightStyle, LanguageDescription, LanguageSupport, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { styleTags, Tag, tags as t } from "@lezer/highlight";
import { baseName } from "./paths.ts";
import { registerDiffThemes } from "./code-palette.ts";

// GH-394: the editor's syntax colours. The values are the shared palette (code-palette.ts, `--syntax-*` in index.css); the diff
// uses the same palette through a Shiki theme. Registering the diff themes here, at module load, puts it before any diff renders
// (tool-card.tsx imports this module).
registerDiffThemes();

// Custom tags that fall back to their parent when a theme does not know them.
const jsonKey = Tag.define(t.propertyName);
const cssProperty = Tag.define(t.propertyName);
const cssClass = Tag.define(t.className);
const cssValue = Tag.define(t.atom);
const cssPseudo = Tag.define(t.className);
const mdListMark = Tag.define(t.processingInstruction);

const c = (name: string) => `var(--syntax-${name})`;

/**
 * Syntax colours on the `--syntax-*` tokens, so light and dark switch with `.dark`. Which rule colours a node is decided by the tag's
 * own specificity (a modified tag before its base); where two tags land on one token the rule defined LAST wins (CSS order), which is why
 * the marks (processingInstruction, punctuation) come after quote, link and strong.
 */
export const syntaxStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: c("keyword") },
  { tag: t.emphasis, color: c("keyword"), fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.variableName), t.function(t.propertyName), t.labelName], color: c("function") },
  { tag: t.link, color: c("function"), textDecoration: "underline" },
  { tag: t.url, color: c("keyword") },
  { tag: [t.definition(t.typeName), t.definition(t.className), t.typeName, t.className, t.definitionKeyword, t.standard(t.typeName)], color: c("type") },
  { tag: t.local(t.variableName), color: c("parameter") },
  { tag: [t.self, t.atom, t.namespace, t.constant(t.variableName)], color: c("builtin") },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], color: c("number") },
  { tag: [t.color, t.constant(t.name), cssValue], color: c("constant") },
  { tag: t.strong, color: c("constant"), fontWeight: "bold" },
  { tag: [t.string, t.special(t.string), t.docString, t.character, t.attributeValue, t.monospace], color: c("string") },
  { tag: t.regexp, color: c("regexp") },
  { tag: t.escape, color: c("escape") },
  { tag: [t.arithmeticOperator, t.logicOperator, t.compareOperator, t.bitwiseOperator, t.definitionOperator, t.updateOperator, cssProperty, cssPseudo], color: c("operator") },
  { tag: t.meta, color: c("decorator") },
  { tag: [t.tagName, t.unit, jsonKey, mdListMark], color: c("tag") },
  { tag: t.heading, color: c("tag"), fontWeight: "bold" },
  { tag: [t.attributeName, cssClass], color: c("attribute") },
  { tag: [t.variableName, t.definition(t.variableName), t.propertyName, t.definition(t.propertyName), t.special(t.propertyName), t.special(t.variableName)], color: c("variable") },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.quote], color: c("comment") },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket, t.derefOperator, t.typeOperator, t.processingInstruction, t.special(t.brace)], color: c("punctuation") },
  { tag: t.invalid, color: "var(--syntax-critical)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

const withTags = (support: LanguageSupport, spec: Parameters<typeof styleTags>[0]) =>
  new LanguageSupport((support.language as unknown as { configure(o: object): Language }).configure({ props: [styleTags(spec)] }), support.support);

// Method names, `< >` of type arguments and parameters, `?`/`:` of a ternary or optional field, `|` `&` of unions, and `new X` are told apart by
// their parent node (verified with highlightTree probes), as pierre's grammar does.
const SCRIPT = {
  "MethodDeclaration/PropertyDefinition": t.function(t.propertyName),
  'TypeArgList/"<" TypeArgList/">" TypeParamList/"<" TypeParamList/">"': t.angleBracket,
  "NewExpression/VariableName": t.function(t.variableName),
  "UnionType/LogicOp IntersectionType/LogicOp": t.punctuation,
  "ConditionalExpression/LogicOp Optional": t.keyword,
  "ClassDeclaration/VariableName": t.className,
  "ParamList/VariableDefinition": t.local(t.variableName),
  "extends implements": t.modifier,
  Arrow: t.definitionKeyword,
};

/** Per language, node names Lezer's own tags do not say enough about (verified against the grammars with highlightTree). */
const OVERRIDES: Record<string, Parameters<typeof styleTags>[0]> = {
  JavaScript: SCRIPT,
  TypeScript: SCRIPT,
  JSX: SCRIPT,
  TSX: SCRIPT,
  JSON: { PropertyName: jsonKey },
  CSS: { PropertyName: cssProperty, ClassName: cssClass, ValueName: cssValue, PseudoClassName: cssPseudo, AtKeyword: t.controlKeyword, "media charset import namespace keyframes supports": t.controlKeyword, Callee: t.function(t.variableName) },
};

/** Language of a file by name. language-data's Markdown is plain CommonMark; OpenCode (Shiki) shows GFM with fenced code in its own language. */
export function loadLanguage(path: string) {
  const lang = LanguageDescription.matchFilename(languages, baseName(path));
  if (lang?.name !== "Markdown") {
    const spec = lang && OVERRIDES[lang.name];
    return spec ? lang.load().then((s) => withTags(s, spec)) : lang?.load();
  }
  // GFM tags table headers as headings; the palette has no table colour, so header cells keep the text colour and the pipes are punctuation (as in pierre).
  const md = {
    props: [
      styleTags({
        "TableHeader/...": t.content,
        TableDelimiter: t.punctuation,
        "TableHeader/TableDelimiter": t.punctuation,
        CodeInfo: t.content,
        HeaderMark: t.heading,
        ListMark: mdListMark,
        "Emphasis/EmphasisMark": t.emphasis,
        "StrongEmphasis/EmphasisMark": t.strong,
      }),
    ],
  };
  return import("@codemirror/lang-markdown").then((m) => m.markdown({ base: m.markdownLanguage, codeLanguages: languages, extensions: md }));
}
