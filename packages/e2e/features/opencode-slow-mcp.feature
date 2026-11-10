Feature: OpenCode in folders with slow MCP servers and turns OpenCode ends on its own (GH-682, GH-681)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN) and its free model: no login. Only structure is asserted.
  # The slow MCP server never answers; OpenCode gives up on it after 8 s, so the folder's MCP load takes 8 s.
  Scenario: With orchestration on, the second prompt in a slow-MCP folder also gets a reply
    Given the viewport is 1440x900
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I enable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    And I see no notice "Could not attach the orchestration tools"
    When I send "Reply with exactly: AGAIN"
    Then I see at least 2 replies from Claude
    And the turn has finished
    And I see no notice "ended this turn on its own"
    And I capture "second prompt answered"

  Scenario: With orchestration off, a prompt in a slow-MCP folder gets a reply
    Given the viewport is 1440x900
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    And I see no notice "ended this turn on its own"
    And I capture "orchestration off reply"

  Scenario: A turn OpenCode ends on its own shows a warning and ends as an error
    Given the viewport is 1440x900
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And an OpenCode session "Coordinator" with the messages "Hello from the seed" is created outside the app
    And I reload the page
    And I open the OpenCode session "Coordinator"
    Then the conversation shows the user message "Hello from the seed"
    When another client cuts OpenCode's MCP load in the project
    And I send "Reply with exactly: OK" in the opened session
    Then I see the warning "OpenCode ended this turn on its own"
    And the opened session's turn has finished
    And the turn footer says error
    And I capture "self aborted turn"

  Scenario: Stop shows the interrupted turn and no warning
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And I send the first prompt "Without using any tool, write 60 long paragraphs about the history of numbers"
    And the reply has started streaming
    And I stop the turn
    Then the turn has finished
    And the transcript shows the interrupted divider
    And I see no notice "ended this turn on its own"
    And I see no notice "claude-ui did not stop it"
    And I capture "stopped without warning"

  Scenario: After a daemon restart the session restores and a new prompt gets a reply
    Given the viewport is 1440x900
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    When I restart the daemon of the OpenCode scenario
    And I open the first session row
    Then I see at least 1 replies from Claude
    When I send "Reply with exactly: AFTER RESTART"
    Then I see at least 2 replies from Claude
    And the turn has finished
    And I see no notice "ended this turn on its own"
    And I capture "after restart"

  # Control for the scenario above: the same steps in a folder whose MCP servers start at once.
  Scenario: After a daemon restart the session of a plain folder restores and a new prompt gets a reply
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    When I restart the daemon of the OpenCode scenario
    And I open the first session row
    Then I see at least 1 replies from Claude
    When I send "Reply with exactly: AFTER RESTART"
    Then I see at least 2 replies from Claude
    And the turn has finished
    And I capture "after restart plain folder"

  # GH-682: no warm-up step. The first request of the run starts OpenCode's server, so POST /session of the new session is a cold folder's first call (it used to give up at 3 s).
  Scenario: Right after choosing OpenCode on a cold server the first prompt gets a reply
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the turn has finished
    And I see no notice "ended this turn on its own"
    And I capture "cold server first prompt"
