Feature: I'll be back: mark a reply, get a brief written by the session, and a reminder

  Scenario: One click marks a reply and the session writes the brief
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: OK"
    Then the turn has finished
    When I mark the last reply with I'll be back
    Then the I'll be back panel has the brief rows
    And the timeline has one collapsed brief row and no tagged prompt
    And the marked button is named "Marked: go to the mark"
    And I capture "back mark brief"
    When I reload the page
    Then the I'll be back panel has the brief rows
    And I capture "back mark after reload"

  Scenario: Interval validation, a reminder in Focus, the card, Open and Done
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: OK"
    Then the turn has finished
    When I mark the last reply with I'll be back
    Then the I'll be back panel has the brief rows
    When I set the reminder "abc" in the panel
    Then the panel shows an interval error "Use a number and m, h or d, e.g. 30m, 2h, 1d"
    When I set the reminder "0m" in the panel
    Then the panel shows an interval error "At least 1m"
    When I set the reminder "8d" in the panel
    Then the panel shows an interval error "At most 7d"
    When I set the reminder "1m" in the panel
    Then the panel shows "in 1m"
    When I open Focus
    Then Focus lists the mark under "Come back to"
    And I capture "back focus list"
    Then the reminder card shows Open, Snooze 1m and Dismiss
    And I capture "back reminder card"
    When I click Open on the reminder card
    Then the I'll be back panel has the focus
    And the transcript still has 1 brief row
    When I click Done in the panel
    Then no I'll be back panel is shown
    And I capture "back mark done"

  Scenario: The panel and the Focus list fit a phone
    Given the viewport is 390x844
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: OK"
    Then the turn has finished
    When I mark the last reply with I'll be back
    Then the I'll be back panel has the brief rows
    And the page has no horizontal scroll
    And I capture "back mark phone"
