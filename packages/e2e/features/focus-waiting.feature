Feature: Focus detail waiting line

  Scenario: A Bash permission request shows the command once, in the Permission card
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Use the Bash tool exactly once to run exactly this command and nothing else: echo zq455 > probe.txt"
    Then I see a permission request
    When I open Focus
    And I select the permission request in Focus
    Then the Focus waiting line shows only the wait time
    And the Focus detail shows "zq455" once
    And the Focus detail has a Permission card
    And the Focus row for the request shows "zq455"
    And I capture "permission"

  Scenario: A question shows its text once, in the Question card
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Use the AskUserQuestion tool exactly once. Ask which color to use. Offer two options, Red and Blue."
    Then I see a question request
    When I open Focus
    And I select the question request in Focus
    Then the Focus waiting line shows only the wait time
    And the Focus detail shows the question text once
    And the Focus detail has a Question card
    And I capture "question"
