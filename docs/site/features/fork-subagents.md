# Fork subagents

A fork is a subagent that starts with a copy of your whole conversation. It runs in its own context and returns only its result. The searches, file reads and logs it goes through never enter your session's context, so a long session stays small.

A fork is not a new session and not an [aside](aside). It appears as a **Fork** card in the transcript, under the agent's call.

Forks work in Claude Code sessions. OpenCode has no fork: its subagents always start fresh, with a brief written by the agent.

## When to fork

The agent reads these rules (the same text is its guidance):

> Fork when the work:
> - needs many reads, searches or logs and only the conclusion matters;
> - is independent of your next step and can run in parallel;
> - needs this conversation's decisions or file knowledge, so a fresh agent would need a long brief;
> - would take more than ~5 file reads or return large output.
>
> Do not fork when the task:
> - is one small step (one read, one edit);
> - feeds a next step that needs the raw output;
> - edits files the main thread also edits;
> - fits a short, self-contained brief: use a fresh subagent and set `model` explicitly (cheaper).

The agent decides when to fork. There is no automatic fork when the context grows past a limit.

## The card

The card shows **Fork**, the task, the status and how long the run took. While it runs, **Stop** cancels it.

- **Steps** (the fork's tool calls) are collapsed behind a count. Open them to follow the work.
- The **result** is the fork's final answer. It is shown once the run has ended.
- **Open** shows the fork in the subagent view, like any other subagent.

After a daemon restart or a reload, the card is restored with its steps and result.

## What a fork uses

- The model, permission mode and rules of the session. A fork on a large model costs that model's tokens. It shares the prompt cache of the session.
- It runs in the background. The agent gets its result in a notification when it ends.
- It does not start other agents.

## Settings

In **Settings › Sessions › Fork subagents**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Let the agent fork itself | On | Off: turns that start later cannot fork, and the agent gets no fork guidance |

The setting applies to turns that start after the change. It does not apply to OpenCode sessions.

## Good to know

- A fork inherits the conversation up to its start. Work you add later is not seen by it.
- Two forks that edit the same files can conflict. The guidance tells the agent not to fork a task that edits files the main thread also edits.
- When a short, self-contained brief is enough, a normal subagent is cheaper: the agent can pick a smaller model for it.
