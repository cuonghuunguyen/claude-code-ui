Feature: Open a single file as a tab (GH-399)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "notes.md" with the text "# Notes"

  Scenario: A file in its own tab: from the tree, never twice, an edit closes with accept
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    Then the file tab "a.ts" opens right of its session tab with the editor focused
    And the Files editor tabs do not list "a.ts"
    And I capture "file-tab-from-tree"
    When I Quick open "src/a.ts" with Alt+Enter
    And I click the first session tab
    And I Quick open "src/a.ts" with Alt+Enter
    Then there is one file tab "a.ts"
    And I capture "file-tab-quick-open"
    When I type "// edit " at the start of the file tab "a.ts"
    And I close the file tab "a.ts" and accept the question
    Then there is no file tab "a.ts"
    And I capture "file-tab-closed"

  Scenario: On a phone the file tab is a row of the tab switcher
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    Then the file tab "a.ts" shows the text "export const a = 1;"
    And the page is exactly 390px wide
    When I open the tab switcher
    Then the tab switcher lists the file row "a.ts"
    And I capture "file-tab-phone"
