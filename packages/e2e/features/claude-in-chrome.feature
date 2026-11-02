Feature: Claude in Chrome setting (GH-514)

  Scenario: Claude in Chrome is off by default, states its limits and survives a daemon restart
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

  Scenario: The palette toggles Claude in Chrome
    Given the viewport is 1440x900
    And the app is open
    When I run "Toggle Claude in Chrome" from the command palette
    And I open Settings › Claude in Chrome
    Then the Claude in Chrome switch is on
    And I capture "chrome on from palette"
    When I turn the Claude in Chrome switch off

  Scenario: The Claude in Chrome setting fits a phone screen
    Given the viewport is 390x844
    And the app is open
    When I open Settings › Claude in Chrome
    Then the page has no horizontal scroll
    And I capture "chrome setting phone"
