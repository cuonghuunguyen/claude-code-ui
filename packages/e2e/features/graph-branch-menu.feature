Feature: The Git graph branch menu pushes, force pushes with a lease and pulls (GH-309)

  Scenario: Pull is fast-forward only, a branch in another worktree has Pull disabled, then Push asks first with the exact command
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the origin's main has the commit "remote work" and the project fetched it
    And the branch "feat/remote" tracks origin and is checked out in another worktree
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Pull" in the branch menu
    Then the "pull" dialog shows the command "pull --no-recurse-submodules --no-rebase --ff-only origin refs/heads/main"
    When I confirm the "pull" dialog
    Then the Graph result line says "Pulled main"
    And the Graph shows the commit "remote work"
    When I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feat/remote"
    Then the branch menu item "Pull" is disabled and says "Checked out in"
    And I capture "pull-other-worktree"
    When I press "Escape" in the branch popup
    Given the scratch project's main has the local commit "local work"
    When I click Refresh in the Graph
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Push" in the branch menu
    Then the "push" dialog shows the command "push --no-recurse-submodules --no-follow-tags origin refs/heads/main:refs/heads/main"
    And I capture "push-dialog"
    When I confirm the "push" dialog
    Then the Graph result line says "Pushed main to origin"
    And the origin's main is the project's main
    And I capture "pushed"

  Scenario: The daemon refuses a stale pull and a stale push, then force push only with the lease and Cancel runs nothing
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work"
    And the origin's main has the commit "remote work" and the project fetched it
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Pull" in the branch menu
    Then the "pull" dialog shows the command "--ff-only"
    When the origin's main has the commit "moved later" and the project fetched it
    And I confirm the "pull" dialog
    Then the Graph shows the error "origin/main moved since the menu opened"
    And the origin's main is not the project's main
    And I capture "stale-pull"
    When I dismiss the Graph result line
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Push" in the branch menu
    Then the "push" dialog shows the command "refs/heads/main:refs/heads/main"
    When the origin's main has the commit "moved again" and the project fetched it
    And I confirm the "push" dialog
    Then the Graph shows the error "origin/main moved since the menu opened"
    And I capture "stale-push"
    When I dismiss the Graph result line
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Force push…" in the branch menu
    Then the force push dialog leases origin's main
    And I capture "force-dialog"
    When I cancel the "force push" dialog
    Then the origin's main is not the project's main
    When I open the branch menu on the chip "refs/heads/main"
    And I pick "Force push…" in the branch menu
    And I confirm the "force push" dialog
    Then the Graph result line says "Pushed main to origin (forced)"
    And the origin's main is the project's main
    And I capture "force-pushed"
