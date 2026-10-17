Feature: Stop a running turn

  Scenario: Stop ends the turn while a command runs
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Use the Bash tool to run exactly this command and nothing else: sleep 120; echo e2e > slept.txt"
    And I allow the permission request
    Then the tool call is running
    And I capture "running"
    When I stop the turn
    Then the turn has finished
    And the tool call ended "error"
    And I capture "stopped"
