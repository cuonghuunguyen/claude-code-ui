Feature: A session whose transcript was deleted leaves the list (GH-635)

  Scenario: After a restart the session is restored; deleting its transcript file drops its row on the next list instead of showing "New session"
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I restart the daemon
    And I reload the page
    And I delete the transcript file of the open session
    And I reload the page
    Then the sidebar has no row for the deleted session
    And the sidebar has no row titled "New session"
    And I capture "session-transcript-deleted"
