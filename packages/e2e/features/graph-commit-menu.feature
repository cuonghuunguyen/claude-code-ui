Feature: Commit menu of the Graph: Undo Commit, Revert Commit, Cherry-Pick and Reset Current Branch to Here (GH-562)

  Scenario: Undo Commit soft-resets an unpushed HEAD and is disabled once the commit is pushed
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    Then the commit menu item "Undo Commit" is enabled
    And I capture "undo-menu"
    When I pick "Undo Commit" in the commit menu
    Then the Graph result line says "Undid commit"
    And the last commit of the project is "initial"
    And the file "work.txt" is staged
    And I capture "undone"
    When the project commits what is staged as "again" and pushes
    And I click Refresh in the Graph
    And I open the commit menu on the row "again"
    Then the commit menu item "Undo Commit" is disabled and says "Already pushed"
    And I capture "undo-pushed"

  Scenario: Revert Commit and Cherry-Pick on a linear history, a merge commit has both disabled
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has a merge commit of the branch "side"
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    And I pick "Revert Commit" in the commit menu
    Then the Graph result line says "Reverted"
    And the last commit of the project is "Revert \"local work\""
    And I capture "reverted"
    When I choose "All branches" in the Graph branch filter
    And I open the commit menu on the row "a commit only on base-alt"
    And I capture "cherry-pick-menu"
    And I pick "Cherry-Pick" in the commit menu
    Then the Graph result line says "Cherry-picked"
    And the file "alt.txt" has the text "alt"
    And I capture "cherry-picked"
    When I open the commit menu on the row "Merge branch 'side'"
    Then the commit menu item "Revert Commit" is disabled and says "Merge commit"
    And the commit menu item "Cherry-Pick" is disabled and says "Merge commit"
    And I capture "merge-row"

  Scenario: A Cherry-Pick that conflicts shows the banner in the Changes tab, on a desktop and on a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the commit menu on the row "feature adds a.txt"
    And I pick "Cherry-Pick" in the commit menu
    And I open the Changes tab of the side panel
    Then the conflict banner says "Cherry-pick in progress" and lists "a.txt"
    And I capture "pick-banner"
    Given the viewport is 390x844
    When I open the Changes tab of the side panel
    Then the conflict banner and its buttons are inside the viewport
    And the page has no horizontal scroll
    And I capture "pick-banner-phone"

  Scenario: Reset hard shows the command and the lost file, refuses when a file changed after the dialog opened, and keeps the lost text in the Timeline
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the commit "second" that changes "README.md" and an uncommitted edit of it
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "initial"
    And I pick "Reset Current Branch to Here…" in the commit menu
    And I pick the reset mode "hard"
    Then the reset dialog shows the command "reset --hard --no-recurse-submodules"
    And the reset dialog lists the lost file "README.md"
    And I capture "reset-dialog"
    When I overwrite "README.md" on disk with "changed again"
    And I confirm the reset dialog
    Then the Graph shows the error "Files changed since the dialog opened"
    And I capture "reset-stale"
    When I dismiss the Graph result line
    And I open the commit menu on the row "initial"
    And I pick "Reset Current Branch to Here…" in the commit menu
    And I pick the reset mode "hard"
    And I confirm the reset dialog
    Then the Graph result line says "Reset main to"
    And the last commit of the project is "initial"
    And the work tree of the project is clean
    And I capture "reset-done"
    When I open the Files tab of the side panel
    And I open the tree file "README.md"
    And I open the Timeline
    Then the Timeline lists "Before reset, initial"
    When I choose "Restore" in the menu of the Timeline row "Before reset"
    And I close the file tree drawer
    Then the Files editor text is "changed again"
    And I capture "reset-restored"
