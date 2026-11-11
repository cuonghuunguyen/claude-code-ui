Feature: Shake the mouse to locate the active session (GH-517)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has 14 files in the folder "many"

  Scenario: Shake rings the active tab and the sidebar row; a file tab rings without a row; a hidden sidebar rings only the tab
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "many"
    And I open every file of the folder "many" in its own tab
    And I select the first session tab of the strip
    Then the active tab is scrolled out of the strip
    When I shake the mouse
    Then the active tab is in view and has the locate ring
    And the active sidebar row is in view and has the locate ring
    And the locate ring pulses
    And the outline of the ringed element is drawn
    And I capture "ring"
    Then the locate ring is gone after 2 seconds
    And I capture "ring-gone"
    When I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I shake the mouse
    Then the active tab is a file tab
    And the active tab is in view and has the locate ring
    And only the tab has the locate ring
    And I capture "file-tab-ring"
    Then the locate ring is gone after 2 seconds
    When I hide the sidebar
    And I shake the mouse
    Then only the tab has the locate ring
    And the sidebar is still hidden
    And I capture "sidebar-hidden"

  Scenario: No ring while a dialog, the palette or a held button is in play
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings › Layout
    And I shake the mouse
    Then nothing has the locate ring
    And I capture "dialog"
    When I close Settings
    And I open the command palette
    And I shake the mouse
    Then nothing has the locate ring
    And I capture "palette"
    When I close Settings
    And I shake the mouse with the button held
    Then nothing has the locate ring
    And I capture "drag"

  Scenario: Phone shows no setting row
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open Settings › Layout
    Then the shake to locate switch is absent
    And the page has no horizontal scroll
    And I capture "phone-settings"
