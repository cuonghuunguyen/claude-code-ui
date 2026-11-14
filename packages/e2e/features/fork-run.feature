Feature: The agent forks a subagent and only its result returns to the main session (GH-718)

  # Only structure is asserted: the Fork card, its status, collapsed steps, the result, the setting. Never the reply wording.
  # A fork inherits the parent conversation and model (Haiku here). Claude Code sessions only: OpenCode has no fork (owner check).

  Background:
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And the scratch project has the fork fixtures
    And I set fork subagents to on in Settings

  Scenario: The agent forks a search and only the result returns
    Given I start a new Haiku session
    When I send "Call the Agent tool with subagent_type 'fork', description 'count txt files', prompt 'Use Glob to list the *.txt files in the project folder, Read each one, then reply with only the number of files and the word inside each.' Wait for its notification, then report its result in one line."
    And I allow permission requests until the turn has finished
    Then the fork card is finished
    And exactly one fork card is shown
    And no plain subagent card is shown
    And the fork card shows collapsed
    And the fork card shows its result
    And the fork card steps are collapsed
    And I see a reply from Claude
    And I capture "fork done 1440"
    When I open the fork card steps
    Then the fork card steps show a "Read" step
    And I capture "fork steps 1440"
    When I resize the viewport to 390x844
    Then the page scrollWidth equals the viewport width
    And I capture "fork done 390"

  Scenario: A restored session shows the fork once, with its steps and result
    Given I start a new Haiku session
    When I send "Call the Agent tool with subagent_type 'fork', description 'count txt files', prompt 'Use Glob to list the *.txt files in the project folder, Read each one, then reply with only the number of files and the word inside each.' Wait for its notification, then report its result in one line."
    And I allow permission requests until the turn has finished
    Then the fork card is finished
    When I restart the daemon
    Then the app is connected
    When I reload the page
    Then the fork card is finished
    And exactly one fork card is shown
    And no plain subagent card is shown
    And the fork card shows its result
    And the fork card steps are collapsed
    And I capture "fork restored 1440"
    When I resize the viewport to 390x844
    Then the page scrollWidth equals the viewport width
    And I capture "fork restored 390"

  Scenario: With the setting off the agent cannot run a fork
    Given I set fork subagents to off in Settings
    And I start a new Haiku session
    When I send "Call the Agent tool with subagent_type 'fork', description 'count txt files', prompt 'List the *.txt files in the project folder.' If that fails, reply with exactly: NONE"
    And I allow permission requests until the turn has finished
    Then the turn has finished
    And no fork run has finished
    And I capture "fork setting off"
    When I set fork subagents to on in Settings
