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
