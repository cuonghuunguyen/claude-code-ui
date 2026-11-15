Feature: Create worktree modal

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin

  Scenario: The project menu has Create worktree…, and the Name tab creates a worktree that opens a new session in it
    Given I open the scratch project
    Then the menu of the scratch project has "create-worktree" and not "new-worktree"
    And I capture "desktop project menu"
    When I press "Escape"
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    When I open the "name" tab of the modal
    And I type the worktree name "feat/x"
    Then the modal shows branch "feat/x" in folder ".claude/worktrees/feat-x"
    And I capture "name tab"
    When I confirm the modal
    Then the modal closes
    And the new-session tab runs in the worktree "feat/x"
    And the worktree folder "feat-x" is on branch "feat/x"
    And I capture "new session in worktree"

  Scenario: The modal fits a phone screen and opens from the project menu, which has no quick New worktree item
    Given the viewport is 390x844
    And I open the scratch project
    When I choose "create-worktree" in the menu of the scratch project
    Then the Create worktree modal is open
    And the modal fits the viewport
    When I open the "name" tab of the modal
    And I type the worktree name "phone"
    And I open the "branch" tab of the modal
    Then the modal fits the viewport
    And I capture "phone modal"
    When I press "Escape"
    Then no Create worktree modal is open
    And the menu of the scratch project has "create-worktree" and not "new-worktree"
    And I capture "phone project menu"
