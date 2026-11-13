Feature: A session restored from its transcript shows no title skeleton (GH-634)

  Scenario: An idle restored session with a placeholder title shows no skeleton
    Given the viewport is 1440x900
    And a Haiku session that has read "notes-634.txt"
    When I restart the daemon
    Then the app is connected
    When I reload the page
    Then no title skeleton shows in the sidebar or the tab strip
    And I capture "restored-no-skeleton"
