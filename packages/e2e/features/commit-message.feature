Feature: Claude writes the commit message of the checked files (GH-559)

  Background:
    Given the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the new files "a.txt, b.txt"

  Scenario: Generate a commit message for the checked files
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    And I click Generate in the commit box
    Then the commit message box holds a message from Claude
    And Commit is enabled
    And no error shows in the commit box
    And I capture "commit-message-generated"

  Scenario: Stop keeps the typed message
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I type the commit message "draft text"
    And I check the file "a.txt" in the Changes tab
    And I click Generate in the commit box
    And I click Stop in the commit box
    Then the commit message box holds exactly "draft text"
    And Generate is available again
    And no error shows in the commit box
    And I capture "commit-message-stopped"

  Scenario: The commit message instructions are kept in Settings Git
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

  Scenario: The Generate button is usable on a phone
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I check the file "a.txt" in the Changes tab
    Then the Generate button is inside the viewport and 44 px high
    And the page has no horizontal scroll
    And I capture "phone-generate-button"
