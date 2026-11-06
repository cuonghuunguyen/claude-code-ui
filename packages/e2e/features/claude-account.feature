Feature: Claude account: log in through the CLI, switch account from the usage ring (GH-615)

  Scenario: A failed login offers the CLI login in a terminal
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I add the Claude token account "bad" with the token "invalid-token" in Settings and pick it
    And I send the prompt "Reply with exactly: OK"
    Then the timeline warns "authentication_failed" and offers "Log in to Claude"
    And the failed turn shows exactly one "authentication_failed" warning
    And I capture "failed-login-warning"
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

  Scenario: A failed login offers the CLI login on a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I add the Claude token account "bad" with the token "invalid-token" in Settings and pick it
    And I send the prompt "Reply with exactly: OK"
    Then the timeline warns "authentication_failed" and offers "Log in to Claude"
    When I use the "Log in to Claude" button of the warning
    Then a terminal titled "Claude login" shows output
    And the page does not scroll sideways
    And I capture "login-terminal-phone"
    When I close the Claude login terminal
    And I remove the Claude token accounts

  Scenario: Settings opens the CLI login in a terminal
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I use the Claude login button in Settings
    Then a terminal titled "Claude login" shows output
    And I capture "settings-login-terminal"
    When I close the Claude login terminal

  Scenario: Switching refreshes the models and keeps the ring, no token leaks
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I record the websocket frames
    When I add the Claude token account "leak" with the token "sk-ant-oat01-TESTSECRET" in Settings and pick it
    Then the Claude account list shows "Token set" and the token field is empty
    And I capture "settings-account-list"
    When I open the usage ring
    Then the usage ring label names the account "leak"
    When I switch to "CLI login" in the usage ring
    Then the models are requested again
    And the usage ring is in the titlebar
    And the usage ring label names the account "CLI login"
    And I capture "after-switch"
    When I send the prompt "Reply with exactly: OK"
    Then a new Claude reply is shown
    When I pick the Claude account "leak" in Settings
    And I remove the Claude token accounts
    And I open the usage ring
    Then the account list is not offering "leak"
    And I capture "after-remove-active"
    And the token appears in no websocket frame, daemon log or web bundle

  Scenario: Without an environment token the default login shows as CLI login in the ring and Settings
    Given a Haiku session with one finished reply
    When I add the Claude token account "spare" with the token "invalid-token" in Settings and keep the default
    Then Settings checks "CLI login" and not "spare"
    And I capture "settings-default-is-cli"
    When I close Settings
    And I open the usage ring
    Then the account list checks "CLI login" and offers "spare"
    And I capture "ring-default-is-cli"
    When I remove the Claude token accounts

  Scenario: The account test of a refused token shows the error and keeps the account
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    And I record the websocket frames
    When I add the Claude token account "bad" with the token "sk-ant-oat01-TESTSECRET" in Settings and keep the default
    And I test the Claude token account "bad"
    Then the account test of "bad" shows an error containing "401"
    And Settings checks "CLI login" and not "bad"
    And I capture "account-test-refused"
    When I close Settings
    And I send the prompt "Reply with exactly: OK"
    Then a new Claude reply is shown
    When I remove the Claude token accounts
    Then the token appears in no websocket frame, daemon log or web bundle

  Scenario: The account test fits a phone screen
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I add the Claude token account "bad" with the token "invalid-token" in Settings and keep the default
    And I test the Claude token account "bad"
    Then the account test of "bad" shows an error containing "401"
    And the Test button of the Claude token account "bad" is at least 44px high
    And the page does not scroll sideways
    And I capture "account-test-phone"
    When I remove the Claude token accounts
