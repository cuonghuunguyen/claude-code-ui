
import { sendPrompt } from "../support/flow.ts";
import { When } from "./fixtures.ts";

When("I send the first prompt {string}", async ({ page }, text: string) => sendPrompt(page, text));
