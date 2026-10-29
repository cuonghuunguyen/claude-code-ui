Feature: Files tab restores open editor tabs after reload (GH-366)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "src/b.ts" with the text "export const b = 1;"
    And the scratch project has the file "notes.md" with the text "# Notes"

  Scenario: Open tabs, order, active and preview come back
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I double click the Files editor tab "a.ts"
    And I open the tree file "src/b.ts"
    And I double click the Files editor tab "b.ts"
    And I open the tree file "notes.md"
    And I click the Files editor tab "a.ts"
    And I reload the page
    And I open the Files tab of the side panel
    Then the Files editor tabs are "a.ts, b.ts, notes.md"
    And the Files editor tab "a.ts" is active
    And the Files editor tab "notes.md" is a preview tab
    And I capture "editor-tabs-restored"

  Scenario: A deleted file is dropped silently
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I double click the Files editor tab "a.ts"
    And I open the tree file "src/b.ts"
    And I double click the Files editor tab "b.ts"
    And I delete the project file "src/b.ts"
    And I reload the page
    And I open the Files tab of the side panel
    Then the Files editor tabs are "a.ts"
    And the Files editor shows no error line
    And I capture "editor-tabs-deleted-dropped"

  Scenario: An unsaved draft survives a reload
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I type "// edit " at the start of the Files editor
    And I reload the page and accept the leave dialog
    And I open the Files tab of the side panel
    Then the Files editor tab "a.ts" shows the unsaved mark
    And the Files editor shows "a.ts" with the text "// edit export const a = 1;"
    And I capture "editor-draft-restored"
    When I save the Files editor
    Then the project file "src/a.ts" has the text "// edit export const a = 1;"

  Scenario: A draft whose file changed on disk shows a conflict
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I type "// edit " at the start of the Files editor
    And I change the project file "src/a.ts" to "export const a = 2;"
    And I reload the page and accept the leave dialog
    And I open the Files tab of the side panel
    Then the Files editor shows the conflict bar
    And the Files editor shows "a.ts" with the text "// edit export const a = 1;"
    And I capture "editor-draft-conflict"
    When I click Reload from disk in the Files editor
    Then the Files editor shows "a.ts" with the text "export const a = 2;"
    And the Files editor tab "a.ts" shows no unsaved mark

  Scenario: A draft of a deleted file is kept
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I type "// edit " at the start of the Files editor
    And I delete the project file "src/a.ts"
    And I reload the page and accept the leave dialog
    And I open the Files tab of the side panel
    Then the Files editor tab "a.ts" shows the unsaved mark
    And the Files editor shows the line "Deleted on disk. Save creates it again."
    And I capture "editor-draft-deleted"
    When I save the Files editor
    Then the project file "src/a.ts" has the text "// edit export const a = 1;"

  Scenario: A file tab keeps its draft
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I type "// edit " at the start of the file tab "a.ts"
    And I reload the page and accept the leave dialog
    Then the file tab "a.ts" shows the unsaved mark
    And the file tab "a.ts" shows the text "// edit export const a = 1;"
    And I capture "file-tab-draft-restored"

  Scenario: Tabs come back on a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I double click the Files editor tab "a.ts"
    And I reload the page
    And I open the Files tab of the side panel
    Then the Files editor tabs are "a.ts"
    And the page has no horizontal scroll
    And I capture "editor-tabs-restored-phone"
