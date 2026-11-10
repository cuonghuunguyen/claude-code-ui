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

  Scenario: Untracked files show U, a staged new file shows A
    Given the file "b.txt" of the scratch project is staged
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the Changes badge of "a.txt" is "U"
    And the Changes badge of "b.txt" is "A"
    And I capture "untracked-badge"

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

  Scenario: The commit message instructions are kept in Settings Git, Stop keeps the typed message, Generate writes a message for the checked files
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open Settings and choose the Git group
    And I set the commit message instruction to "Write one short line."
    And I set the commit message instruction of the project to "Answer in French."
    # After a reload the new-session tab picks the project with the newest activity, which can be an earlier scenario's: pick ours again.
    And I reload the page
    And I start a new Haiku session
    And I open Settings and choose the Git group
    Then the commit message instruction is "Write one short line."
    And the commit message instruction of the project is "Answer in French."
    And I capture "commit-message-instructions"
    When I close Settings
    And I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I type the commit message "draft text"
    And I check the file "a.txt" in the Changes tab
    And I click Generate in the commit box
    And I click Stop in the commit box
    Then the commit message box holds exactly "draft text"
    And Generate is available again
    And no error shows in the commit box
    And I capture "commit-message-stopped"
    When I type the commit message ""
    And I click Generate in the commit box
    Then the commit message box holds a message from Claude
    And Commit is enabled
    And no error shows in the commit box
    And I capture "commit-message-generated"

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
