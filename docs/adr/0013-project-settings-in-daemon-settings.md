# Project settings live in Daemon settings, not in the repository

Project settings (Label, commit message instruction, overrides of global settings) are stored in the Daemon settings file under `projects`, keyed by the Project's cwd, not in a file inside the repository. Labels and commit message instructions already lived there, and a claude-ui file in the repository would need a `.gitignore` entry or would leak one user's choices (model, Claude account, Permission mode) to the team. Exception: skill overrides stay in `<project>/.claude/settings.local.json`, because Claude Code reads them from there.

## Considered options

- **File in the repository** (`.claude-ui.json`): shared with the team through git, but writes into the user's repository and mixes personal choices with team ones.
- **`<project>/.claude/settings.local.json` under a claude-ui key**: next to Claude Code's settings, but a file Claude Code owns and may validate.
- **Daemon settings keyed by cwd** (chosen): ours, outside the repository, one patch path.

## Consequences

- Project settings are per Daemon machine; the same repository on another machine or Side starts with none.
- Moving or renaming the Project folder loses its Project settings (the key is the cwd).
- No team-shared Project settings; adding them later needs a second, repository-level layer.
