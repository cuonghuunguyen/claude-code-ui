Feature: Shake the mouse to locate the active session (GH-517)

  Background:
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has 14 files in the folder "many"

  Scenario: Shake rings the active tab and the sidebar row
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

  Scenario: Compact tabs ring the group chip
    Given compact tab groups are on
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    When I shake the mouse
    Then the group chip has the locate ring and the active tab has not
    And I capture "chip-ring"

  Scenario: Small or slow moves do not trigger and a second shake is on cooldown
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I move the mouse in strokes of 30 px
    Then nothing has the locate ring
    When I move the mouse with only 3 direction changes
    Then nothing has the locate ring
    When I shake the mouse slowly
    Then nothing has the locate ring
    When I shake the mouse
    Then the active tab is in view and has the locate ring
    And I capture "valid-shake"

  Scenario: A second shake within 2 seconds does not trigger again
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I shake the mouse
    Then the active tab is in view and has the locate ring
    Then the locate ring is gone after 2 seconds
    When I shake the mouse
    Then nothing has the locate ring
    And I capture "cooldown"

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

  Scenario: New session tab active rings nothing
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the New session tab
    And I shake the mouse
    Then nothing has the locate ring
    And I capture "new-tab"

  Scenario: A file tab rings and the sidebar has no row for it
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I shake the mouse
    Then the active tab is a file tab
    And the active tab is in view and has the locate ring
    And only the tab has the locate ring
    And I capture "file-tab-ring"

  Scenario: A session row hidden in a collapsed group is left alone
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I collapse the project group in the sidebar
    And I shake the mouse
    Then the active tab is in view and has the locate ring
    And only the tab has the locate ring
    And the sidebar still lists no session row of the project
    And I capture "collapsed-group"

  Scenario: Hidden sidebar rings only the tab and does not open
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I hide the sidebar
    And I shake the mouse
    Then only the tab has the locate ring
    And the sidebar is still hidden
    And I capture "sidebar-hidden"

  Scenario: The setting is on by default and off stops the shake
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings › Layout
    And I turn the shake to locate switch off
    And I capture "switch-off"
    And I close Settings
    And I shake the mouse
    Then nothing has the locate ring
    And I capture "off"

  Scenario: Reduced motion gives a static ring
    Given reduced motion is on
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    When I shake the mouse
    Then the active tab is in view and has the locate ring
    And the locate ring is static
    And I capture "ring-static"

  Scenario: Phone shows no setting row
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open Settings › Layout
    Then the shake to locate switch is absent
    And the page has no horizontal scroll
    And I capture "phone-settings"
