Feature: A session shown in the side or bottom panel

  Scenario: A session moves to the side panel and keeps working there
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    Then the tab strip has 1 session tab
    And the "side" panel has a selected session tab with a timeline and a prompt box
    And the active session tab is not the docked session
    When I send "Reply with exactly: OK" in the docked prompt box
    Then the docked session shows a reply
    And the docked turn has finished
    And I capture "docked-side"

  Scenario: A docked session never becomes the current session
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I run "Move session to bottom panel" from the command palette
    And I open a second session with a finished reply
    And I note the page hash
    And I click a session in the sidebar that is docked
    Then the "bottom" panel has a selected session tab with a timeline and a prompt box
    And the page hash is unchanged
    And the active session tab is not the docked session
    And I capture "docked-not-current"

  Scenario: Esc stops only the docked turn
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    And I send "Use the Bash tool to run exactly this command and nothing else: for i in $(seq 1 120); do sleep 1; done" in the docked prompt box
    And I allow the permission request in the docked panel
    And I send "Use the Bash tool to run exactly this command and nothing else: for i in $(seq 1 120); do sleep 1; done" in the main prompt box
    And I allow the permission request in the main area
    And I press Escape in the docked prompt box
    Then the docked turn has finished
    And the main turn is still running
    And I capture "docked-esc"

  Scenario: A permission request shows in the dock
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    And I send "Use the Bash tool to run exactly this command and nothing else: echo e2e > probe.txt" in the docked prompt box
    Then the docked panel shows a permission request
    And the docked tab is marked "needs input"
    And I capture "docked-permission"
    When I allow the permission request in the docked panel
    Then the docked turn has finished

  Scenario: Back to the main area, and Close
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    And I choose "Move to main area" in the docked tab menu
    Then the tab strip has 2 session tabs
    And no panel has a docked session tab
    When I move the first session to the "side" panel from its tab menu
    And I choose "Close tab" in the docked tab menu
    Then the tab strip has 1 session tab
    And no panel has a docked session tab

  Scenario: Reload and Reset layout
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    And I reload the page
    Then the "side" panel has a docked session tab
    And the tab strip has 1 session tab
    And I capture "docked-reload"
    When I choose Reset layout in the side panel menu
    Then the tab strip has 2 session tabs
    And no panel has a docked session tab
    And I capture "docked-reset"

  Scenario Outline: Below the side panel's width the docked session is a normal tab at <width>x<height>
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    And the viewport is <width>x<height>
    Then the tab bar lists 2 sessions
    And the page has no horizontal scroll
    And I capture "docked-narrow-<width>"

    Examples:
      | width | height |
      | 1000  | 800    |
      | 390   | 844    |
