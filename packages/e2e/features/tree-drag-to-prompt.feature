Feature: Drag files and folders from the Files tree into the prompt box (GH-707)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "lib/b.ts" with the text "export const b = 1;"
    And the scratch project has the file "other/note.txt" with the text "note"
    And the scratch project has the file "moveme/inner.txt" with the text "inner"

  Scenario: A dragged row and Add to prompt on a folder insert @mentions into the new session prompt box
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I drag the tree row "src/a.ts" onto the prompt box
    Then the prompt box text is "@src/a.ts "
    And no drop confirm dialog is shown
    And I capture "drag-file-to-prompt"
    When I choose "Add to prompt" in the tree menu of "lib"
    Then the prompt box text is "@src/a.ts @lib/ "
    And I capture "add-folder-to-prompt"

  Scenario: Several selected rows dragged onto the timeline become mentions in that session's prompt box; a single row still moves inside the tree
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I ControlOrMeta-click the tree row "src/a.ts"
    And I ControlOrMeta-click the tree row "lib"
    Then the tree row "src/a.ts" is selected
    And the tree row "lib" is selected
    When I drag the tree row "lib" onto the timeline
    Then the prompt box text is "@lib/ @src/a.ts "
    And I capture "multi-select-drag-to-timeline"
    When I drag the tree row "moveme" onto the tree row "other"
    Then the drop confirm dialog says "Move “moveme” into “other”?"
    And I capture "tree-move-still-asks"

  Scenario: The Files tab with a selection does not scroll the page sideways on a phone
    Given the viewport is 390x844
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I ControlOrMeta-click the tree row "src"
    And I ControlOrMeta-click the tree row "lib"
    Then the page has no horizontal scroll
    And I capture "tree-selection-phone"
