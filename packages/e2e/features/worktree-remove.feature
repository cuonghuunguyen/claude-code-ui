Feature: Remove worktree dialog and background removal

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And the scratch project ignores .claude and *.log

  Scenario: The dialog opens at once with Checking…, removal runs in the background and reports the ignored files, and the dialog shows what will be lost
    Given the scratch project has a clean worktree "wt-ignored"
    And the worktree "wt-ignored" has 3 ignored files
    And the scratch project has a worktree "wt-work" with an uncommitted edit
    And I open the scratch project
    When I open the Remove worktree dialog of "wt-ignored"
    Then the Remove worktree dialog is titled "Remove worktree wt-ignored?"
    And the Remove worktree dialog shows its result and Remove worktree is enabled
    And the Remove worktree dialog showed Checking… with Remove worktree disabled before its result
    And I capture "remove dialog"
    When I confirm the removal
    Then the Remove worktree dialog closes at once
    And the worktree folder "wt-ignored" is gone
    And a toast reports "3 ignored files deleted"
    And I capture "removed with ignored files"
    When I open the Remove worktree dialog of "wt-work"
    Then the Remove worktree dialog says "1 uncommitted file"
    And I capture "work dialog"

  Scenario: The Remove dialog on a phone fits the screen
    Given the viewport is 390x844
    And the scratch project has a clean worktree "wt-phone"
    And I open the scratch project
    When I open the Remove worktree dialog of "wt-phone"
    Then the Remove worktree dialog shows its result and Remove worktree is enabled
    And the Remove worktree dialog showed Checking… with Remove worktree disabled before its result
    And the Remove worktree dialog fits the viewport
    And I capture "phone remove dialog"
    When I confirm the removal
    Then the Remove worktree dialog closes at once
    And the worktree folder "wt-phone" is gone
