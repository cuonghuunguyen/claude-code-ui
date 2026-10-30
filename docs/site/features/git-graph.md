# Git graph

The **Graph** pane shows the project's commit history as a graph, like `git log --graph`. It is read-only, except **Fetch**. It lives in the side panel by default and can be a tab in the main area, where it takes the whole area (see [Panes & layout](panes)).

![The git graph with branches, tags and commits](/screenshots/git-graph.png)

## How to use

1. Open the side panel and pick **graph** (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>).
2. In a folder with several repositories, pick the repository first (see [Changes](changes#repositories)). The choice is shared with Changes.
3. Pick which branch to show: **HEAD** (the default) or **All branches**, or one branch.
4. Search with **Text or hash**, or filter by **Author**.
5. Click a commit to see its details and the diff of each file.

## Good to know

- Labels are colored by kind: HEAD, local branches, remote branches and tags.
- It loads 200 commits at a time. Older ones load as you scroll down.
- **Refresh** reloads the graph.
- **Fetch** and the branch menu act on the selected repository. Fetching a submodule fetches only its own remotes.
- A commit that moved a submodule shows "Submodule *path* → *commit*" instead of a diff, with **Show graph of** *path*.
- It never checks out, commits or pushes.
