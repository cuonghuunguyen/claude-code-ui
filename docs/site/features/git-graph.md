# Git graph

The **Graph** pane shows the project's commit history as a graph, like `git log --graph`. It is read-only.

![The git graph with branches, tags and commits](/screenshots/git-graph.png)

## How to use

1. Open the side panel and pick **graph** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
2. Pick which branch to show: **HEAD** (the default) or **All branches**, or one branch.
3. Search with **Text or hash**, or filter by **Author**.
4. Click a commit to see its details and the diff of each file.

## Good to know

- Labels are colored by kind: HEAD, local branches, remote branches and tags.
- It loads 200 commits at a time. Older ones load as you scroll down.
- **Refresh** reloads the graph.
- It never changes your repository: no checkout, no commit, no push.
