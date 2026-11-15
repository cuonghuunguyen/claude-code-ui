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
