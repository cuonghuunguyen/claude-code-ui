Feature: Remove worktree dialog and background removal

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And the scratch project ignores .claude and *.log

  Scenario: The dialog opens at once with Checking…, removal runs in the background and reports the ignored files
    Given the scratch project has a clean worktree "wt-ignored"
    And the worktree "wt-ignored" has 3 ignored files
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

  Scenario: The row shows Removing… while a large worktree is deleted
    Given the scratch project has a clean worktree "wt-big"
    And the worktree "wt-big" has 12000 ignored files in many folders
    And I open the scratch project
    When I open the Remove worktree dialog of "wt-big"
    Then the Remove worktree dialog shows its result and Remove worktree is enabled
    When I confirm the removal
    Then the Remove worktree dialog closes at once
    And the row of "wt-big" showed Removing… dimmed before it disappeared
    And the worktree folder "wt-big" is gone
    And a toast reports an ignored files count

  Scenario: The dialog shows what will be lost and a blocked removal never starts
    Given the scratch project has a worktree "wt-work" with an uncommitted edit
    And I open the scratch project
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

  Scenario Outline: DATA SAFETY: work added after the check refuses the removal and deletes nothing
    Given the scratch project has a clean worktree "wt-safe"
    And I open the scratch project
    When I open the Remove worktree dialog of "wt-safe"
    Then the Remove worktree dialog shows its result and Remove worktree is enabled
    And I capture "safe dialog"
    When <terminal change>
    And I confirm the removal
    Then the removal is refused with an error naming "wt-safe"
    And nothing of the worktree "wt-safe" was deleted
    And the branch "wt-safe" still exists
    And the worktree row of "wt-safe" is not dimmed
    And I capture "refused"

    Examples:
      | terminal change                                                                                                                     |
      | in a terminal I edit README.md in the worktree "wt-safe"                                                                            |
      | in a terminal I add the file "notes.txt" to the worktree "wt-safe"                                                                  |
      | in a terminal I commit a change in the worktree "wt-safe"                                                                           |

  Scenario: DATA SAFETY: a tracked edit and an untracked file together refuse the removal
    Given the scratch project has a clean worktree "wt-both"
    And I open the scratch project
    When I open the Remove worktree dialog of "wt-both"
    Then the Remove worktree dialog shows its result and Remove worktree is enabled
    When in a terminal I edit README.md in the worktree "wt-both"
    And in a terminal I add the file "notes.txt" to the worktree "wt-both"
    And I confirm the removal
    Then the removal is refused with an error naming "wt-both"
    And nothing of the worktree "wt-both" was deleted
    And the file "notes.txt" of the worktree "wt-both" still exists
    And the branch "wt-both" still exists
    And I capture "both refused"

  Scenario: DATA SAFETY on a phone: the removal is refused and nothing is deleted
    Given the viewport is 390x844
    And the scratch project has a clean worktree "wt-psafe"
    And I open the scratch project
    When I open the Remove worktree dialog of "wt-psafe"
    Then the Remove worktree dialog shows its result and Remove worktree is enabled
    When in a terminal I edit README.md in the worktree "wt-psafe"
    And in a terminal I add the file "notes.txt" to the worktree "wt-psafe"
    And I confirm the removal
    Then nothing of the worktree "wt-psafe" was deleted
    And the file "notes.txt" of the worktree "wt-psafe" still exists
    And the branch "wt-psafe" still exists
    And I capture "phone refused"
