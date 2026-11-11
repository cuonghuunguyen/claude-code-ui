Feature: Keep the daemon machine awake while a session runs (GH-523)

  Scenario: Keep computer awake sits under Keep screen awake with its hint, survives a daemon restart and fits a phone
    Given the viewport is 1440x900
    And the app is open
    And Keep computer awake is off
    When I open Settings › General
    Then Keep computer awake is "off"
    And Keep computer awake says closing the lid can still sleep a laptop
    When I click Keep computer awake
    Then Keep computer awake is "on"
    When I close Settings
    And I restart the daemon
    And I open Settings › General
    Then Keep computer awake is "on"
    And I capture "computer awake on after restart"
    When I click Keep computer awake
    Then Keep computer awake is "off"
    Given the viewport is 390x844
    Then Keep computer awake is "off"
    And the page has no horizontal scroll
    And I capture "phone"

  Scenario: Keep computer awake reaches a second page without a reload
    Given the viewport is 1440x900
    And the app is open
    And Keep computer awake is off
    And a second page shows Settings › General
    When I open Settings › General
    And I click Keep computer awake
    Then Keep computer awake is "on" on the second page
    And I capture "first page"

  Scenario: Keep computer awake is toggled from the command palette and set by Keep screen awake from Settings, the titlebar and the palette
    Given the viewport is 1440x900
    And the app is open
    And Keep computer awake is off
    When I run "Toggle keep computer awake" from the command palette
    And I open Settings › General
    Then Keep computer awake is "on"
    And I capture "palette on"
    When I close Settings
    And I run "Toggle keep computer awake" from the command palette
    And I open Settings › General
    Then Keep computer awake is "off"
    When I click Keep screen awake
    Then Keep computer awake is "on"
    When I click Keep screen awake
    Then Keep computer awake is "off"
    When I close Settings
    And I click the Keep screen awake titlebar button
    Then Keep computer awake is "on"
    When I click the Keep screen awake titlebar button
    Then Keep computer awake is "off"
    When I run "Toggle keep screen awake" from the command palette
    Then Keep computer awake is "on"
    When I run "Toggle keep screen awake" from the command palette
    Then Keep computer awake is "off"
    When I open Settings › General
    And I click Keep computer awake
    Then Keep computer awake is "on"
    And Keep screen awake is "off"
    And I capture "computer on, screen off"
