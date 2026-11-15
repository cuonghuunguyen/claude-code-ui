
import { When } from "./fixtures.ts";
When("I wait {int} seconds", async ({ page }, s: number) => page.waitForTimeout(s * 1000));