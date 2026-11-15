Feature: Permission request

  Scenario: Allow runs the command
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Use the Bash tool exactly once to run exactly this command and nothing else: echo zq455 > probe.txt"
    Then I see a permission request
    And I capture "card"
    When I allow the permission request
    Then the permission request is gone
    And the "probe.txt" tool call is finished
    And the file "probe.txt" exists in the project
    And the turn has finished
    And I capture "allowed"

  Scenario: Deny does not run the command
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Use the Bash tool to run exactly this command and nothing else: echo e2e > probe.txt"
    Then I see a permission request
    And I capture "card"
    When I deny the permission request
    Then the permission request is gone
    And the "probe.txt" tool call is denied
    And the file "probe.txt" does not exist in the project
    And the turn has finished
    And I capture "denied"
