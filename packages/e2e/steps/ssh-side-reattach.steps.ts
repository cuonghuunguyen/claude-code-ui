// SSH Side after a Hub restart (GH-549, ADR 0009): see features/ssh-side-reattach.feature. POSIX with docker and the ssh tools only.
// Shared steps (throwaway host, choose host, Settings › Sides, Grace, unreachable, kill ssh) live in ssh-side.steps.ts / ssh-side-survive.steps.ts;
// the Hub the user starts in the host and the second Claude UI live in one-hub.steps.ts.
import { expect } from "@playwright/test";
import { hubPids } from "../support/ssh-hub.ts";
import { Then, When } from "./fixtures.ts";

let remembered: string[] = [];
When("I remember the Hub of the SSH host", async ({ sshHost }) => {
  remembered = hubPids((await sshHost.get()).name);
  expect(remembered.length, "Hubs in the host").toBe(1);
});

Then("the Hub of the SSH host is the remembered one", async ({ sshHost }) => {
  expect(hubPids((await sshHost.get()).name)).toEqual(remembered);
});
