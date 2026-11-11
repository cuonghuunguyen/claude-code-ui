Feature: A changed submodule shows as a submodule row (GH-388)

  Scenario: A moved submodule is a submodule row in the uncommitted changes and against the branch
    Given the viewport is 1440x900
    And the scratch project is a superproject with a moved submodule
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the submodule row "libs/lib" shows a submodule badge and no line counts
    And the changes list shows "s.txt" as a normal file with line counts
    And the detail of the submodule "libs/lib" says it is "in HEAD" at the recorded commit
    And no changes error shows
    And I capture "uncommitted-moved-submodule"
    When I choose the "Against branch" diff mode
    Then the submodule row "libs/lib" shows a submodule badge and no line counts
    And the detail of the submodule "libs/lib" says it is "at the merge base" at the recorded commit
    And no changes error shows
    And I capture "branch-moved-submodule"

  Scenario: The Graph lists a commit that moved a submodule without a diff
    Given the viewport is 1440x900
    And the scratch project is a superproject with a commit that moved a submodule
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I select the commit "move libs/lib" in the Graph
    Then the commit details list the submodule "libs/lib" moved to the new commit
    And I capture "graph-moved-submodule"

  Scenario: A submodule with only uncommitted edits is not listed in the parent's changes
    Given the viewport is 1440x900
    And the scratch project is a superproject with a submodule with only uncommitted edits
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the changes list has no row for "libs/lib"
    And I capture "dirty-only-submodule"

  Scenario: The status bar does not count a moved submodule as added and removed lines and the submodule row fits a phone
    Given the viewport is 1440x900
    And the scratch project is a superproject with a moved submodule
    And a Haiku session with one finished reply
    Then the status bar shows no added or removed lines for the submodule
    And I capture "status-bar-counts"
    Given the viewport is 390x844
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the submodule row "libs/lib" shows a submodule badge and no line counts
    And the page has no horizontal scroll
    And I capture "phone-submodule-row"
