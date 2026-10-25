Feature: The Git graph shows the repository chosen in the selector (GH-391)

  Scenario: The Graph filter row starts with the repository selector and shares the choice with Changes
    Given the viewport is 1440x900
    And the scratch project is a superproject with a dirty submodule and a nested repository
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    Then the Graph filter row starts with the repository selector
    And the Graph shows the commit "add libs/lib"
    And I capture "graph-selector-own"
    When I open the Graph repository selector
    And I pick the repository "libs/lib"
    Then the Graph repository selector shows "lib"
    And the Graph shows the commit "lib one"
    And the Graph does not show the commit "add libs/lib"
    And I capture "graph-picked-lib"
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the Changes repository selector shows "lib"
    And the Changes list has a row ending in "a.txt" and none ending in "s.txt"
    When I open the Changes repository selector
    And I pick the repository "."
    And I open the Graph tab of the side panel
    Then the Graph shows the commit "add libs/lib"
    And the Graph does not show the commit "lib one"
    And I capture "graph-follows-changes"

  Scenario: Fetching a submodule fetches only its remotes and names it
    Given the viewport is 1440x900
    And the scratch project is a superproject with a dirty submodule and a nested repository
    And the scratch project and its submodule have local bare remotes with remote-only branches
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the Graph repository selector
    And I pick the repository "libs/lib"
    And I click Fetch in the Graph
    Then the Graph result line says "Fetched all remotes of libs/lib"
    And the Graph branch list offers "origin/lib-remote-only"
    And I capture "graph-fetch-lib"
    When I open the Graph repository selector
    And I pick the repository "."
    Then the Graph branch list does not offer "origin/super-remote-only"
    And the Graph has no result line
    When I open the Graph repository selector
    And I pick the repository "libs/lib"
    Then the Graph result line says "Fetched all remotes of libs/lib"
    And I capture "graph-fetch-result-kept"

  Scenario: Show graph of libs/lib in the details of a commit that moved it
    Given the viewport is 1440x900
    And the scratch project is a superproject with a commit that moved a listed submodule
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I select the commit "move libs/lib" in the Graph
    And I click "Show graph of libs/lib" in the commit details
    Then the Graph repository selector shows "lib"
    And the Graph shows the commit "lib two"
    And the Graph does not show the commit "move libs/lib"
    And I capture "graph-show-graph-of"

  Scenario: The Graph selector fits a phone
    Given the viewport is 390x844
    And the scratch project is a superproject with a dirty submodule and a nested repository
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    Then the Graph filter row starts with the repository selector
    And the Graph selector is on its own full-width line and 44px high
    And the scrollWidth of the page is 390
    And I capture "phone-graph-closed"
    When I open the Graph repository selector
    Then the repository sheet is a full-width bottom sheet
    And every repository tree row is 44px high
    And the scrollWidth of the page is 390
    And I capture "phone-graph-sheet"
