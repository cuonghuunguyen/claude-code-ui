Feature: Open a single file as a tab (GH-399)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "notes.md" with the text "# Notes"

  Scenario: Open a file from the tree in its own tab
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    Then the file tab "a.ts" opens right of its session tab with the editor focused
    And the Files editor tabs do not list "a.ts"
    And I capture "file-tab-from-tree"

  Scenario: Unsaved edits move with the file
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I open the tree file "src/a.ts"
    And I type "// edit " at the start of the Files editor
    And I click Open in tab in the Files header
    Then the file tab "a.ts" shows the unsaved mark
    And the file tab "a.ts" shows the text "// edit export const a = 1;"
    And I capture "file-tab-dirty-moved"
    When I save the file tab "a.ts"
    Then the file tab "a.ts" shows no unsaved mark
    And I capture "file-tab-saved"

  Scenario: A file that is open as a tab is focused, not opened twice
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    And I click the first session tab
    And I Quick open "src/a.ts" with Alt+Enter
    Then there is one file tab "a.ts"
    And I capture "file-tab-quick-open"

  Scenario: Closing a file tab with unsaved edits asks first
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    And I type "// edit " at the start of the file tab "a.ts"
    And I close the file tab "a.ts" and dismiss the question
    Then the question was "Discard unsaved changes to a.ts?"
    And there is one file tab "a.ts"
    And I capture "file-tab-close-confirm"
    When I close the file tab "a.ts" and accept the question
    Then there is no file tab "a.ts"

  Scenario: Move to Files brings the file back with its draft
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    And I type "// edit " at the start of the file tab "a.ts"
    And I choose "Move to Files" in the menu of the file tab "a.ts"
    Then there is no file tab "a.ts"
    And the Files editor shows "a.ts" with the text "// edit export const a = 1;"
    And the tree row "src/a.ts" is shown
    And I capture "file-tab-moved-back"

  Scenario: A Markdown file tab has the Markdown view and its breadcrumb reveals the folder in Files
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    And I click the breadcrumb folder "src" of the file tab "a.ts"
    Then the tree row "src/a.ts" is shown
    When I click the first session tab
    And I Quick open "notes.md" with Alt+Enter
    And I choose the Markdown view "Split"
    Then the Markdown preview of the file tab "notes.md" shows "Notes"
    And I capture "file-tab-markdown"

  Scenario: A file tab survives a reload and a deleted file shows the read error
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    And I reload the page
    Then the file tab "a.ts" shows the text "export const a = 1;"
    And I capture "file-tab-restored"
    When I delete the project file "src/a.ts"
    And I reload the page
    Then the file tab "a.ts" shows a read error
    And I capture "file-tab-missing"

  Scenario: Split a file tab beside its session
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    And I choose "Split right" in the menu of the file tab "a.ts"
    Then the session area is split
    And I capture "file-tab-split"

  Scenario: On a phone the file tab is a row of the tab switcher
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I Quick open "src/a.ts" with Alt+Enter
    Then the file tab "a.ts" shows the text "export const a = 1;"
    And the page is exactly 390px wide
    When I open the tab switcher
    Then the tab switcher lists the file row "a.ts"
    And I capture "file-tab-phone"

  Scenario: Open in tab from the file dialog of a Read card
    Given the viewport is 1440x900
    And a Haiku session that has read "a.ts"
    When I open the file dialog from the Read card of "a.ts"
    And I click Open in tab in the file dialog
    Then no file dialog shows
    And the file tab "a.ts" opens right of its session tab with the editor focused
    And I capture "file-tab-from-dialog"
