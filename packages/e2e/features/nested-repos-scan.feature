Feature: Nested repositories are found, Filter files and @-mentions search inside them, and Settings has a Git group (GH-389, GH-393)

  Scenario: Filter files and an @-mention find a file in a nested repository and gitignored files are not offered
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
    And I capture "filter-nested-repo"
    When I type "@handler" in the prompt box
    Then the mention picker lists "api/src/handler.ts"
    When I choose the mention "api/src/handler.ts"
    And I capture "mention-nested-repo"

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

  Scenario: A folder that holds repositories gets the git modes and the Graph tab, Reload and Refresh find repositories added on disk
    Given the viewport is 1440x900
    And the scratch project is a folder that holds the repositories "api,web"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the changes list has a row ending in "a.txt"
    And I choose the "Against branch" diff mode
    When I open the Graph tab of the side panel
    Then the Graph shows the commit "api commit"
    And the Graph does not show the commit "web commit"
    And I capture "workspace-folder-graph-and-changes"
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I add the repository "aaa" on disk
    And I click Reload from disk in the Changes tab
    Then the changes list has a row ending in "aaa/a.txt"
    And I capture "reload-finds-new-repository"
    When I add the repository "000" on disk
    And I open the Graph tab of the side panel
    And I click Refresh in the Graph
    Then the Graph shows the commit "000 commit"
    And I capture "refresh-finds-new-repository"

  Scenario: Settings Git lists its defaults, a list setting adds, edits and removes items, an invalid Scan repositories entry is refused, and the group fits a phone
    Given the viewport is 1440x900
    And the app is open
    When I open Settings and choose the Git group
    Then the Git group lists the settings:
      | setting                          | kind   | value            |
      | Auto repository detection        | select | true             |
      | Repository scan max depth        | number | 1                |
      | Repository scan ignored folders  | list   | node_modules     |
      | Scan repositories                | list   | none             |
      | Ignored repositories             | list   | none             |
      | Detect submodules                | switch | on               |
      | Detect submodules limit          | number | 10               |
      | Ignore submodules                | switch | off              |
      | Open repository in parent folders| select | always           |
    And the parent folders setting notes the difference from VS Code
    And I capture "settings-git-defaults"
    When I scroll the Git settings to the end
    And I capture "settings-git-defaults-end"
    When I add the item "vendor" to "Repository scan ignored folders"
    And I edit the item "vendor" of "Repository scan ignored folders" to "dist"
    Then "Repository scan ignored folders" lists the items "node_modules,dist"
    When I reload the page and open Settings Git again
    Then "Repository scan ignored folders" lists the items "node_modules,dist"
    And I capture "list-persists-after-reload"
    When I remove the item "dist" from "Repository scan ignored folders"
    Then "Repository scan ignored folders" lists the items "node_modules"
    And I capture "list-item-removed"
    When I try to add the item "/abs/path" to "Scan repositories"
    Then the settings dialog shows an error
    And "Scan repositories" lists the items "none"
    When I try to add the item "../outside" to "Scan repositories"
    Then the settings dialog shows an error
    And "Scan repositories" lists the items "none"
    When I try to add the item "sub/.git" to "Scan repositories"
    Then the settings dialog shows an error
    And "Scan repositories" lists the items "none"
    And I capture "scan-repositories-refused"
    When I reload the page and open Settings Git again
    Then "Scan repositories" lists the items "none"
    When I close Settings
    Given the viewport is 390x844
    When I open Settings and choose the Git group
    Then the page has no horizontal scroll
    And the Git settings panel does not scroll sideways
    And every list row button in Settings is at least 44px
    And I capture "phone-settings-git"
