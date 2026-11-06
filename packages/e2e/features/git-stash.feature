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

  Scenario: Apply keeps the entry, Drop confirms and deletes it
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the committed file "a.txt" with the text "base"
    And the scratch project has the stash "kept" of "a.txt" with the text "stashed"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Stashes section of the Graph
    And I click "Apply" on the stash "kept"
    Then the Graph result line says "Applied stash@{0}"
    And the file "a.txt" has the text "stashed"
    And the project has 1 stash entry
    When I click "Drop" on the stash "kept"
    Then the stash drop dialog asks about "kept"
    And I capture "stash-drop-dialog"
    When I cancel the stash drop dialog
    Then the project has 1 stash entry
    When I click "Drop" on the stash "kept"
    And I confirm the stash drop dialog
    Then the Graph result line says "Dropped stash@{0}"
    And no stash is listed
    And the project has 0 stash entries

  Scenario: Pop that conflicts shows the conflict banner and keeps the entry
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the committed file "a.txt" with the text "base"
    And the scratch project has the stash "clash" of "a.txt" with the text "stashed"
    And the scratch project commits "a.txt" with the text "newer"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Stashes section of the Graph
    And I click "Pop" on the stash "clash"
    Then the Graph result line says "Popping stash@{0} stopped on conflicts: see the Changes tab"
    And the project has 1 stash entry
    And I capture "stash-pop-conflict"
    When I open the Changes tab of the side panel
    Then the conflict banner says "Unmerged files" and lists "a.txt"
    And I capture "stash-pop-conflict-banner"
