Feature: Changes tab adds files and diff lines to the prompt

  Background:
    Given the scratch project is a git repository with two commits
    And the scratch project has a committed 30-line file "long.txt"

  Scenario: Add to prompt from a Changes row menu
    Given the scratch project has the edited file "README.md" and the new file "b.txt"
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I choose "Add to prompt" in the menu of the Changes row "README.md"
    Then the prompt box contains "@README.md"
    And I capture "row-add-to-prompt"

  Scenario: Send selection to Claude inserts the numbered diff lines
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    And I select the diff lines from the removed line 3 to the added line 3
    And I capture "lines-selected"
    And I click "Send selection to Claude" in the diff
    Then the prompt box has the diff lines "-3 | line 3" and "+3 | line 3 edited"
    And I capture "selection-sent"

  Scenario: Alt+K sends the selected diff lines
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    And I select the diff lines from the removed line 25 to the added line 25
    And I press Alt+K in the diff
    Then the prompt box has the diff lines "-25 | line 25" and "+25 | line 25 edited"
    And I capture "alt-k-sent"

  Scenario: The send button fits a phone
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    Then the send selection button is at least 44px high
    And the page has no horizontal scroll
    And I capture "phone-send-button"
