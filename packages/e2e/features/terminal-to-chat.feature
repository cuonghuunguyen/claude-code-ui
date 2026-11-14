Feature: Selected terminal output goes to the chat (GH-710)

  Scenario: A. Docked terminal on desktop: floating menu and Add to chat
    Given the viewport is 1440x900
    And I start a Haiku session with the terminal docked
    When I type "printf '\e[31mred-710\e[0m\n'" in the terminal
    Then the terminal shows "red-710" on a line of its own
    When I select the terminal output line "red-710"
    Then the terminal selection menu offers "Add to chat"
    And the terminal selection menu sits at the end of the selection
    And I capture "terminal-selection-menu"
    When I click Add to chat in the terminal selection menu
    Then the prompt box has the terminal output block with "red-710" for "Terminal 1"
    And the terminal selection menu is gone
    And I capture "terminal-add"

  Scenario: B. Context menu: Add to chat needs a selection
    Given the viewport is 1440x900
    And I start a Haiku session with the terminal docked
    When I type "printf '\e[31mred-710\e[0m\n'" in the terminal
    Then the terminal shows "red-710" on a line of its own
    When I right click the empty terminal area
    Then the terminal menu offers Add to chat disabled with a reason
    When I close the terminal menu
    And I select the terminal output line "red-710"
    And I right click the selected terminal output
    Then the terminal menu offers Add to chat enabled
    And I capture "terminal-menu-enabled"
    When I click Add to chat in the terminal menu
    Then the prompt box has the terminal output block with "red-710" for "Terminal 1"
    And I capture "terminal-menu-add"

  Scenario: C. A selection over the cap is truncated to its tail
    Given the viewport is 1440x900
    And I start a Haiku session with the terminal docked
    When I run "seq 1 5000" in the terminal and wait for its output to end with "5000"
    And I select the terminal output over the cap down to the last visible row
    Then the terminal selection menu offers "Add to chat"
    When I click Add to chat in the terminal selection menu
    Then the prompt box has the terminal output block for "Terminal 1" marked truncated
    And I capture "terminal-truncated"

  Scenario: D. Phone: Add to chat shows the block in the session pane
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And the viewport is 390x844
    When I open the terminal pane on the phone
    When I type "printf '\e[31mred-710\e[0m\n'" in the terminal
    Then the terminal shows "red-710" on a line of its own
    When I select the terminal output line "red-710"
    And I click Add to chat in the terminal selection menu
    Then the prompt box has the terminal output block with "red-710" for "Terminal 1"
    And the scrollWidth of the page is 390
    And I capture "terminal-phone"

  Scenario: E. Main area Terminal tab: Add to chat opens the owner session
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    And I type "printf '\e[31mred-710\e[0m\n'" in the terminal
    Then the terminal shows "red-710" on a line of its own
    When I select the terminal output line "red-710"
    And I click Add to chat in the terminal selection menu
    Then the session tab is the selected tab
    And the prompt box has the terminal output block with "red-710" for "Terminal 1"
    And I capture "terminal-main-area-add"
