// The Focus page: a permission, a question and a finished turn waiting on the user, one session still working.
import type { Part } from "@claude-ui/protocol";
import type { Scene } from "../scene.ts";
import { assistantText, DEMO, DEMO_API, MIN, NOW, session, toolCall, userText } from "../demo.ts";

const todo = (id: string): Part => ({
  type: "todo_update",
  id,
  items: [
    { content: "Add the order summary", status: "completed" },
    { content: "Wire up the shipping form", status: "in_progress", activeForm: "Wiring up the shipping form" },
    { content: "Write the checkout tests", status: "pending" },
  ],
});

const sessions = [
  session("11111111-aaaa-4b7a-9a41-0c2b7e8f1a01", { title: "Run the checkout tests", state: "needs_input", lastActivity: NOW - 2 * MIN }, [
    userText("u", "Run the checkout tests and fix what fails."),
    toolCall("t0", "Read", { file_path: `${DEMO}/src/checkout/cart.test.ts` }),
    {
      type: "permission_request",
      id: "p1",
      requestId: "p1",
      toolUseId: "tp1",
      tool: "Bash",
      input: { command: "npm run test -- checkout", description: "Run the checkout tests" },
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run test *" }], behavior: "allow", destination: "localSettings" }],
      settled: false,
      at: NOW - 2 * MIN - 14_000,
      tier: "low",
    },
  ]),
  session("22222222-bbbb-4b7a-9a41-0c2b7e8f1a02", { title: "Plan the order history page", state: "needs_input", lastActivity: NOW - 45_000 }, [
    userText("u", "Plan the order history page."),
    assistantText("a", "Before I plan this I need one decision."),
    {
      type: "question",
      id: "q1",
      requestId: "q1",
      toolUseId: "tq1",
      settled: false,
      at: NOW - 45_000,
      questions: [
        {
          question: "Keep the old /orders route?",
          header: "Route",
          options: [
            { label: "Keep", description: "Redirect the old route to the new page" },
            { label: "Drop", description: "Remove it and update the links" },
          ],
          multiSelect: false,
        },
      ],
    },
  ]),
  session("33333333-cccc-4b7a-9a41-0c2b7e8f1a03", { title: "Shipping form validation", state: "running", lastActivity: NOW - 20_000 }, [
    userText("u", "Add validation to the shipping form."),
    todo("todo1"),
    toolCall("tr", "Edit", { file_path: `${DEMO}/src/checkout/ShippingForm.tsx`, old_string: "a", new_string: "b" }, "running"),
  ]),
  session("44444444-dddd-4b7a-9a41-0c2b7e8f1a04", { title: "Speed up product search", state: "idle", lastActivity: NOW - 12 * MIN }, [
    userText("u", "The product search feels slow, find out why."),
    assistantText("a", "Search was refetching on every keystroke. I debounced the input by 200 ms and cached results per query; typing now sends one request."),
    { type: "turn_result", id: "tr1", durationMs: 94_000, costUsd: 0.31, usage: { inputTokens: 1200, outputTokens: 900, cacheReadTokens: 30000, cacheCreationTokens: 0 }, isError: false },
  ]),
  session("55555555-eeee-4b7a-9a41-0c2b7e8f1a05", { title: "Rotate the API keys", cwd: DEMO_API, state: "idle", lastActivity: NOW - 5 * 60 * MIN }, [userText("u", "Rotate the keys."), assistantText("a", "Done.")]),
];

export const scene: Scene = {
  hash: "#focus",
  sessions,
  projects: [DEMO, DEMO_API],
  storage: { "claude-ui.tabs": JSON.stringify([sessions[0]!.info.id, sessions[1]!.info.id, sessions[3]!.info.id]) },
};
