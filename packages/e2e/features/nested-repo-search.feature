Feature: Filter files and @-mentions find files inside nested repositories and submodules (GH-393)

  Scenario: Filter files finds a file in a nested repository of a workspace folder
    Given the viewport is 1440x900
    And the scratch project is a folder that holds the repositories "api,web"
    And the nested repository "api" has the file "src/handler.ts"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I filter the Files tree by "handler"
    Then the Files filter shows the file "api/src/handler.ts"
    And I capture "filter-nested-repo"

  Scenario: Filter files finds a file inside a submodule
    Given the viewport is 1440x900
    And the scratch project is a superproject with a dirty submodule and a nested repository
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I filter the Files tree by "libs/lib/a"
    Then the Files filter shows the file "libs/lib/a.txt"
    And I capture "filter-submodule"

  Scenario: An @-mention finds a file in a nested repository
    Given the viewport is 1440x900
    And the scratch project is a folder that holds the repositories "api,web"
    And the nested repository "api" has the file "src/handler.ts"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I type "@handler" in the prompt box
    Then the mention picker lists "api/src/handler.ts"
    When I choose the mention "api/src/handler.ts"
    And I capture "mention-nested-repo"

  Scenario: Gitignored files of a nested repository are not offered
    Given the viewport is 1440x900
    And the scratch project is a folder that holds the repositories "api,web"
    And the nested repository "api" has the file "src/handler.ts"
    And the nested repository "api" ignores "dist/" and has the file "dist/handler.js"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I filter the Files tree by "handler"
    Then the Files filter shows the file "api/src/handler.ts"
    And the Files filter does not show the file "api/dist/handler.js"
    And I capture "filter-ignored-nested"

  Scenario: Filter files finds a nested repository file on a phone
    Given the viewport is 390x844
    And the scratch project is a folder that holds the repositories "api,web"
    And the nested repository "api" has the file "src/handler.ts"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    # A phone shows the panes only for a session with a message.
    When I send "Reply with exactly: OK"
    And the turn has finished
    And I open the Files tab of the side panel
    And I filter the Files tree by "handler"
    Then the Files filter shows the file "api/src/handler.ts"
    And the page has no horizontal scroll
    And I capture "phone-filter-nested-repo"
