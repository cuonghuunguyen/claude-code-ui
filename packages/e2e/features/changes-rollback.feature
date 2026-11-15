Feature: Changes tab rolls back files and hunks and adds files and diff lines to the prompt

  Background:
    Given the scratch project is a git repository with two commits
    And the scratch project has a committed 30-line file "long.txt"

  Scenario: Rollback restores checked files and a row menu rolls back one file
    Given the scratch project has the edited file "README.md" and the new file "b.txt"
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "README.md" in the Changes tab
    And I check the file "README.md" in the Changes tab
    And I check the file "b.txt" in the Changes tab
    And I click "Rollback" in the commit box
    Then the Rollback dialog lists "README.md, b.txt"
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
