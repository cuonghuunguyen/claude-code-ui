Feature: Split view with a session and one of its panes

  Scenario: A session beside its Plan, then its Terminal
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I toggle the terminal from the titlebar
    And I move the Plan pane to the main area from its tab menu
    And I move the "Terminal" pane to the main area from its tab menu
    And I hide the side panel
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    Then the session area is split
    And the "Plan" tab is shown in a split
    And the active split shows the "Plan" tab
    And the command palette lists "Change permission mode"
    And I capture "session-plan-split"
    When I click the "Terminal" tab
    Then the "Terminal" tab is shown in a split
    And the "Plan" tab is not shown in a split
    And I capture "session-terminal-split"
    When I reload the page
    Then the session area is split
    And the "Terminal" tab is shown in a split
    And the terminal of the split is ready
    And I capture "split-restored"

  Scenario: An activated pane never replaces the only session of the split
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I toggle the terminal from the titlebar
    And I move the Plan pane to the main area from its tab menu
    And I move the "Terminal" pane to the main area from its tab menu
    And I hide the side panel
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    And I click the first session tab
    Then the session split is active
    When I click the "Terminal" tab
    Then the session area is split
    And the session split is shown
    And the "Terminal" tab is shown in a split
    And the "Plan" tab is not shown in a split
    And I capture "pane-keeps-session"

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
    And I click the first session tab
    And I hide the side panel
    And I hold the "Git graph" tab over the right edge of the session area
    Then the drop overlay says "Git graph needs the whole area"
    And I capture "graph-drop-refused"
    When I release the mouse
    Then the session area is not split

  Scenario: A drop that leaves no session is refused
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I toggle the terminal from the titlebar
    And I move the Plan pane to the main area from its tab menu
    And I move the "Terminal" pane to the main area from its tab menu
    And I hide the side panel
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    Then the "Plan" tab is shown in a split
    When I hold the "Terminal" tab over the session split
    Then the drop overlay says "A split needs a session"
    And I capture "drop-needs-session"
    When I release the mouse
    Then the "Plan" tab is shown in a split
    And the session split is shown
    And the "Terminal" tab is not shown in a split

  Scenario: Files beside a second session; the docks and the palette follow the owner
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I move the "Files" pane to the main area from its tab menu
    And I hide the side panel
    And I open a second session with a finished reply
    And I choose "Split right" in the menu of the "Files" tab
    Then the session area is split
    And the "Files" tab is shown in a split
    And the sidebar highlights the first session
    And the command palette does not list "Change permission mode"
    When I run "Focus prompt" from the command palette
    Then the prompt box of the session split has the focus
    And the sidebar highlights the session of the session split
    And I capture "files-other-session-split"

  Scenario: The hidden-split rules stay the same
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I hide the side panel
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    Then the "Plan" tab is shown in a split
    Given the viewport is 1000x800
    Then the session area is not split
    And I capture "split-narrow-1000"
    Given the viewport is 390x844
    When I reload the page
    Then the session area is not split
    And the scrollWidth of the page is 390
    And I capture "split-phone-390"

  Scenario: A split with a Terminal tab keeps each folder's selected terminal across a reload
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I hide the side panel
    And I open the terminal with the shortcut
    And I click the Terminal tab New terminal button
    And I select "Terminal 1" in the Terminal tab
    And I open a session in a second project folder with a finished reply
    And I open the terminal with the shortcut
    And I click the Terminal tab New terminal button
    And I click the Terminal tab of the first project
    And I choose "Split right" in the menu of the "Terminal" tab
    Then the session area is split
    When I reload the page
    Then the session area is split
    And the terminal of the split is ready
    And the Terminal tab selects "Terminal 1"
    When I click the Terminal tab of the second project
    Then the Terminal tab selects "Terminal 2"
    And I capture "split-terminal-selected-per-folder"

  Scenario: Typing works right after splitting a Terminal tab
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    And I click the first session tab
    And I hide the side panel
    And I choose "Split right" in the menu of the "Terminal" tab
    Then the session area is split
    And the shell has the focus within 5 seconds
    When I type "echo split-focus-ok" on the keyboard and press Enter
    Then the terminal shows "split-focus-ok" on a line of its own
    And I capture "split-terminal-focus"

  Scenario: The terminal fits its split
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    And I click the first session tab
    And I hide the side panel
    And I choose "Split right" in the menu of the "Terminal" tab
    Then the terminal of the split is ready
    And the terminal columns fit its split
    When I reload the page
    Then the terminal of the split is ready
    And the terminal columns fit its split
    And I capture "split-terminal-cols"

  Scenario: A cramped split with a pane active shows the pane alone
    Given the viewport is 1700x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I open the menu of the plan tab
    And I choose "Split right" in the plan tab menu
    Then the active split shows the "Plan" tab
    Given the viewport is 1024x800
    Then the session area is not split
    And the split hint is shown
    And the plan tab is the selected tab
    And I capture "split-cramped-pane-1100"
    Given the viewport is 1700x900
    Then the session area is split
    And the active split shows the "Plan" tab
