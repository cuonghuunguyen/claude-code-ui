Feature: Clean up scan and status cache

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project ignores .claude and *.log
    And the scratch project has a worktree "wt-squash" that origin already squash merged
    And the scratch project has a clean worktree "wt-clean"
    And the scratch project has a worktree "wt-work" with an uncommitted edit
    And the scratch project has a worktree "wt-cancel" whose commits cancel out

  Scenario: Clean up fetches first, a squash-merged worktree is Safe and can be removed with its branch
    Given I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-squash" is "Safe"
    And the Clean up row "wt-squash" mentions "squash/rebase merged"
    And the Clean up row "wt-squash" mentions "ignored files: checked at removal"
    And the Clean up row "wt-clean" is "Safe"
    And the Clean up row "wt-work" is "Has work"
    And the Clean up row "wt-cancel" is "has unmerged commits"
    And Clean up showed Fetching… and then Fetched
    And the status bar of the app answers while Clean up scans
    And I capture "clean up scan"
    When I tick the Clean up row "wt-squash"
    And I also delete the branch of the Clean up row "wt-squash"
    And I capture "squash ticked"
    And I confirm Clean up
    Then the worktree folder "wt-squash" is gone
    And the branch "wt-squash" is gone
    And the worktree folder "wt-cancel" is on branch "wt-cancel"
    And the worktree folder "wt-work" is on branch "wt-work"
    And I capture "after clean up"

  Scenario: A worktree whose commits cancel out stays and its branch is kept
    Given I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-cancel" is "unmerged commits"
    And the Clean up row "wt-cancel" mentions "ignored files: checked at removal"
    And I capture "net zero branch"

  Scenario: Clean up still resolves rows when origin is unreachable
    Given the origin of the scratch project is unreachable
    And I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up says the fetch failed and rows still resolve
    And the Clean up row "wt-clean" is "Safe"
    And I capture "fetch failed"

  Scenario: Clean up on a phone fits the screen and shows the scan
    Given the viewport is 390x844
    And I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-squash" is "Safe"
    And the Clean up dialog fits the viewport
    And I capture "phone clean up"

  Scenario: Reopening Clean up shows the cached rows at once and a changed row is rechecked
    Given I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-clean" is "Safe"
    And the Clean up row "wt-squash" is "Safe"
    When I close the Clean up dialog
    And in a terminal I edit README.md in the worktree "wt-clean" and stage it
    And I open Clean up from the menu of the scratch project
    Then the Clean up row "wt-clean" is "Has work"
    And the Clean up row "wt-squash" is "Safe"
    And the cached row "wt-squash" was shown before the fetch finished
    And the row "wt-clean" showed Checking… with its checkbox disabled and then a fresh result
    And I capture "second open"

  Scenario: A plain file edit from a terminal is seen when Clean up is reopened
    Given I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-clean" is "Safe"
    When I close the Clean up dialog
    And in a terminal I edit README.md in the worktree "wt-clean"
    And I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-clean" is "Has work"
    And I capture "plain edit seen"

  Scenario: A file edited while Clean up is open stops the removal of that row
    Given I open the scratch project
    When I open Clean up from the menu of the scratch project
    Then Clean up has finished fetching
    And the Clean up row "wt-clean" is "Safe"
    When I tick the Clean up row "wt-clean"
    And in a terminal I edit README.md in the worktree "wt-clean"
    And I confirm Clean up
    Then the Clean up summary says "wt-clean" was not removed because it "Changed since it was checked"
    And nothing of the worktree "wt-clean" was deleted
    And I capture "edit refused"

