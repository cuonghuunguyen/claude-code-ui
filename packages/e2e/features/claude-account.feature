Feature: Claude account: log in through the CLI, switch account from the usage ring (GH-615)

  Scenario: A failed login offers the CLI login in a terminal
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I add the Claude token account "bad" with the token "invalid-token" in Settings and pick it
    And I send the prompt "Reply with exactly: OK"
    Then the timeline warns "authentication_failed" and offers "Log in to Claude"
    When I use the "Log in to Claude" button of the warning
    Then a terminal titled "Claude login" shows output
    And the page does not scroll sideways
    And I capture "login-terminal"
    When I close the Claude login terminal
    And I remove the Claude token accounts

  Scenario: The usage ring switches the account
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I add the Claude token account "bad" with the token "invalid-token" in Settings and pick it
    And I open the usage ring
    Then the usage popover names the account "bad"
    And the account list checks "bad" and offers "CLI login"
    And I capture "usage-ring-accounts"
    When I switch to "CLI login" in the usage ring
    Then the account list checks "CLI login"
    And the usage ring is in the titlebar
    When I send the prompt "Reply with exactly: OK"
    Then a new Claude reply is shown
    When I remove the Claude token accounts

  Scenario: The account switcher fits a phone screen
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I add the Claude token account "bad" with the token "invalid-token" in Settings and pick it
    And I open the usage ring
    Then the usage popover is inside the viewport
    And the page does not scroll sideways
    And I capture "usage-ring-accounts-phone"
    When I remove the Claude token accounts
