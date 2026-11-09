Feature: Graph branch popup in dark mode, on a phone and by keyboard (GH-671)

  Scenario: Dark mode desktop shows the popup, its actions and the commit menu legibly
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And a Haiku session with one finished reply
    And the mode is "dark"
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    Then the branch popup marks the current branch
    And I capture "dark-popup"
    When I type "ma" in the branch popup
    Then the branch popup highlights the match "ma"
    And I capture "dark-search"
    When I open the actions of the branch "main" in the branch popup
    Then the branch popup actions show "Force push…" in red
    And I capture "dark-actions"
    When I press "Escape" in the branch popup
    And I press "Escape" in the branch popup
    And I press "Escape" in the branch popup
    Then the branch popup is closed
    When I open the commit menu on the row "local work"
    Then the commit menu shows "Reset Current Branch to Here…" in red
    And I capture "dark-commit-menu"

  Scenario: Dark mode phone shows the popup, its actions and the commit menu legibly
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And a Haiku session with one finished reply
    And the mode is "dark"
    And the viewport is 390x844
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    Then the branch popup marks the current branch
    And I capture "dark-phone-popup"
    When I type "ma" in the branch popup
    Then the branch popup highlights the match "ma"
    And I capture "dark-phone-search"
    When I open the actions of the branch "main" in the branch popup
    Then the branch popup actions show "Force push…" in red
    And the scrollWidth of the page is 390
    And I capture "dark-phone-actions"
    When I press "Escape" in the branch popup
    And I press "Escape" in the branch popup
    And I press "Escape" in the branch popup
    Then the branch popup is closed
    When I open the commit menu on the subject "local work"
    Then the commit menu shows "Reset Current Branch to Here…" in red
    And the scrollWidth of the page is 390
    And I capture "dark-phone-commit-menu"

  Scenario: On a phone a key typed in the actions returns to the list with the key in the query
    Given the viewport is 390x844
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    And I open the actions of the branch "topic" in the branch popup
    Then the branch popup search box is hidden
    And I capture "phone-actions"
    When I type "top" in the branch popup
    Then the branch popup actions are closed
    And the branch popup search box has the value "top"
    And the branch popup lists "topic"
    And the branch popup does not list "main"
    And I capture "phone-typed-from-actions"

  Scenario: Keyboard order, the Esc order and the collapsed Remote group
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    Then the branch popup does not list "origin/main"
    When I click the "Remote" header of the branch popup
    Then the branch popup lists "origin/main"
    When I click the "Remote" header of the branch popup
    Then the branch popup does not list "origin/main"
    When I type "origin" in the branch popup
    Then the branch popup lists "origin/main"
    And I press "Escape" in the branch popup
    Then the branch popup does not list "origin/main"
    When I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowUp" in the branch popup
    Then the active branch popup row is "main"
    When I press "ArrowDown" in the branch popup
    And I press "ArrowRight" in the branch popup
    Then the branch popup actions offer "Checkout"
    And I capture "keyboard-actions"
    When I press "ArrowLeft" in the branch popup actions
    Then the branch popup actions are closed
    And the branch popup search box is focused
    When I press "ArrowRight" in the branch popup
    And I type "to" in the branch popup
    Then the branch popup search box has the value "to"
    And the branch popup lists "topic"
    Then the branch popup actions offer "Checkout"
    When I press "Escape" in the branch popup
    Then the branch popup actions are closed
    And the branch popup search box has the value "to"
    When I press "Escape" in the branch popup
    Then the branch popup search box is empty
    Then the active branch popup row is "All branches"
    When I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    Then the active branch popup row is "topic"
    When I press "ArrowRight" in the branch popup
    Then the branch popup actions offer "Checkout"
    When I press "Escape" in the branch popup
    Then the branch popup actions are closed
    And the branch popup lists "topic"
    When I press "Escape" in the branch popup
    Then the branch popup is closed
    When I open the Graph branch popup
    Then the branch popup search box is focused
    When I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    And I press "ArrowDown" in the branch popup
    Then the active branch popup row is "topic"
    When I press "Enter" in the branch popup
    Then the Graph branch filter shows "topic"
    And I capture "keyboard-enter"

  Scenario: The commit menu keeps commit actions only and a branch chip opens the branch actions
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    Then the commit menu lists in order "Copy Revision Number, Cherry-Pick, Reset Current Branch to Here…, Revert Commit, Undo Commit, New Branch…"
    And the commit menu has no "Fetch all remotes"
    And the commit menu has no "Merge"
    And I capture "commit-menu-order"
    When I press "Escape" in the branch popup
    And I open the branch menu on the chip "refs/heads/main"
    Then the branch chip menu offers "Push"
    And the branch chip menu does not offer "Checkout"
    And the branch chip menu does not offer "Merge into main…"
    And I capture "chip-menu"
