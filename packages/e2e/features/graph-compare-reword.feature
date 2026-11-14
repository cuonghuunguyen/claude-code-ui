Feature: Graph compare and Edit Commit Message (GH-667)

  Scenario: Compare with Local lists the changes since a commit
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the scratch project's file "README.md" has an uncommitted edit
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "initial"
    And I pick "Compare with Local" in the compare menu
    Then the compare list shows the file "README.md"
    And the compare list shows the file "work.txt"
    And I capture "compare-with-local"
    When I open the compare file "README.md"
    Then the compare diff is shown
    And I capture "compare-file-diff"
    When I go back from the compare file
    And I go back from the compare list
    And I open the commit menu on the row "local work"
    And I pick "Compare Before with Local" in the compare menu
    Then the compare list shows the file "work.txt"
    And the compare list shows the file "README.md"
    And I capture "compare-before-with-local"

  Scenario: Edit Commit Message rewords HEAD with amend
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    And I pick "Edit Commit Message…" in the compare menu
    Then the reword message is "local work"
    When I type the reword message "local work, reworded"
    Then the reword dialog shows the command "git commit --amend --only --allow-empty -m"
    And I capture "reword-amend"
    When I confirm the reword dialog
    Then the Graph result line says "Edited message of"
    And the last commit of the project is "local work, reworded"
    And the commit row "local work, reworded" exists

  Scenario: Edit Commit Message rewords an older commit with a rebase
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "first local" that adds "first.txt"
    And the scratch project's main has the local commit "second local" that adds "second.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "first local"
    And I pick "Edit Commit Message…" in the compare menu
    And I type the reword message "first local, reworded"
    Then the reword dialog shows the command "rebase -i --autosquash --autostash"
    And the reword dialog shows 2 commands
    And I capture "reword-rebase"
    When I confirm the reword dialog
    Then the Graph result line says "Edited message of"
    And the commit row "first local, reworded" exists
    And the commit row "second local" exists
    And the project has no commit with the subject "amend!"
    And the project's last two subjects are "second local" and "first local, reworded"

  Scenario: Edit Commit Message is disabled for a pushed commit
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "initial"
    Then the compare menu item "Edit Commit Message…" is disabled and says "Already pushed to origin/main"
    And I capture "reword-pushed"

  Scenario: The reword dialog fits a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And a Haiku session with one finished reply
    Given the viewport is 390x844
    When I open the Graph tab of the side panel
    And I open the commit menu on the visible row "local work"
    And I pick "Edit Commit Message…" in the compare menu
    And I type the reword message "a message that is long enough to make the command wrap onto several lines of the dialog"
    Then the page has no horizontal scroll
    And I capture "reword-phone"
