Feature: Run a running Bash command in the background

  Background:
    Given the app is open
    And I open the scratch project
    And I start a new Haiku session

  Scenario Outline: Run in background moves a running command to the background at <width>x<height>
    Given the viewport is <width>x<height>
    When I send "Use the Bash tool to run exactly this command in the foreground (no run_in_background) and nothing else: for i in $(seq 1 25); do sleep 1; done; echo done"
    And I allow the permission request
    Then the "seq 1 25" tool call is running
    When I click Run in background on the "seq 1 25" tool card
    And the turn has finished
    And I note the reply count
    Then the "seq 1 25" tool call is running
    And the status bar shows "1 shell"
    And the "seq 1 25" tool card has no Run in background button right away
    And the page has no horizontal scroll
    And I capture "backgrounded"
    When the "seq 1 25" tool call is finished
    Then the status bar shows no shells
    And Claude replies after the shell ended
    And the page has no horizontal scroll
    And I capture "notified"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: The card button is a 44 px touch target on a phone
    Given the viewport is 390x844
    When I send "Use the Bash tool to run exactly this command in the foreground (no run_in_background) and nothing else: for i in $(seq 1 25); do sleep 1; done; echo done"
    And I allow the permission request
    And the Run in background button shows on the "seq 1 25" tool card
    Then the Run in background button is at least 44 px on the "seq 1 25" tool card
    And the page has no horizontal scroll
    And I capture "phone-button"

  Scenario: The shortcut moves the running command to the background
    Given the viewport is 1440x900
    When I send "Use the Bash tool to run exactly this command in the foreground (no run_in_background) and nothing else: for i in $(seq 1 25); do sleep 1; done; echo done"
    And I allow the permission request
    And the Run in background button shows on the "seq 1 25" tool card
    And I press "ControlOrMeta+Shift+B"
    And the turn has finished
    Then the "seq 1 25" tool call is running
    And the status bar shows "1 shell"
    And the "seq 1 25" tool card has no Run in background button right away
    And I capture "shortcut-backgrounded"

  Scenario: A finished command has no Run in background button
    When I send "Use the Bash tool to run exactly this command in the foreground (no run_in_background) and nothing else: echo quick > quick.txt"
    And I allow the permission request
    And the turn has finished
    Then the "quick.txt" tool call is finished
    And the "quick.txt" tool card has no Run in background button
    And I capture "finished-no-button"

  Scenario: A command started with run_in_background has no Run in background button
    When I send "Use the Bash tool with run_in_background set to true to run exactly this command and nothing else: for i in $(seq 1 25); do sleep 1; done; echo done"
    And I allow the permission request
    And the turn has finished
    Then the "seq 1 25" tool card has no Run in background button
    And I capture "started-in-background-no-button"

  Scenario: A backgrounded command still shows as backgrounded after a reload
    When I send "Use the Bash tool to run exactly this command in the foreground (no run_in_background) and nothing else: for i in $(seq 1 25); do sleep 1; done; echo done"
    And I allow the permission request
    And I click Run in background on the "seq 1 25" tool card
    And the turn has finished
    Then the status bar shows "1 shell"
    When I reload the page
    Then the "seq 1 25" tool call is running
    And the status bar shows "1 shell"
    And the "seq 1 25" tool card has no Run in background button right away
    And I capture "after-reload"
