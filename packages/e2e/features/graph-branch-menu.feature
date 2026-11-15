Feature: The Git graph branch menu pushes, force pushes with a lease and pulls (GH-309)

  Scenario: Pull is fast-forward only, then Push asks first with the exact command
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the origin's main has the commit "remote work" and the project fetched it
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Pull" in the branch menu
    Then the "pull" dialog shows the command "pull --no-recurse-submodules --no-rebase --ff-only origin refs/heads/main"
    When I confirm the "pull" dialog
    Then the Graph result line says "Pulled main"
    And the Graph shows the commit "remote work"
    Given the scratch project's main has the local commit "local work"
    When I click Refresh in the Graph
    And I open the branch menu on the chip "refs/heads/main"
    And I pick "Push" in the branch menu
    Then the "push" dialog shows the command "push --no-recurse-submodules --no-follow-tags origin refs/heads/main:refs/heads/main"
    And I capture "push-dialog"
    When I confirm the "push" dialog
    Then the Graph result line says "Pushed main to origin"
    And the origin's main is the project's main
    And I capture "pushed"
