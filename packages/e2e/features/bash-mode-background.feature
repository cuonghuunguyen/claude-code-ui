Feature: A running ! command can be moved to the background

  Background:
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session

  Scenario Outline: A running ! command moves to the background, frees the session and Claude answers its end at <width>x<height>
    Given the viewport is <width>x<height>
    When I run the shell command "for i in $(seq 1 10); do echo tick-$i; sleep 1; done; echo bang-$((6*7))"
    And I click Run in background on the bash card
    Then the bash card runs in the background
    And the status bar shows "1 shell"
    When I note the reply count
    And I send "Reply with exactly: FREE"
    And the turn has finished
    And I capture "bang-backgrounded"
    Then a bash card shows "bang-42"
    And the bash card is finished
    And the status bar shows no shells
    And Claude has replied 2 times since the noted count
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
    When I run the shell command "for i in $(seq 1 10); do echo tick-$i; sleep 1; done; echo bang-$((6*7))"
    And I click Run in background on the bash card
    Then a bash card shows "bang-42"
    And the bash card is finished
    When I restart the daemon
    Then a bash card shows "bang-42"
    And the bash card is finished
    And I capture "bang-restored"

  Scenario: The shortcut moves a running ! command to the background
    Given the viewport is 1440x900
    When I run the shell command "for i in $(seq 1 15); do echo key-$i; sleep 1; done"
    And the bash card shows Run in background
    And I press "ControlOrMeta+Shift+B"
    Then the bash card runs in the background
    And the status bar shows "1 shell"
    And I capture "bang-shortcut"

  Scenario: A killed ! command starts no turn and Claude is told with the next message
    Given the viewport is 1440x900
    When I run the shell command "for i in $(seq 1 90); do echo kill-$i; sleep 1; done; echo zebra-kill-marker"
    And I click Run in background on the bash card
    And I note the reply count
    And I open the shells list from the status bar
    And I open the "zebra-kill-marker" shell
    And I kill the shell and confirm
    Then the shell details show "Claude will be told on your next message."
    When I close the shells list
    Then no Claude reply starts for 12 seconds
    When I send "A background shell of mine was stopped. Quote its command text exactly."
    And the turn has finished
    Then the chat shows a reply containing "zebra-kill-marker"
    And I capture "bang-kill-told"

  Scenario: A ! command with long output shows its last lines in the list
    Given the viewport is 1440x900
    When I run the shell command "for i in $(seq 1 6); do echo tick-$i; sleep 1; done; seq 1 40000; sleep 90; echo tail-end"
    And I click Run in background on the bash card
    And I open the shells list from the status bar
    And I open the "tail-end" shell
    Then the shell output starts with the truncation marker and ends with "40000"
    And I capture "bang-tail"

  Scenario: A subagent's Bash call keeps Run in background and the subagent goes on
    Given the viewport is 1440x900
    When I send "Use the Agent tool once. The subagent must use its Bash tool to run exactly this command in the foreground and nothing else: for i in $(seq 1 60); do echo sub-$i; sleep 1; done. Wait for the subagent, then reply only DONE."
    And I move the subagent Bash call "seq 1 60" to the background
    Then the status bar shows a shell within a minute
    And I capture "subagent-backgrounded"
