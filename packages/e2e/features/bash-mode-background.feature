Feature: A running ! command can be moved to the background

  Background:
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session

  Scenario Outline: A running ! command moves to the background, frees the session and Claude answers its end at <width>x<height>
    Given the viewport is <width>x<height>
    When I run the shell command "for i in $(seq 1 20); do echo tick-$i; sleep 1; done; echo bang-$((6*7))"
    And I click Run in background on the bash card
    Then the bash card runs in the background
    And the status bar shows "1 shell"
    When I send "Reply with exactly: FREE"
    And the turn has finished
    And I capture "bang-backgrounded"
    And I note the reply count
    Then a bash card shows "bang-42"
    And the bash card is finished
    And the status bar shows no shells
    And Claude replies after the shell ended
    And the page has no horizontal scroll
    And I capture "bang-notified"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A backgrounded ! command is in Background shells with live output and Kill
    Given the viewport is 1440x900
    When I run the shell command "for i in $(seq 1 60); do echo tick-$i; sleep 1; done"
    And I click Run in background on the bash card
    And I open the shells list from the status bar
    Then the shells list shows "seq 1 60" as running
    When I open the "seq 1 60" shell
    Then the shell output shows "tick-"
    When I kill the shell and confirm
    Then the shell details show "Claude will be told on your next message."
    And I capture "bang-killed"

  Scenario: A backgrounded ! command survives a reload of the transcript
    Given the viewport is 1440x900
    When I run the shell command "for i in $(seq 1 20); do echo tick-$i; sleep 1; done; echo bang-$((6*7))"
    And I click Run in background on the bash card
    Then a bash card shows "bang-42"
    And the bash card is finished
    When I restart the daemon
    Then a bash card shows "bang-42"
    And the bash card is finished
    And I capture "bang-restored"
