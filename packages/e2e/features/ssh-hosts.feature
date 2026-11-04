# GH-547. No docker: only a run-local ssh config (CLAUDE_UI_SSH_CONFIG=<run>/ssh/config); the owner's ~/.ssh is never read or written.
# Runs before ssh-side.feature (alphabetical, one worker); that feature writes its own config again.
Feature: SSH hosts from the ssh config and the Add SSH host form

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

  Scenario Outline: Add SSH host writes a Host block, refuses an existing alias and lists the new host without a restart at <width>x<height>
    Given the viewport is <width>x<height>
    And an ssh config with an Include and patterns
    When I open the app
    And I list the SSH hosts in Open project
    And I open the Add SSH host form
    And I add the SSH host with the command "ssh deploy@build.example.com -p 2222" and the alias "added-<width>"
    Then the SSH host list shows "added-<width>" once
    And the ssh config has a Host block "added-<width>" with "HostName build.example.com"
    And I capture "ssh-host-added"
    When I open the Add SSH host form
    And I add the SSH host with the command "ssh other@example.com" and the alias "main-a"
    Then the Add SSH host form says "already exists"
    And the form fits the viewport
    And the form, its error and its buttons are inside the Open project dialog
    And I capture "ssh-host-refused"
    When I add the SSH host with the command "ssh other@example.com" and the alias "inc-b"
    Then the Add SSH host form says "already exists"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
