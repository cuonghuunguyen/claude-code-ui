Feature: Restart the daemon

  Scenario: The transcript comes back after a daemon restart
    Given a Haiku session with one finished reply
    And I capture "before-restart"
    When I restart the daemon
    Then the app is connected
    When I reload the page
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And I capture "after-restart"
