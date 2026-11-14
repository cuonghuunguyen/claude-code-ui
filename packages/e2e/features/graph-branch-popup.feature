Feature: The Graph branch popup searches branches and offers branch actions, in dark mode, on a phone and by keyboard (GH-671)

  Scenario: Speed search narrows the list, Enter filters the graph, Esc clears the query first
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    Then the branch popup search box is focused
    And the branch popup lists "main"
    And the branch popup lists "topic"
    And the branch popup does not list "origin/main"
    When I type "top" in the branch popup
    Then the branch popup lists "topic"
    And the branch popup does not list "main"
    And I capture "popup-search"
    When I press "Escape" in the branch popup
    Then the branch popup search box is empty
    And the branch popup lists "main"
    When I type "top" in the branch popup
    And I press "Enter" in the branch popup
    Then the Graph branch filter shows "topic"
    And I capture "popup-filtered"

  Scenario: Commit and chip menus, keyboard order, typing from the actions, outside press, actions per branch and Checkout
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    Then the commit menu lists in order "Copy Revision Number, Cherry-Pick, Compare with Local, Compare Before with Local, Reset Current Branch to Here…, Revert Commit, Undo Commit, Edit Commit Message…, New Branch…, New Tag…"
    And the commit menu has no "Fetch all remotes"
    And the commit menu has no "Merge"
    And I capture "commit-menu-order"
    When I press "Escape" in the branch popup
    And I open the branch menu on the chip "refs/heads/main"
    Then the branch chip menu offers "Push"
    And the branch chip menu does not offer "Checkout"
    And the branch chip menu does not offer "Merge into main…"
    And I capture "chip-menu"
    When I press "Escape" in the branch popup
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
    When I open the Graph branch popup
    And I open the actions of the branch "topic" in the branch popup
    And I type "top" in the branch popup
    Then the branch popup search box has the value "top"
    And the branch popup does not list "main"
    And I capture "popup-type-from-actions"
    When I click outside the branch popup
    Then the branch popup is closed
    When I open the Graph branch popup
    And I type "top" in the branch popup
    And I click outside the branch popup
    Then the branch popup is closed
    When I open the Graph branch popup
    And I open the actions of the branch "topic" in the branch popup
    And I click outside the branch popup
    Then the branch popup is closed
    And I capture "popup-outside-press"
    When I open the Graph branch popup
    And I open the actions of the branch "main" in the branch popup
    Then the branch popup actions offer "Push"
    And the branch popup actions do not offer "Checkout"
    And I capture "popup-actions-current"
    When I press "ArrowLeft" in the branch popup actions
    And I open the actions of the branch "topic" in the branch popup
    Then the branch popup actions offer "Checkout"
    When I pick "Checkout" in the branch popup actions
    Then the Graph result line says "Checked out topic"
    And the project is on the branch "topic"
    And I capture "popup-checkout"

  Scenario: Dark mode shows the popup, its actions and the commit menu legibly on a desktop and a phone, with 44px buttons
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
    When I press "Escape" in the branch popup
    Given the viewport is 390x844
    When I open the Graph branch popup
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
    When I press "Escape" in the branch popup
    And I open the Graph branch popup
    Then every branch popup action button is at least 44px high
    And the scrollWidth of the page is 390
    And I capture "popup-phone"
    When I open the actions of the branch "topic" in the branch popup
    Then the branch popup search box is hidden
    And I capture "phone-actions"
    When I type "top" in the branch popup
    Then the branch popup actions are closed
    And the branch popup search box has the value "top"
    And the branch popup lists "topic"
    And the branch popup does not list "main"
    And I capture "phone-typed-from-actions"
    When I press "Escape" in the branch popup
    And I press "Escape" in the branch popup
    Then the branch popup is closed
    When I open the branch menu on the chip "refs/heads/main"
    Then every branch menu item is at least 44px high
    And the scrollWidth of the page is 390
    And I capture "phone-menu"
    When I pick "Push" in the branch menu
    Then the "push" dialog shows the command "refs/heads/main:refs/heads/main"
    And the scrollWidth of the page is 390
    And I capture "phone-dialog"
