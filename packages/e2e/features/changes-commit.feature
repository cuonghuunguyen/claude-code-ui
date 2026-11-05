Feature: Changes tab commits the checked files

  Background:
    Given the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the new files "a.txt, b.txt"

  Scenario: Commit a checked subset and keep the unchecked file listed
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    And I type the commit message "add a"
    And I click "Commit" in the commit box
    Then the Changes result line says "Committed"
    And the Changes list no longer has the file "a.txt"
    And the Changes list still has the file "b.txt"
    And the last commit of the project holds only "a.txt"
    And I capture "committed-subset"

  Scenario: Commit and Push goes through the push dialog
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    And I type the commit message "add a and push"
    And I click "Commit and Push" in the commit box
    Then the "push" dialog shows the command "origin refs/heads/main:refs/heads/main"
    And I capture "push-dialog"
    When I confirm the "push" dialog
    Then the Changes result line says "Pushed main to origin"
    And the origin's main is the project's main
    And I capture "pushed"

  Scenario: A failing pre-commit hook shows its output and keeps the files
    Given the scratch project has a pre-commit hook that prints "hook says no" and fails
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    And I type the commit message "blocked"
    And I click "Commit" in the commit box
    Then the Changes error shows "hook says no"
    And the Changes list still has the file "a.txt"
    And the project has no new commit
    And I capture "hook-failed"

  Scenario: The commit box is usable on a phone
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    And I type the commit message "phone commit"
    Then the commit box and its buttons are inside the viewport
    And the page has no horizontal scroll
    And I capture "phone-commit-box"
    When I click "Commit" in the commit box
    Then the Changes result line says "Committed"
    And the page has no horizontal scroll
    And I capture "phone-committed"

  Scenario: An unresolved merge conflict replaces the commit box with the conflict banner
    Given the scratch project has an unresolved merge conflict
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the conflict banner says "Merge in progress" and lists "c.txt"
    And the commit box is not shown
    And the project head is unchanged
    And the project still has a merge in progress
    And I capture "conflict-banner-instead-of-commit"

  Scenario: A resolved merge that is not finished shows the banner without conflicted files
    Given the scratch project has a merge with its conflicts resolved but not committed
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the conflict banner says "Merge in progress"
    And the commit box is not shown
    And the project head is unchanged
    And the project still has a merge in progress
    And I capture "merge-banner-resolved"
