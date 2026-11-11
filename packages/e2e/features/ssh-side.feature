# GH-546. A real sshd in a throwaway Debian container (support/ssh-host.ts, needs docker, ssh, ssh-keygen, ssh-keyscan, network for apt) and a
# run-local ssh config (CLAUDE_UI_SSH_CONFIG=<run>/ssh/config): the owner's ~/.ssh is never read or written. The scenarios run in this order on one
# daemon: the first installs claude-ui on the host, the next ones use the installed Side. A Claude session is not proven here (the host has no
# Claude login): the owner checks a real session by hand. Skips itself on Windows.
Feature: Open a project on an SSH host

  Scenario: The ssh config hosts are listed as SSH Sides and the first open installs from the bundle with phases
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I install the SSH host and record the phases
    Then the phases include preparing and unpacking in the host
    And I capture "ssh-installed"

  Scenario: A project on the SSH host has its file tree, git changes, Terminal with the login profile PATH and cwd routing
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    Then the sidebar shows the project under the side "SSH: e2e-ok"
    And the Files pane lists "hello.txt"
    And the Changes pane lists "hello.txt"
    When I toggle the terminal from the titlebar
    And I type "echo GH546-$((6*7))" in the terminal
    Then the terminal shows "GH546-42"
    And I capture "ssh-project"
    When I type "command -v gh592-tool" in the terminal
    Then the terminal shows "/opt/gh592/bin/gh592-tool"
    And I capture "ssh-login-path"

  Scenario: A session on a host without a Claude login says so
    Given a throwaway SSH host
    When I choose the SSH host "e2e-ok" in Open project
    And I open the remote project folder
    And I send the prompt "hello" in the remote project
    Then the session says Claude is not logged in
    And I capture "ssh-not-logged-in"

  Scenario: A host that refuses the login says to run ssh once in a terminal
    Given a throwaway SSH host
    When I choose the SSH host "e2e-auth" in Open project
    Then the side panel says "refused the login"
    And the side panel says "ssh e2e-auth"
    And I capture "ssh-auth-failed"

  Scenario: A host with an unknown host key says to run ssh once in a terminal
    Given a throwaway SSH host
    When I choose the SSH host "e2e-hostkey" in Open project
    Then the side panel says "host key is not trusted"
    And the side panel says "ssh e2e-hostkey"
    And I capture "ssh-host-key"

  Scenario: An unreachable host says so
    Given a throwaway SSH host
    When I choose the SSH host "e2e-down" in Open project
    Then the side panel says "is not reachable"
    And I capture "ssh-unreachable"

  Scenario: Start with Claude UI is off by default and can be turned on, and an SSH host with a custom name and icon shows them in Settings, Open project and the project badge
    Given a throwaway SSH host
    When I open the app and Settings › Sides
    Then the Settings row of the SSH host "e2e-ok" says Start with Claude UI is "off"
    When I turn on Start with Claude UI for the SSH host "e2e-ok"
    Then the Settings row of the SSH host "e2e-ok" says Start with Claude UI is "on"
    And I capture "ssh-start-with-claude-ui"
    When I rename the SSH host "e2e-ok" to "Build box" with the emoji "🖥️"
    Then the Settings row of the SSH host "e2e-ok" is named "Build box"
    When I close Settings
    And I list the SSH hosts in Open project
    When I pick the SSH host named "e2e-ok"
    Then the Open project target shows "Build box"
    When I open the remote project folder
    And the project badge shows "Build box"
    And I capture "ssh-custom-name"
    When Open project forgets the last chosen side
    And I list the SSH hosts in Open project
    Then the Open project row "Build box" shows the emoji "🖥️" and the raw name "e2e-ok"
    When I filter the Open project list by "e2e-ok"
    Then the Open project list shows only "Build box"
    When I filter the Open project list by "build"
    Then the Open project list shows only "Build box"
    And I capture "ssh-open-project-names"
