Feature: Reconnect after the page was offline

  Scenario Outline: A session that changed while the page was offline shows the change after reconnect
    Given the viewport is <size>
    And the page's connection to the daemon can be cut
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Count from 1 to 40, one number per line, then write the word done."
    And I see a reply from Claude
    And the connection to the daemon is cut
    And I wait 5 seconds
    And the connection to the daemon is back
    Then the app is connected
    And I see a reply from Claude
    And the turn has finished
    And the page has no horizontal scroll
    And I capture "<name>"

    Examples:
      | size     | name                  |
      | 1440x900 | reconnect-reply-wide  |
      | 390x844  | reconnect-reply-phone |

  Scenario: A session in a background tab also shows its finished reply after reconnect
    Given the viewport is 1440x900
    And the page's connection to the daemon can be cut
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Count from 1 to 40, one number per line, then write the word done."
    And I see a reply from Claude
    And I open a second new session tab
    And I send "Reply with exactly: OK" in the new session tab
    And the connection to the daemon is cut
    And I wait 5 seconds
    And the connection to the daemon is back
    Then the app is connected
    When I switch to session tab 2
    Then the shown session has a reply from Claude
    And the shown session's turn has finished
    When I switch to session tab 1
    Then the shown session has a reply from Claude
    And the shown session's turn has finished
    And I capture "reconnect-background-tab"
