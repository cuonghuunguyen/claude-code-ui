Feature: OpenCode in folders with slow MCP servers and turns OpenCode ends on its own (GH-682, GH-681)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN). Only structure is asserted.
  # @model: DeepSeek V4.1 Flash with the owner's login (E2E_OPENCODE_AUTH names a copy of its auth file).
  # The slow MCP server never answers; OpenCode gives up on it after 8 s, so the folder's MCP load takes 8 s.
  @model
  Scenario: With orchestration on, the second prompt in a slow-MCP folder also gets a reply
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
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

  # GH-682 review: Stop ends the wait for the folder's MCP load at once, and the stopped prompt is dropped for good.
  @model
  Scenario: Stop while the prompt waits for the MCP attach ends the turn, and the next prompt runs alone
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And the OpenCode server of the daemon is running
    When I enable orchestration in Settings
    And I send the first prompt "Reply with exactly: STOPPEDPROMPT"
    And I stop the turn as soon as it can be stopped
    Then the turn is interrupted within 5 seconds
    And the transcript shows the interrupted divider
    And I see no notice "ended this turn on its own"
    And I capture "stopped during attach wait"
    When I send "Reply with exactly: SECONDPROMPT"
    Then I see a reply from Claude
    And the turn has finished
    And the transcript has exactly 1 replies from Claude
    And OpenCode stored the user prompt "SECONDPROMPT" and never "STOPPEDPROMPT"
    And I capture "only the second prompt ran"

  @model
  Scenario: With orchestration off, a prompt in a slow-MCP folder gets a reply
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    And I see no notice "ended this turn on its own"
    And I capture "orchestration off reply"

  @model
  Scenario: A turn OpenCode ends on its own shows a warning and ends as an error
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And an OpenCode session "Coordinator" with the messages "Hello from the seed" is created outside the app
    And I reload the page
    And I open the OpenCode session "Coordinator"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    Then the conversation shows the user message "Hello from the seed"
    When another client cuts OpenCode's MCP load in the project
    And I send "Reply with exactly: OK" in the opened session
    Then I see the warning "OpenCode ended this turn on its own"
    And the opened session's turn has finished
    And the turn footer says error
    And I capture "self aborted turn"

  @model
  Scenario: Stop shows the interrupted turn and no warning
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And the OpenCode server of the daemon is running
    When I disable orchestration in Settings
    And I send the first prompt "Without using any tool, write 60 long paragraphs about the history of numbers"
    And the reply has started streaming
    And I stop the turn
    Then the turn has finished
    And the transcript shows the interrupted divider
    And I see no notice "ended this turn on its own"
    And the transcript shows exactly 1 interrupted markers
    And I see no notice "claude-ui did not stop it"
    And I capture "stopped without warning"
    When I send "Reply with exactly: AFTERSTOP"
    Then I see at least 2 replies from Claude
    And the turn has finished
    And the transcript shows exactly 1 interrupted markers
    And I see no notice "ended this turn on its own"
    And I capture "after stop new prompt answered"

  @model
  Scenario: After a daemon restart the session restores and a new prompt gets a reply
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
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
  @model
  Scenario: After a daemon restart the session of a plain folder restores and a new prompt gets a reply
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
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
  @model
  Scenario: Right after choosing OpenCode on a cold server the first prompt gets a reply
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I disable orchestration in Settings
    And I send the first prompt "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the turn has finished
    And I see no notice "ended this turn on its own"
    And I capture "cold server first prompt"
