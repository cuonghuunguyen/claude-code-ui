import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Event, Part, PermissionUpdate } from "@claude-ui/protocol";
import { editedInput, PermissionPanel, ruleLabel } from "./permission.tsx";
import { applyEvent, emptySession, pendingPermission, type PermissionRequest } from "./store.ts";

const bash: PermissionUpdate = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" };
const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  type: "permission_request",
  id: "r1",
  requestId: "r1",
  toolUseId: "t1",
  tool: "Bash",
  input: { command: "npm test" },
  suggestions: [bash],
  settled: false,
  ...over,
});

describe("ruleLabel", () => {
  it("formats rules the way Claude Code writes them", () => {
    expect(ruleLabel(bash)).toBe("Bash(npm test:*)");
    expect(ruleLabel({ ...(bash as Extract<PermissionUpdate, { type: "addRules" }>), rules: [{ toolName: "WebSearch" }, { toolName: "Read", ruleContent: "//tmp/**" }] })).toBe("WebSearch, Read(//tmp/**)");
    expect(ruleLabel({ type: "addDirectories", directories: ["/tmp"], destination: "session" })).toBe("/tmp");
    expect(ruleLabel({ type: "setMode", mode: "acceptEdits", destination: "session" })).toBe("all edits this session");
  });
});

describe("PermissionPanel", () => {
  it("is bounded in height: the body scrolls and the Allow/Deny tray stays outside the scroller", () => {
    const html = renderToStaticMarkup(<PermissionPanel part={request()} onRespond={() => {}} />);
    expect(html).toMatch(/<form[^>]*max-h-\[60dvh\]/);
    expect(html).toMatch(/<div[^>]*min-h-0[^>]*overflow-y-auto[^>]*>(?:(?!<\/form>).)*<\/div><div[^>]*border-t[^>]*><button[^>]*>Deny/s);
  });
  it("ExitPlanMode shows the plan as markdown with Claude Code's plan approval options", () => {
    const accept: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" };
    const html = renderToStaticMarkup(<PermissionPanel part={request({ tool: "ExitPlanMode", input: { plan: "## Plan\n\n1. edit **a.txt**" }, suggestions: [accept] })} onRespond={() => {}} />);
    expect(html).toContain("Claude has written up a plan");
    expect(html).toMatch(/<h2[^>]*>Plan<\/h2>/);
    expect(html).toContain("Yes, and auto-accept edits");
    expect(html).toContain("Yes, manually approve edits");
    expect(html).toContain("No, keep planning");
    expect(html).not.toContain("&quot;plan&quot;");
  });

  it("is an OpenCode dock: Permission required, the SDK title, rule patterns; tray Deny · Allow always · Allow once; No with feedback", () => {
    const dir: PermissionUpdate = { type: "addDirectories", directories: ["/work"], destination: "session" };
    const html = renderToStaticMarkup(<PermissionPanel part={request({ title: "Claude wants to run npm test", suggestions: [bash, dir] })} onRespond={() => {}} />);
    expect(html).toContain("Permission required");
    expect(html).toContain("Claude wants to run npm test");
    expect(html).toContain("npm test");
    expect(html).toContain("don&#x27;t ask again for <code");
    expect(html).toContain("Bash(npm test:*), /work");
    expect(html.match(/<button[^>]*>([^<]*)<\/button>/g)!.map((b) => b.replace(/<[^>]+>/g, ""))).toEqual(["Deny", "Allow always", "Allow once"]);
    expect(html).toContain("No, and tell Claude what to do differently");
  });

  it("offers no Allow always without suggestions", () => {
    const html = renderToStaticMarkup(<PermissionPanel part={request({ suggestions: [] })} onRespond={() => {}} />);
    expect(html).not.toContain("Allow always");
    expect(html).not.toContain("ask again");
  });
});

describe("edit before accept", () => {
  const edit = request({ tool: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b", replace_all: false }, suggestions: [] });
  const write = request({ tool: "Write", input: { file_path: "/w/b.ts", content: "x\n" }, suggestions: [] });

  it("shows the diff and the proposed new content in an editable field for Edit and Write", () => {
    for (const [part, content] of [[edit, "b"], [write, "x\n"]] as const) {
      const html = renderToStaticMarkup(<PermissionPanel part={part} onRespond={() => {}} />);
      expect(html).toContain('data-testid="edit-diff"');
      expect(html).toMatch(new RegExp(`<textarea[^>]*aria-label="Proposed new content"[^>]*>${content}</textarea>`));
    }
  });

  it("has no editable field for other tools", () => {
    expect(renderToStaticMarkup(<PermissionPanel part={request()} onRespond={() => {}} />)).not.toContain("<textarea");
  });

  it("edited content becomes the full updatedInput; unchanged content sends none, like a normal Yes", () => {
    expect(editedInput(edit, "c")).toEqual({ file_path: "/w/a.ts", old_string: "a", new_string: "c", replace_all: false });
    expect(editedInput(write, "y\n")).toEqual({ file_path: "/w/b.ts", content: "y\n" });
    expect(editedInput(edit, "b")).toBeUndefined();
    expect(editedInput(request(), "anything")).toBeUndefined();
  });
});

describe("pendingPermission", () => {
  it("is the oldest unsettled request, cleared by its settlement event", () => {
    const ev = (seq: number, part: Part): Event => ({ type: "event", sessionId: "s", seq, part });
    let s = applyEvent(emptySession(), ev(1, request()));
    s = applyEvent(s, ev(2, request({ id: "r2", requestId: "r2" })));
    expect(pendingPermission(s)?.id).toBe("r1");
    s = applyEvent(s, ev(3, request({ settled: true, decision: "allow" })));
    expect(pendingPermission(s)?.id).toBe("r2");
    s = applyEvent(s, ev(4, request({ id: "r2", requestId: "r2", settled: true, decision: "deny" })));
    expect(pendingPermission(s)).toBeUndefined();
  });
});
