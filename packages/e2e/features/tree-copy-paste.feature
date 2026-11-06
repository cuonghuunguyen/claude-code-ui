Feature: Copy, cut, paste, drag and drop in the Files tree (GH-555)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "dest/keep.txt" with the text "keep"
    And the scratch project has the file "other/note.txt" with the text "note"
    And the scratch project has the file "moveme/inner.txt" with the text "inner"
    And the scratch project has the file "dest2/a.ts" with the text "export const old = 0;"

  Scenario: Copy a file with the menu and paste it into a folder
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Copy" in the tree menu of "src/a.ts"
    And I choose "Paste" in the tree menu of "dest"
    Then the tree lists the row "dest/a.ts"
    And the tree lists the row "src/a.ts"
    And the project has "dest/a.ts" on disk with the text "export const a = 1;"
    And I capture "copy-paste-file"

  Scenario: Cut a folder and paste it on another folder with the keyboard
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I press "ControlOrMeta+x" on the tree row "moveme"
    And I press "ControlOrMeta+v" on the tree row "other"
    Then the tree lists the row "other/moveme"
    And the tree lists no row "moveme"
    And the project has "other/moveme/inner.txt" on disk with the text "inner"
    And the project has no "moveme" on disk
    And I capture "cut-paste-folder"

  Scenario: Pasting a file whose name exists asks, and Keep both makes a copy
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I press "ControlOrMeta+c" on the tree row "src/a.ts"
    And I press "ControlOrMeta+v" on the tree row "dest2"
    Then the paste clash dialog is shown
    And I capture "paste-clash-dialog"
    When I answer the paste clash with "Keep both"
    Then the project has "dest2/a copy.ts" on disk with the text "export const a = 1;"
    And the project has "dest2/a.ts" on disk with the text "export const old = 0;"
    And the tree lists the row "dest2/a copy.ts"

  Scenario: Replace on a clash lists "Before paste" in the Timeline of that file
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I press "ControlOrMeta+c" on the tree row "src/a.ts"
    And I press "ControlOrMeta+v" on the tree row "dest2"
    And I answer the paste clash with "Replace"
    Then the project has "dest2/a.ts" on disk with the text "export const a = 1;"
    When I expand the tree folder "dest2"
    And I open the tree file "dest2/a.ts"
    And I open the Timeline
    Then the Timeline lists "Before paste"
    And I capture "timeline-before-paste"

  Scenario: A folder cannot be pasted into its own child
    Given the scratch project has the file "parent/child/x.txt" with the text "x"
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "parent/child"
    And I choose "Copy" in the tree menu of "parent"
    And I choose "Paste" in the tree menu of "parent/child"
    Then the tree error line says "cannot be pasted into itself"
    And the project has no "parent/child/parent" on disk
    And I capture "paste-into-itself"

  Scenario: OS files dropped on a folder and an OS file pasted are uploaded
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I drop the OS files "one.txt, two.txt" on the tree row "dest"
    Then the project has "dest/one.txt" on disk with the text "content of one.txt"
    And the project has "dest/two.txt" on disk with the text "content of two.txt"
    When I paste the OS file "pasted.txt" on the tree row "other"
    Then the project has "other/pasted.txt" on disk with the text "content of pasted.txt"
    And I capture "os-files-uploaded"

  Scenario: A tree row dragged onto a folder asks, then moves
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I drag the tree row "src/a.ts" onto the tree row "other"
    Then the drop confirm dialog says "Move “a.ts” into “other”?"
    And I capture "drop-confirm"
    When I confirm the drop
    Then the project has "other/a.ts" on disk with the text "export const a = 1;"
    And the project has no "src/a.ts" on disk
    And the tree lists the row "other/a.ts"

  Scenario: A tree row dragged over the other drop areas triggers none of them
    Given the viewport is 1700x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I start dragging the tree row "src/a.ts" over the session area edge
    Then no drop overlay is shown
    And I capture "row-drag-over-session-area"
    When I release the mouse
    And I drag the tree row "src/a.ts" onto the prompt box
    Then no attachment is shown
    And the session area is not split
    And the project has "src/a.ts" on disk with the text "export const a = 1;"
    And no drop confirm dialog is shown

  # headless Chromium does not read the OS clipboard
  @headed
  Scenario: Pasting a folder from the system clipboard is refused
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And the system clipboard holds the project folder "other"
    And I press "ControlOrMeta+v" on the tree row "dest"
    Then the tree error line says "Folders cannot be pasted from the system clipboard"
    And the tree lists the row "dest"
    And I capture "os-folder-refused"

  # headless Chromium does not read the OS clipboard
  @headed
  Scenario: A file copied in the OS is pasted into a folder
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And the system clipboard holds the project file "moveme/inner.txt"
    And I press "ControlOrMeta+v" on the tree row "dest"
    Then the project has "dest/inner.txt" on disk with the text "inner"
    And I capture "os-file-pasted"

  Scenario: The tree menu fits a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I open the tree menu of "dest"
    Then the tree menu items "Cut, Copy, Paste" are visible
    And the page is exactly 390px wide
    And I capture "tree-menu-phone"
