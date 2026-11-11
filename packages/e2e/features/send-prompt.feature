Feature: Send a prompt

  Scenario: The reply streams into the transcript and comes back after a daemon restart
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the turn has finished
    And I capture "reply"
    When I restart the daemon
    Then the app is connected
    When I reload the page
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And I capture "after-restart"
