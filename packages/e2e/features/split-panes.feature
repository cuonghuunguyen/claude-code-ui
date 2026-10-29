Feature: Split view with a session and one of its panes

  Scenario: A session beside its Plan, then its Terminal
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I move the "Terminal" pane to the main area from its tab menu
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    Then the session area is split
    And the "Plan" tab is shown in a split
    And the active split shows the "Plan" tab
    And I capture "session-plan-split"
    When I click the "Terminal" tab
    Then the "Terminal" tab is shown in a split
    And the "Plan" tab is not shown in a split
    And I capture "session-terminal-split"
    When I reload the page
    Then the session area is split
    And the "Terminal" tab is shown in a split
    And I capture "split-restored"

  Scenario: Split items refuse Git graph
    Given the viewport is 1440x900
    And the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I move the "Git graph" pane to the main area from its tab menu
    And I open the menu of the "Git graph" tab
    Then the menu item "Split right" is disabled
    And the menu item "Split down" is disabled
    And the menu shows "Git graph needs the whole area"
    And I capture "graph-menu-refused"
    When I close the menu
    And I hold the "Git graph" tab over the right edge of the session area
    Then the drop overlay says "Git graph needs the whole area"
    And I capture "graph-drop-refused"
    When I release the mouse
    Then the session area is not split

  Scenario: Files beside a second session; the docks and the palette follow the owner
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    And I open a second session with a finished reply
    And I choose "Split right" in the menu of the "Files" tab
    Then the session area is split
    And the "Files" tab is shown in a split
    And the sidebar highlights the first session
    When I run "Focus prompt" from the command palette
    Then the prompt box of the session split has the focus
    And I capture "files-other-session-split"

  Scenario: The hidden-split rules stay the same
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    Then the "Plan" tab is shown in a split
    Given the viewport is 1000x800
    Then the session area is not split
    And I capture "split-narrow-1000"
    Given the viewport is 390x844
    Then the session area is not split
    And the scrollWidth of the page is 390
    And I capture "split-phone-390"
