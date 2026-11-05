Feature: New branch, Checkout and Smart checkout from the Graph branch menu (GH-561)

  Scenario: New branch from a commit row is checked out, on a desktop and on a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the branch menu on the commit row "initial"
    And I create the branch "topic" from the branch menu
    Then the Graph result line says "Created and checked out topic"
    And the project is on the branch "topic"
    And the project branch "topic" is at the commit "initial"
    And the scrollWidth of the page is 1440
    And I capture "new-branch"
    Given the viewport is 390x844
    When I open the branch menu on the commit row "initial"
    And I create the branch "phone-topic" from the branch menu
    Then the Graph result line says "Created and checked out phone-topic"
    And the project is on the branch "phone-topic"
    And the page has no horizontal scroll
    And I capture "new-branch-phone"

  Scenario: Checkout of a remote branch creates a tracking local branch
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/remotes/origin/feat/remote"
    And I click the branch menu item "branch-checkout-remote"
    Then the Graph result line says "Checked out"
    And the project is on the branch "feat/remote"
    And the project branch "feat/remote" tracks "origin/feat/remote"
    And I capture "remote-checkout"

  Scenario: A conflicting local edit opens the Smart checkout dialog, which keeps the edit on the new branch
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And the scratch project has the uncommitted text "one\ntwo\nthree\nfour\nfive edited\n" in "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/topic"
    And I click the branch menu item "branch-checkout"
    Then the Smart checkout dialog shows git's message about "a.txt"
    And the project is on the branch "main"
    And I capture "smart-dialog"
    When I confirm the Smart checkout dialog
    Then the project is on the branch "topic"
    And the file "a.txt" contains "topic"
    And the file "a.txt" contains "five edited"
    And the project has 0 stash entries
    And I capture "smart-done"

  Scenario: A Smart checkout whose pop conflicts shows the conflict banner
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And the scratch project has the uncommitted text "local" in "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feature"
    And I click the branch menu item "branch-checkout"
    And I confirm the Smart checkout dialog
    Then the Graph result line says "applying your changes stopped on conflicts"
    And the project is on the branch "feature"
    And the project has 1 stash entry
    When I open the Changes tab of the side panel
    Then the conflict banner says "Unmerged files" and lists "a.txt"
    And I capture "smart-conflict"

  Scenario: A branch checked out in another worktree is refused with git's reason
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the branch "feat/remote" tracks origin and is checked out in another worktree
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feat/remote"
    And I click the branch menu item "branch-checkout"
    Then the Graph shows the error "worktree"
    And the project is on the branch "main"
    And I capture "other-worktree"
