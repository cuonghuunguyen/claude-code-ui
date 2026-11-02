Feature: Auto-continue after a usage limit reset is on by default (GH-524)

  Background:
    Given the viewport is 1440x900
    And the app is open

  Scenario: Fresh install shows auto-continue on, off survives a daemon restart
    When I open Settings › Usage limits
    Then the auto-continue switch is on
    And I capture "fresh install auto-continue on"
    When I turn the auto-continue switch off
    And I close Settings
    And I restart the daemon
    And I open Settings › Usage limits
    Then the auto-continue switch is off
    And I capture "off kept after restart"
    When I turn the auto-continue switch on
    Then the auto-continue switch is on
