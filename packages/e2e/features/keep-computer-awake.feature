Feature: Keep the daemon machine awake while a session runs (GH-523)

  Scenario: Keep computer awake sits under Keep screen awake with its hint and survives a daemon restart
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

  Scenario: Keep computer awake reaches a second page without a reload
    Given the viewport is 1440x900
    And the app is open
    And Keep computer awake is off
    And a second page shows Settings › General
    When I open Settings › General
    And I click Keep computer awake
    Then Keep computer awake is "on" on the second page
    And I capture "first page"

  Scenario: Keep screen awake sets Keep computer awake from Settings, the titlebar and the palette
    Given the viewport is 1440x900
    And the app is open
    And Keep computer awake is off
    When I open Settings › General
    And I click Keep screen awake
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

  Scenario: Toggle keep computer awake from the command palette
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

  Scenario: A running session holds one sleep inhibitor until the turn ends
    Given the viewport is 1440x900
    And the app is open
    And Keep computer awake is off
    And I open the scratch project
    And I start a new Haiku session
    Then the daemon holds no sleep inhibitor
    When I run "Toggle keep computer awake" from the command palette
    And I send "Use the Bash tool to run exactly this command and nothing else: echo e2e > probe.txt"
    Then I see a permission request
    And the daemon holds one sleep inhibitor
    And I capture "waiting holds one inhibitor"
    When I allow the permission request
    And the turn has finished
    Then the daemon holds no sleep inhibitor
    And I capture "released after turn"

  Scenario: Keep computer awake fits a phone
    Given the viewport is 390x844
    And the app is open
    And Keep computer awake is off
    When I open Settings › General
    Then Keep computer awake is "off"
    And the page has no horizontal scroll
    And I capture "phone"
