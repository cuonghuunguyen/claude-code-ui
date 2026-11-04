# GH-547. No docker: only a run-local ssh config (CLAUDE_UI_SSH_CONFIG=<run>/ssh/config); the owner's ~/.ssh is never read or written.
# Runs before ssh-side.feature (alphabetical, one worker); that feature writes its own config again.
Feature: SSH hosts from the ssh config and the Add SSH host dialog

  Scenario: Hosts of Include'd files are listed once, wildcard and negated patterns are skipped
    Given an ssh config with an Include and patterns
    When I open the app
    And I list the SSH hosts in Open project
    Then the SSH host list shows "main-a" once
    And the SSH host list shows "inc-b" once
    And the SSH host list shows "inc-c" once
    And the SSH host list does not show "wild-*"
    And the SSH host list does not show "neg-y"
    And the SSH host list does not show "!neg-y"
    And the SSH host list does not show "*.wild"
    And I capture "ssh-include-hosts"

  Scenario Outline: Add SSH host dialog previews the command, writes a Host block, refuses an existing alias and selects the new host at <width>x<height>
    Given the viewport is <width>x<height>
    And an ssh config with an Include and patterns
    When I open the app
    And I list the SSH hosts in Open project
    And I open the Add SSH host dialog
    Then the Add SSH host dialog fits the viewport
    When I type the Add SSH host command "ssh deploy@build.example.com -p 2222"
    Then the Add SSH host preview shows "host" as "build.example.com"
    And the Add SSH host preview shows "user" as "deploy"
    And the Add SSH host preview shows "port" as "2222"
    And I capture "ssh-host-preview"
    When I add the typed SSH host
    Then the Add SSH host dialog is closed
    And the SSH host list shows "build.example.com" once
    And the SSH host "build.example.com" is the selected row
    And the ssh config has a Host block "build.example.com" with "HostName build.example.com"
    And the ssh config has a Host block "build.example.com" with "Port 2222"
    And I capture "ssh-host-added"
    When I open the Add SSH host dialog
    And I type the Add SSH host command "ssh main-a"
    And I add the typed SSH host
    Then the Add SSH host dialog says "already exists"
    And the Add SSH host dialog fits the viewport
    And I capture "ssh-host-refused"
    When I type the Add SSH host command "ssh inc-b"
    And I add the typed SSH host
    Then the Add SSH host dialog says "already exists"
    When I press Escape in the Add SSH host dialog
    Then the Add SSH host dialog is closed
    And the Add SSH host button has the focus

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
