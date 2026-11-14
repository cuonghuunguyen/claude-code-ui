# GH-711. Not run in the build stage (see packages/e2e/README.md).
# The auto mode classifier denies a call only sometimes, so the scenarios' own daemon runs its Claude sessions on the fake CLI (support/fake-claude-cli.mjs):
# a prompt with DENY-PROBE gets a denied Bash call, the follow-up of Allow and retry asks the SDK's PreToolUse hook and runs the call when the hook allows it.
# Not covered here: a call the user denied has no Allow and retry (no cheap user-deny path on the fake CLI; web unit tests cover it).
Feature: Allow and retry

  Scenario: Allow and retry runs a call auto mode denied
    Given the viewport is 1440x900
    And the app is open on a daemon whose Claude sessions run the fake CLI
    And I start a new Haiku session on the fake CLI
    When I send "DENY-PROBE"
    Then the Bash tool card shows the auto mode denial "Git Destructive"
    And I capture "denied"
    When the fake CLI ends the turn with the suggestion ""
    And the turn has finished
    And I click Allow and retry
    And the fake CLI ends the turn with the suggestion ""
    Then a user message contains "git push --force origin main"
    And the Allow and retry button shows "Allowed once" and is disabled
    And 2 Bash tool cards exist and the last one is done
    And the turn has finished
    And I capture "allowed once"

  Scenario: Allow and retry on a phone
    Given the viewport is 390x844
    And the app is open on a daemon whose Claude sessions run the fake CLI
    And I start a new Haiku session on the fake CLI
    When I send "DENY-PROBE"
    Then the Bash tool card shows the auto mode denial "Git Destructive"
    And the Allow and retry button is visible and at least 44px high
    And the page has no horizontal scroll
    And I capture "phone"
