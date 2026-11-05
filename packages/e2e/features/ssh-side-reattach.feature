# GH-549, ADR 0009. An SSH Side after a Hub restart: reattach to the same Hub of the host, no start when none runs, and a Hub the user started in the host left alone.
# Same throwaway sshd and run-local ssh config as ssh-side-survive.feature (CLAUDE_UI_SSH_CONFIG under the run folder: the owner's ~/.ssh is never read or written).
# Two Hubs attached to one host (the old takeover scenario) is in one-hub-per-machine.feature. Skips itself on Windows.
Feature: An SSH Side after a Hub restart

  Scenario: A Hub restart reattaches to the same Hub of the host
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When I remember the Hub of the SSH host
    And I reload the app and the daemon restarts and I open Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the Hub of the SSH host is the remembered one
    And I capture "reattached-same-hub"

  Scenario: A Hub of the host that ended is not started again by a Hub restart
    Given a throwaway SSH host
    When I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says Start with Claude UI is "off"
    When I stop the app, end the Hub of the SSH host and start the app
    And I open the app and Settings › Sides
    And I wait 20 seconds
    Then the Settings row of the SSH host "e2e-ok" does not say "Running"
    And no Hub runs in the SSH host
    And I capture "side-off-after-restart"

  Scenario: A Hub the user started in the SSH host is attached to, left as it is and not ended by the Grace period
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When I stop the app, replace the Hub of the SSH host by one the user started and start the app
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When I note the config of the Hub the user started in the SSH host
    And I reload the app and the daemon restarts and I open Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the Hub the user started in the SSH host is unchanged
    When I set the Grace period of the SSH host "e2e-ok" to "1"
    And the SSH host "e2e-ok" becomes unreachable
    And I kill the Hub's ssh process of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Reconnecting"
    When I wait 100 seconds
    Then the Hub the user started in the SSH host is unchanged
    When the SSH host "e2e-ok" becomes reachable again
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And I capture "user-hub-untouched"
    # the Grace period is a shared setting: leave the default for the next feature
    When I set the Grace period of the SSH host "e2e-ok" to "30"
