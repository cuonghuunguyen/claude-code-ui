# GH-548, ADR 0009. An SSH Side survives a dropped pipe: the Hub of the host (started by the first attach) keeps running. Same throwaway sshd and run-local ssh config as ssh-side.feature (CLAUDE_UI_SSH_CONFIG under the run
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
    And the Hub of the SSH host is still running
    And I capture "side-reconnecting"
    When the SSH host "e2e-ok" becomes reachable again
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And I capture "side-ready-again"
