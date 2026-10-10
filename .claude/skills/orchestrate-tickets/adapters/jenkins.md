# Adapter: Jenkins (CI)

Tool: the `jenkins` skill (the user also calls it `/jenkins-cli`).

**Gate:** the skill is listed in the session, **and** it has credentials: `--url/--user/--token`,
else `JENKINS_URL` / `JENKINS_USER` / `JENKINS_API_TOKEN`, else `git config jenkins.url` in the
checkout. Then `jenkins whoami` answers. A skill with no credentials fails halfway through
stage 3, not at the gate.

Watch instructions (paste into the build-watch prompt):

```
- Use the jenkins skill. Let it find the job from this checkout's git remote rather than
  guessing a job name. Find the build for branch <remote-branch>, tail its console, and wait
  for a terminal status with the skill's wait subcommand, not a poll loop of your own.
- A branch job may take a minute to notice the push. Not found yet is not a failure.
```

**Forbidden:** triggering, re-triggering, aborting or replaying builds; editing job config.
