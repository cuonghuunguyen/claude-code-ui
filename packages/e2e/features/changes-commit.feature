Feature: Changes tab commits the checked files and Claude writes the commit message (GH-559)

  Background:
    Given the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the new files "a.txt, b.txt"

  Scenario: Commit a checked subset, keep the unchecked file listed, then Commit and Push goes through the push dialog
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
    When I check the file "b.txt" in the Changes tab
    And I type the commit message "add b and push"
    And I click "Commit and Push" in the commit box
    Then the "push" dialog shows the command "origin refs/heads/main:refs/heads/main"
    And I capture "push-dialog"
    When I confirm the "push" dialog
    Then the Changes result line says "Pushed main to origin"
    And the origin's main is the project's main
    And I capture "pushed"

  Scenario: The commit box and the Generate button are usable on a phone
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    Then the Generate button is inside the viewport and 44 px high
    And the page has no horizontal scroll
    And I capture "phone-generate-button"
    When I type the commit message "phone commit"
    Then the commit box and its buttons are inside the viewport
    And the page has no horizontal scroll
    And I capture "phone-commit-box"
    When I click "Commit" in the commit box
    Then the Changes result line says "Committed"
    And the page has no horizontal scroll
    And I capture "phone-committed"
