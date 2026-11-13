Feature: Selecting text in a diff or an editor shows an Add to chat / Quote menu (GH-706)

  Background:
    Given the scratch project is a git repository with two commits
    And the scratch project has a committed 30-line file "long.txt"

  Scenario: A. Changes diff on desktop: menu, Add to chat and Quote
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    And I select the diff lines from the removed line 3 to the added line 3
    Then the selection menu offers "Add to chat" and "Quote"
    And no button is named like "Send selection"
    And the selection menu text does not mention "Claude"
    And I capture "diff-menu"
    When I click "Add to chat" in the selection menu
    Then the prompt box has the diff lines "-3 | line 3" and "+3 | line 3 edited"
    And I capture "diff-add"
    When I select the diff lines from the removed line 25 to the added line 25
    And I click "Quote" in the selection menu
    Then the prompt box has a quoted block
    And I capture "diff-quote"

  Scenario: B. Files editor: Add to chat, Quote and no menu without a selection
    Given the scratch project has the five-line file "sel.ts"
    And the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Files tab of the side panel
    And I open the tree file "sel.ts"
    And I select two full lines of the Files editor
    Then the selection menu offers "Add to chat" and "Quote"
    And the selection menu text does not mention "Claude"
    When I click "Add to chat" in the selection menu
    Then the prompt box has a file mention with a line range
    And I capture "editor-add"
    When I select two full lines of the Files editor
    And I click "Quote" in the selection menu
    Then the prompt box has a quoted block
    And I capture "editor-quote"
    When I click once in the Files editor
    Then the selection menu is absent
    And I capture "editor-no-menu"

  Scenario: C. Changes diff on a phone: menu below the selection with 44px buttons
    Given the scratch project has long.txt edited at lines 3 and 25
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    And the pointer is coarse
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the diff of "long.txt" in the Changes tab
    And I select the diff lines from the removed line 3 to the added line 3
    Then the selection menu is below the selected diff rows
    And the selection menu buttons are at least 44px high
    And the page has no horizontal scroll
    And I capture "menu-phone"
