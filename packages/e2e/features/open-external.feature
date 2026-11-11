Feature: Open a file or folder in the file manager, an editor or the default app (GH-612)

  Background:
    Given the scratch project is a git repository with two commits
    And the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the edited file "README.md" and the new file "b.txt"

  Scenario: Open in app items of the Files tree, the Changes list, a file tab and a user editor command
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree menu of "src/a.ts"
    Then the menu offers the open-in-app items "reveal, default"
    And I capture "open-external-tree-menu"
    When I choose the open-in-app item "reveal"
    Then the daemon started a file manager command for "src/a.ts"
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the menu of the Changes row "README.md"
    Then the row menu lists "Open, Copy path, Copy relative path"
    And the row menu offers the open-in-app items "reveal, default"
    And I capture "open-external-changes-menu"
    When I choose the open-in-app item "reveal" in the row menu
    Then the daemon started a file manager command for "README.md"
    When I open the Files tab of the side panel
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I open the menu of the file tab "a.ts"
    Then the tab menu offers the open-in-app items "reveal, default"
    And I capture "open-external-tab-menu"
    When I press "Escape"
    And I set the editor command "<node> --goto={path}" with the name "My Editor" in Settings
    And I open the Files tab of the side panel
    And I open the tree menu of "src/a.ts"
    Then the menu offers the open-in-app items "reveal, custom, default"
    And the tree menu entry "custom" reads "Open in My Editor"
    And I capture "open-app-settings-menu"
    When I choose the open-in-app item "custom"
    Then the daemon started the editor command with the argument "--goto=" and the file "src/a.ts"

  Scenario: Phone: a folder offers no default app; the editor command field shows its error (GH-646)
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I open the tree menu of "src"
    Then the menu offers the open-in-app items "reveal"
    And the page has no horizontal scroll
    And I capture "open-external-folder-menu-phone"
    When I press "Escape"
    And I open Settings › Open in app
    And I enter the editor command 'subl "oops' and leave the field
    Then the editor command shows an error and keeps the text
    And the page has no horizontal scroll
    And I capture "open-app-settings-error-phone"
