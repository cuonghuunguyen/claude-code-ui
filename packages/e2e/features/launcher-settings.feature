Feature: Launcher settings (GH-553)

  Scenario: The launcher shortcut is created and removed from Settings
    Given the viewport is 1440x900
    And the app is open
    When I open Settings › Launcher
    Then the launcher shortcut switch is off
    When I turn the launcher shortcut switch on
    Then the launcher shortcut entry exists
    And I capture "launcher shortcut on"
    When I turn the launcher shortcut switch off
    Then the launcher shortcut entry is gone
    And I capture "launcher shortcut off"

  Scenario: Launcher fits a phone
    Given the viewport is 390x844
    And the app is open
    When I open Settings › Launcher
    Then the page has no horizontal scroll
    And I capture "launcher phone"

  Scenario: Saved start options apply on the next start; a flag still wins
    Given the viewport is 1440x900
    And the app is open
    When I open Settings › Launcher
    And I set the Launcher port to 4999
    And I turn the Launcher "Allow bypass permissions" switch on
    Then the Launcher URL says "http://127.0.0.1:4999/"
    When I close Settings
    And I restart the daemon
    Then the app is connected
    When I open the scratch project
    And I start a new Haiku session
    Then the permission mode picker offers "Bypass permissions"
    And I capture "saved options after restart"
    When I open Settings › Launcher
    And I set the Launcher port to 4280
    And I turn the Launcher "Allow bypass permissions" switch off
    Then the Launcher URL says "http://127.0.0.1:4280/"
    When I close Settings
    And I restart the daemon
    Then the app is connected
