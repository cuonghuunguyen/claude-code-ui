Feature: Claude in Chrome setting (GH-514)

  Scenario: Claude in Chrome is off by default, states its limits, survives a daemon restart, toggles from the palette and fits a phone
    Given the viewport is 1440x900
    And the app is open
    When I open Settings › Claude in Chrome
    Then the Claude in Chrome switch is off
    And the Claude in Chrome hint names the daemon's computer and the claude.ai account
    And I capture "chrome setting off by default"
    When I turn the Claude in Chrome switch on
    And I close Settings
    And I restart the daemon
    And I open Settings › Claude in Chrome
    Then the Claude in Chrome switch is on
    And I capture "chrome setting on after restart"
    When I turn the Claude in Chrome switch off
    And I close Settings
    And I run "Toggle Claude in Chrome" from the command palette
    And I open Settings › Claude in Chrome
    Then the Claude in Chrome switch is on
    And I capture "chrome on from palette"
    When I turn the Claude in Chrome switch off
    Given the viewport is 390x844
    When I close Settings
    And I open Settings › Claude in Chrome
    Then the page has no horizontal scroll
    And I capture "chrome setting phone"
