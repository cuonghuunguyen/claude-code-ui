# GH-756. Not run in the build stage (see packages/e2e/README.md).
# Same fake CLI as Allow and retry (support/fake-claude-cli.mjs): DENY-PROBE gets a denied Bash call. The fake answers list_permission_rules from the flag
# rules in auto mode and leaves out a rule holding IGNORED-PROBE (stands in for auto mode dropping it); a retry whose rule is a flag rule runs without the hook.
Feature: Always allow

  Scenario: Always allow for this session runs the call and keeps the rule
    Given the viewport is 1440x900
    And the app is open on a daemon whose Claude sessions run the fake CLI
    And I start a new Haiku session on the fake CLI
    When I send "DENY-PROBE"
    Then the Bash tool card shows the auto mode denial "Git Destructive"
    When the fake CLI ends the turn with the suggestion ""
    And the turn has finished
    And I click Always allow
    Then the Always allow panel shows the rule "Bash(git push --force origin main)"
    And the Always allow hint names a file ending ".claude/settings.local.json"
    And I capture "panel"
    When I pick the "session" scope in the Always allow panel
    And the fake CLI ends the turn with the suggestion ""
    Then a user message contains "Bash(git push --force origin main)"
    And the Always allow label shows "Always allowed (session)"
    And 2 Bash tool cards exist and the last one is done
    And the turn has finished
    And I capture "always allowed session"

  Scenario: Always allow for this project writes the local settings
    Given the viewport is 1440x900
    And the app is open on a daemon whose Claude sessions run the fake CLI
    And the fake CLI project is a git repository
    And I start a new Haiku session on the fake CLI
    When I send "DENY-PROBE"
    Then the Bash tool card shows the auto mode denial "Git Destructive"
    When the fake CLI ends the turn with the suggestion ""
    And the turn has finished
    And I click Always allow
    And I pick the "local" scope in the Always allow panel
    And the fake CLI ends the turn with the suggestion ""
    Then the Always allow label shows "Always allowed (project)"
    And 2 Bash tool cards exist and the last one is done
    And the project's local settings allow "Bash(git push --force origin main)"
    And the turn has finished
    And I capture "always allowed project"

  Scenario: Always allow says why auto mode would ignore the rule
    Given the viewport is 1440x900
    And the app is open on a daemon whose Claude sessions run the fake CLI
    And I start a new Haiku session on the fake CLI
    When I send "DENY-PROBE-IGNORED"
    Then the Bash tool card shows the auto mode denial "Git Destructive"
    When the fake CLI ends the turn with the suggestion ""
    And the turn has finished
    And I click Always allow
    And I pick the "session" scope in the Always allow panel
    Then the Always allow alert starts with "Not saved: auto mode ignores the rule"
    And Allow and retry is still enabled
    And no user message contains "I added the allow rule"
    And I capture "ignored"

  Scenario: Always allow on a phone
    Given the viewport is 390x844
    And the app is open on a daemon whose Claude sessions run the fake CLI
    And I start a new Haiku session on the fake CLI
    When I send "DENY-PROBE"
    Then the Bash tool card shows the auto mode denial "Git Destructive"
    When I click Always allow
    Then the Always allow panel shows the rule "Bash(git push --force origin main)"
    And the Always allow scope buttons are at least 44px high
    And the page has no horizontal scroll
    And I capture "phone"
