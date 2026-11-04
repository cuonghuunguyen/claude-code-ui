# GH-549. An SSH Side after a Hub restart: reattach to the same Side Daemon, no start when none runs, takeover by a second Hub, and a claude-ui Hub in the host left alone.
# Same throwaway sshd and run-local ssh config as ssh-side-survive.feature (CLAUDE_UI_SSH_CONFIG under the run folder: the owner's ~/.ssh is never read or written).
# The second Hub is a second daemon of this run: own XDG_CONFIG_HOME, own port, the same CLAUDE_UI_SSH_CONFIG. Skips itself on Windows.
Feature: An SSH Side after a Hub restart

  Scenario: A Hub restart reattaches to the same Side Daemon
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When I remember the Side Daemon processes of the SSH host
    And I reload the app and the daemon restarts and I open Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the Side Daemon processes of the SSH host are the remembered ones
    And I capture "reattached-same-daemon"

  Scenario: A Side Daemon that ended is not started again by a Hub restart
    Given a throwaway SSH host
    When I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says Start with Claude UI is "off"
    When I stop the app, end the Side Daemon of the SSH host and start the app
    And I open the app and Settings › Sides
    And I wait 20 seconds
    Then the Settings row of the SSH host "e2e-ok" does not say "Running"
    And no Side Daemon runs in the SSH host
    And I capture "side-off-after-restart"

  Scenario: A second Claude UI takes over the SSH host and the first one stays off
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When I remember the Side Daemon processes of the SSH host
    And a second Claude UI opens the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "taken over by another Claude UI"
    When I wait 60 seconds
    Then the Settings row of the SSH host "e2e-ok" says "taken over by another Claude UI"
    And the Side Daemon processes of the SSH host are the remembered ones
    And I capture "first-claude-ui-taken-over"
    And the second Claude UI shows the SSH host "e2e-ok" as "Running"
    When I click Retry on the Settings row of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the second Claude UI shows the SSH host "e2e-ok" as "taken over by another Claude UI"
    And I capture "retry-takes-ssh-host-back"

  Scenario: A claude-ui Hub in the SSH host is left alone by attach, restart and the Grace exit
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    When a claude-ui Hub runs in the SSH host
    And I reload the app and the daemon restarts and I open Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says "Running"
    And the claude-ui Hub in the SSH host is unchanged
    When I set the Grace period of the SSH host "e2e-ok" to "1"
    And the SSH host "e2e-ok" becomes unreachable
    And I kill the Hub's ssh process of the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says "Reconnecting"
    When the Side Daemon of the SSH host ended
    Then the claude-ui Hub in the SSH host is unchanged
    When the SSH host "e2e-ok" becomes reachable again
    And I capture "remote-hub-untouched"
