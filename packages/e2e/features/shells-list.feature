Feature: Manage background shells: list, view output, kill

  Background:
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session

  Scenario: Shells Claude started and shells moved to the background show in the list from every entry point
    Given the viewport is 1440x900
    When I ask Claude to run "for i in $(seq 1 90); do echo alpha-$i; sleep 1; done" in the background
    And I run "for i in $(seq 1 90); do echo beta-$i; sleep 1; done" in the foreground and move it to the background
    Then the status bar shows "2 shells"
    When I open the shells list from the status bar
    Then the shells list has 2 rows
    And the shells list shows "alpha-" as running
    And the shells list shows "beta-" as running
    And I capture "status-bar"
    When I close the shells list
    And I run "Background shells" from the command palette
    Then the shells list has 2 rows
    And I capture "palette"
    When I close the shells list
    And I send "/tasks"
    Then the shells list has 2 rows
    And I capture "tasks"
    When I close the shells list
    And I send "/bashes"
    Then the shells list has 2 rows
    And I capture "bashes"

  Scenario: A running shell shows live output and a finished one shows output, run time and exit code
    Given the viewport is 1440x900
    When I ask Claude to run "for i in $(seq 1 15); do echo tick-$i; sleep 1; done; exit 3" in the background
    And I open the shells list from the status bar
    And I open the "tick-" shell
    Then the shell details show "Running"
    And the shell output shows "tick-"
    And the shell output grows
    And I capture "running-output"
    And the shell details show "exit code 3"
    And the shell details show "Failed"
    And the shell details show a run time
    And the shell output shows "tick-15"
    And the shell has no Kill button
    And I capture "finished-output"

  Scenario: Kill with confirm stops a running shell
    Given the viewport is 1440x900
    When I ask Claude to run "for i in $(seq 1 300); do echo tick-$i; sleep 1; done" in the background
    And I open the shells list from the status bar
    And I open the "tick-" shell
    Then the shell output shows "tick-"
    When I kill the shell and confirm
    Then the shell details show "Killed"
    And the shell has no Kill button
    And the status bar shows no shells
    And I capture "killed"
    When I close the shells list
    Then the "tick-" tool call is killed

  Scenario: After a kill Claude is told with the next message, not by a turn of its own
    Given the viewport is 1440x900
    When I ask Claude to run "for i in $(seq 1 300); do echo tick-$i; sleep 1; done" in the background
    And I open the shells list from the status bar
    And I open the "tick-" shell
    And I kill the shell and confirm
    Then the shell details show "Killed"
    And the shell details show "Claude will be told on your next message"
    When I close the shells list
    And I send "Reply with one word: ok"
    Then the turn has finished
    And I capture "notification-next-message"

  Scenario: The list survives a reload and a daemon restart
    Given the viewport is 1440x900
    When I ask Claude to run "echo restored-out; exit 3" in the background
    And I ask Claude to run "for i in $(seq 1 200); do sleep 1; done" in the background
    And I open the shells list from the status bar
    Then the shells list has 2 rows
    And the shells list shows "restored-out" as failed
    When I close the shells list
    And I reload the page
    Then the status bar shows "1 shell"
    When I run "Background shells" from the command palette
    Then the shells list has 2 rows
    And the shells list shows "restored-out" as failed
    And I capture "after-reload"
    When I close the shells list
    And I restart the daemon
    Then the app is connected
    When I reload the page
    Then I see my prompt in the transcript
    When I run "Background shells" from the command palette
    Then the shells list has 2 rows
    And the shells list shows "restored-out" as failed
    And I capture "after-restart-list"
    When I open the "restored-out" shell
    Then the shell details show "exit code 3"
    And the shell output is not an error
    And the shell output shows its text or "Output not available"
    And I capture "after-restart-output"

  Scenario: The shells list is usable on a phone
    Given the viewport is 390x844
    When I ask Claude to run "for i in $(seq 1 120); do echo tick-$i; sleep 1; done" in the background
    And I open the shells list from the status bar
    Then the shell rows are at least 44 px high
    And the shells dialog fits the viewport
    And the page has no horizontal scroll
    And I capture "phone-list"
    When I open the "tick-" shell
    Then the shell output shows "tick-"
    And the Kill button is reachable and at least 44 px high
    And the shells dialog fits the viewport
    And the page has no horizontal scroll
    And I capture "phone-detail"

  Scenario: Each split pane opens the shells of its own session
    Given the viewport is 1440x900
    When I ask Claude to run "for i in $(seq 1 120); do echo alpha-$i; sleep 1; done" in the background
    And I open a second session that runs "for i in $(seq 1 120); do echo beta-$i; sleep 1; done" in the background
    And I split the two sessions one above the other
    Then the session area is split
    When I click the shells field of pane 1
    Then the shells list has 1 rows
    And the shells list shows "alpha-"
    And I capture "pane-1-mouse"
    When I close the shells list
    And I click the shells field of pane 2
    Then the shells list has 1 rows
    And the shells list shows "beta-"
    And I capture "pane-2-mouse"
    When I close the shells list
    And I reach the shells field of pane 1 with Tab and press Enter
    Then the shells list shows "alpha-"
    And the shells list does not show "beta-"
    And I capture "pane-1-keyboard"
    When I close the shells list
    And I reach the shells field of pane 2 with Tab and press Enter
    Then the shells list shows "beta-"
    And the shells list does not show "alpha-"
    And I capture "pane-2-keyboard"
