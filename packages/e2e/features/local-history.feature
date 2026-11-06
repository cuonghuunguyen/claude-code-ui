Feature: Local history and Timeline (GH-565)

  Background:
    Given the scratch project is a git repository with two commits

  Scenario: Saving a file adds a Local history entry that the Timeline compares and restores
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/app.ts"
    And I type "// edit " at the start of the Files editor
    And I save the Files editor
    And I open the Timeline
    Then the Timeline lists "File saved, second commit"
    And I capture "timeline-after-save"
    When I choose "Compare with current" in the menu of the Timeline row "File saved"
    Then the comparison dialog is shown
    And I capture "timeline-compare"
    When I close the comparison dialog
    And I hide Git history in the Timeline
    Then the Timeline lists "File saved"
    And I capture "timeline-history-only"
    When I choose "Restore" in the menu of the Timeline row "File saved"
    And I close the file tree drawer
    Then the Files editor text is "export const app = 1;"
    And I capture "timeline-restored"

  Scenario: An agent edit of an existing file adds a Local history entry
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I send "Read src/app.ts, then use the Edit tool to change `app = 1` to `app = 2` in src/app.ts. Reply with the word done."
    Then I see a permission request
    When I allow the permission request
    Then the turn has finished
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/app.ts"
    And I open the Timeline
    Then the Timeline lists "Agent edit, second commit"
    And I capture "timeline-agent-edit"

  Scenario: The Timeline fits a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I open the tree file "src/app.ts"
    And I open the Timeline
    Then the Timeline lists "second commit"
    And the page is exactly 390px wide
    And every Timeline row is at least 44px high
    And I capture "timeline-phone"
