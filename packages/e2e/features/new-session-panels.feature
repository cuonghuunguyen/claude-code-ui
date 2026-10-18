Feature: The new-session tab shows the side and bottom panels

  Scenario: The panels are there before the first prompt and stay as they are after it
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then the side panel shows
    And a terminal shows in the bottom panel
    And I capture "draft panels"
    When I note the panel layout
    And I send "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And the panel layout is unchanged
    And the turn has finished
    And the panel layout is unchanged
    And I capture "after send"

  Scenario: Changes on the new-session tab shows an empty state
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    Then the side panel shows
    And the Changes tab shows its empty state
    And I capture "draft changes"

  Scenario: A remembered terminal starts no shell after a reload
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I restart the daemon
    Then the app is connected
    When I remember to count terminal requests
    And I reload the page
    And I start a new Haiku session
    Then the bottom panel is hidden
    And no shell is open
    And the page sent no terminal request since the reload
    And I capture "no shells after reload"
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    And the page sent one terminal request
    And I capture "one shell after toggle"

  Scenario: Narrow screens show no panels on the new-session tab
    Given the viewport is 390x844
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    Then no side or bottom panel shows
    And the page has no horizontal scroll
    And I capture "narrow draft"
