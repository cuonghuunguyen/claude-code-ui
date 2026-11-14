Feature: View cache

  Scenario Outline: A reloaded page shows the open session before the daemon answers
    Given the viewport is <size>
    And the page's connection to the daemon can be held
    And a Haiku session with one finished reply
    And the view cache has saved the finished session
    When the connection to the daemon is held
    And I reload the page without waiting for the connection
    Then the connection status is not connected
    And I see my prompt in the transcript
    And I see a reply from Claude
    And I capture "<name>-cached"
    When the connection to the daemon is released
    Then the app is connected
    And the shown session still has 1 prompt and 1 reply
    And the turn has finished
    And the page has no horizontal scroll
    And I capture "<name>"

    Examples:
      | size     | name                 |
      | 1440x900 | view-cache-wide      |
      | 390x844  | view-cache-phone     |

  Scenario: A reload shows the cached turn first and the turn finished in another page after release
    Given the viewport is 1440x900
    And the page's connection to the daemon can be held
    And a Haiku session with one finished reply
    And the view cache has saved the finished session
    When I leave the page
    And another page of the same browser finishes a second turn in the session
    And the connection to the daemon is held
    And I open the app again without waiting for the connection
    And I switch to session tab 1
    Then the connection status is not connected
    And the shown session has 1 prompt and 1 reply
    And I capture "view-cache-second-turn-cached"
    When the connection to the daemon is released
    Then the app is connected
    And the shown session has 2 prompts and 2 replies
    And the turn has finished
    And the page has no horizontal scroll
    And I capture "view-cache-second-turn"

  Scenario: After a daemon restart the reloaded page shows the cached session, then the same view as a fresh load
    Given the viewport is 1440x900
    And the page's connection to the daemon can be held
    And a Haiku session with one finished reply
    And the view cache has saved the finished session
    When the connection to the daemon is held
    And I restart the daemon
    And I reload the page without waiting for the connection
    Then the connection status is not connected
    And I see my prompt in the transcript
    And I see a reply from Claude
    And the cached session shows its cost footer
    And I capture "view-cache-restart-cached"
    When the connection to the daemon is released
    Then the app is connected
    And the resume reply of the session carries refs for the cached parts
    And the resume reply of the session sends no cached part in full
    And the shown session still has 1 prompt and 1 reply
    And the shown session has no cost footer
    And the part ids of the shown session equal those of a fresh page
    And I capture "view-cache-restart-resynced"

  Scenario: The app works without IndexedDB
    Given browser storage is blocked
    And a Haiku session with one finished reply
    When I reload the page
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the shown session still has 1 prompt and 1 reply
    And the turn has finished
    And the page has no horizontal scroll
    And I capture "view-cache-no-indexeddb"

  Scenario: Unpairing clears the session cache
    Given a Haiku session with one finished reply
    And the view cache has saved the finished session
    When the stored pairing token is replaced by a wrong one and the page reloads
    Then the pairing form shows
    And the view cache holds no session
    And I capture "view-cache-unpaired"
