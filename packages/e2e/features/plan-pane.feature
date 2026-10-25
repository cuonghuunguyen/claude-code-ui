Feature: Plan pane

  Scenario: A plan shows in the side panel while its approval waits
    Given a Haiku session with one finished reply
    Then the side panel has no Plan tab
    When I switch the session to Plan mode
    And I send "Plan only. Call ExitPlanMode right now with its plan parameter set to a two-step markdown list: create hello.txt containing hi, verify it. Do not write any file and use no other tool."
    Then I see a permission request
    And the side panel lists the Plan tab after Git graph
    And the Plan pane shows the plan as markdown
    And the Plan pane waits for my answer
    And I capture "plan-waiting"

  Scenario: Go to request opens the session with the focus on Open plan in popup
    Given a Haiku session in Plan mode with a plan waiting for approval
    When I click Go to request in the Plan pane
    Then the focus is inside the permission request
    And the permission request is still open
    And "Open plan in popup" has the focus
    And I capture "go-to-request"

  Scenario: The plan moves to the main area as its own tab and survives a reload
    Given a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    Then the plan tab opens right of its session tab and has the focus
    And the side panel has no Plan tab
    When I go to the session tab
    And I click Open in tab on the plan card
    Then there is one plan tab and it has the focus
    And I capture "plan-tab"
    When I reload the page
    Then there is one plan tab and it has the focus
    And the plan tab is right of its session tab
    And I capture "plan-tab-reloaded"

  Scenario: Activating a plan tab makes its session current and the move applies to every session
    Given a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I keep planning in the first session
    And I open a second session with a finished reply
    Then the sidebar highlights the second session
    When I click the plan tab
    Then the sidebar highlights the session of the plan tab
    And the side panel shows panes of that session
    And the stored layout has Plan in the main area
    And I capture "plan-tab-current-session"

  Scenario: The plan tab menu offers Close, Pin and Go to session, and no split
    Given a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I open the menu of the plan tab
    Then the menu item "Split right" is disabled
    And the menu item "Split down" is disabled
    And I capture "plan-tab-menu"
    When I choose "Pin tab" in the plan tab menu
    Then the plan tab is pinned
    When I open the menu of the plan tab
    And I choose "Go to session" in the plan tab menu
    Then the session tab is active
    When I open the menu of the plan tab
    And I choose "Close tab" in the plan tab menu
    Then there is no plan tab
    And I capture "plan-tab-closed"

  Scenario: Moving Plan back to a dock closes its tabs with Undo
    Given a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I choose "Move Plan to side panel" in the plan tab menu
    Then a toast says "Closed 1 Plan tab"
    And there is no plan tab
    And the side panel lists the Plan tab after Git graph
    And I capture "closed-toast"
    When I click Undo in the toast
    Then there is one plan tab and it has the focus
    And the side panel has no Plan tab
    And I capture "undo"

  Scenario: Reset layout returns Plan to the side panel
    Given a Haiku session in Plan mode with a plan waiting for approval
    When I move the Plan pane to the main area from its tab menu
    And I choose Reset layout in the side panel menu
    Then there is no plan tab
    And the side panel lists the Plan tab after Git graph
    And I capture "reset"

  Scenario: Narrow and phone: Plan in the pane switcher and the plan tab in the tab switcher
    Given a Haiku session in Plan mode with a plan waiting for approval
    When the viewport is 900x800
    Then the pane switcher lists Plan
    And I capture "narrow-switcher"
    When the viewport is 1440x900
    And I move the Plan pane to the main area from its tab menu
    And the viewport is 390x844
    And I open the tab switcher
    Then the tab switcher lists a plan row
    And the page has no horizontal scroll
    And I capture "phone-switcher"
