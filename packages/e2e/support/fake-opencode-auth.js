// A fake login plugin for OpenCode (acceptance of "OpenCode provider login"): no network, no real credential.
// It replaces the login of the models.dev provider `groq`. Saved values are fake strings in the run's scratch auth store.
import { createServer } from "node:http";

let done;
/** A tiny local page: GET /done finishes the browser login. */
async function page() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    if (req.url === "/done") (res.end("Fake login done"), done?.({ type: "success", key: "fake-oauth-not-real" }));
    else res.end("Fake login page");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  return `http://127.0.0.1:${server.address().port}`;
}

export const FakeLogin = async () => ({
  auth: {
    provider: "groq",
    methods: [
      {
        type: "oauth",
        label: "Fake browser login",
        authorize: async () => {
          const base = await page();
          return { url: base, instructions: `Finish in the browser: ${base}/done`, method: "auto", callback: () => new Promise((r) => (done = r)) };
        },
      },
      {
        type: "oauth",
        label: "Fake code login",
        authorize: async () => ({ url: `${await page()}/code`, instructions: "Paste the code `good`", method: "code", callback: async (code) => (code === "good" ? { type: "success", key: "fake-code-not-real" } : { type: "failed" }) }),
      },
      { type: "api", label: "API key" },
    ],
  },
});
