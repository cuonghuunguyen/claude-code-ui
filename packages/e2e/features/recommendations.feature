Feature: Recommendations (GH-518)

  Scenario: The Create worktree modal suggests connecting Jira once
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And I open the scratch project
    When I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows the Jira hint
    And I capture "jira hint"
    When I click the Connect Jira hint
    Then Settings › Jira is open
    And I capture "jira settings from hint"
    When I close Settings
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows no Jira hint
    When I reload the page
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows no Jira hint

  Scenario: Show recommendations off: no Jira hint
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And I open the scratch project
    When I open Settings › General
    And I turn off Show recommendations
    Then Show recommendations is off
    And I capture "recommendations off"
    When I close Settings
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows no Jira hint

  Scenario: Opening files in tabs twice teaches middle-click
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "notes.md" with the text "# Notes"
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I choose "Open in tab" in the tree menu of "notes.md"
    Then a toast says "Tip: middle-click a file in the tree to open it in its own tab."
    And I capture "middle-click tip"
