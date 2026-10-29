Feature: Drag panes between the side and bottom panels and the main area

  Scenario: The Plan dock tab dropped on the tab strip opens right of its session tab
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I drag the "Plan" dock tab onto the tab strip
    Then the "Plan" tab opens right of its session tab and has the focus
    And the side panel has no "Plan" tab
    And I capture "drag-plan-to-strip"

  Scenario: The Files dock tab dropped on the right edge of the session area splits it
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I drag the "Files" dock tab onto the right edge of the session area
    Then the session area is split
    And the "Files" tab is shown in a split
    And the active split shows the "Files" tab
    And the side panel has no "Files" tab
    And I capture "drag-files-split"

  Scenario: The Git graph needs the whole area
    Given the viewport is 1440x900
    And the scratch project is a git repository with two commits
    And a Haiku session with one finished reply
    When I start dragging the "Git graph" dock tab over the right edge of the session area
    Then the drop overlay says "Git graph needs the whole area"
    And I capture "drag-graph-refused"
    When I release the mouse
    Then the session area is not split
    And the side panel lists the "Git graph" tab
    When I drag the "Git graph" dock tab onto the session area
    Then there is one "Git graph" tab
    And the session area is not split
    And I capture "drag-graph-whole"

  Scenario: Changes stays in a panel
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I start dragging the "Changes" dock tab over the session area
    Then the drop overlay says "Changes stays in a panel"
    When I release the mouse
    Then the side panel lists the "Changes" tab
    And there is no "Changes" tab
    And I capture "drag-changes-refused"

  Scenario: A Terminal tab of the main area dropped on the side panel returns to a panel
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I move the "Terminal" pane to the main area from its tab menu
    And I drag the "Terminal" tab onto the side panel
    Then there is no "Terminal" tab
    And a toast says "Closed 1 Terminal tab"
    And the side panel has the "Terminal" tab selected
    And I capture "drag-terminal-to-side"

  Scenario: A pane tab dropped on the bottom drop strip opens the hidden bottom panel
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I move the "Plan" pane to the main area from its tab menu
    And I hide the bottom panel
    And I drag the "Plan" tab onto the bottom drop strip
    Then there is no "Plan" tab
    And the bottom panel has the "Plan" tab selected
    And I capture "drag-plan-to-bottom"

  Scenario: A file tab dropped on the panel that holds Files goes back to Files with its edit
    Given the viewport is 1440x900
    And the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/a.ts"
    And I type "// edit " at the start of the Files editor
    And I click Open in tab in the Files header
    And I drag the file tab "a.ts" onto the side panel
    Then there is no file tab "a.ts"
    And the Files editor shows "a.ts" with the text "// edit export const a = 1;"
    And I capture "drag-file-to-files"
    When I click Open in tab in the Files header
    And I start dragging the file tab "a.ts" over the bottom panel
    Then no drop target is outlined

  Scenario: A session tab moves to the bottom panel and back to the strip
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I open a second session with a finished reply
    When I drag the first session tab onto the bottom panel
    Then the "bottom" panel has a selected session tab with a timeline and a prompt box
    And the tab strip has 1 session tab
    And I capture "drag-dock-session"
    When I drag the docked session tab onto the tab strip
    Then no panel has a docked session tab
    And the tab strip has 2 session tabs
    And I capture "drag-undock-session"

  Scenario: Escape cancels a drag
    Given the viewport is 1440x900
    And a Haiku session in Plan mode with a plan waiting for approval
    When I start dragging the "Plan" dock tab over the tab strip
    And I press "Escape"
    Then no drop target is outlined
    And the side panel lists the "Plan" tab
    And I capture "drag-escape"
