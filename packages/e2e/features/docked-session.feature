Feature: A session shown in the side or bottom panel

  Scenario: A session in the side panel keeps working: permission, file link, quote, palette, reload, image, narrow screens, Close
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I move the first session to the "side" panel from its tab menu
    Then the tab strip has 1 session tab
    And the "side" panel has a selected session tab with a timeline and a prompt box
    And the active session tab is not the docked session
    When I send "Use the Bash tool to run exactly this command and nothing else: echo e2e > probe.txt" in the docked prompt box
    Then the docked panel shows a permission request
    And the docked tab is marked "needs input"
    And I capture "docked-permission"
    When I allow the permission request in the docked panel
    Then the docked turn has finished
    When I send "Reply with exactly the absolute path of the file probe.txt in the current folder, in backticks" in the docked prompt box
    Then the docked session shows a reply
    And the docked reply has a file link
    And the docked turn has finished
    When I select the docked reply text and click Quote
    Then the docked prompt box starts with ">"
    And the main prompt box is empty
    And I capture "docked-quote"
    When I click the file link in the docked reply
    Then the file dialog shows "probe.txt"
    And I capture "docked-file-link"
    When I press "Escape"
    And I open the command palette and search the docked session
    Then its palette row has the open mark
    And I capture "docked-palette"
    When I press "Escape"
    And I reload the page
    Then the "side" panel has a docked session tab
    And the tab strip has 1 session tab
    And I capture "docked-reload"
    When I choose Reset layout in the side panel menu
    Then the tab strip has 2 session tabs
    And no panel has a docked session tab
    And I capture "docked-reset"
    When I attach an image in the main prompt box
    And I move the first session to the "side" panel from its tab menu
    Then the docked prompt box shows 1 image
    When I choose "Move to main area" in the docked tab menu
    Then the tab strip has 2 session tabs
    And no panel has a docked session tab
    And the main prompt box shows 1 image
    And I capture "docked-image"
    When I move the first session to the "side" panel from its tab menu
    And the viewport is 1000x800
    Then the tab bar lists 2 sessions
    And the page has no horizontal scroll
    And I capture "docked-narrow-1000"
    When the viewport is 390x844
    Then the tab bar lists 2 sessions
    And the page has no horizontal scroll
    And I capture "docked-narrow-390"
    When the viewport is 1440x900
    And I choose "Close tab" in the docked tab menu
    Then the tab strip has 1 session tab
    And no panel has a docked session tab


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

  Scenario: A docked session keeps its plan approval actions and never shows its own plan tab
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    And I move the Plan pane to the main area from its tab menu
    And I open a second session with a finished reply
    And I select the first session tab
    When I move the first session to the "side" panel from its tab menu
    Then the active session tab is not the docked session
    And no plan tab is active
    And I capture "docked-owner-plan"
    And the docked panel shows "Open plan in popup"
    When I click "Open plan in popup" in the docked panel
    Then the plan popup shows the docked session's plan
    And I capture "docked-plan-popup"
