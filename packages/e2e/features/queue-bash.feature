Feature: Queue a shell command while a turn runs

  Background:
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Use the Bash tool to run exactly this command and nothing else: sleep 30; echo e2e > slept.txt"
    And I allow the permission request

  Scenario Outline: A shell command sent during the turn is queued and runs after it at <width>x<height>
    Given the viewport is <width>x<height>
    When I run the shell command "echo queued-$((6*7))"
    Then the queue shows the shell command "echo queued-$((6*7))"
    And the prompt box is empty
    And no prompt error shows
    And the page has no horizontal scroll
    And I capture "queued"
    When the turn has finished
    Then a bash card shows "queued-42"
    And the queue is empty
    And the page has no horizontal scroll
    And I capture "ran"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: Prompt, shell command, prompt run in submit order
    When I queue "Reply with exactly: ONE"
    And I run the shell command "echo two-$((6*7))"
    And I queue "Reply with exactly: THREE"
    Then the queue lists 3 items
    When the queue is empty
    And the turn has finished
    Then the transcript shows a prompt, a bash card, a prompt in that order after the first prompt
    And I capture "order"

  Scenario: Send now is disabled for the shell command and Edit restores bash mode
    When I run the shell command "echo edit-$((6*7))"
    Then the queue shows the shell command "echo edit-$((6*7))"
    And Send now on the queued shell command is disabled with a reason
    And I capture "send-now-disabled"
    When I edit the queued shell command
    Then the queue is empty
    And the prompt box is in bash mode with "echo edit-$((6*7))"
    And I capture "edit-restored"
