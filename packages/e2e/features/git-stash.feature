Feature: Stash in the Git graph (GH-563)

  Scenario: Stash and pop round trip, on a desktop and on a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the committed file "a.txt" with the text "base"
    And a Haiku session with one finished reply
    When I edit "a.txt" on disk to "edited"
    And I open the Graph tab of the side panel
    And I open the Stashes section of the Graph
    And I stash the changes with the message "my wip"
    Then the Graph result line says "Stashed"
    And the stash "my wip" is listed
    And the project has 1 stash entry
    And the file "a.txt" has the text "base"
    And I capture "stash-pushed"
    When I click "Pop" on the stash "my wip"
    Then the Graph result line says "Popped stash@{0}"
    And the file "a.txt" has the text "edited"
    And the project has 0 stash entries
    And no stash is listed
    Given the viewport is 390x844
    When I edit "a.txt" on disk to "edited again"
    And I open the Graph tab of the side panel
    And I open the Stashes section of the Graph
    And I stash the changes with the message "phone wip"
    Then the stash "phone wip" is listed
    And the page has no horizontal scroll
    And I capture "stash-phone"
