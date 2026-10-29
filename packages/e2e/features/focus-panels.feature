Feature: Switching to Focus or the New session tab moves no panel

  Scenario: Session tab, New session tab and Focus keep the panels in place
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I send "Reply with exactly: OK"
    Then the turn has finished
    When I note the panel layout
    And I open the New session tab
    Then the panel layout is unchanged
    And I capture "new session keeps panels"
    When I open Focus
    Then the panel layout is unchanged
    And I capture "focus keeps panels"
    When I click the first session tab
    Then the panel layout is unchanged
    And I capture "back on the session"

  Scenario: Focus restores a maximized bottom panel; Hide survives the switch
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I send "Reply with exactly: OK"
    Then the turn has finished
    When I maximize the bottom panel
    And I open Focus
    Then the bottom panel is not maximized
    And I capture "focus restores maximized"
    When I click the first session tab
    And I hide the bottom panel
    And I note the panel layout
    And I open Focus
    Then the panel layout is unchanged
    And I capture "focus hidden bottom"

  Scenario: Narrow screens show no docks on Focus
    Given the viewport is 390x844
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: OK"
    Then the turn has finished
    When I open Focus
    Then no side or bottom panel shows
    And the page has no horizontal scroll
    And I capture "narrow focus"
