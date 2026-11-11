Feature: Permission request

  Scenario: Allow runs the command; Focus shows the request once; a running session holds one sleep inhibitor
    Given the app is open
    And Keep computer awake is off
    And I open the scratch project
    And I start a new Haiku session
    Then the daemon holds no sleep inhibitor
    When I run "Toggle keep computer awake" from the command palette
    And I send "Use the Bash tool exactly once to run exactly this command and nothing else: echo zq455 > probe.txt"
    Then I see a permission request
    And the daemon holds one sleep inhibitor
    And I capture "card"
    When I open Focus
    And I select the permission request in Focus
    Then the Focus waiting line shows only the wait time
    And the Focus detail shows "zq455" once
    And the Focus detail has a Permission card
    And the Focus row for the request shows "zq455"
    And I capture "focus permission"
    When I click the first session tab
    And I allow the permission request
    Then the permission request is gone
    And the "probe.txt" tool call is finished
    And the file "probe.txt" exists in the project
    And the turn has finished
    And the daemon holds no sleep inhibitor
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
