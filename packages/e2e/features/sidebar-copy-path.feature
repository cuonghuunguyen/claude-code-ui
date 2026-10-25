Feature: Sidebar Copy path on project and worktree rows

  Scenario: Project row right click copies the project path
    Given the viewport is 1440x900
    And the scratch project is a git repository with its own worktree
    And the browser may use the clipboard
    And the app is open
    And I open the scratch project
    When I right click the scratch project row
    Then the row menu has "Copy path" in its own section near the top
    And I capture "project-menu"
    When I choose "Copy path" in the row menu
    Then the clipboard holds the scratch project path
    And a toast says "Copied path"
    And I capture "project-copied"

  Scenario: Worktree row right click copies the worktree path
    Given the viewport is 1440x900
    And the scratch project is a git repository with its own worktree
    And the browser may use the clipboard
    And the app is open
    And I open the scratch project
    When I right click the scratch worktree row
    Then the row menu has "Copy path" in its own section near the top
    And I capture "worktree-menu"
    When I choose "Copy path" in the row menu
    Then the clipboard holds the scratch worktree path
    And a toast says "Copied path"
    And I capture "worktree-copied"

  Scenario: Keyboard opens the menu with Copy path
    Given the viewport is 1440x900
    And the scratch project is a git repository with its own worktree
    And the browser may use the clipboard
    And the app is open
    And I open the scratch project
    When I focus the scratch project row and press "Shift+F10"
    Then the row menu has "Copy path" in its own section near the top
    And I capture "project-shift-f10"
    When I close the row menu
    And I focus the scratch worktree row and press "ContextMenu"
    Then the row menu has "Copy path" in its own section near the top
    And I capture "worktree-context-menu-key"
    When I choose "Copy path" in the row menu
    Then the clipboard holds the scratch worktree path
    And a toast says "Copied path"
    And I capture "worktree-copied-by-key"

  Scenario: Phone kebab menu has Copy path
    Given the viewport is 390x844
    And the scratch project is a git repository with its own worktree
    And the browser may use the clipboard
    And the app is open
    And I open the scratch project
    When I open the kebab menu of the scratch project row
    Then the row menu has "Copy path" in its own section near the top
    And the row menu items are at least 44px high
    And the page has no horizontal scroll
    And the page is exactly 390px wide
    And I capture "phone-project-kebab"
    When I choose "Copy path" in the row menu
    Then the clipboard holds the scratch project path
    And a toast says "Copied path"
    When I open the kebab menu of the scratch worktree row
    Then the row menu has "Copy path" in its own section near the top
    And the row menu items are at least 44px high
    And I capture "phone-worktree-kebab"

  Scenario: Clipboard denied shows the path in the error toast
    Given the viewport is 1440x900
    And the scratch project is a git repository with its own worktree
    And the browser denies the clipboard
    And the app is open
    And I open the scratch project
    When I right click the scratch project row
    And I choose "Copy path" in the row menu
    Then an error toast says "Copy failed" and ends with the scratch project path
    And I capture "clipboard-denied"
