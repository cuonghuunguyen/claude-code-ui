Feature: Open a file or folder in the file manager, an editor or the default app (GH-612)

  Background:
    Given the scratch project is a git repository with two commits
    And the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the edited file "README.md" and the new file "b.txt"

  Scenario: Files tree: Reveal on a file starts the file manager for it
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree menu of "src/a.ts"
    Then the menu offers the open-in-app items "reveal, default"
    And I capture "open-external-tree-menu"
    When I choose the open-in-app item "reveal"
    Then the daemon started a file manager command for "src/a.ts"

  Scenario: Files tree: a folder offers no default app
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I open the tree menu of "src"
    Then the menu offers the open-in-app items "reveal"
    And the page has no horizontal scroll
    And I capture "open-external-folder-menu-phone"

  Scenario: Changes list: right click offers Open, Copy path and Reveal
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the menu of the Changes row "README.md"
    Then the row menu lists "Open, Copy path, Copy relative path"
    And the row menu offers the open-in-app items "reveal, default"
    And I capture "open-external-changes-menu"
    When I choose the open-in-app item "reveal" in the row menu
    Then the daemon started a file manager command for "README.md"

  Scenario: File tab: the tab menu offers the open-in-app items
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I open the menu of the file tab "a.ts"
    Then the tab menu offers the open-in-app items "reveal, default"
    And I capture "open-external-tab-menu"
