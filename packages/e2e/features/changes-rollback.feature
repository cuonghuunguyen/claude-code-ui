Feature: Changes tab rolls back files and hunks and adds files and diff lines to the prompt

  Background:
    Given the scratch project is a git repository with two commits
    And the scratch project has a committed 30-line file "long.txt"

  Scenario: Rollback after the files changed is refused, then Rollback restores checked files, a row menu rolls back one file and Delete local copies removes the new file
    Given the scratch project has the edited file "README.md" and the new file "b.txt"
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "README.md" in the Changes tab
    And I click "Rollback" in the commit box
    Then the Rollback dialog lists "README.md"
    When the project file "README.md" is overwritten with "changed after the dialog opened\n"
    And I confirm the Rollback dialog
    Then the Changes error shows "changed"
    And the project file "README.md" holds "changed after the dialog opened\n"
    And I capture "stale-refused"
    When I check the file "README.md" in the Changes tab
    And I check the file "b.txt" in the Changes tab
    And I click "Rollback" in the commit box
    Then the Rollback dialog lists "README.md, b.txt"
    And the Rollback option "Delete local copies of added files" is off
    And I capture "rollback-dialog"
    When I confirm the Rollback dialog
    Then the Changes result line says "Rolled back"
    And the project file "README.md" holds "# Fixture\n"
    And the project file "b.txt" exists
    And the Changes list still has the file "b.txt"
    And the Changes list no longer has the file "README.md"
    And I capture "rolled-back"
    When the project file "README.md" is overwritten with "overwritten for the row menu\n"
    And I reload the Changes tab from disk
    And I choose "Rollback…" in the menu of the Changes row "README.md"
    Then the Rollback dialog lists "README.md"
    And I capture "row-menu-dialog"
    When I confirm the Rollback dialog
    Then the Changes result line says "Rolled back"
    And the project file "README.md" holds "# Fixture\n"
    And the Changes list still has the file "b.txt"
    And I capture "row-menu-rolled-back"
    When the project file "README.md" is overwritten with "overwritten for the delete option\n"
    And I reload the Changes tab from disk
    And I check the file "b.txt" in the Changes tab
    And I click "Rollback" in the commit box
    Then the Rollback dialog lists "b.txt"
    When I turn the Rollback option "Delete local copies of added files" on
    And I capture "rollback-delete-option"
    And I confirm the Rollback dialog
    Then the Changes result line says "Rolled back"
    And the project file "b.txt" does not exist
    And the Changes list no longer has the file "b.txt"
    And the Changes list still has the file "README.md"
    And I capture "deleted-local-copy"

  Scenario: Hunk Rollback, then Restore from the Timeline, gives the file back
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    Then the diff of "long.txt" has 2 hunk Rollback buttons
    And I capture "two-hunks"
    When I click the hunk Rollback button number 1
    Then the Changes result line says "Rolled back"
    And no Rollback dialog is shown
    And the diff of "long.txt" has 1 hunk Rollback buttons
    And the project file "long.txt" has line 3 "line 3" and line 25 "line 25 edited"
    And I capture "first-hunk-rolled-back"
    When I open the Files tab of the side panel
    And I open the tree file "long.txt"
    And I open the Timeline
    Then the Timeline lists "Before rollback, add long"
    And I capture "timeline-before-rollback"
    When I choose "Restore" in the menu of the Timeline row "Before rollback"
    And I close the file tree drawer
    Then the Files editor has the text "line 3 edited" and "line 25 edited"
    And I capture "timeline-restored"

  Scenario: Add to prompt from a Changes row menu, Add to chat in the selection menu and Alt+K insert the numbered diff lines
    Given the scratch project has the edited file "README.md" and the new file "b.txt"
    And the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I choose "Add to prompt" in the menu of the Changes row "README.md"
    Then the prompt box contains "@README.md"
    And I capture "row-add-to-prompt"
    When I open the diff of "long.txt" in the Changes tab
    Then the narrow diff header shows the file name and has no send button
    And I capture "narrow-header"
    When I select the diff lines from the removed line 3 to the added line 3
    And I capture "lines-selected"
    And I click "Add to chat" in the selection menu
    Then the prompt box has the diff lines "-3 | line 3" and "+3 | line 3 edited"
    And I capture "selection-sent"
    When I select the diff lines from the removed line 25 to the added line 25
    And I press Alt+K in the diff
    Then the prompt box has the diff lines "-25 | line 25" and "+25 | line 25 edited"
    And I capture "alt-k-sent"

  Scenario: The hunk button, the selection menu and the Rollback dialog fit a phone
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    And the pointer is coarse
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    Then the diff of "long.txt" has 2 hunk Rollback buttons
    And every hunk Rollback button is inside the viewport
    When I select the diff lines from the removed line 3 to the added line 3
    Then the selection menu buttons are at least 44px high
    And the page has no horizontal scroll
    And I capture "phone-hunk-buttons"
    When I check the file "long.txt" in the Changes tab
    And I click "Rollback" in the commit box
    Then the Rollback dialog lists "long.txt"
    And the Rollback dialog is inside the viewport
    And the page has no horizontal scroll
    And I capture "phone-rollback-dialog"
