# GH-305. Not run in the build stage: needs a real Claude on Haiku (see packages/e2e/README.md).
# Not covered here: the usage-limit row (a real limit cannot be forced; focus.test.ts, focus-page.test.tsx) and the error row
# after a page reload (no step puts a real session into `error` reliably; focus.test.ts, app.test.tsx).
# Scenario "Next for you chip" is timing-dependent: the CLI sends a suggestion a few seconds after the turn (none on the first turn, not always), so the step waits generously; it can be flaky.
Feature: Focus rows

  Scenario: Worker rows nest under their coordinator
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I enable orchestration in Settings
    And I start a new Haiku session
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"project\":\"<project>\",\"prompt\":\"Use the Bash tool exactly once to run exactly this command and nothing else: echo zq305 > probe.txt\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    And I open Focus
    Then Focus shows a worker group with a permission row nested under its coordinator
    And I capture "nested desktop"
    When I collapse the Focus worker group
    Then the Focus worker group is collapsed
    And I capture "nested collapsed"
    When I reload the page
    And I open Focus
    Then the Focus worker group is collapsed
    Given the viewport is 390x844
    And I open Focus
    Then the Focus worker group is collapsed
    And the page has no horizontal scroll
    When I expand the Focus worker group
    Then Focus shows a worker group with a permission row nested under its coordinator
    And the page has no horizontal scroll
    And I capture "nested phone"

  Scenario: The Next for you chip fills the prompt box
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I enable Next for you in Settings
    And I start a new Haiku session
    When I send "Reply with exactly: one"
    Then the turn has finished
    When I send "Reply with exactly: two"
    And I open Focus
    Then a Finished row in Focus shows a Next for you chip
    And I capture "chip desktop"
    When I click the Next for you chip
    Then the session opens with a prompt box that is not empty
    And I capture "chip filled"
    Given the viewport is 390x844
    And I open Focus
    Then a Finished row in Focus shows a Next for you chip
    And the page has no horizontal scroll
    And I capture "chip phone"

  Scenario: A finished row survives a daemon restart
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I send "Reply with exactly: one"
    Then the turn has finished
    When I send "Reply with exactly: two"
    And I open Focus
    Then Focus shows a Finished row
    When I restart the daemon
    Then the app is connected
    When I reload the page
    And I open Focus
    Then Focus shows a Finished row
    And I capture "finished after restart"
