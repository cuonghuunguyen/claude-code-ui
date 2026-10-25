Feature: Files and Git graph in the main area

  Scenario: Files moves to the main area and keeps its editor tabs while hidden
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    Then the "Files" tab opens right of its session tab and has the focus
    And the "Files" tab is labeled with the scratch project name
    And the side panel has no "Files" tab
    When I open the file "README.md" in the Files tab
    Then the Files tab shows the file "README.md"
    And I capture "files-main-open-file"
    When I click the first session tab
    And I click the "Files" tab
    Then the Files tab shows the file "README.md"
    And I capture "files-main-kept"

  Scenario: Keys open or focus the tab of the current session, one tab per project folder
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    And I move the "Git graph" pane to the main area from its tab menu
    And I close the "Files" tab from its tab menu
    Then there is no "Files" tab
    When I press "Control+Shift+E"
    Then there is one "Files" tab
    And the "Files" tab has the focus
    When I open a second session with a finished reply
    And I press "Control+Shift+E"
    Then there is one "Files" tab
    And the "Files" tab has the focus
    When I press "Control+Shift+H"
    Then there is one "Git graph" tab
    And the "Git graph" tab has the focus
    And I capture "keys-one-tab-per-folder"
    When I open the New session tab
    And I press "Control+Shift+E"
    Then there is one "Files" tab
    And the "Files" tab has the focus
    And I capture "keys-from-new-session"

  Scenario: Git graph shows alone while sessions are split and the split returns
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I open a second session with a finished reply
    And I move the "Git graph" pane to the main area from its tab menu
    And I click the second session tab
    And I split the two sessions one above the other
    Then the session area is split
    When I click the "Git graph" tab
    Then the session area is not split
    And the "Git graph" tab has the focus
    When I select the first commit in the Git graph
    Then the Git graph keeps the selected commit
    And I capture "graph-alone"
    When I click the first session tab
    Then the session area is split
    And I capture "split-returns"
    When I click the "Git graph" tab
    Then the Git graph keeps the selected commit

  Scenario: Moving Files back to the side panel closes its tabs with Undo
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    And I choose "Move Files to side panel" in the menu of the "Files" tab
    Then a toast says "Closed 1 Files tab"
    And there is no "Files" tab
    And the side panel lists the "Files" tab
    And I capture "files-closed-toast"
    When I click Undo in the toast
    Then there is one "Files" tab
    And the side panel has no "Files" tab
    And I capture "files-undo"

  Scenario: Changes offers no Move to main area
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    Then the side panel has no Changes "Move to main area" item
    And I capture "changes-menu"

  Scenario: Files and Git graph tabs survive a reload and Reset layout closes them
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    And I move the "Git graph" pane to the main area from its tab menu
    And I reload the page
    Then the sidebar lists the scratch project
    And there is one "Files" tab
    And there is one "Git graph" tab
    And I capture "reloaded"
    When I choose Reset layout in the side panel menu
    Then there is no "Files" tab
    And there is no "Git graph" tab
    And a toast says "Closed 2 pane tabs"
    And the side panel lists the "Files" tab
    And the side panel lists the "Git graph" tab
    And I capture "reset"

  Scenario: Phone lists the Files and Git graph tabs in the tab switcher
    Given the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    And I move the "Git graph" pane to the main area from its tab menu
    And the viewport is 390x844
    And I dismiss the open toasts
    And I open the tab switcher
    Then the tab switcher lists a "Files" row
    And the tab switcher lists a "Git graph" row
    And the page has no horizontal scroll
    And I capture "phone-switcher"
    When I pick the "Git graph" row in the tab switcher
    Then the page has no horizontal scroll
    And I capture "phone-graph"
