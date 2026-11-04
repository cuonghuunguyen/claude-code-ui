# GH-548. An SSH Side survives a dropped pipe (ADR 0007). Same throwaway sshd and run-local ssh config as ssh-side.feature (CLAUDE_UI_SSH_CONFIG under the run
# folder: the owner's ~/.ssh is never read or written). The Hub's ssh process is killed by PID (found by the run's config path); "unreachable" is the
# run's ssh config with the host's port moved to a closed one, restored after. The scenarios run in this order on one daemon: the first installs claude-ui on the host.
# Skips itself on Windows.
Feature: An SSH Side survives a dropped pipe

  Scenario: Killing the Hub's ssh process shows Reconnecting, then the Side is ready again
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When the SSH host "e2e-ok" becomes unreachable
    And I kill the Hub's ssh process of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Reconnecting"
    And the Side Daemon of the SSH host is still running
    And I capture "side-reconnecting"
    When the SSH host "e2e-ok" becomes reachable again
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And I capture "side-ready-again"

  Scenario: The Grace period of an SSH host is 30 minutes, can be set to 5 and persists
    Given a throwaway SSH host
    When I open the app and Settings › Sides
    Then the Grace period of the SSH host "e2e-ok" shows "30"
    And I capture "grace-default"
    When I set the Grace period of the SSH host "e2e-ok" to "5"
    And I reload the app and the daemon restarts and I open Settings › Sides
    Then the Grace period of the SSH host "e2e-ok" shows "5"
    And I capture "grace-5-persisted"

  Scenario: After the Grace period ran out the attach finds no Side Daemon, and opening the host starts a fresh one
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    And I set the Grace period of the SSH host "e2e-ok" to "1"
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And I note the Side Daemon of the SSH host
    When the SSH host "e2e-ok" becomes unreachable
    And I kill the Hub's ssh process of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Reconnecting"
    When the Side Daemon of the SSH host ended
    And the SSH host "e2e-ok" becomes reachable again
    Then the Settings row of the SSH host "e2e-ok" says "Grace period ran out"
    And I capture "side-off-no-daemon"
    When I close Settings
    And I open Open project on the last chosen host
    Then the Open project folder input is shown
    And the Side Daemon of the SSH host is a new one
    When I open the remote project folder
    And I capture "side-fresh-daemon"
